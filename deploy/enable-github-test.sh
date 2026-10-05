#!/usr/bin/env bash
# Accende lo STATO DEI TEST del quadro dei deploy (server/notify/github.js) sull'istanza già in
# esecuzione. Il quadro lo legge da GitHub Actions con una GitHub App dell'organizzazione che esiste
# già (permessi Actions e Metadata in lettura), le cui credenziali stanno in SSM in un ALTRO account:
#
#   1. copia id e chiave privata dell'App dall'account dove stanno a quello di Dadaguard, SecureString,
#      senza che il valore passi mai dallo schermo né dalla riga di comando
#   2. li fa leggere al ruolo di esecuzione, AGGIUNTI alla policy che c'è (non sostituita)
#   3. registra una revision della task definition coi due secret (e org e rami, se dati)
#
# Perché uno script e non `terraform apply`: la stessa ragione di enable-quadro.sh. Il workflow di
# deploy riusa la task definition VIVA cambiandone solo l'immagine, quindi la revision registrata qui
# sopravvive ai deploy successivi. Senza questi secret il quadro funziona lo stesso, senza stati di
# test, e lo dice una volta nel log.
#
# Idempotente: ogni passo controlla prima se è già fatto. Non stampa MAI un valore.
#
# Uso (servono le sessioni AWS sui due profili):
#   DADAGUARD_GITHUB_SRC_PROFILE=<profilo dell'account dove stanno le credenziali, default staging> \
#   DADAGUARD_GITHUB_SRC_ID_PARAM=<nome del parametro con l'id dell'App> \
#   DADAGUARD_GITHUB_SRC_KEY_PARAM=<nome del parametro con la chiave privata, PEM o PEM in base64> \
#   DADAGUARD_GITHUB_ORG=<organizzazione, facoltativa> \
#   DADAGUARD_GITHUB_RAMI='produzione=main,staging=staging' \
#   bash deploy/enable-github-test.sh
# `FORCE=1` ricopia i due parametri anche se ci sono già, e riavvia il servizio perché li rilegga.
set -euo pipefail

REGION=eu-central-1
PROFILE=${DADAGUARD_PAYER_PROFILE:-management}
PROFILE_SRC=${DADAGUARD_GITHUB_SRC_PROFILE:-staging}
CLUSTER=${DADAGUARD_ECS_CLUSTER:-dadaguard}
SERVICE=dadaguard
CONTAINER=dadaguard
EXEC_ROLE=dadaguard-execution
P_ID=/dadaguard/github-app-id
P_KEY=/dadaguard/github-app-key

SRC_ID=${DADAGUARD_GITHUB_SRC_ID_PARAM:?serve DADAGUARD_GITHUB_SRC_ID_PARAM: il parametro con l id dell App}
SRC_KEY=${DADAGUARD_GITHUB_SRC_KEY_PARAM:?serve DADAGUARD_GITHUB_SRC_KEY_PARAM: il parametro con la chiave privata}
ORG=${DADAGUARD_GITHUB_ORG:-}
RAMI=${DADAGUARD_GITHUB_RAMI:-}

ACCOUNT=$(aws sts get-caller-identity --profile "$PROFILE" --query Account --output text)
ARN_ID="arn:aws:ssm:$REGION:$ACCOUNT:parameter$P_ID"
ARN_KEY="arn:aws:ssm:$REGION:$ACCOUNT:parameter$P_KEY"
TMP=$(mktemp -d); chmod 700 "$TMP"; trap 'rm -rf "$TMP"' EXIT
payer() { env $(aws configure export-credentials --profile "$PROFILE" --format env-no-export) aws "$@"; }
src() { env $(aws configure export-credentials --profile "$PROFILE_SRC" --format env-no-export) aws "$@"; }
step() { printf '\n\033[1m▸ %s\033[0m\n' "$1"; }

payer ecs describe-services --region "$REGION" --cluster "$CLUSTER" --services "$SERVICE" \
  --query 'services[0].serviceName' --output text 2>/dev/null | grep -qx "$SERVICE" || {
  echo "servizio $SERVICE non trovato nel cluster $CLUSTER: imposta DADAGUARD_ECS_CLUSTER" >&2
  exit 1
}

# --- 1. i due parametri nell'account di Dadaguard ----------------------------------------------
step "credenziali della GitHub App in SSM"
RIPUNTATO=0
copia() {
  local dst="$1" da="$2" desc="$3" valore
  if payer ssm get-parameter --region "$REGION" --name "$dst" >/dev/null 2>&1; then
    if [ "${FORCE:-0}" != "1" ]; then
      echo "  $dst già presente, lo lascio stare (FORCE=1 per ricopiarlo)"
      return 0
    fi
    RIPUNTATO=1
  fi
  # Il valore resta in una variabile e da lì in un file del solo utente: mai a schermo, e mai sulla
  # riga di comando di un processo, dove lo vedrebbe chiunque legga i processi. `printf` è un comando
  # interno della shell, quindi non crea un processo.
  valore=$(src ssm get-parameter --region "$REGION" --name "$da" --with-decryption --query Parameter.Value --output text)
  [ -n "$valore" ] && [ "$valore" != "None" ] || { echo "  $da è vuoto o non leggibile: mi fermo" >&2; exit 1; }
  printf '%s' "$valore" >"$TMP/valore"
  # Oltre 4 KB un parametro standard non basta (una chiave RSA da 4096 bit in base64 ci arriva).
  local tier=Standard
  [ "${#valore}" -gt 4096 ] && tier=Advanced
  unset valore
  payer ssm put-parameter --region "$REGION" --name "$dst" --type SecureString --tier "$tier" --overwrite \
    --value "file://$TMP/valore" --description "$desc" >/dev/null
  rm -f "$TMP/valore"
  echo "  $dst copiato"
}
copia "$P_ID" "$SRC_ID" "Id della GitHub App da cui il quadro legge lo stato dei test"
copia "$P_KEY" "$SRC_KEY" "Chiave privata della GitHub App da cui il quadro legge lo stato dei test"

