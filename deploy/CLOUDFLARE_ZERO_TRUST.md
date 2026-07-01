# Cloudflare Zero Trust — esporre Dadaguard senza porte pubbliche

Dadaguard resta **read-only** e **no-LLM**, ma la dashboard mostra la tua infra AWS
reale: non va su Internet in chiaro. Questa guida la mette dietro un **Cloudflare
Tunnel** (l'unico ingresso) + **Cloudflare Access** (il login del team). Nessuna
porta aperta, nessun IP pubblico.

> **Dadaguard non ha autenticazione propria.** Il tunnel *pubblica* la dashboard;
> è **Access** che ci mette davanti il login. Un tunnel senza Access = dashboard
> esposta a chiunque abbia l'URL. I due pezzi vanno **entrambi**.

```
browser (team) ──TLS──▶ Cloudflare Access (login SSO) ──▶ Tunnel ──▶ Dadaguard (localhost:3001)
```

Vale per qualunque hosting (docker compose, VM, PaaS, ECS Fargate): cambia solo
*dove gira il connettore `cloudflared`*. Per la ricetta Fargate completa vedi
[`terraform/`](terraform/) — questa guida copre la parte Cloudflare, che quella dà
per scontata.

---

## Prerequisito che decide tutto: l'account

Un **tunnel vive in un solo account Cloudflare**, e le sue route possono puntare
**solo a zone (domini) di quello stesso account**. Quindi:

> Crea il tunnel **nell'account Cloudflare che possiede il dominio** con cui vuoi
> pubblicare Dadaguard. Se il dominio è su un altro account, il tunnel di questo
> non potrà esporlo — servirebbe un tunnel nell'account giusto.

Serve anche che su quell'account **Zero Trust sia inizializzato** (ha un *team
domain* tipo `iltuoteam.cloudflareaccess.com`; la prima Access application te lo
fa creare).

---

## 1. Crea il tunnel

Zero Trust → **Networks → Tunnels → Create a tunnel** → tipo **Cloudflared** →
dagli un nome (`dadaguard`) → **copia il token**.

> ⚠️ Il token è un **segreto**: dà accesso all'account. Non committarlo, non
> incollarlo in chat/log/issue. Va in un secret store (per Fargate: un SSM
> SecureString iniettato come `TUNNEL_TOKEN` — vedi la ricetta terraform).

Il wizard mostra `cloudflared service install <token>` e resta in *"Waiting for
your Tunnel to connect…"* con **Continue disabilitato**: è normale. Si sblocca solo
quando un connettore si collega (passo 2). Ti serve solo la stringa del token, non
lanciare quel comando se il connettore girerà altrove (es. Fargate).

## 2. Collega il connettore (`cloudflared`)

Il connettore è ciò che tiene aperto il tunnel dal lato dove gira Dadaguard.

- **docker compose / VM** — aggiungi accanto a Dadaguard:
  ```yaml
  cloudflared:
    image: cloudflare/cloudflared:latest
    command: tunnel --no-autoupdate run
    environment:
      - TUNNEL_TOKEN=${TUNNEL_TOKEN}   # dal tuo .env, non hardcodato
    restart: unless-stopped
  ```
  Con il service dadaguard che ascolta su `3001`, la route punterà a
  `http://dadaguard:3001` (nome del service nella rete compose).

- **ECS Fargate** — il connettore è un **sidecar** nella stessa task definition,
  col token da SSM. Un gotcha specifico di Fargate:
  ```
  TUNNEL_TRANSPORT_PROTOCOL=http2
  ```
  i buffer UDP limitati di Fargate rendono QUIC inaffidabile (connessione su ma
  data-plane che non instrada → 502 sull'edge). Forza HTTP/2. La route punta a
  `http://localhost:3001` (stesso task, `localhost`).

Quando il connettore parte e si registra, nella tab **Overview** del tunnel lo
stato diventa **Healthy** e il Continue del wizard si sblocca.

## 3. Aggiungi la route (public hostname)

Tunnel → **Configure → Public Hostname** (console classica) oppure **Routes → Add
route** (console nuova) → aggiungi:

| Campo | Valore |
|---|---|
| Subdomain / hostname | `dadaguard` |
| Domain | `example.com` |
| Type / Service | **HTTP** → `localhost:3001` (o `dadaguard:3001` in compose) |

> **Le due console usano parole diverse per la stessa cosa.** Nuova UI: *Route →
> "Published application"*. Classica: *Public Hostname → Type HTTP*. Identiche.

Salvando, Cloudflare crea nella zona un **record DNS di tipo "Tunnel"** (proxied,
nuvola arancione) — l'equivalente di un CNAME verso `<tunnel-id>.cfargotunnel.com`.
Se **non** compare da solo, aggiungilo a mano in DNS → Records: `CNAME` `dadaguard`
→ `<tunnel-id>.cfargotunnel.com`, **Proxied**. (`<tunnel-id>` è nell'URL del tunnel.)
Se esiste già un record `dadaguard` verso un tunnel vecchio, **correggi quello**,
non crearne un secondo.

## 4. Metti Access davanti (obbligatorio)

Zero Trust → **Access → Applications → Add an application → Self-hosted**:

1. **Application name**: `Dadaguard`
2. **Public hostname**: `dadaguard` . `example.com` (path vuoto)
3. **Add policy** → Action **Allow** → Include → **Emails ending in** `@example.com`
   (o email/gruppi specifici)
4. Salva.

Se è la **prima** Access app dell'account, ti fa confermare il **team domain**.
Serve almeno un **Identity Provider** (Zero Trust → Settings → Authentication): se
non hai SSO, lascia il **One-time PIN** — login via codice email, funziona subito,
e la policy limita comunque chi entra.

## 5. Verifica

```bash
curl -sSI https://dadaguard.example.com/ | grep -iE '^HTTP|^location'
```

- ✅ Atteso: **redirect** (`302`/`location:`) verso `*.cloudflareaccess.com` — Access
  è attiva.
- ❌ **`HTTP 200` secco** senza redirect: Access **non** è davanti → la dashboard è
  esposta. Torna al passo 4.

**Gotcha DNS — "a me dà NXDOMAIN ma ad altri no".** È cache negativa **locale**:
avevi aperto il nome *prima* che il record esistesse e il tuo resolver si è tenuto
il "non esiste". Il record è comunque vivo (verifica con
`curl -H 'accept: application/dns-json' 'https://1.1.1.1/dns-query?name=dadaguard.example.com&type=A'`
→ `Status: 0`). Per sbloccarti: svuota la cache DNS del SO (`ipconfig /flushdns` su
Windows) **e** del browser (`chrome://net-internals/#dns`), oppure prova da un'altra
rete (es. hotspot mobile). Il negative-cache dura al massimo il *minimum* del SOA
della zona (spesso ~30 min).

---

## Spostare o ruotare (cambio dominio/account, token esposto)

Il dominio e le route **non** stanno in Terraform: vivono in Cloudflare. Per
spostare Dadaguard su un altro dominio/account: crea un **nuovo tunnel nell'account
giusto**, aggiorna il `TUNNEL_TOKEN` nel secret store, riavvia il connettore
(`cloudflared`), rifai route + Access sul nuovo dominio, poi **elimina il vecchio
tunnel** — eliminarlo invalida il vecchio token (utile anche se il token è stato
esposto per errore).
