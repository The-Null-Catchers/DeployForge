# DeployForge progress log

Short, append-only log so work can resume across sessions. Newest first.

## Current state

| Milestone | Status |
| --- | --- |
| 1. Repo, architecture decisions, local infra | done (compose, dev overlay, setup script) |
| 2. Auth, workspaces, DB, app CRUD | implemented; tests pending |
| 3. Real deployment path public repo → Docker → local domain | **verified manually** (see below) |
| 4. Persistence, logs, health-gated promotion, recovery | implemented; automated tests pending |
| 5. Immutable releases, config/env revisions, rollback | implemented; rollback verified manually |
| 6. GitHub App + push deploys | implemented against fixture adapter; tests pending |
| 7. Custom domains, HTTPS, hardening | implemented; public DNS/HTTPS unverified |
| 8. Dashboard, metrics, security tests, docs | not started |
| Mobile (Flutter) | not started |

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

## Next

1. API unit + integration tests (authz, CSRF, refresh reuse, outbox, webhooks, SSE).
2. Web dashboard.
3. Flutter mobile app.
4. Full-compose acceptance script, CI, documentation.
