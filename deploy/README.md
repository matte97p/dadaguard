# Fase Cloud — deploy self-hostato

Dadaguard nasce local-first, ma la stessa immagine gira in cloud per un team.
Resta **read-only** (non tocca mai l'infra — quella si cambia solo via Terraform) e
**senza LLM** (100% deterministico). In cloud cambia solo *come si autentica ad AWS*:
niente profili SSO, ma un **task role** che assume un ruolo read-only in ogni account.

```
                          ┌──────────────────────────┐
   browser (team) ──TLS──▶│  Cloudflare Access (ZT)  │  SSO, niente porte pubbliche
                          └────────────┬─────────────┘
                                       │  Tunnel (cloudflared)
                          ┌────────────▼─────────────┐
                          │  Dadaguard — ECS Fargate │  container unico:
                          │  Express → dist/ + /api  │  zero storage, fetch-on-load
                          └────────────┬─────────────┘
                                       │  task role
                                       │  sts:AssumeRole  (+ ExternalId)
              ┌────────────────────────┼────────────────────────┐
              ▼                        ▼                         ▼
     ┌─────────────────┐      ┌─────────────────┐       ┌─────────────────┐
     │ account staging │      │  account prod   │       │  account N ...  │
     │ dadaguard-      │      │ dadaguard-      │       │ dadaguard-      │
     │  readonly role  │      │  readonly role  │       │  readonly role  │
     └─────────────────┘      └─────────────────┘       └─────────────────┘
```

## Modello di sicurezza

- **Read-only by design** — il ruolo assunto ha solo `Describe*`/`Get*`/`List*`.
  Dadaguard non può mutare nulla: nessuna API di scrittura nella policy.
- **ExternalId** — contro il *confused-deputy*: chi indovina il `roleArn` non può
  assumerlo senza la stringa condivisa (in `services.yaml` e nella trust policy).
- **Secret per NOME, mai valore** — la policy concede `ssm:GetParametersByPath` ma
  **non** `kms:Decrypt`: Dadaguard legge i nomi dei parametri, mai i valori in chiaro.
- **Niente chiavi custodite** — il task role è dell'account host; assume i ruoli
  cross-account con credenziali temporanee (STS).
- **Niente porte pubbliche** — Cloudflare Tunnel + Access: l'app non è esposta su
  Internet, l'accesso passa dall'SSO del team.

## Step

1. **In ogni account target** crea il ruolo `dadaguard-readonly`
   (vedi [`dadaguard-readonly-role.example.tf`](dadaguard-readonly-role.example.tf)),
   con trust verso il task role host + `ExternalId`.
2. **Nell'account host** builda e deploya il container su ECS Fargate
   (`docker build -t dadaguard .`). Il task role deve poter fare `sts:AssumeRole`
   sui `dadaguard-readonly` di ogni account.
3. **Config via env** — in cloud Dadaguard legge `DADAGUARD_CONFIG` (lo YAML di
   `services.yaml`, iniettato da un SSM SecureString): niente file/storage. Per ogni
   account usa `roleArn` + `externalId` invece di `profile` (vedi `services.example.yaml`).
   In cloud il config si versiona in SSM/TF, non si edita dalla dashboard.
4. **Cloudflare**: sidecar `cloudflared` (Tunnel) + un'Access application che
   limita l'ingresso al team.

## Build & run locale del container

```bash
docker build -t dadaguard .
docker run -p 3001:3001 -v "$PWD/services.yaml:/app/services.yaml:ro" dadaguard
# → http://localhost:3001  (frontend + API sulla stessa porta)
```

In locale puoi ancora montare `~/.aws` e usare `profile`; in cloud usa `roleArn`.
