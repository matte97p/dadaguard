#!/usr/bin/env bash
# Completa il passaggio alla scoperta via Organizations: rende LEGGIBILI i due account che comparivano
# ma non si potevano leggere (lo dicono i log, ora che la scoperta non inghiotte più gli errori).
#
#   1. crea il ruolo read-only nel payer (aws-management #327, live/management/dadaguard-readonly)
#   2. applica la policy del task role, perché possa assumere il ruolo in Security e nel payer
#      (senza, l'AssumeRole è negato prima di partire: CloudTrail non mostrava un solo tentativo)
#   3. aggiunge `selfUsesRole: true` al blocco org, così nel proprio account Dadaguard assume il
#      ruolo invece di usare le credenziali del task — che non hanno permessi di lettura, né `ce:`
#   4. riavvia e verifica che le letture non falliscano più
#
# Idempotente e con guardrail sui plan. Non stampa mai un valore segreto.
# Prerequisiti:  aws sso login --profile management   (e production, per leggere l'ExternalId)
set -euo pipefail

REGION=eu-central-1
CLUSTER=cato-management
SERVICE=dadaguard
P_CFG=/dadaguard/services-yaml
IAC="$HOME/www/cato-infra/aws-management/live/management"

TMP=$(mktemp -d)
chmod 700 "$TMP"
trap 'rm -rf "$TMP"' EXIT
payer() { env $(aws configure export-credentials --profile management --format env-no-export) aws "$@"; }
step() { printf '\n\033[1m▸ %s\033[0m\n' "$1"; }

# L'ExternalId serve a terragrunt (get_env) e non si scrive da nessuna parte: si legge dal ruolo GIÀ
# esistente in produzione, che per definizione ha il valore giusto.
DADAGUARD_EXTERNAL_ID=$(
  env $(aws configure export-credentials --profile production --format env-no-export) \
    aws iam get-role --role-name dadaguard-readonly \
    --query 'Role.AssumeRolePolicyDocument.Statement[0].Condition.StringEquals."sts:ExternalId"' \
    --output text
)
export DADAGUARD_EXTERNAL_ID TG_NON_INTERACTIVE=true
if [ -z "$DADAGUARD_EXTERNAL_ID" ] || [ "$DADAGUARD_EXTERNAL_ID" = "None" ]; then
  echo "ExternalId non letto: mi fermo" >&2
  exit 1
fi

# apply di un layer solo se il plan è ESATTAMENTE quello atteso: su layer applicati a mano è l'unica
# difesa contro un plan cambiato sotto i piedi (ed è così che stamattina ho evitato di riscrivere una
# trust policy e di far ripartire il servizio su un'immagine vecchia).
apply_if() { # $1 = cartella, $2 = riga di Plan attesa
  cd "$IAC/$1"
  echo "  plan…"
  terragrunt plan -out="$TMP/$1.tfplan" >"$TMP/$1.log" 2>&1 || {
    tail -20 "$TMP/$1.log" >&2
    return 1
  }
  if grep -qF "$2" "$TMP/$1.log"; then
    echo "  plan atteso ($2) → applico"
    terragrunt apply "$TMP/$1.tfplan" 2>&1 | grep -E "Apply complete|Error" | head -4
  else
    echo "  ✋ plan DIVERSO dall'atteso ($2): non applico." >&2
    grep -E 'Plan:|No changes' "$TMP/$1.log" >&2 || tail -20 "$TMP/$1.log" >&2
    return 2
  fi
}

step "1. ruolo read-only nel payer"
if payer iam get-role --role-name dadaguard-readonly >/dev/null 2>&1; then
  echo "  già presente, salto"
else
  apply_if dadaguard-readonly "3 to add, 0 to change, 0 to destroy"
fi

step "2. il task role può assumere i ruoli nuovi"
# Atteso: la policy AssumeRole (voluta), due tag di servizio (deriva preesistente) e la solita
# revision di task definition. Il servizio NON cambia immagine: ignore_changes=[task_definition].
apply_if dadaguard "1 to add, 2 to change, 1 to destroy" || echo "  (se il plan è già a zero, è fatto)"

step "3. selfUsesRole nel blocco org"
payer ssm get-parameter --region "$REGION" --name "$P_CFG" --with-decryption \
  --query Parameter.Value --output text >"$TMP/cfg.yaml"
chmod 600 "$TMP/cfg.yaml"
if grep -q 'selfUsesRole' "$TMP/cfg.yaml"; then
  echo "  già presente, non tocco la config"
  RESTART=0
elif ! grep -q '^org:' "$TMP/cfg.yaml"; then
  echo "  ✋ nessun blocco `org` in config: lancia prima enable-org-discovery.sh" >&2
  exit 1
else
  BACKUP="$HOME/dadaguard-services-yaml.backup.$(date +%Y%m%d%H%M%S)"
  cp "$TMP/cfg.yaml" "$BACKUP"
  chmod 600 "$BACKUP"
  echo "  copia della config precedente in $BACKUP"
  # Riga aggiunta DENTRO il blocco org (due spazi di rientro), subito dopo la sua intestazione.
  awk '/^org:$/ { print; print "  selfUsesRole: true # nel payer il ruolo read-only esiste: assumilo invece di usare le creds del task"; next } { print }' \
    "$TMP/cfg.yaml" >"$TMP/cfg.new.yaml"
  mv "$TMP/cfg.new.yaml" "$TMP/cfg.yaml"
  payer ssm put-parameter --region "$REGION" --name "$P_CFG" --type SecureString \
    --value "file://$TMP/cfg.yaml" --overwrite >/dev/null
  echo "  aggiunto"
  RESTART=1
fi

if [ "$RESTART" = "1" ]; then
  step "riavvio"
  payer ecs update-service --region "$REGION" --cluster "$CLUSTER" --service "$SERVICE" --force-new-deployment >/dev/null
  payer ecs wait services-stable --region "$REGION" --cluster "$CLUSTER" --services "$SERVICE"
  echo "  stabile"
fi

step "4. verifica: le letture falliscono ancora?"
echo "  (attendo un giro di scoperta)"
sleep 60
FAILS=$(payer logs filter-log-events --region "$REGION" --log-group-name /ecs/dadaguard \
  --start-time "$((($(date +%s) - 120) * 1000))" --filter-pattern '"letture non riuscite"' \
  --query 'length(events)' --output text 2>/dev/null || echo "?")
if [ "$FAILS" = "0" ]; then
  echo "  ✅ nessuna lettura fallita nell'ultimo minuto"
else
  echo "  ⚠️  ancora $FAILS letture fallite — leggi il dettaglio:"
  payer logs filter-log-events --region "$REGION" --log-group-name /ecs/dadaguard \
    --start-time "$((($(date +%s) - 120) * 1000))" --filter-pattern '"letture non riuscite"' \
    --query 'events[-1].message' --output text 2>/dev/null | head -c 600
  echo
fi
payer logs filter-log-events --region "$REGION" --log-group-name /ecs/dadaguard \
  --start-time "$((($(date +%s) - 300) * 1000))" --filter-pattern '"auto-discovery"' \
  --query 'events[-1].message' --output text 2>/dev/null | head -c 300
echo
