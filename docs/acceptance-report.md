# Acceptance report (real Docker)

Generated 2026-09-29 15:01 UTC by `scripts/acceptance.sh`.
Docker 29.3.1, Compose project `deployforge-acceptance`, TLS mode off (local domains).

**14/14 checks passed.**

| Check | Result | Detail | Time |
| --- | --- | --- | --- |
| 0. First-run setup requires the token; owner signs in | PASS | app cmumsyfdj000501p8j6gfuaji | 0s |
| 1. Deploy version A (clone → BuildKit build → health → promote) | PASS | #1 image 752a79f911f9 | 4s |
| 2. Version A answers through the proxy | PASS | version A | 0s |
| 3. Deploy version B; response changes | PASS | #2 serving B | 17s |
| 4. Unhealthy deployment fails; B stays available | PASS | Health check /health on port 3000 did not pass after 10 attempts: unexpected status 503 | 15s |
| 5. Roll back to A without rebuilding | PASS | #4 image reused | 3s |
| 6. Invalid Dockerfile is reported as a build failure | PASS | docker build failed after 0s: exit status 1 | 2s |
| 7. Container startup crash is reported as such | PASS | Container exited with code 3 before becoming healthy | 5s |
| 8. Concurrent deployment requests produce exactly one active release | PASS | ['canceled', 'canceled', 'canceled', 'succeeded'] | 20s |
| 9. Proxy update failure keeps the previous route | PASS | Caddy admin API unreachable: connect ENOENT /run/caddy-admin/admin.sock | 10s |
| 10. Worker crash mid-build is recovered as interrupted | PASS | interrupted | 23s |
| 11. Reconciler recreates a missing active container | PASS | restored B | 15s |
| 12. Restart all DeployForge services; app stays available and state reconciles | PASS | diagnostics {'database': True, 'redis': True, 'runner': True, 'proxy': True} | 24s |
| 13. Deleting the app removes only resources DeployForge owns | PASS | cleanup scoped to owned resources | 3s |

## Evidence

- Deployment #1 (d37986d39ed9) image `752a79f911f9` stages: preparing 123ms, cloning 1049ms, building 1032ms, starting 194ms, checking_health 1027ms, promoting 51ms
- `GET http://sample.acceptance.localhost/version` → `A`; forwarding headers {'host': 'sample.acceptance.localhost', 'x-forwarded-for': '172.28.0.1', 'x-forwarded-proto': 'http', 'x-forwarded-host': 'sample.acceptance.localhost'}
- After #2: `/version` → `B`; running app containers after drain: 1
- #3 failed (health_check_failed): Health check /health on port 3000 did not pass after 10 attempts: unexpected status 503; `/version` still `B`
- Rollback #4 reused image `752a79f911f9` (same as #1); stages: preparing, starting, checking_health, promoting; app image count unchanged (3)
- 4 concurrent requests → statuses ['canceled', 'canceled', 'canceled', 'succeeded']; 1 active release; 1 running container
- Caddy admin socket removed before promotion → #11 failed (proxy_promotion_failed); active release unchanged, `/version` → `B`
- Worker killed during `cloning` → #12 ended `interrupted`; active #10
- `docker compose restart` of all services: app answered `B` in 1/2 samples during the restart (the app container itself is not restarted; Caddy briefly restarts); after restart active #10, state `running`, diagnostics {'database': True, 'redis': True, 'runner': True, 'proxy': True}
- App deletion removed its containers, images, network and route; an unrelated container and a container labeled for another installation kept running
