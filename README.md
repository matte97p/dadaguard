# Dadaguard 🐶

> *il watchdog del tuo stack*

Dashboard **local-first** che risponde a una sola domanda: *"il mio stack è su **e coerente**?"*,
correlando **AWS + Doppler + Terraform**. Read-only, fetch-on-load, zero storage.

> **Stato: scheletro verticale.** Per ora un solo segnale — **liveness** (#1).
> I prossimi (runtime AWS, versione attesa, secret Doppler) si agganciano uno alla volta.

## Avvio (dev)

```bash
npm install
aws sso login --sso-session ops-ro   # rinnova il token SSO (vale per tutti i profili)
npm run dev                          # i profili AWS arrivano da services.yaml (staging-ro / production-ro)
```

- Frontend → http://localhost:5173
- API → http://localhost:3001/api/status  (porta cambiabile: `PORT=4000 npm run dev` sposta backend **e** proxy insieme)

Solo backend (senza UI): `npm run server`, poi `curl localhost:3001/api/status`.

## Config

Modifica `services.yaml`: un servizio = una entry. Per ora basta `healthUrl`.
Il file viene **riletto a ogni fetch** — nessuno stato, nessun riavvio.

## Architettura

- `server/` — Express sottile. `GET /api/status` ricarica `services.yaml` ed esegue i
  check in parallelo (`server/checks/`). **Aggiungere un segnale = un file in `checks/`
  + una riga in `server/status.js`.**
- `web/` — React + Ant Design. Una card per servizio, semaforo = peggiore dei check.

Niente DB, niente processo always-on: apri → fetch → mostra → chiudi.
