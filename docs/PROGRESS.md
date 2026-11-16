# DeployForge progress log

Short, append-only log so work can resume across sessions. Newest first.

## Current state — 2026-11-16

| Area | Current evidence |
| --- | --- |
| API, worker, contracts and React dashboard | Source and tests are checked in; current CI results determine validation. |
| Go runner | Build blocked: imported `internal/build` package is absent from Git. Restore original source before release. |
| Deployment/rollback/recovery | Historical acceptance report records 14/14 checks on 2026-09-29; not reproduced from this checkout. |
| CI | Added required TypeScript/unit/build, PostgreSQL/Redis integration, Go/race/Docker, acceptance and browser jobs. |
| Source tracking | Root-scoped `/build/` ignore rule prevents nested build-source packages being silently ignored. |
| Public DNS/HTTPS and real GitHub App | Not verified by the local fixture. |
| Flutter | Not present. |

## Next

1. Restore `services/runner/internal/build` from the original working source.
2. Run all CI jobs and fix any additional clean-checkout failures before merging.
3. Validate public TLS, real GitHub integration, backup/restore and host behavior separately.

The older session log below is historical and does not override the current
clean-checkout blocker. The acceptance report is retained with its original date.

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
