# Ricetta Terraform — Dadaguard su AWS Fargate

Deploy AWS-native di Dadaguard: un servizio ECS Fargate (container app + sidecar
`cloudflared`), dietro Cloudflare Tunnel + Access. Resta **read-only** e **senza LLM**.

> **Questa è la via avanzata.** Per provare Dadaguard, o per girare local-first,
> usa `docker compose up` (vedi il README principale). Questa ricetta serve a chi
> vuole hostarlo su AWS in modo riproducibile.

## Cosa crea
- Servizio ECS Fargate (2 container: `dadaguard` + `cloudflared`)
- Ruolo **execution** (pull immagine, log, lettura dei 2 secret SSM)
- Ruolo **task** (assume *solo* i ruoli `dadaguard-readonly` cross-account — nient'altro)
- Security group **solo egress** (nessuna porta pubblica) + log group CloudWatch

## Prerequisiti (NON creati da qui)
1. Una VPC con **subnet private + NAT** e un **cluster ECS** nell'account host.
2. Un **Cloudflare Tunnel** già creato → il suo **token**.
3. In **ogni account da monitorare**, il ruolo `dadaguard-readonly`
   (applica [`../dadaguard-readonly-role.example.tf`](../dadaguard-readonly-role.example.tf)).
4. Due **parametri SSM SecureString** nell'account host:
   - `…/config` → lo YAML di config (come [`../../services.example.yaml`](../../services.example.yaml), con `roleArn` + `externalId` per account)
   - `…/tunnel-token` → il token del Tunnel

## Uso
```bash
cd deploy/terraform
cp terraform.tfvars.example terraform.tfvars   # compila con i tuoi ARN/ID
terraform init
terraform plan
terraform apply
```

Dopo l'apply, in **ogni account target** restringi la trust del ruolo
`dadaguard-readonly` dall'account-root al `task_role_arn` in output (passalo come
`dadaguard_task_role_arn`), così solo questo task può assumerlo.

## Aggiornare la versione
Qui Terraform possiede anche i deploy: cambia `image` nel tfvars e `terraform apply`
rilascia la nuova revision. Se invece hai un CI che aggiorna le task definition,
scommenta `ignore_changes = [task_definition]` in [`main.tf`](main.tf) così Terraform
non sovrascrive i deploy applicativi.

## Sicurezza
Stesso modello del ruolo read-only ([`../README.md`](../README.md)): read-only by
design, **ExternalId** anti confused-deputy, secret **per nome mai valore**, niente
porte pubbliche (ingresso solo via Tunnel + Access).
