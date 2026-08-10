#!/usr/bin/env bash
# Passa Dadaguard dall'elenco a mano degli account alla SCOPERTA via AWS Organizations, in due passi
# nell'ordine giusto:
#
#   1. crea il ruolo read-only nell'account Security (layer già mergiato, si applica a mano perché
#      `live/security` non è coperto dalla pipeline CodeBuild). Prima, non dopo: altrimenti nel
#      frattempo quell'account compare con un errore di AssumeRole.
#   2. aggiunge il blocco `org` alla config in SSM e riavvia il task perché la rilegga.
#
# Idempotente: ogni passo controlla se è già fatto. Non stampa MAI un valore segreto.
# Reversibile: il passo 2 salva la config precedente in un file locale, e la si rimette con
#   aws ssm put-parameter --name /dadaguard/services-yaml --type SecureString --overwrite --value file://<backup>
#
# Prerequisiti:  aws sso login --profile security   (e production, management)
set -euo pipefail

REGION=eu-central-1
CLUSTER=${DADAGUARD_ECS_CLUSTER:-dadaguard}
SERVICE=dadaguard
P_CFG=/dadaguard/services-yaml
LAYER="${DADAGUARD_IAC_DIR:-$HOME/iac}/live/security/dadaguard-readonly"

TMP=$(mktemp -d)
chmod 700 "$TMP"
trap 'rm -rf "$TMP"' EXIT
payer() { env $(aws configure export-credentials --profile management --format env-no-export) aws "$@"; }
step() { printf '\n\033[1m▸ %s\033[0m\n' "$1"; }

# --- 1. il ruolo in Security ---------------------------------------------------------------------
step "ruolo read-only nell'account Security"
if env $(aws configure export-credentials --profile security --format env-no-export) \
  aws iam get-role --role-name dadaguard-readonly >/dev/null 2>&1; then
  echo "  già presente, salto l'apply"
else
  # L'ExternalId non si scrive da nessuna parte: si legge dal ruolo GIÀ esistente in produzione, che
  # per definizione ha il valore giusto (deve combaciare con la config di Dadaguard).
  DADAGUARD_EXTERNAL_ID=$(
    env $(aws configure export-credentials --profile production --format env-no-export) \
      aws iam get-role --role-name dadaguard-readonly \
      --query 'Role.AssumeRolePolicyDocument.Statement[0].Condition.StringEquals."sts:ExternalId"' \
      --output text
  )
  export DADAGUARD_EXTERNAL_ID
  if [ -z "$DADAGUARD_EXTERNAL_ID" ] || [ "$DADAGUARD_EXTERNAL_ID" = "None" ]; then
    echo "  ExternalId non letto dal ruolo di produzione: mi fermo" >&2
    exit 1
  fi
  cd "$LAYER"
  export TG_NON_INTERACTIVE=true
  echo "  plan…"
  terragrunt plan -out="$TMP/dgsec.tfplan" >"$TMP/plan.log" 2>&1 || {
    tail -20 "$TMP/plan.log" >&2
    exit 1
  }
  # Guardrail: applica SOLO il plan letto e mergiato. Qualunque altra forma — un change, un destroy,
  # un numero diverso — significa che il mondo è cambiato sotto i piedi, e su un layer applicato a
  # mano è l'unica difesa che c'è.
  if grep -qE '3 to add, 0 to change, 0 to destroy' "$TMP/plan.log"; then
    echo "  plan atteso (3 add, 0 change, 0 destroy) → applico"
    terragrunt apply "$TMP/dgsec.tfplan" 2>&1 | tail -6
  else
    echo "  ✋ plan DIVERSO dall'atteso: non applico niente." >&2
    grep -E 'Plan:|No changes' "$TMP/plan.log" >&2 || tail -20 "$TMP/plan.log" >&2
    exit 2
  fi
fi

# --- 2. il blocco `org` nella config ------------------------------------------------------------
step "blocco org nella config in SSM"
payer ssm get-parameter --region "$REGION" --name "$P_CFG" --with-decryption \
  --query Parameter.Value --output text >"$TMP/cfg.yaml"
chmod 600 "$TMP/cfg.yaml"
BACKUP="$HOME/dadaguard-services-yaml.backup.$(date +%Y%m%d%H%M%S)"

if grep -q '^org:' "$TMP/cfg.yaml"; then
  echo "  già presente, non tocco la config"
  RESTART=0
