#!/usr/bin/env bash
# Accende, sull'istanza già in esecuzione, le due cose che il codice sa fare ma che senza
# configurazione restano inerti:
#
#   1. NOTIFICHE SLACK — copia i due webhook dall'account di produzione a quello di Dadaguard
#      (SecureString), li inietta nel task e allarga la policy del ruolo di esecuzione.
#      Principale = #aws-deploy · cron mai partiti = #tech-devops-cron.
#   2. SONDE HTTP (segnale #1) — aggiunge la mappa `health:` alla config in SSM.
#
# Perché uno script e non `terraform apply`: lo stato Terraform di questo deploy non è su questa
# macchina (nessun backend remoto, nessun tfstate locale), e il workflow di deploy riusa la task
# definition VIVA cambiandone solo l'immagine → una revision registrata qui sopravvive ai deploy
# successivi. Il codice Terraform in deploy/terraform resta la descrizione della stessa cosa.
#
# Idempotente: ogni passo controlla prima se è già fatto. Non stampa MAI un valore segreto.
# Uso:  bash deploy/enable-notifications.sh          (serve `aws sso login` su management+production)
set -euo pipefail

REGION=eu-central-1
PROFILE_PAYER=${DADAGUARD_PAYER_PROFILE:-management}   # profilo AWS dove gira Dadaguard (il payer)
PROFILE_SRC=production     # dove vivono già i webhook Slack
ACCOUNT=$(aws sts get-caller-identity --profile "$PROFILE_PAYER" --query Account --output text)
CLUSTER=${DADAGUARD_ECS_CLUSTER:-dadaguard}
SERVICE=dadaguard
CONTAINER=dadaguard
EXEC_ROLE=dadaguard-execution

P_CFG=/dadaguard/services-yaml
P_MAIN=/dadaguard/slack-webhook
P_CRON=/dadaguard/slack-webhook-cron
# Da DOVE arrivano le destinazioni: sono quelle che la tua organizzazione usa già, quindi nessun canale nuovo da far
# seguire e niente da creare in Slack.
#   - principale → il webhook di audit del backend, che scrive in #tech-devops-alert (verificato: le
#     impersonificazioni in quel canale le manda `emit_impersonation_started` con
#     SLACK_AUDIT_WEBHOOK_URL, ed è dove vivono già gli allarmi PostHog 🔴/🟢). «Un servizio è giù» è
#     un allarme, non un rilascio: in #aws-deploy annegherebbe nel registro dei deploy.
#   - cron → il webhook dei cron di produzione, che scrive in #tech-devops-cron.
SRC_MAIN=/acme/production/backend/SLACK_AUDIT_WEBHOOK_URL
SRC_CRON=/acme/production/cron/ai-credit-monitor/SLACK_WEBHOOK_URL

ARN_CFG="arn:aws:ssm:$REGION:$ACCOUNT:parameter$P_CFG"
ARN_MAIN="arn:aws:ssm:$REGION:$ACCOUNT:parameter$P_MAIN"
ARN_CRON="arn:aws:ssm:$REGION:$ACCOUNT:parameter$P_CRON"
ARN_TUNNEL="arn:aws:ssm:$REGION:$ACCOUNT:parameter/dadaguard/cloudflared-token"
ARN_CFTOKEN="arn:aws:ssm:$REGION:$ACCOUNT:parameter/dadaguard/cloudflare-api-token"

TMP=$(mktemp -d); chmod 700 "$TMP"; trap 'rm -rf "$TMP"' EXIT
payer() { env $(aws configure export-credentials --profile "$PROFILE_PAYER" --format env-no-export) aws "$@"; }
src() { env $(aws configure export-credentials --profile "$PROFILE_SRC" --format env-no-export) aws "$@"; }
step() { printf '\n\033[1m▸ %s\033[0m\n' "$1"; }

# --- 1. i due webhook nell'account di Dadaguard ------------------------------------------------
step "webhook Slack in SSM"
REWIRED=0
for pair in "$P_MAIN|$SRC_MAIN|#tech-devops-alert — destinazione principale delle notifiche Dadaguard" \
  "$P_CRON|$SRC_CRON|#tech-devops-cron — solo i cron mai partiti"; do
  IFS='|' read -r dst src_name desc <<<"$pair"
  if payer ssm get-parameter --region "$REGION" --name "$dst" >/dev/null 2>&1; then
    if [ "${FORCE:-0}" != "1" ]; then
      echo "  $dst già presente, lo lascio stare (FORCE=1 per ri-puntarlo a un altro canale)"
      continue
    fi
    echo "  $dst esiste: FORCE=1 → lo ri-punto a $src_name"
    REWIRED=1
  fi
  value=$(src ssm get-parameter --region "$REGION" --name "$src_name" --with-decryption --query Parameter.Value --output text)
  [ -n "$value" ] || {
    echo "  $src_name è vuoto: mi fermo" >&2
    exit 1
  }
  # `--overwrite` serve nel caso FORCE=1 (parametro che esiste già, lo si ri-punta a un altro canale):
  # senza, SSM risponde ParameterAlreadyExists. Alla creazione è innocuo.
  payer ssm put-parameter --region "$REGION" --name "$dst" --type SecureString --value "$value" \
    --description "Webhook Slack $desc (copia di $src_name)" --overwrite >/dev/null
  [ "$REWIRED" = "1" ] && echo "  $dst ri-puntato" || echo "  $dst creato"
done

