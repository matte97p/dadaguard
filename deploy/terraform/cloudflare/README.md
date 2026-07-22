# Front-door di Dadaguard come codice (Cloudflare Access + DNS)

Dadaguard **non ha login proprio**: il login è **Cloudflare Access** davanti. Questo modulo mette in
Terraform i pezzi che altrimenti si fanno a click nella dashboard — e che qualcuno può aprire a
«everyone» per sbaglio, senza che nessuno se ne accorga:

1. **Access policy** — CHI può entrare (domini email / email del team)
2. **Access application** — su quale hostname si applica
3. **DNS** — pubblica l'hostname sul tunnel `cloudflared`

Template **generico**: nessun valore specifico dentro. Passa i tuoi via `terraform.tfvars`.

## Prerequisito una-tantum: il tunnel

Il tunnel `cloudflared` (e il suo **token** per il connettore) si crea una volta — dashboard
Zero Trust → *Networks → Tunnels*, o `cloudflared tunnel create`. Ti servono:

- il **tunnel id** → lo passi come `tunnel_id` (il DNS punterà a `<tunnel_id>.cfargotunnel.com`);
- il **token** → nel secret store del tuo hosting, per il connettore. Per la ricetta AWS/Fargate è il
  sidecar `cloudflared` in [`../`](../) (token da un SSM SecureString). Per docker-compose/VM vedi
  [`../../CLOUDFLARE_ZERO_TRUST.md`](../../CLOUDFLARE_ZERO_TRUST.md).

## Uso

```bash
cp terraform.tfvars.example terraform.tfvars   # compila account/zone/tunnel/team
export CLOUDFLARE_API_TOKEN=...                 # permessi: Access (Apps+Policies) + DNS edit sulla zona
terraform init
terraform plan     # rivedi CHI entra prima di applicare
terraform apply
```

Il guardiano anti-esposizione integrato ([`server/exposure.js`](../../../server/exposure.js)) ricava
l'URL pubblico **da solo** dall'header della richiesta (via Cloudflare) — niente var da impostare — e
sonda quell'hostname in continuo, segnando la dashboard **ROSSA** se Access non è più davanti
(regressione a «everyone» / tunnel rotto). L'output `public_url` qui è solo per reference.

## Note

- **Provider v5**: le risorse Zero Trust sono `cloudflare_zero_trust_*`; `self_hosted_domains`
  dell'application è calcolato da `destinations` (non dichiarare entrambi).
- **Guardrail**: se `allowed_email_domains` e `allowed_emails` sono entrambi vuoti, `terraform plan`
  fallisce di proposito (una policy che non ammette nessuno non protegge nulla di utile).
- **Cato**: le istanze reali di Cato vivono in `aws-management` (account privati, apply via CodeBuild).
  Questo modulo è il **template riusabile**; aws-management può consumarlo o rispecchiarlo.