else
  # L'ExternalId serve anche al blocco org (per assumere i ruoli nei membri) ed è GIÀ in questo file:
  # lo si riusa da qui, senza farlo passare da nessun'altra parte.
  EXT=$(grep -m1 -E '^[[:space:]]*externalId:' "$TMP/cfg.yaml" | sed -E 's/.*externalId:[[:space:]]*//' | tr -d '"' | tr -d "'")
  if [ -z "$EXT" ]; then
    echo "  nessun externalId nella config: mi fermo (il blocco org non potrebbe assumere i ruoli)" >&2
    exit 1
  fi
  cp "$TMP/cfg.yaml" "$BACKUP"
  chmod 600 "$BACKUP"
  echo "  copia della config precedente in $BACKUP"

  # Gli account restano dichiarati: la fusione è campo per campo e il dichiarato VINCE (v0.4.69), così
  # label, colore e `terraform.stateBucket` — che alimenta i segnali di drift — non si perdono.
  {
    echo ""
    echo "# --- Scoperta degli account via AWS Organizations ---"
    echo "# Aggiunto il $(date +%Y-%m-%d). Prima gli account erano solo quelli elencati sopra: il payer"
    echo "# (dove vive la spesa di Bedrock, Marketplace e CodeBuild) non si vedeva affatto, e un account"
    echo "# nuovo non sarebbe comparso finché nessuno lo aggiungeva a mano."
    echo "# Gli account dichiarati sopra restano e VINCONO campo per campo: la scoperta riempie solo ciò"
    echo "# che manca. L'account che ospita Dadaguard si riconosce da sé e usa le credenziali del task."
    echo "org:"
    echo "  region: $REGION"
    echo "  externalId: $EXT"
  } >>"$TMP/cfg.yaml"

  # `freeTierAccount` punta a una CHIAVE di account: con la scoperta il payer prende la chiave del suo
  # nome nell'organizzazione (es. `Acme` → `acme`). Se puntava a `management`, la vista Free Tier
  # cercherebbe un account che non esiste più con quel nome.
  if grep -qE '^freeTierAccount:[[:space:]]*management[[:space:]]*$' "$TMP/cfg.yaml"; then
    # La chiave dell'account payer diventa il nome che l'organizzazione gli dà, minuscolo: si legge da
    # AWS invece di scriverlo qui, così lo script vale per chiunque e non nomina nessuna azienda.
    PAYER_ID=$(payer sts get-caller-identity --query Account --output text)
    PAYER_KEY=$(payer organizations describe-account --account-id "$PAYER_ID" \
      --query 'Account.Name' --output text | tr '[:upper:] ' '[:lower:]-')
    sed -i '' -E "s/^freeTierAccount:[[:space:]]*management[[:space:]]*$/freeTierAccount: ${PAYER_KEY}/" "$TMP/cfg.yaml"
    echo "  freeTierAccount: management → ${PAYER_KEY} (la chiave cambia con la scoperta)"
  fi

  payer ssm put-parameter --region "$REGION" --name "$P_CFG" --type SecureString \
    --value "file://$TMP/cfg.yaml" --overwrite >/dev/null
  echo "  config aggiornata"
  RESTART=1
fi

# --- 3. riavvio + verifica ----------------------------------------------------------------------
# La config è iniettata come `secret`: si legge quando il task PARTE. Cambiarla non basta.
if [ "$RESTART" = "1" ]; then
  step "riavvio per rileggere la config"
  payer ecs update-service --region "$REGION" --cluster "$CLUSTER" --service "$SERVICE" --force-new-deployment >/dev/null
  payer ecs wait services-stable --region "$REGION" --cluster "$CLUSTER" --services "$SERVICE"
  echo "  stabile"
fi

step "quali account vede adesso"
sleep 20 # il primo giro di discovery parte all'avvio
payer logs filter-log-events --region "$REGION" --log-group-name /ecs/dadaguard \
  --start-time "$((($(date +%s) - 300) * 1000))" --filter-pattern '"auto-discovery"' \
  --query 'events[-1].message' --output text 2>/dev/null || echo "  (log non ancora disponibile: riprova tra un minuto)"

cat <<'NOTE'

Atteso: i tuoi account (es. Staging, Production, payer, Security).
Se Security compare con un errore di AssumeRole, il ruolo del passo 1 non è stato creato.
Per tornare indietro: rimetti in SSM il file di backup stampato sopra e rilancia un force-new-deployment.
NOTE
