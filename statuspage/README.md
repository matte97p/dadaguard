# Dadaguard status engine

The engine behind a public status page for the services Dadaguard watches, as a Cloudflare Worker.
The page itself, with its incidents, maintenance and history, lives on Atlassian Statuspage; this
Worker decides the state of each component and pushes it there.

It lives outside the infrastructure it describes: if your cloud goes down, the engine keeps running
and its external probe sees it.

- **Every minute** (cron trigger) the Worker probes the public URL of each component and reads
  `GET /api/public-status` from your Dadaguard instance, decides the state, pushes the changes to
  Statuspage and saves the state in KV.
- **Dadaguard** answers only with component ids and states, for the components you list under
  `statusPage` in its config. No service names, accounts or errors leave it. Put an Access
  application with a service-token-only policy in front of that path.
- **Incidents and maintenance** are opened by a person on Statuspage. A component that Statuspage
  shows as `under_maintenance` is never overwritten until the window closes; when it closes, the
  measured state is pushed again if the page shows `operational` on a component still down.
- **`/health`** is the only HTTP path: 503 when the last tick is older than 3 minutes, or when
  Statuspage has rejected the states for more than 5. Nobody visits this Worker, so point a
  watchdog at it: without one, a stuck cron leaves the vendor page on its last state. Every other
  path answers 404.

## How the state is decided

| Source | Effect |
|---|---|
| Probe | two failures in a row (5xx or no answer) = outage; answer slower than 5 s = degraded |
| Dadaguard | its state, from liveness, runtime and alarms only |

The worse of the two wins. With no source at all the component is `unknown`, and `unknown` is never
pushed: Statuspage keeps the last real state instead of an invented one.

## Configure

Components, as JSON (the id and an optional probe; names are set on Statuspage):

```json
[
  { "id": "web", "probe": "https://shop.example.com/" },
  { "id": "api", "probe": "https://api.example.com/health" },
  { "id": "jobs" }
]
```

In Dadaguard's config, the same ids mapped to the services that make them up:

```yaml
statusPage:
  web: [production/storefront]
  api: [production/api]
  jobs: [production/worker, production/scheduler]
```

Then map your component ids to the Statuspage component ids and add an API key:

```bash
export STATUSPAGE_ATLASSIAN_PAGE_ID=… STATUSPAGE_ATLASSIAN_COMPONENTS='{"web":"…","api":"…"}'
npx wrangler secret put ATLASSIAN_API_KEY --config statuspage/wrangler.generated.json
```

Every minute the Worker reads the components on Statuspage, then pushes only the ones the page
shows differently from the measured state: when the measured state changed, or when the page shows
`operational` while the Worker measures a problem (for example a maintenance that ended by setting a
component that is still down back to operational). Any other state set by a person on an incident
stays until the measured state changes. To silence a false alarm, open a maintenance: a green set by
hand on a component the Worker sees down is overwritten on the next tick. A failed call is retried
on the next tick.

## Deploy

1. Create a KV namespace and a proxied DNS record for the host that serves `/health`. Put the rest
   of the host behind a login if you like: the Worker serves nothing else.
2. Generate the wrangler config from environment variables (nothing installation-specific is in
   this repo):

   ```bash
   export CLOUDFLARE_ACCOUNT_ID=… STATUSPAGE_HOST=status-engine.example.com STATUSPAGE_ZONE=example.com \
     STATUSPAGE_KV_ID=… STATUSPAGE_COMPONENTS='[…]' STATUSPAGE_DADAGUARD_URL=https://dadaguard.example.com \
     STATUSPAGE_ATLASSIAN_PAGE_ID=… STATUSPAGE_ATLASSIAN_COMPONENTS='{…}'
   node statuspage/build-config.mjs > statuspage/wrangler.generated.json
   ```

3. Set the secrets once, then deploy:

   ```bash
   npx wrangler secret put DADAGUARD_CLIENT_ID --config statuspage/wrangler.generated.json
   npx wrangler secret put DADAGUARD_CLIENT_SECRET --config statuspage/wrangler.generated.json
   npx wrangler secret put ATLASSIAN_API_KEY --config statuspage/wrangler.generated.json
   npx wrangler deploy --config statuspage/wrangler.generated.json
   ```

Run the deploy from a private place (your machine, or a private repo's CI), not from the CI of a
public fork: Actions logs of a public repository are readable by anyone, and repository variables
(host, KV id, account id, components) are printed in clear in them. Only secrets are masked.

## Upgrading from the version with its own page

Older versions served the page themselves (`/`, `/api/status.json`, `/feed.xml`), kept a 90-day
history in KV and had an `/admin` page for incidents and maintenance. This version drops all of it:

- The first tick moves the history out of the `snap` key into `history-archive`, and nothing reads
  it after that. Incidents and maintenance written from `/admin` stay in the `items` key, also
  unread. An incident still open there no longer affects the state: reopen it on Statuspage.
- The variables `STATUSPAGE_SITE_NAME`, `STATUSPAGE_TZ`, `STATUSPAGE_ACCESS_TEAM_DOMAIN` and
  `STATUSPAGE_ACCESS_AUD` are ignored, and so are the names in `STATUSPAGE_COMPONENTS`. Remove the
  Access application you had in front of `/admin`.
- When you no longer need the old data, delete the two keys:

  ```bash
  npx wrangler kv key delete history-archive --namespace-id <KV id> --remote
  npx wrangler kv key delete items --namespace-id <KV id> --remote
  ```

## Cost

One KV write a minute for the state: about 45,000 writes a month, above the Workers free tier
(1,000 a day) and well inside the paid plan.
