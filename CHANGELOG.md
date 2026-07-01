# Changelog

All notable changes to Dadaguard are documented here. Format based on
[Keep a Changelog](https://keepachangelog.com/), versioning follows [SemVer](https://semver.org/).

## [Unreleased]

### Added
- **Topology, upgraded** — the dependency view is now **full-screen**, auto-laid-out with dagre, and
  infers far more than before. `env` references are read from **ECS task definitions** too (not only
  Lambda) — so an ECS/Fargate stack finally shows its wiring; plus two new sources: **Step Functions**
  (the resources a state machine orchestrates → `flow` edges) and **Application Load Balancers** (the
  ECS/EC2 services behind each target group → `lb` edges). Demo mode now ships a fully-wired sample
  graph, so the feature is visible with no AWS connection. New read-only permission:
  `states:DescribeStateMachine` (the Terraform role modules already granted it; only the JSON policy
  example was missing it).
- **Aggregate panels open near-fullscreen** — Costs, Waste, Quotas and Meta-health now open as a
  centered modal (were narrow side drawers) with accounts laid out side-by-side, so a multi-account
  fleet fills the width instead of a long single column. The modal height follows the content, so a
  short panel doesn't leave half the screen blank. Each carries the same "filter from the dashboard
  bar" hint as Topology (the bar is covered while a panel is open).
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
  the Terraform-drift row is now the Terraform logo colored by state (green/red/yellow), no text.
- **Truer Lambda states** — a function/cron that fails **100% of its invocations** is now **down**
  (was only "warning"); the cron dead-man window has a **10-min floor** so high-frequency crons (1m/5m)
  don't false-alarm on CloudWatch metric-publication lag; the on-demand idle threshold is **60 min**
  (was 15, too aggressive).
- **Throttling resilience** — several layers so busy dashboards stop hitting `TooManyRequests`:
  CloudWatch `GetMetricData` is **batched** (one call per credentials+window, ≤500 metrics, instead of
  one per service); AWS clients **share one credential provider per account** (a single STS AssumeRole
  instead of one per client); adaptive retry (client-side rate limiting under 429); and a 5-min
  resolved-services cache. Tunables: `DADAGUARD_AWS_MAX_ATTEMPTS`, `DADAGUARD_DISCOVERY_TTL_MS`, `DADAGUARD_CONCURRENCY`.
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
