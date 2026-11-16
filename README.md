# DeployForge

A self-hosted, single-server deployment platform for trusted teams. The control
plane uses NestJS, PostgreSQL, Redis and a React dashboard. A separate Go runner
builds images and manages application containers; Caddy routes traffic after
health checks pass. Deployments, retained-image rollbacks and reconciliation
are represented in persistent state.

## Current checkout status

The missing Go package `services/runner/internal/build` has been reimplemented.
It builds exact Git commits with BuildKit, bounds concurrent work and retained
logs, supports cancellation and deadlines, and checks image ownership before
returning success. See [build manager behavior](services/runner/internal/build/README.md).
Go vet, race tests and compilation pass locally. Full Docker and browser results
are verified by the required CI jobs before merging.

The checked-in [acceptance report](docs/acceptance-report.md) records 14/14 checks
from 29 September 2026. It is historical evidence, not proof that the current
checkout can reproduce those results. CI generates a fresh report and keeps Go
and full-stack checks mandatory. See [progress](docs/PROGRESS.md).

## Prerequisites

- Node.js 22.12 or later; pnpm 10.33.0 (`packageManager` in `package.json`).
- Go 1.24 or later for the runner.
- Linux with Docker Engine, the Buildx plugin, Compose v2 with `!override`
  support (2.24.4 or later), and Git.
- Local ports 5173, 3000, 5432, 6379 and 8080 for development; acceptance uses
  loopback port 18080.

The runner mounts the Docker socket and can control the host daemon. Use a
dedicated host for trusted applications and keep the runner/control network
private. The API and worker do not mount that socket.

## Development

From the repository root:

```sh
corepack enable
corepack prepare pnpm@10.33.0 --activate
pnpm install --frozen-lockfile
node scripts/setup.mjs --dev
pnpm dev:infra
pnpm db:migrate
pnpm build
bash scripts/dev-procs.sh start runner
pnpm dev
```

Open http://localhost:5173. Use the one-time setup token printed by the setup
script to create the first owner. Setup refuses to overwrite an existing `.env`.
Keep the generated master encryption keys with the database backup; changing
those keys makes existing encrypted variables unreadable.

Stop the host runner with `bash scripts/dev-procs.sh stop runner`. Stopping local
infrastructure with `docker compose -f infra/compose.yaml -f
infra/compose.dev.yaml --env-file .env down` preserves its named volumes.

## Full-stack verification

The acceptance fixture runs its own Compose project, generates temporary test
secrets, and clones a local sample Git repository. Use a disposable test host:

```sh
bash scripts/acceptance.sh all
# Check the newly generated docs/acceptance-report.md.
bash scripts/acceptance.sh down
```

`down` deletes the acceptance project's data and its labeled application
resources. It is a test cleanup command, not the command for a real installation.

For unit/type/build checks:

```sh
pnpm --filter @deployforge/contracts build
pnpm typecheck
pnpm lint
pnpm test
pnpm build
(cd services/runner && go vet ./... && go test -race ./... && go build ./...)
```

API integration tests require a dedicated, disposable database and Redis DB:

```sh
export TEST_DATABASE_URL=postgresql://deployforge:password@localhost:5432/deployforge_test
export TEST_REDIS_URL=redis://localhost:6379/5
pnpm --filter @deployforge/api db:generate
pnpm test:integration
```

The tests truncate application tables and flush their Redis database. Do not
point these variables at production or shared application data.

## CI

[DeployForge CI](.github/workflows/ci.yml) runs on pull requests, manual dispatch,
and pushes to `main` or the current default development branch. It checks:

- TypeScript, unit tests, and production bundles.
- PostgreSQL migrations/API integration with isolated PostgreSQL and Redis.
- Go vet, race tests, compilation, and real Docker runner integration.
- The real-Docker acceptance scenario and browser deployment workflows.

CI uploads the generated acceptance report and browser failure artifacts;
it does not publish `.env` files. Required jobs are not skipped or allowed to fail.

## Single-server installation

After passing CI and verifying the target host:

```sh
node scripts/setup.mjs --domain deploy.example.com --apps-domain apps.example.com --email ops@example.com
# Configure dashboard and wildcard application DNS to this host first.
docker compose -f infra/compose.yaml --env-file .env up -d --build
```

Review `.env.example` for ports, retention, GitHub integration and TLS settings.
Public DNS/ACME and a real GitHub App remain separate deployment validations.
A Flutter client is not present in this checkout.
