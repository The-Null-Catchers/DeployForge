# DeployForge sample application

A dependency-free Node.js service used by the acceptance suite and the demo.

| Endpoint   | Purpose                                                        |
| ---------- | -------------------------------------------------------------- |
| `/`        | HTML page coloured per release, shows `GREETING` and env names |
| `/health`  | `200` when `release.json` has `healthy: true`, otherwise `503` |
| `/version` | JSON `{ version, buildLabel, startedAt }`                      |
| `/headers` | Echoes proxy forwarding headers (`X-Forwarded-*`)              |
| `/ws`      | WebSocket echo, used to verify proxy upgrade handling          |

Release variants are selected by editing `release.json` and committing:

| Variant   | `release.json`                                               |
| --------- | ------------------------------------------------------------ |
| A         | `{"version":"A","color":"#1d4ed8","healthy":true}`           |
| B         | `{"version":"B","color":"#15803d","healthy":true}`           |
| Unhealthy | `{"version":"C-unhealthy","color":"#b91c1c","healthy":false}` |
| Crash     | `{"version":"D-crash","crashOnStart":true}`                  |

`scripts/make-fixture-repo.sh` builds a git repository with one commit per
variant for the hermetic acceptance test. To use it with DeployForge
directly, point an application at this repository with build context
`examples/sample-app`, Dockerfile `examples/sample-app/Dockerfile`, port `3000`
and health path `/health`.

The app listens on `0.0.0.0:$PORT`; DeployForge sets `PORT` to the configured
container port.