# --- 2. il ruolo di esecuzione può leggerli ----------------------------------------------------
# `secrets` nella task definition è risolto dall'AGENTE ECS col ruolo di ESECUZIONE, non dal task:
# senza questa policy il container non parte affatto (ResourceInitializationError).
step "policy del ruolo di esecuzione"
cat >"$TMP/policy.json" <<JSON
{
  "Version": "2012-10-17",
  "Statement": [
    {
      "Sid": "ReadInjectedSecrets",
      "Effect": "Allow",
      "Action": ["ssm:GetParameters"],
      "Resource": ["$ARN_CFG", "$ARN_TUNNEL", "$ARN_CFTOKEN", "$ARN_MAIN", "$ARN_CRON"]
    },
    { "Sid": "DecryptSecureString", "Effect": "Allow", "Action": ["kms:Decrypt"], "Resource": "*" }
  ]
}
JSON
payer iam put-role-policy --role-name "$EXEC_ROLE" --policy-name secrets-read --policy-document "file://$TMP/policy.json"
echo "  secrets-read aggiornata (5 parametri)"

# --- 3. la mappa `health:` nella config --------------------------------------------------------
# Sondiamo SOLO host verificati come serviti da AWS: una richiesta marcata su staging-endpoint e
# staging-app è stata ritrovata nei log /ecs/acme-staging/{backend,frontend}. NON sondiamo
# staging-agentic-chat / -analisi-avanzata / -guarantee-agent (rispondono da Railway: header
# x-railway-*) né app.get-acme.com (Vercel: x-vercel-id): un verde là parlerebbe del vecchio
# hosting, non del servizio AWS — e un pannello che mente una volta non lo si guarda più.
step "mappa health: nella config"
payer ssm get-parameter --region "$REGION" --name "$P_CFG" --with-decryption --query Parameter.Value --output text >"$TMP/cfg.yaml"
chmod 600 "$TMP/cfg.yaml"
if grep -q '^health:' "$TMP/cfg.yaml"; then
  echo "  già presente, non tocco niente"
else
  cat >>"$TMP/cfg.yaml" <<'YAML'

# --- Sonde HTTP (segnale #1) ---
# Solo host VERIFICATI serviti da AWS (richiesta marcata ritrovata in /ecs/acme-staging/*). Gli altri
# rispondono ancora da Railway/Vercel: sondarli darebbe un verde sul vecchio hosting.
health:
  staging/backend: https://staging-endpoint.get-acme.com/health
  staging/frontend: https://staging-app.get-acme.com/
YAML
  payer ssm put-parameter --region "$REGION" --name "$P_CFG" --type SecureString \
    --value "file://$TMP/cfg.yaml" --overwrite >/dev/null
  echo "  aggiunte 2 sonde (staging backend + frontend)"
fi

# --- 4. i due webhook dentro il task -----------------------------------------------------------
step "task definition"
TD=$(payer ecs describe-services --region "$REGION" --cluster "$CLUSTER" --services "$SERVICE" --query 'services[0].taskDefinition' --output text)
payer ecs describe-task-definition --region "$REGION" --task-definition "$TD" --query taskDefinition >"$TMP/td.json"
if jq -e --arg C "$CONTAINER" '.containerDefinitions[] | select(.name==$C) | .secrets[]? | select(.name=="DADAGUARD_SLACK_WEBHOOK")' "$TMP/td.json" >/dev/null; then
  echo "  $TD ha già i webhook: nessuna revision da registrare"
else
  jq --arg C "$CONTAINER" --arg M "$ARN_MAIN" --arg K "$ARN_CRON" '
    .containerDefinitions |= map(
      if .name == $C then
        .secrets += [{name:"DADAGUARD_SLACK_WEBHOOK", valueFrom:$M},
                     {name:"DADAGUARD_SLACK_WEBHOOK_CRON", valueFrom:$K}]
      else . end)
    | {family, taskRoleArn, executionRoleArn, networkMode, containerDefinitions,
       requiresCompatibilities, cpu, memory}
  ' "$TMP/td.json" >"$TMP/new-td.json"
  NEW=$(payer ecs register-task-definition --region "$REGION" --cli-input-json "file://$TMP/new-td.json" --query taskDefinition.taskDefinitionArn --output text)
  payer ecs update-service --region "$REGION" --cluster "$CLUSTER" --service "$SERVICE" --task-definition "$NEW" >/dev/null
  echo "  registrata ${NEW##*/}, servizio aggiornato — attendo che il task nuovo sia stabile…"
  payer ecs wait services-stable --region "$REGION" --cluster "$CLUSTER" --services "$SERVICE"
  echo "  stabile"
fi

# Un `secret` viene risolto quando il task PARTE: se il valore di un parametro già iniettato è
# cambiato (cambio di canale), il container in esecuzione tiene ancora il vecchio. Serve un riavvio.
if [ "$REWIRED" = "1" ]; then
  step "riavvio per rileggere le destinazioni"
  payer ecs update-service --region "$REGION" --cluster "$CLUSTER" --service "$SERVICE" --force-new-deployment >/dev/null
  payer ecs wait services-stable --region "$REGION" --cluster "$CLUSTER" --services "$SERVICE"
  echo "  stabile"
fi

step "fatto"
payer ecs describe-services --region "$REGION" --cluster "$CLUSTER" --services "$SERVICE" \
  --query 'services[0].{revision:taskDefinition,attivi:runningCount,voluti:desiredCount}' --output table
cat <<'NOTE'
Il primo giro del notificatore è SILENZIOSO per costruzione: prende nota dello stato del mondo e non
annuncia niente (altrimenti a ogni riavvio rovescerebbe in chat l'intero pannello). Dal secondo giro
in poi manda solo le TRANSIZIONI, confermate su due letture consecutive.
NOTE
