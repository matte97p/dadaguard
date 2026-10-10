#!/usr/bin/env bash
# Accende il QUADRO DEI DEPLOY (server/notify/quadro.js) sull'istanza già in esecuzione:
#
#   1. il token dell'app Slack (deploy/slack-app-manifest.yml) in SSM, come SecureString
#   2. il ruolo di esecuzione che lo può leggere, AGGIUNTO alla policy che c'è (non sostituito)
#   3. una revision della task definition col token, i canali e l'indirizzo pubblico di Dadaguard
#
# Perché uno script e non `terraform apply`: la stessa ragione di enable-notifications.sh. Il workflow
# di deploy riusa la task definition VIVA cambiandone solo l'immagine, quindi una revision registrata
# qui sopravvive ai deploy successivi. L'ordine con il merge del codice non conta: un'immagine che non
# conosce il quadro ignora le variabili, e quella che lo conosce le trova già lì.
#
# Idempotente: ogni passo controlla prima se è già fatto. Non stampa MAI il token.
#
# Uso (serve la sessione AWS sul profilo dell'account dove gira Dadaguard):
#   DADAGUARD_ECS_CLUSTER=<cluster> \
#   DADAGUARD_SLACK_BOT_TOKEN_FILE=<file col token xoxb-, permessi 600> \
#   DADAGUARD_QUADRO_CANALI='produzione=C0123,staging=C0123' \
#   DADAGUARD_PUBLIC_URL=https://dadaguard.example.com \
#   DADAGUARD_QUADRO_SQUADRE='data=Scraper,scraper-image,worker-*' \
#   DADAGUARD_ALLARMI_DATA_CANALE=C0456 \
#   DADAGUARD_CORSE_CANALI='tutti=C0789,data=C0456' \
#   DADAGUARD_GITHUB_ORG=<organizzazione GitHub, facoltativa> \
#   DADAGUARD_GITHUB_REF=<ramo dei link al codice, default main> \
#   bash deploy/enable-quadro.sh
# Le squadre sono facoltative: senza, il canale ha le schede degli ambienti e quella dei cron. Un
# elemento senza `*` è un repository, uno con `*` un glob sul nome breve della risorsa (per i
# componenti esterni e le Lambda dell'IaC, che un repository nostro non ce l'hanno).
# `DADAGUARD_CORSE_CANALI` è facoltativa e accende il canvas delle CORSE dei cron (server/notify/
# corse.js): un canvas per canale, `tutti` con ogni cron o il nome di una squadra di
# `DADAGUARD_QUADRO_SQUADRE` con i soli suoi (la stessa definizione del quadro). Una squadra che lì non
# c'è si dice nel log e il suo canale resta senza canvas. Nessun permesso Slack nuovo. Senza, spento.
# Accanto a ogni canvas delle corse c'è una Slack List «Lista corse cron <CHIAVE>», una riga per cron
# da filtrare e ordinare (Ambiente, Stato, Sezione), e il canvas si riduce al riepilogo col link alla
# List. Accese di default come quelle del quadro; `DADAGUARD_CORSE_LISTE=0` (da mettere a mano nella
# task definition, come `DADAGUARD_QUADRO_LISTE`) le spegne e riporta le tabelle nel canvas. Gli scope
# `lists:read` e `lists:write` sono quelli delle List del quadro: niente da reinstallare.
# Se `DADAGUARD_QUADRO_SQUADRE` definisce una squadra `infra` (o quella in `DADAGUARD_CORSE_INFRA`), i
# suoi cron vanno in sezioni «Infra» in fondo al canvas `tutti` e alla pagina Cron.
# Il nome di un cron è il percorso del suo codice, dal tag AWS `Codice` della risorsa (`<repo>/<percorso>`
# o un indirizzo intero; vedi shared/codice.js), e ha accanto il link al codice:
# `DADAGUARD_GITHUB_ORG` è l'organizzazione dei `<repo>/<percorso>` (la stessa variabile della GitHub
# App dei test) e `DADAGUARD_GITHUB_REF` il ramo (default `main`). Senza org il percorso si vede senza
# link. Per i cron Lambda il ruolo read-only vuole `lambda:ListTags` (deploy/dadaguard-readonly-policy.json):
# senza, i cron Lambda tengono il nome dello schedule.
# `FORCE=1` riscrive un token già presente in SSM e riavvia il servizio perché lo rilegga.
# Lo stato dei test (GitHub Actions) si accende a parte, con deploy/enable-github-test.sh.
set -euo pipefail

REGION=eu-central-1
PROFILE=${DADAGUARD_PAYER_PROFILE:-management}
CLUSTER=${DADAGUARD_ECS_CLUSTER:-dadaguard}
SERVICE=dadaguard
CONTAINER=dadaguard
EXEC_ROLE=dadaguard-execution
P_TOKEN=/dadaguard/slack-bot-token

