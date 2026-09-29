# syntax=docker/dockerfile:1
# DeployForge runner: the only component with Docker socket access.
FROM golang:1.24-alpine AS build
WORKDIR /src
COPY go.mod ./
COPY . .
RUN --mount=type=secret,id=build_ca,required=false \
    if [ -s /run/secrets/build_ca ]; then export SSL_CERT_FILE=/run/secrets/build_ca; fi; \
    CGO_ENABLED=0 go build -trimpath -ldflags="-s -w" -o /out/runner ./cmd/runner \
 && CGO_ENABLED=0 go build -trimpath -ldflags="-s -w" -o /out/runner-healthcheck ./cmd/healthcheck \
 && CGO_ENABLED=0 go build -trimpath -ldflags="-s -w" -o /out/gitfixture ./cmd/gitfixture

# docker:cli ships the Docker CLI and the buildx plugin used for BuildKit builds.
FROM docker:29.3-cli AS runner
RUN --mount=type=secret,id=build_ca,required=false \
    if [ -s /run/secrets/build_ca ]; then export SSL_CERT_FILE=/run/secrets/build_ca; fi; \
    apk add --no-cache git ca-certificates
COPY --from=build /out/runner /out/runner-healthcheck /usr/local/bin/
ENV DOCKER_SOCKET=/var/run/docker.sock
ENTRYPOINT ["/usr/local/bin/runner"]

# Test-only image for the hermetic git fixture used by the acceptance suite.
FROM alpine:3.22 AS gitfixture
RUN --mount=type=secret,id=build_ca,required=false \
    if [ -s /run/secrets/build_ca ]; then export SSL_CERT_FILE=/run/secrets/build_ca; fi; \
    apk add --no-cache git git-daemon
COPY --from=build /out/gitfixture /usr/local/bin/gitfixture
ENTRYPOINT ["/usr/local/bin/gitfixture"]

# The production runner is the default (last) target.
FROM runner
