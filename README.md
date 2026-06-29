# Dadaguard 🐶

Watchdog DevOps **local-first**: *il mio stack è su **e coerente**?* Correla lo stato reale di **AWS + secret + Terraform** — **senza LLM**, 100% deterministico.

Un uptime monitor ti dice se un endpoint risponde `200`. Dadaguard va oltre: la versione deployata è quella attesa? il runtime reale (task *running* vs *desired*) è a posto? i secret che il servizio usa esistono? lo stato combacia con Terraform? Un servizio "verde" altrove qui può diventare **giallo**.

## Segnali
- **Liveness** + latenza
- **Versione** deployata vs attesa
- **Runtime** AWS reale: ECS · ASG · Lambda (con dead-man switch per le cron) · RDS/Aurora · ALB · EC2
- **Secret** presenti (SSM / Doppler) — solo per **nome**, mai i valori
- **Drift** vs Terraform: leggero (state ↔ AWS) e completo (`terragrunt plan`, on-demand)
- **Risorse non gestite** da Terraform
- **Sprechi** (EIP / NAT / EBS orfani) + **Costi** per servizio (AWS Cost Explorer)
- **Topologia** dei servizi per ambiente e tipo

## Principi
- **No LLM** — deterministico: niente costi, latenza o non-determinismo.
- **Read-only sull'infra** — non crea/modifica/distrugge nulla; l'infrastruttura si cambia **solo** via Terraform.
- **Fetch-on-load, zero storage** — la config (`services.yaml`) è riletta a ogni richiesta.

## Uso locale
```bash
cp services.example.yaml services.yaml   # adatta ai tuoi account e servizi
npm install --legacy-peer-deps
npm run dev                              # → http://localhost:5173
```
Auth AWS in locale: profilo SSO/CLI (campo `profile:` per account in `services.yaml`).

## Deploy in cloud (self-hosted)
Vedi [`deploy/README.md`](deploy/README.md): immagine unica su **ECS Fargate**, dietro **Cloudflare Access** (Zero Trust, zero porte pubbliche), auth AWS via **AssumeRole read-only cross-account** (niente chiavi). In cloud la config arriva da env (SSM), non da file.

## Architettura
- `server/` — Express. `GET /api/status` rilegge `services.yaml` ed esegue i check in parallelo (`server/checks/`). Aggiungere un segnale = un file in `checks/` + una riga in `server/status.js`.
- `web/` — React + Ant Design. Una card per servizio; il semaforo è il check messo peggio.
- In cloud Express serve anche il frontend buildato (`dist/`) sulla stessa porta.

## Licenza
[MIT](LICENSE) © 2026 Matteo Perino