TOKEN_FILE=${DADAGUARD_SLACK_BOT_TOKEN_FILE:?serve DADAGUARD_SLACK_BOT_TOKEN_FILE: il file col token del bot}
CANALI=${DADAGUARD_QUADRO_CANALI:?serve DADAGUARD_QUADRO_CANALI, es. produzione=C0123,staging=C0123}
PUBLIC_URL=${DADAGUARD_PUBLIC_URL:-}
SQUADRE=${DADAGUARD_QUADRO_SQUADRE:-}
CANALE_DATA=${DADAGUARD_ALLARMI_DATA_CANALE:-}
CORSE=${DADAGUARD_CORSE_CANALI:-}
INFRA=${DADAGUARD_CORSE_INFRA:-}
GH_ORG=${DADAGUARD_GITHUB_ORG:-}
GH_REF=${DADAGUARD_GITHUB_REF:-}

ACCOUNT=$(aws sts get-caller-identity --profile "$PROFILE" --query Account --output text)
ARN_TOKEN="arn:aws:ssm:$REGION:$ACCOUNT:parameter$P_TOKEN"
TMP=$(mktemp -d); chmod 700 "$TMP"; trap 'rm -rf "$TMP"' EXIT
payer() { env $(aws configure export-credentials --profile "$PROFILE" --format env-no-export) aws "$@"; }
step() { printf '\n\033[1m▸ %s\033[0m\n' "$1"; }

# Il cluster di default di questo script non è quello di tutti: senza questo controllo il token andava
# in SSM e la revision falliva dopo, lasciando il lavoro a metà.
payer ecs describe-services --region "$REGION" --cluster "$CLUSTER" --services "$SERVICE" \
  --query 'services[0].serviceName' --output text 2>/dev/null | grep -qx "$SERVICE" || {
  echo "servizio $SERVICE non trovato nel cluster $CLUSTER: imposta DADAGUARD_ECS_CLUSTER" >&2
  exit 1
}

# --- 1. il token in SSM ------------------------------------------------------------------------
step "token del bot in SSM"
[ -r "$TOKEN_FILE" ] || { echo "  $TOKEN_FILE non leggibile" >&2; exit 1; }
# Un file che non contiene un token del bot è quasi sempre un appunto incollato sbagliato: meglio
# fermarsi qui che scoprirlo dal primo giro, con un `invalid_auth` nei log.
grep -q '^xoxb-' "$TOKEN_FILE" || { echo "  $TOKEN_FILE non contiene un token xoxb-: mi fermo" >&2; exit 1; }
RIPUNTATO=0
if payer ssm get-parameter --region "$REGION" --name "$P_TOKEN" >/dev/null 2>&1 && [ "${FORCE:-0}" != "1" ]; then
  echo "  $P_TOKEN già presente, lo lascio stare (FORCE=1 per riscriverlo)"
else
  payer ssm get-parameter --region "$REGION" --name "$P_TOKEN" >/dev/null 2>&1 && RIPUNTATO=1
  # Il valore passa da un file, non dalla riga di comando: lì lo vedrebbe chiunque legga i processi.
  payer ssm put-parameter --region "$REGION" --name "$P_TOKEN" --type SecureString --overwrite \
    --value "file://$TOKEN_FILE" --description "Token del bot Slack del quadro dei deploy" >/dev/null
  echo "  $P_TOKEN scritto"
fi

# --- 2. il ruolo di esecuzione lo può leggere --------------------------------------------------
# Si AGGIUNGE l'ARN alla policy che c'è: riscriverla da zero toglierebbe gli altri parametri, e il
# container non partirebbe più (ResourceInitializationError su un secret che prima leggeva).
step "policy del ruolo di esecuzione"
payer iam get-role-policy --role-name "$EXEC_ROLE" --policy-name secrets-read --query PolicyDocument --output json >"$TMP/policy.json"
if jq -e --arg A "$ARN_TOKEN" '.Statement[] | select(.Sid=="ReadInjectedSecrets") | .Resource | (if type=="array" then . else [.] end) | index($A)' "$TMP/policy.json" >/dev/null; then
  echo "  secrets-read legge già $P_TOKEN"
else
  jq --arg A "$ARN_TOKEN" '.Statement |= map(if .Sid=="ReadInjectedSecrets" then .Resource = ((if (.Resource|type)=="array" then .Resource else [.Resource] end) + [$A]) else . end)' \
    "$TMP/policy.json" >"$TMP/policy-new.json"
  payer iam put-role-policy --role-name "$EXEC_ROLE" --policy-name secrets-read --policy-document "file://$TMP/policy-new.json"
  echo "  secrets-read: aggiunto $P_TOKEN"
fi

