# Security

## Security posture

Dadaguard is designed to be safe to point at production infrastructure.

- **Read-only by design.** Dadaguard performs no write actions on AWS. It only
  reads state (`Describe*` / `Get*` / `List*`-style calls). It cannot create,
  modify, or destroy resources. Infra changes happen exclusively through
  Terraform, never through this tool.
- **Secrets are read by name only.** When checking that the secrets a service
  uses exist (SSM / Doppler), Dadaguard reads their **names**, never their
  values. The example read-only IAM role grants **no `kms:Decrypt`** — secret
  values stay inaccessible to Dadaguard. See
  [`deploy/dadaguard-readonly-role.example.tf`](deploy/dadaguard-readonly-role.example.tf).
- **No credentials in the repo.** AWS access comes from the instance role
  (EC2/ECS), local AWS profiles (`~/.aws`), or environment variables — never
  committed. Cross-account access uses `roleArn` (AssumeRole) with an optional
  `externalId`.
- **`services.yaml` is gitignored.** Your real configuration (accounts, ARNs,
  endpoints) never enters the repo or the Docker image; only
  `services.example.yaml` is tracked. The image is built without it; mount it at
  runtime.
- **No LLM, no telemetry, no persistence.** Deterministic checks, zero stored
  state, no data sent to third parties.

## Recommended deployment hardening

- Grant Dadaguard a dedicated, least-privilege read-only IAM role per account.
- Keep the dashboard behind authentication (e.g. Cloudflare Access / Zero Trust);
  it exposes no public endpoints of its own by design.

## Reporting a vulnerability

If you find a security issue, please report it privately rather than opening a
public issue.

- Email: `security@<your-domain>`
  *(maintainer: replace this placeholder with a real contact before publishing.)*

Please include steps to reproduce and the affected version/commit. We do not
commit to a specific response SLA, but reports are taken seriously and addressed
on a best-effort basis.
