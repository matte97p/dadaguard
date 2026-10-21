#!/usr/bin/env bash
# Accende gli ALLARMI CloudWatch detti da Dadaguard (server/notify/allarmi.js) sull'istanza già in
# esecuzione: mette `DADAGUARD_ALLARMI_CODA` e `DADAGUARD_ALLARMI_CANALE` nella task definition viva, e da
# lì ogni cambio di stato di un allarme arriva nel canale in pochi secondi, coi log nel thread.
#
# La coda NON la crea questo script, e nemmeno i permessi: sono infrastruttura, e stanno con lei (in
# Terraform, accanto alla regola che ci mette gli eventi). Qui serve solo che esista e che il task role
# possa riceverne e cancellarne i messaggi. Lo script lo controlla prima di toccare il task.
#
# Il canale è l'id (`C0…`) dove scrive il bot del quadro (DADAGUARD_SLACK_BOT_TOKEN), che deve esserci
# dentro: senza bot nel canale ogni allarme ripiega sul webhook principale, senza thread.
#
# Perché uno script e non `terraform apply`: la stessa ragione di enable-quadro.sh. Il workflow di
# deploy riusa la task definition VIVA cambiandone solo l'immagine, quindi la revision registrata qui
# sopravvive ai deploy successivi.
#
# Idempotente: se le variabili ci sono già con quei valori non registra niente.
#
# Uso (serve la sessione AWS sul profilo dell'account dove gira Dadaguard):
#   DADAGUARD_ECS_CLUSTER=<cluster> \
#   DADAGUARD_ALLARMI_CODA=https://sqs.<regione>.amazonaws.com/<conto>/<nome> \
#   DADAGUARD_ALLARMI_CANALE=C0XXXXXXX \
#   bash deploy/enable-allarmi.sh
set -euo pipefail

REGION=eu-central-1
PROFILE=${DADAGUARD_PAYER_PROFILE:-management}
CLUSTER=${DADAGUARD_ECS_CLUSTER:-dadaguard}
SERVICE=dadaguard
CONTAINER=dadaguard
CODA=${DADAGUARD_ALLARMI_CODA:?serve DADAGUARD_ALLARMI_CODA: l indirizzo della coda degli allarmi}
CANALE=${DADAGUARD_ALLARMI_CANALE:?serve DADAGUARD_ALLARMI_CANALE: l id del canale degli allarmi}

TMP=$(mktemp -d); chmod 700 "$TMP"; trap 'rm -rf "$TMP"' EXIT
payer() { env $(aws configure export-credentials --profile "$PROFILE" --format env-no-export) aws "$@"; }
step() { printf '\n\033[1m▸ %s\033[0m\n' "$1"; }

payer ecs describe-services --region "$REGION" --cluster "$CLUSTER" --services "$SERVICE" \
  --query 'services[0].serviceName' --output text 2>/dev/null | grep -qx "$SERVICE" || {
  echo "servizio $SERVICE non trovato nel cluster $CLUSTER: imposta DADAGUARD_ECS_CLUSTER" >&2
  exit 1
}

# --- 1. la coda c'è, e il task role la legge -------------------------------------------------------
step "la coda"
REGIONE_CODA=$(printf '%s' "$CODA" | sed -nE 's#^https://sqs\.([a-z0-9-]+)\.amazonaws\.com/[0-9]+/[A-Za-z0-9_-]+$#\1#p')
[ -n "$REGIONE_CODA" ] || { echo "  $CODA non è l'indirizzo di una coda SQS" >&2; exit 1; }
ARN_CODA=$(payer sqs get-queue-attributes --region "$REGIONE_CODA" --queue-url "$CODA" --attribute-names QueueArn \
  --query Attributes.QueueArn --output text 2>/dev/null) || { echo "  la coda non risponde: va creata prima (Terraform)" >&2; exit 1; }
echo "  $ARN_CODA"

TD=$(payer ecs describe-services --region "$REGION" --cluster "$CLUSTER" --services "$SERVICE" --query 'services[0].taskDefinition' --output text)
payer ecs describe-task-definition --region "$REGION" --task-definition "$TD" --query taskDefinition >"$TMP/td.json"
TASK_ROLE=$(jq -r '.taskRoleArn' "$TMP/td.json")
# Il simulatore dice se il ruolo PUÒ, senza ricevere niente: ricevere toglierebbe un messaggio a
# Dadaguard per un minuto.
NEGATE=$(payer iam simulate-principal-policy --policy-source-arn "$TASK_ROLE" --resource-arns "$ARN_CODA" \
  --action-names sqs:ReceiveMessage sqs:DeleteMessage \
  --query 'EvaluationResults[?EvalDecision!=`allowed`].EvalActionName' --output text)
if [ -n "$NEGATE" ]; then
  echo "  il task role ${TASK_ROLE##*/} non ha: $NEGATE. Va dato prima (Terraform, accanto alla coda)" >&2
  exit 1
fi
echo "  il task role ${TASK_ROLE##*/} riceve e cancella"

# --- 2. la variabile nella task definition viva ---------------------------------------------------
step "task definition"
jq --arg C "$CONTAINER" --arg CODA "$CODA" --arg CANALE "$CANALE" '
  def metti(lista; nome; campo; valore): [lista[]? | select(.name != nome)] + [{name: nome, (campo): valore}];
  .containerDefinitions |= map(if .name == $C then .environment = (metti(metti(.environment; "DADAGUARD_ALLARMI_CODA"; "value"; $CODA); "DADAGUARD_ALLARMI_CANALE"; "value"; $CANALE)) else . end)
  | {family, taskRoleArn, executionRoleArn, networkMode, containerDefinitions,
     requiresCompatibilities, cpu, memory}
' "$TMP/td.json" >"$TMP/new-td.json"
norm='.containerDefinitions[] | select(.name=="'"$CONTAINER"'") | (.environment // [] | sort_by(.name))'
if [ "$(jq -S "$norm" "$TMP/td.json")" = "$(jq -S "$norm" "$TMP/new-td.json")" ]; then
  echo "  ${TD##*/} ha già coda e canale: nessuna revision da registrare"
else
  NEW=$(payer ecs register-task-definition --region "$REGION" --cli-input-json "file://$TMP/new-td.json" --query taskDefinition.taskDefinitionArn --output text)
  payer ecs update-service --region "$REGION" --cluster "$CLUSTER" --service "$SERVICE" --task-definition "$NEW" >/dev/null
  echo "  registrata ${NEW##*/}, servizio aggiornato: attendo che il task nuovo sia stabile…"
  payer ecs wait services-stable --region "$REGION" --cluster "$CLUSTER" --services "$SERVICE"
  echo "  stabile"
fi

step "fatto"
cat <<'NOTE'
Nel log del task deve comparire «allarmi: ascolto attivo». Da lì il primo allarme che cambia stato
compare nel canale; se compare invece nel canale del webhook, il bot non è nel canale (invitalo).
NOTE
