<p align="center">
  <img src="assets/logo.png" alt="Dadaguard" width="120">
</p>

<h1 align="center">Dadaguard</h1>

<p align="center">
  Il tuo <code>200&nbsp;OK</code> mente. Dadaguard diventa <b>giallo</b> quando un servizio è <b>su</b> ma non <b>coerente</b> —<br>
  versione, runtime, secret, Terraform. Watchdog DevOps · local-first · read-only · <b>no-LLM</b>.
</p>

<p align="center">
  <img src="https://img.shields.io/github/v/release/matte97p/dadaguard?color=7c3aed" alt="release">
  <img src="https://img.shields.io/badge/license-MIT-blue" alt="MIT">
  <a href="https://github.com/matte97p/dadaguard/pkgs/container/dadaguard"><img src="https://img.shields.io/badge/ghcr.io-dadaguard-2496ED?logo=docker&logoColor=white" alt="container image"></a>
  <a href="https://hub.docker.com/r/matte97/dadaguard"><img src="https://img.shields.io/docker/pulls/matte97/dadaguard?logo=docker&label=pulls&color=2496ED" alt="Docker pulls"></a>
  <a href="https://github.com/matte97p/dadaguard/stargazers"><img src="https://img.shields.io/github/stars/matte97p/dadaguard?style=social" alt="stars"></a>
</p>

<p align="center">
  <img src="assets/demo.gif" alt="Dadaguard in azione" width="760"><br>
  <sub><a href="assets/demo.mp4">▶ video completo</a> · girato con <a href="https://github.com/matte97p/demowright">demowright</a></sub>
</p>

**Provalo in 10 secondi, senza AWS** — immagine pubblica, dati finti, zero config:
```bash
docker run -p 3001:3001 -e DADAGUARD_DEMO=1 ghcr.io/matte97p/dadaguard:latest
# → http://localhost:3001
```

Un uptime monitor ti dice se un endpoint risponde `200`. Dadaguard va oltre: la versione deployata è quella attesa? il runtime reale (task *running* vs *desired*) è a posto? i secret che il servizio usa esistono? lo stato combacia con Terraform? Un servizio "verde" altrove qui può diventare **giallo**.

## Segnali
- **Liveness** + latenza
- **Versione** deployata vs attesa
- **Runtime** AWS reale: ECS · ASG · Lambda (con dead-man switch per le cron) · RDS/Aurora · ALB · EC2
- **Secret** presenti (SSM / Doppler) — solo per **nome**, mai i valori
- **Drift** vs Terraform: leggero (state ↔ AWS) e completo (`terragrunt plan`, on-demand)
- **Risorse non gestite** da Terraform
- **Sprechi** (EIP / NAT / EBS orfani) + **Costi** per servizio (AWS Cost Explorer)
- **Topologia** delle dipendenze tra servizi, **dedotta da AWS** (env Lambda · event source · security group) — niente da dichiarare a mano

## Principi
- **No LLM** — deterministico: niente costi, latenza o non-determinismo.
- **Read-only sull'infra** — non crea/modifica/distrugge nulla; l'infrastruttura si cambia **solo** via Terraform.
- **Fetch-on-load, zero storage** — la config (`services.yaml`) è riletta a ogni richiesta.

## Uso locale
```bash
npm install --legacy-peer-deps
npm run dev                              # → http://localhost:5173
```
Auth AWS in locale: profilo SSO/CLI o credenziali di default dell'ambiente. **`services.yaml` è opzionale**: senza, Dadaguard **auto-scopre** i servizi che girano nell'account (read-only). Copialo (`cp services.example.yaml services.yaml`) solo per *fissare* watchlist, versioni attese, account multipli e Terraform.

**Provalo senza AWS** — dati finti, zero credenziali:
```bash
DADAGUARD_DEMO=1 npm run dev
```

In modalità local-first `services.yaml` è anche **editabile dalla dashboard** (aggiungere/togliere servizi dalla watchlist riscrive il file). In cloud la config è read-only e arriva da SSM.

## Deploy
**Self-host in un comando** — gira ovunque (VM, NAS, mini-PC, PaaS), UI in italiano e inglese:
```bash
cp services.example.yaml services.yaml   # cosa monitorare + account
cp .env.example .env                      # accesso AWS read-only (profilo o chiavi)
docker compose up -d                      # → http://localhost:3001
```
In alternativa al build locale c'è l'**immagine pubblicata**: togli il commento `image:` nel compose, o `docker run -p 3001:3001 -v $PWD/services.yaml:/app/services.yaml -v $HOME/.aws:/root/.aws:ro ghcr.io/matte97p/dadaguard:latest`.

Accesso AWS, a scelta: profili `~/.aws` (montati) + `AWS_PROFILE`, chiavi in `.env`, o il ruolo dell'istanza se giri dentro AWS (EC2/ECS). Cross-account: gli account in `services.yaml` usano `roleArn` (AssumeRole). Read-only by design: zero scritture sull'infra.

Ogni account monitorato concede a Dadaguard un ruolo IAM di sola lettura — [esempio Terraform](deploy/dadaguard-readonly-role.example.tf) o la stessa [policy in JSON](deploy/dadaguard-readonly-policy.json) se non usi Terraform (niente `kms:Decrypt`: i valori dei secret restano inaccessibili).

### Hosting su AWS Fargate (avanzato, opzionale)
Fargate dietro **Cloudflare Access** (Zero Trust, zero porte pubbliche), con la config iniettata da SSM: vedi [`deploy/README.md`](deploy/README.md). È una delle ricette di hosting possibili — per la maggior parte dei casi `docker compose` basta.

## CLI & metriche
Oltre alla dashboard, due interfacce per il flusso DevOps (read-only, on-demand):
```bash
npm run check                 # esegue tutti i check; exit ≠0 se un servizio è giù
npm run check -- --json       # output machine-readable
npm run check -- --fail-on degraded   # soglia più severa (gating di pipeline)
```
- **`/metrics`** — formato Prometheus (severità per servizio/check + latenza + running/desired): aggancialo a Grafana/Alertmanager per dashboard, alert e storico, senza che Dadaguard diventi un servizio stateful.
- **`/healthz`** — liveness dell'app (non chiama AWS).

## Architettura
- `server/` — Express. `GET /api/status` rilegge `services.yaml` ed esegue i check in parallelo (`server/checks/`). Aggiungere un segnale = un file in `checks/` + una riga in `server/status.js`.
- `web/` — React + Ant Design. Una card per servizio; il semaforo è il check messo peggio.
- In cloud Express serve anche il frontend buildato (`dist/`) sulla stessa porta.

## Licenza
[MIT](LICENSE) © 2026 Matteo Perino


---

<sub>🌐 Built by **Matteo Perino** — [matteoperino.dev](https://matteoperino.dev)</sub>