# --- 3. token, canali e indirizzo dentro il task -----------------------------------------------
step "task definition"
TD=$(payer ecs describe-services --region "$REGION" --cluster "$CLUSTER" --services "$SERVICE" --query 'services[0].taskDefinition' --output text)
payer ecs describe-task-definition --region "$REGION" --task-definition "$TD" --query taskDefinition >"$TMP/td.json"
jq --arg C "$CONTAINER" --arg T "$ARN_TOKEN" --arg CANALI "$CANALI" --arg URL "$PUBLIC_URL" --arg SQ "$SQUADRE" --arg CD "$CANALE_DATA" --arg CO "$CORSE" --arg IN "$INFRA" --arg GO "$GH_ORG" --arg GR "$GH_REF" '
  def metti(lista; nome; campo; valore): [lista[]? | select(.name != nome)] + [{name: nome, (campo): valore}];
  .containerDefinitions |= map(
    if .name == $C then
      .secrets = metti(.secrets; "DADAGUARD_SLACK_BOT_TOKEN"; "valueFrom"; $T)
      | .environment = metti(.environment; "DADAGUARD_QUADRO_CANALI"; "value"; $CANALI)
      | (if $URL != "" then .environment = metti(.environment; "DADAGUARD_PUBLIC_URL"; "value"; $URL) else . end)
      | (if $SQ != "" then .environment = metti(.environment; "DADAGUARD_QUADRO_SQUADRE"; "value"; $SQ) else . end)
      | (if $CD != "" then .environment = metti(.environment; "DADAGUARD_ALLARMI_DATA_CANALE"; "value"; $CD) else . end)
      | (if $CO != "" then .environment = metti(.environment; "DADAGUARD_CORSE_CANALI"; "value"; $CO) else . end)
      | (if $IN != "" then .environment = metti(.environment; "DADAGUARD_CORSE_INFRA"; "value"; $IN) else . end)
      | (if $GO != "" then .environment = metti(.environment; "DADAGUARD_GITHUB_ORG"; "value"; $GO) else . end)
      | (if $GR != "" then .environment = metti(.environment; "DADAGUARD_GITHUB_REF"; "value"; $GR) else . end)
    else . end)
  | {family, taskRoleArn, executionRoleArn, networkMode, containerDefinitions,
     requiresCompatibilities, cpu, memory}
' "$TMP/td.json" >"$TMP/new-td.json"
# Uguale a quella viva (a meno dell'ordine delle voci)? Allora non c'è niente da registrare.
norm='.containerDefinitions[] | select(.name=="'"$CONTAINER"'") | {secrets: (.secrets // [] | sort_by(.name)), environment: (.environment // [] | sort_by(.name))}'
if [ "$(jq -S "$norm" "$TMP/td.json")" = "$(jq -S "$norm" "$TMP/new-td.json")" ]; then
  echo "  ${TD##*/} ha già token, canali, indirizzo e squadre: nessuna revision da registrare"
else
  NEW=$(payer ecs register-task-definition --region "$REGION" --cli-input-json "file://$TMP/new-td.json" --query taskDefinition.taskDefinitionArn --output text)
  payer ecs update-service --region "$REGION" --cluster "$CLUSTER" --service "$SERVICE" --task-definition "$NEW" >/dev/null
  echo "  registrata ${NEW##*/}, servizio aggiornato: attendo che il task nuovo sia stabile…"
  payer ecs wait services-stable --region "$REGION" --cluster "$CLUSTER" --services "$SERVICE"
  echo "  stabile"
  RIPUNTATO=0 # la revision nuova è già un riavvio: il token l'ha riletto
fi

# Un `secret` si risolve quando il task PARTE: un token riscritto non arriva al container che gira.
if [ "$RIPUNTATO" = "1" ]; then
  step "riavvio per rileggere il token"
  payer ecs update-service --region "$REGION" --cluster "$CLUSTER" --service "$SERVICE" --force-new-deployment >/dev/null
  payer ecs wait services-stable --region "$REGION" --cluster "$CLUSTER" --services "$SERVICE"
  echo "  stabile"
fi

step "fatto"
cat <<'NOTE'
Il quadro parte col primo giro del task: crea o ritrova i canvas di ogni ambiente nel suo canale, e
una Slack List per area (PRODOTTO, CRON, una per squadra) nel canale del primo ambiente
(`DADAGUARD_QUADRO_LISTE=0` per i soli canvas). Permessi nuovi nel manifest vogliono
l'app REINSTALLATA, o la List risponde `missing_scope`.
Il bot dev'essere nei canali (`/invite @Dadaguard`), o il giro risponde `not_in_channel`.
Con DADAGUARD_CORSE_CANALI il canvas delle corse dei cron parte un minuto e mezzo dopo l'avvio e si
aggiorna ogni 5 minuti (DADAGUARD_CORSE_INTERVAL), anche lui solo nei canali dove il bot è invitato.
Con lui una Slack List per canale (`DADAGUARD_CORSE_LISTE=0` per il solo canvas, con le tabelle): al
primo giro le righe nascono 30 per giro, quindi la List si riempie in qualche giro.
Il primo giro degli allarmi è SILENZIOSO per costruzione: prende nota di cosa è già rotto e non lo
annuncia, altrimenti a ogni rilascio di Dadaguard ripeterebbe tutti i rossi.
NOTE