# --- 2. il ruolo di esecuzione li può leggere --------------------------------------------------
# Si AGGIUNGONO gli ARN alla policy che c'è: riscriverla da zero toglierebbe gli altri parametri, e il
# container non partirebbe più (ResourceInitializationError su un secret che prima leggeva).
step "policy del ruolo di esecuzione"
payer iam get-role-policy --role-name "$EXEC_ROLE" --policy-name secrets-read --query PolicyDocument --output json >"$TMP/policy.json"
cp "$TMP/policy.json" "$TMP/policy-new.json"
for arn in "$ARN_ID" "$ARN_KEY"; do
  jq --arg A "$arn" '.Statement |= map(if .Sid=="ReadInjectedSecrets" then .Resource = (((if (.Resource|type)=="array" then .Resource else [.Resource] end) + [$A]) | unique) else . end)' \
    "$TMP/policy-new.json" >"$TMP/policy-tmp.json"
  mv "$TMP/policy-tmp.json" "$TMP/policy-new.json"
done
if [ "$(jq -S . "$TMP/policy.json")" = "$(jq -S . "$TMP/policy-new.json")" ]; then
  echo "  secrets-read legge già i due parametri"
else
  payer iam put-role-policy --role-name "$EXEC_ROLE" --policy-name secrets-read --policy-document "file://$TMP/policy-new.json"
  echo "  secrets-read: aggiunti $P_ID e $P_KEY"
fi

# --- 3. i secret dentro il task ----------------------------------------------------------------
step "task definition"
TD=$(payer ecs describe-services --region "$REGION" --cluster "$CLUSTER" --services "$SERVICE" --query 'services[0].taskDefinition' --output text)
payer ecs describe-task-definition --region "$REGION" --task-definition "$TD" --query taskDefinition >"$TMP/td.json"
jq --arg C "$CONTAINER" --arg I "$ARN_ID" --arg K "$ARN_KEY" --arg ORG "$ORG" --arg RAMI "$RAMI" '
  def metti(lista; nome; campo; valore): [lista[]? | select(.name != nome)] + [{name: nome, (campo): valore}];
  .containerDefinitions |= map(
    if .name == $C then
      .secrets = metti(.secrets; "DADAGUARD_GITHUB_APP_ID"; "valueFrom"; $I)
      | .secrets = metti(.secrets; "DADAGUARD_GITHUB_APP_KEY"; "valueFrom"; $K)
      | (if $ORG != "" then .environment = metti(.environment; "DADAGUARD_GITHUB_ORG"; "value"; $ORG) else . end)
      | (if $RAMI != "" then .environment = metti(.environment; "DADAGUARD_GITHUB_RAMI"; "value"; $RAMI) else . end)
    else . end)
  | {family, taskRoleArn, executionRoleArn, networkMode, containerDefinitions,
     requiresCompatibilities, cpu, memory}
' "$TMP/td.json" >"$TMP/new-td.json"
norm='.containerDefinitions[] | select(.name=="'"$CONTAINER"'") | {secrets: (.secrets // [] | sort_by(.name)), environment: (.environment // [] | sort_by(.name))}'
if [ "$(jq -S "$norm" "$TMP/td.json")" = "$(jq -S "$norm" "$TMP/new-td.json")" ]; then
  echo "  ${TD##*/} ha già i secret della GitHub App: nessuna revision da registrare"
else
  NEW=$(payer ecs register-task-definition --region "$REGION" --cli-input-json "file://$TMP/new-td.json" --query taskDefinition.taskDefinitionArn --output text)
  payer ecs update-service --region "$REGION" --cluster "$CLUSTER" --service "$SERVICE" --task-definition "$NEW" >/dev/null
  echo "  registrata ${NEW##*/}, servizio aggiornato: attendo che il task nuovo sia stabile…"
  payer ecs wait services-stable --region "$REGION" --cluster "$CLUSTER" --services "$SERVICE"
  echo "  stabile"
  RIPUNTATO=0 # la revision nuova è già un riavvio: i secret li ha riletti
fi

# Un `secret` si risolve quando il task PARTE: un valore ricopiato non arriva al container che gira.
if [ "$RIPUNTATO" = "1" ]; then
  step "riavvio per rileggere le credenziali"
  payer ecs update-service --region "$REGION" --cluster "$CLUSTER" --service "$SERVICE" --force-new-deployment >/dev/null
  payer ecs wait services-stable --region "$REGION" --cluster "$CLUSTER" --services "$SERVICE"
  echo "  stabile"
fi

step "fatto"
cat <<'NOTE'
Al primo giro il quadro chiede a GitHub l'installazione dell'App e un token, poi i run dei repository
delle sue righe. Se qualcosa non va lo dice UNA volta nel log (`quadro: GitHub non letto`), e le righe
restano senza stato dei test. L'App deve essere installata sull'organizzazione con accesso a quei
repository.
NOTE
