# Changelog

All notable changes to Dadaguard are documented here. Format based on
[Keep a Changelog](https://keepachangelog.com/), versioning follows [SemVer](https://semver.org/).

## [Unreleased]

### Added
- **Log window selector** — the recent-logs drawer now offers 1h / 6h / 24h (was fixed at 1h); the
  backend already accepted `?minutes=`. The snapshot cap (~100 lines per call) still applies.
- **Cost month selector** — the Costs drawer can pick the reference month (last 12 months), not just
  the current MTD; the backend takes `?month=YYYY-MM` (defaults to the current month).

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
