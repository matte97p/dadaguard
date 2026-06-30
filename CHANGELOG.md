# Changelog

All notable changes to Dadaguard are documented here. Format based on
[Keep a Changelog](https://keepachangelog.com/), versioning follows [SemVer](https://semver.org/).

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
