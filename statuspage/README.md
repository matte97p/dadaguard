# Dadaguard status page

A public status page for the services Dadaguard watches, as a Cloudflare Worker.

It lives outside the infrastructure it describes: if your cloud goes down, the page stays up and
turns red thanks to its external probe.

- **Every minute** (cron trigger) the Worker probes the public URL of each component and reads
  `GET /api/public-status` from your Dadaguard instance, then stores state and a 90-day history in
  KV.
- **Dadaguard** answers only with component ids and states, for the components you list under
  `statusPage` in its config. No service names, accounts or errors leave it. Put an Access
  application with a service-token-only policy in front of that path.
- **Incidents and maintenance** are written by a person at `/admin`. Put an Access application
  with your identity provider in front of `/admin`; the Worker also verifies the Access token
  itself (`ACCESS_TEAM_DOMAIN`, `ACCESS_AUD`), so `/admin` stays closed if Access is removed by
  mistake.
- **Pages**: `/` (the status page, Italian and English), `/api/status.json`, `/feed.xml`
  (`?lang=en`), `/health`.

## How the state is decided

| Source | Effect |
|---|---|
| Probe | two failures in a row (5xx or no answer) = outage; answer slower than 5 s = degraded |
| Dadaguard | its state, from liveness, runtime and alarms only |
| Open incident | its impact (degraded or outage) |

The worst of the three wins. With no source at all the component is `unknown`, never green.
Degraded minutes count as available in the uptime percentage; unknown minutes don't count.

## Configure

Components, as JSON (names shown on the page, optional probe):

```json
[
  { "id": "web", "it": "Vetrina", "en": "Storefront", "probe": "https://shop.example.com/" },
  { "id": "api", "it": "API", "en": "API", "probe": "https://api.example.com/health" },
  { "id": "jobs", "it": "Elaborazioni", "en": "Background jobs" }
]
```

In Dadaguard's config, the same ids mapped to the services that make them up:

```yaml
statusPage:
  web: [production/storefront]
  api: [production/api]
  jobs: [production/worker, production/scheduler]
```

## Deploy

1. Create a KV namespace and a proxied DNS record for the host.
2. Generate the wrangler config from environment variables (nothing installation-specific is in
   this repo):

   ```bash
   export CLOUDFLARE_ACCOUNT_ID=… STATUSPAGE_HOST=status.example.com STATUSPAGE_ZONE=example.com \
     STATUSPAGE_KV_ID=… STATUSPAGE_COMPONENTS='[…]' STATUSPAGE_SITE_NAME=Example \
     STATUSPAGE_TZ=Europe/Rome STATUSPAGE_DADAGUARD_URL=https://dadaguard.example.com \
     STATUSPAGE_ACCESS_TEAM_DOMAIN=example.cloudflareaccess.com STATUSPAGE_ACCESS_AUD=…
   node statuspage/build-config.mjs > statuspage/wrangler.generated.json
   ```

3. Set the two secrets once, then deploy:

   ```bash
   npx wrangler secret put DADAGUARD_CLIENT_ID --config statuspage/wrangler.generated.json
   npx wrangler secret put DADAGUARD_CLIENT_SECRET --config statuspage/wrangler.generated.json
   npx wrangler deploy --config statuspage/wrangler.generated.json
   ```

Run the deploy from a private place (your machine, or a private repo's CI), not from the CI of a
public fork: Actions logs of a public repository are readable by anyone, and repository variables
(host, KV id, account id, components) are printed in clear in them. Only secrets are masked.

## Cost

One KV write a minute for the state, plus one per admin action: about 45,000 writes a month,
above the Workers free tier (1,000 a day) and well inside the paid plan.
