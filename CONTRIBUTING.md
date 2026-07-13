# Contributing to Dadaguard

Thanks for considering a contribution. Dadaguard is a small, deliberately scoped
project — please read the non-negotiable principles below before opening a PR.

## Local setup

```bash
cp services.example.yaml services.yaml   # what to monitor + your accounts
npm install
npm run dev                              # server + Vite, → http://localhost:5173
```

AWS auth in local dev: SSO/CLI profile (the `profile:` field per account in
`services.yaml`). Cross-account uses `roleArn` (AssumeRole). Everything is
read-only — see [SECURITY.md](SECURITY.md).

## Project layout

- `server/` — Express. `GET /api/status` re-reads `services.yaml` and runs the
  checks in parallel.
  - `server/checks/` — **one file per signal**. Each module exports
    `{ key, run(service, ctx) }`; `run()` returns a result
    (`{ key, status, ... }`) or `null` when the signal doesn't apply to the
    service. Signals are wired in `server/status.js` (the `CHECKS` array).
  - `server/i18n.js` — dynamic summary strings (interpolated), translated
    server-side and returned already localized via `/api/status?lang=`.
- `web/` — React + Ant Design. One card per service; the traffic light is the
  worst check. Static UI strings live in `web/i18n.jsx`.
- `test/` — `node --test` (built-in runner, no extra dependency).

## Non-negotiable principles

These define the product. A PR that breaks one of them won't be merged.

- **Read-only on the infra.** Dadaguard never creates, modifies, or destroys
  anything in AWS. Only `Describe*` / `Get*` / `List*`-style calls. Infra changes
  go through Terraform, not through this tool.
- **No LLM.** 100% deterministic: no LLM calls, no inference, no model
  dependency. Keeps it free, fast, and predictable.
- **Fetch-on-load, zero storage.** No database, no persisted state. `services.yaml`
  is re-read on every request; results are computed live and not cached server-side.

## Adding a new signal

1. Create `server/checks/<signal>.js` exporting `key` and
   `async run(service, ctx)`. Use `ctx.t` for any human-readable summary so it
   stays translatable; return `null` if the signal doesn't apply.
2. Register it in `server/status.js` (import + add to the `CHECKS` array).
3. If it introduces new summary strings, add the key to **both** `it` and `en`
   in `server/i18n.js`. If you add UI strings, add them to both languages in
   `web/i18n.jsx`. The test suite enforces IT/EN key parity.
4. The check must only read from AWS (no writes) and must degrade gracefully
   (return `unknown`/`degraded` with a reason, never throw the whole status).

## Adding a new connector / account type

Account-level auth (profile, `roleArn`, `externalId`, `region`) is resolved in
`server/status.js` and passed to each check via `ctx`. New connectors should
follow the same read-only credential flow and never require `kms:Decrypt` —
secrets are read **by name only**.

## Tests & PRs

- Run the tests with `npm test` (`node --test`). Add tests for any pure,
  AWS-independent logic you touch — don't write tests that call AWS.
- PRs must pass **build** (`npm run build`) and **tests** (`npm test`).
- Keep the tone of docs and code dry and factual. Match the existing style.
