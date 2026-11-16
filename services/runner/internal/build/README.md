# Build manager

`Manager` implements the runner's asynchronous build contract. Each request
clones the exact commit through the Git host/transport policy, resolves the
context and Dockerfile relative to the repository root (including symlink
checks), and invokes `docker buildx build --load` without a shell. Dockerfile
paths may be outside a nested context, but cannot leave the repository.

Success requires a verified `sha256` image identity and matching Docker inspection
and all ownership labels. Clone, configuration, build, timeout, cancellation and
internal failures retain distinct protocol classifications.

The config digest from Buildx metadata identifies the loaded image when present.
Other exporters only return an iid. If that iid is a manifest digest unavailable
through a direct lookup, the owned tag must expose a matching immutable descriptor
or repository digest before its local image ID can be used. A tag alone never
proves identity; configuration and ownership checks still apply.

## Limits and lifecycle

- Concurrency defaults to 2 and is capped at 32. At most 128 operations are
  retained. Only completed operations may be evicted when admitting new work.
- The request deadline is 30–7200 seconds and includes time waiting for a slot.
- Reusing an operation ID for the same repository/SHA, workspace, application,
  deployment and image returns the existing operation. Refreshed credentials or
  different arguments do not restart it. A different identity is rejected.
- The in-memory cache is lost on runner restart; the control plane resubmits its
  durable deployment operation. Evicted operations can likewise be resubmitted.
- Canceling queued work prevents execution. Canceling running work or reaching
  its deadline kills the entire Git/Docker CLI process group, including buildx.
- Temporary workspaces are removed before terminal status is published. Startup
  cleanup in `cmd/runner` handles workspaces left by a killed runner process.

## Logs and secrets

Each operation retains at most 1000 lines and 1 MiB of text, with individual
lines capped at 8192 bytes. Older lines are discarded and `logsTruncated` is set.
`nextSeq` is the next unread record: pass it unchanged as the next `after`
cursor (inclusive). Sequence numbers never reset when old records are removed.

Build arguments are non-sensitive and may appear in Docker metadata. Build
secrets use private mode-0600 files outside the checkout and therefore outside
the build context. Repository credentials remain in the Git child environment.
Raw, URL-encoded, multiline and short secrets are redacted from streamed logs,
commit subjects and errors, including secrets split across writes. Arbitrarily
transformed secrets cannot be detected; Dockerfiles must handle them responsibly.

Unit tests exercise command arguments with a fake Docker executable. Existing
`go test -tags docker ./internal/server/` and full-stack acceptance/browser CI
exercise a real daemon, real Git transport, secret mounts and deployments.
