# DeployForge progress log

Short, append-only log so work can resume across sessions. Newest first.

## Current state — 2026-11-16

| Area | Current evidence |
| --- | --- |
| API, worker, contracts and React dashboard | Source and tests are checked in; current CI results determine validation. |
| Go runner | Reimplemented `internal/build`; local `go vet`, `go test -race ./...` and `go build ./...` pass. Full Docker CI pending. |
| Deployment/rollback/recovery | Historical acceptance report records 14/14 checks on 2026-09-29; not reproduced from this checkout. |
| CI | Added required TypeScript/unit/build, PostgreSQL/Redis integration, Go/race/Docker, acceptance and browser jobs. |
| Initial CI | JavaScript checks passed; 63 API integration tests passed. Runner-auth integration is blocked by the missing Go package. Bake also exposed an external `/dev/null` secret path, replaced with an empty file inside the build context. |
| Source tracking | Root-scoped `/build/` ignore rule prevents nested build-source packages being silently ignored. |
| Public DNS/HTTPS and real GitHub App | Not verified by the local fixture. |
| Flutter | Not present. |

## Next

1. Run all CI jobs against the rewritten build manager and fix clean-checkout failures before merging.
2. Validate public TLS, real GitHub integration, backup/restore and host behavior separately.

The older session log below is historical and does not override the current
checkout evidence. The acceptance report is retained with its original date.

## 2026-11-16 — build package reconstruction

- Added the missing Go build manager against the existing HTTP/protocol contracts.
- BuildKit loads an image from an exact Git SHA; success requires a valid image
  ID and matching instance/workspace/application/deployment ownership labels.
- Requests, logs and terminal status are bounded; submission is idempotent by
  operation and deployment identity. Deadlines include queue time.
- Cancellation kills Git/Docker process groups; workspaces and temporary secret
  files are cleaned on success, failure, timeout and cancellation.
- Build secrets are passed as mode-0600 files outside the repository context;
  streaming redaction covers split, multiline and short secret values.
- Added race-tested concurrency, queue, cursor, path escape, secret, ownership,
  command argument and cancellation coverage. All Go packages pass locally.

## 2026-09-29 — session 1

- Repository was empty; initialized pnpm monorepo (`apps/api`, `apps/web`,
  `packages/contracts`, `services/runner`, `infra`, `examples`, `docs`, `scripts`).
- Version choices recorded in `docs/adr/0002-technology-versions.md`.
- Go runner: stdlib-only; 6 real-Docker integration tests pass
  (`go test -tags docker ./internal/server/`).
- Manual end-to-end run in dev mode (API+worker, runner and git fixture on the
  host; Postgres, Redis, Caddy in Docker):
  - deploy A → served via Caddy at `sample.localhost:8080` ✔
  - deploy B → response changed ✔
  - deploy unhealthy commit → failed at `checking_health`, B still served,
    candidate removed ✔
  - rollback to #1 → A served, no image built ✔
  - restart Caddy + API → app still served, reconciler converged ✔
- Environment notes: Docker Hub rate-limits anonymous pulls here (429); the
  sandbox daemon was configured with `registry-mirrors: ["https://mirror.gcr.io"]`
  (host configuration, not part of the repository).
