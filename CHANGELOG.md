# Changelog

All notable changes to Dadaguard are documented here. Format based on
[Keep a Changelog](https://keepachangelog.com/), versioning follows [SemVer](https://semver.org/).

## [Unreleased]

### Added
- **Security page** — a new **Security** page: security & governance findings aggregated in one list,
  filterable by category and sorted by severity. Categories: **public surface** (SGs open to
  `0.0.0.0/0` on sensitive ports, RDS `publicly accessible`, internet-facing ALBs, S3 without a
  complete Public Access Block), **expiring** (ACM certs within 30 days), **IAM hygiene** (policies
  with `Action`/`Resource` `"*"`, IAM users without MFA, access keys not rotated in 90+ days), and
  **stale secrets** (Secrets Manager not rotated in 90+ days — metadata only, never the value).
  Read-only, best-effort. New read-only permissions: `acm:ListCertificates`/`DescribeCertificate`,
  `iam:ListUsers`/`ListAccessKeys`/`ListMFADevices`, `secretsmanager:ListSecrets`. Relevant findings
  **link into the IAM page**: a too-broad policy → its "by policy" view; an exposed resource or a stale
  secret → the "by resource" view ("who can reach it").
- **IAM explorer** — a new **IAM** page with up to three lenses, each shown only when it applies to the
  account (no empty tabs): "by policy" appears only if there are customer-managed policies, "SSO access"
  only if an Identity Center instance exists. **By policy**: pick a customer-managed policy
  and see who uses it (roles/users/groups) and what it grants (actions by service + resource ARNs).
  **By resource**: pick a service and see who can reach it — unified across **both** IAM policies
  (roles/services) *and* SSO permission sets (people/groups via their inline policy), so "who can reach
  the prod DB?" is answered no matter how access is granted. **SSO access**: the *real* human access via Identity Center —
  permission set → people/groups → account (with SSO there are no IAM users/groups to look at, so the
  first two lenses show empty user/group columns; this one shows how access actually works — groups are expanded to their members, so you see who's actually inside). Read-only,
  no secret values are ever read. New read-only permissions: `iam:ListPolicies`/`ListEntitiesForPolicy`,
  and — for the SSO lens, on the account hosting Identity Center — `sso:List*`/`DescribePermissionSet`
  + `identitystore:DescribeUser`/`DescribeGroup`/`ListGroupMemberships`.
- **Topology, upgraded** — the dependency view is now **its own page**, auto-laid-out with dagre, and
  infers far more than before. `env` references are read from **ECS task definitions** too (not only
  Lambda) — so an ECS/Fargate stack finally shows its wiring; plus new sources: **Step Functions**
  (resources a state machine orchestrates → `flow` edges), **Application Load Balancers** (the ECS/EC2
  services behind each target group → `lb` edges), and **IAM role policies** (the resources a service's
  role can reach → `iam` edges — the strongest signal when connection strings live in Secrets Manager,
  so the DB/queues stop looking isolated; reuses the `iam:*` read grants the security check already
  needs). Demo mode now ships a fully-wired sample graph, so the feature is visible with no AWS
  connection. New read-only permission: `states:DescribeStateMachine` (the Terraform role modules
  already granted it; only the JSON policy example was missing it).
- **Multi-page navigation** — Dadaguard is no longer one page with pop-out panels: Dashboard, Costs,
  Waste, Topology and Quotas are now real pages with their own URLs (react-router; deep links and the
  browser Back button work). The filter bar lives **on every page** and its state persists as you move
  between them — Dashboard and Topology get the full bar, the per-account pages (Costs/Waste/Quotas)
  show just Account + Region. Drift, Discover and Meta-health stay as pop-up panels opened from the header.
- **Log window selector** — the recent-logs drawer now offers 1h / 6h / 24h (was fixed at 1h); the
  backend already accepted `?minutes=`. The snapshot cap (~100 lines per call) still applies.
- **Cost month selector** — the Costs drawer can pick the reference month (last 12 months), not just
  the current MTD; the backend takes `?month=YYYY-MM` (defaults to the current month).
- **Cron auto-detection** — discovered Lambdas get their schedule inferred from EventBridge Rules, so
  cron functions are recognised as such: the card shows a ⏰ cadence badge and the **dead-man switch**
  fires when a cron misses its expected window (instead of showing it as idle). New read-only
  permissions: `events:ListRules`, `events:ListTargetsByRule`.
- **Rich, global filters** — the dashboard bar now filters by name search, account, type, status
  (multi), region, cron/on-demand, and Terraform-managed, plus a "problems only" toggle and a clear
  button. Filters apply **everywhere**: cards, Topology (its duplicate account selector is gone), and
  the aggregate drawers (Costs/Waste/Quotas/Meta-health) narrow to the accounts still visible.
- **Filter presets** — save, recall and delete named filter combinations (localStorage).
- **Compact filter bar + decluttered topology** — the filter bar is one compact icon row; the Topology
  dependency view graphs only connected services (auto-laid out top-down with dagre, orthogonal
  `smoothstep` edges — no more overlapping nodes or crossing curves) and lists the isolated ones
  (e.g. crons) in a side panel.
- **Discovered services fully wired** — logs/events/topology now work for auto-discovered services too
  (were 404 / edge-less); a shared 60s-cached resolved list also curbs AWS "Rate exceeded" throttling.
- **Amazon Bedrock** — new service type: per-model usage from CloudWatch (invocations, client/server
  errors, throttling, latency). Auto-discovered from the models you've actually invoked (CloudWatch
  `ListMetrics`), or declared with `aws: { type: bedrock, model: <modelId> }`.
- **More service types** — OpenSearch (cluster status + nodes), SES (send volume, bounce/complaint
  rate), SageMaker (endpoint invocations/errors/latency) — all via CloudWatch and auto-discovered.
- **Calmer cards** — metadata (build sha, timestamps) is dimmed so the eye lands on status first;
  the Terraform-drift row is now the Terraform logo colored by state (green/red/yellow), no text;
  long execution latencies are humanized (`p95 245759ms` → `p95 4m 6s`, near-timeout `(300s)` → `(5m)`).
- **Truer Lambda states** — a function/cron that fails **100% of its invocations** is now **down**
  (was only "warning"); the cron dead-man window has a **10-min floor** so high-frequency crons (1m/5m)
  don't false-alarm on CloudWatch metric-publication lag; the on-demand idle threshold is **60 min**
  (was 15, too aggressive).
- **Throttling resilience** — several layers so busy dashboards stop hitting `TooManyRequests`:
  CloudWatch `GetMetricData` is **batched** (one call per credentials+window, ≤500 metrics, instead of
  one per service); AWS clients **share one credential provider per account** (a single STS AssumeRole
  instead of one per client); adaptive retry (client-side rate limiting under 429); and a 5-min
  resolved-services cache, plus a shared cache + single-flight for Lambda `GetFunctionConfiguration`
  (build/drift/runtime read the same function's config in one refresh → one control-plane call instead
  of three, and repeat refreshes reuse it for a TTL — the main reason a cron fleet stopped hitting 429).
  Tunables: `DADAGUARD_AWS_MAX_ATTEMPTS`, `DADAGUARD_DISCOVERY_TTL_MS`, `DADAGUARD_CONCURRENCY`, `DADAGUARD_LAMBDA_CFG_TTL_MS`.
  And when a burst still exhausts the retries, the build field shows a clean *"AWS rate limit — retry on
  refresh"* instead of the raw `TooManyRequestsException: HTTP 429` SDK exception.
- **Terraform badge** — the "Terraform-compliant" row is now a green/red badge, readable at a glance.

### Changed
- **Auto-discovery merges with the watchlist, on by default** — discovered services are now added to
  those declared in `services.yaml` (declared ones win and keep their overrides), instead of running
  only when the watchlist is empty. Works in cloud too. Opt out with `DADAGUARD_DISCOVER=0`.

## [0.2.0] — 2026-06-30

Adoption, trust and scale — the jump from "deep tool" to "the dashboard a DevOps reaches for".

### Added
- **Zero-config auto-discovery** — starts with no `services.yaml`: discovers what's running in each
  account (read-only, in memory). `services.yaml` becomes an override to pin watchlist/versions/accounts.
- **Demo mode** (`DADAGUARD_DEMO=1`) — a fake 12-service fleet covering every state, zero AWS. Try it,
  record a demo, or evaluate the UI without credentials.
- **AWS Organizations + multi-region** — an `org` block enumerates members (`organizations:ListAccounts`)
  and assumes the read-only role in each; auto-discovery sweeps every member × region.
- **Recent changes (CloudTrail)** — write API calls on a resource (who/what/when + errorCode): the cause
  behind a service turning yellow/red, alongside operational events.
- **Account reachability (meta-health)** — an STS probe per account + a header indicator; broken plumbing
  (expired creds, wrong ExternalId) no longer hides as a falsely "unknown" signal.
- **AWS console deep-links** — one click from any card to the exact resource (17 types).
- **Expected-version provenance** — `expectedVersionUrl` resolves the expected version from a dynamic
  source of truth; the UI always shows where "expected" came from.
- **Brand** — a dog mascot logo + favicon, and a demo video/GIF in the README (rendered by demowright).

### Changed
- **Deploy-aware grace for ECS** — no false reds during rollouts: a running<desired count during a
  deployment reads as "rollout in progress", not a fault (`DADAGUARD_DEPLOY_GRACE_SECONDS`, default 120).

### Read-only role
- New permissions: **`cloudtrail:LookupEvents`** (recent changes) and **`organizations:ListAccounts`**
  (org mode only). Re-apply the role to enable them.

## [0.1.0] — 2026-06-30

First public release. A local-first, **read-only**, **no-LLM** watchdog that answers
*"is my stack up **and coherent**?"* by correlating AWS + secrets (SSM/Doppler) + Terraform.

### Signals
- **Reachable** — liveness + latency of an HTTP endpoint.
- **Build / deploy** — what runs and since when, zero-config: image tag + deploy time (ECS),
  version + last-modified (Lambda), AMI + launch time (EC2). Compares to `expectedVersion` when set.
- **Runtime** — real desired-vs-running for ECS · ASG · Lambda (with cron dead-man switch) · RDS ·
  ALB · EC2 · **SQS** (queue depth) · **DynamoDB** · **ElastiCache**.
- **Terraform** — lightweight drift (state ↔ AWS) and full `terragrunt plan` on demand, which now
  distinguishes *in-sync* / *to-apply* / *real drift*; plus resources not managed by Terraform.
- **Secrets** — present in SSM/Doppler (by name only, never values); missing-between-environments.
- **Security** — open security groups (`0.0.0.0/0`) and IAM wildcard policies (opt-in per service).
- **Costs & waste** — real MTD spend (usage vs credits) and list-price waste (idle EIP/NAT/EBS).
- **Topology** — dependencies inferred from AWS (Lambda env, event sources, security groups) and a
  network map (VPC → subnet → service, with egress), both with a per-account filter.

### Interfaces
- Web dashboard (React + Ant Design), **it/en** UI with per-mode default language.
- **CLI/CI** — `npm run check` with exit codes to gate pipelines (`--json`, `--service`, `--fail-on`).
- **`/metrics`** (Prometheus) + **`/healthz`** — let Grafana/Alertmanager do dashboards, alerting and
  history without Dadaguard becoming a stateful service.

### Deploy
- `docker compose up` for one-command self-host; published image on GHCR.
- Cross-account read-only via AssumeRole + ExternalId; least-privilege role example (Terraform + JSON).
- `npm run config:push` to publish the watchlist to a cloud instance (SSM + redeploy).

### Principles
Read-only on the infra · no LLM · fetch-on-load, zero storage · secrets by name only.
