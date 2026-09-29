// Command runner is the DeployForge deployment runner: the only component
// with Docker daemon access. It exposes a narrow, HMAC-authenticated API on
// the private control network.
package main

import (
	"context"
	"fmt"
	"log/slog"
	"net"
	"net/http"
	"os"
	"os/signal"
	"path/filepath"
	"strconv"
	"strings"
	"syscall"
	"time"

	"github.com/the-null-catchers/deployforge/services/runner/internal/build"
	"github.com/the-null-catchers/deployforge/services/runner/internal/docker"
	"github.com/the-null-catchers/deployforge/services/runner/internal/gitops"
	"github.com/the-null-catchers/deployforge/services/runner/internal/server"
)

func env(k, def string) string {
	if v := strings.TrimSpace(os.Getenv(k)); v != "" {
		return v
	}
	return def
}

func list(k, def string) []string {
	out := []string{}
	for _, p := range strings.Split(env(k, def), ",") {
		if p = strings.TrimSpace(p); p != "" {
			out = append(out, p)
		}
	}
	return out
}

func main() {
	logger := slog.New(slog.NewJSONHandler(os.Stdout, &slog.HandlerOptions{Level: slog.LevelInfo}))
	if err := run(logger); err != nil {
		logger.Error("runner exited", "err", err)
		os.Exit(1)
	}
}

func run(logger *slog.Logger) error {
	secret := os.Getenv("RUNNER_SHARED_SECRET")
	if len(secret) < 32 {
		return fmt.Errorf("RUNNER_SHARED_SECRET must be set to at least 32 characters")
	}
	socket := env("DOCKER_SOCKET", "/var/run/docker.sock")
	workDir := env("RUNNER_WORK_DIR", "/var/lib/deployforge-runner/work")
	if err := os.MkdirAll(workDir, 0o700); err != nil {
		return err
	}
	// Remove workspaces left behind by a crash; they belong to builds that no
	// longer exist.
	if entries, err := os.ReadDir(workDir); err == nil {
		for _, e := range entries {
			if strings.HasPrefix(e.Name(), "build-") {
				_ = os.RemoveAll(filepath.Join(workDir, e.Name()))
			}
		}
	}
	maxBuilds, _ := strconv.Atoi(env("RUNNER_MAX_CONCURRENT_BUILDS", "2"))
	git := gitops.Policy{
		AllowedHosts:      list("RUNNER_GIT_ALLOWED_HOSTS", "github.com"),
		InsecureHTTPHosts: list("RUNNER_GIT_INSECURE_HTTP_HOSTS", ""),
	}
	if len(git.InsecureHTTPHosts) > 0 {
		logger.Warn("insecure http git hosts enabled; this is intended only for the test fixture", "hosts", git.InsecureHTTPHosts)
	}

	d := docker.New(socket)
	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	v, err := d.Negotiate(ctx)
	cancel()
	if err != nil {
		logger.Warn("docker not reachable at startup; will retry per request", "err", err)
	} else {
		logger.Info("connected to docker", "version", v.Version, "api", v.APIVersion)
	}

	self := ""
	if env("RUNNER_ATTACH_SELF", "false") == "true" {
		self, _ = os.Hostname()
	}
	bm := build.NewManager(build.Config{WorkDir: workDir, DockerHost: "unix://" + socket, MaxConcurrent: maxBuilds, Git: git, Logger: logger}, d)
	srv := server.New(server.Config{Secret: []byte(secret), SelfContainer: self, Git: git, Logger: logger}, d, bm)

	addr, err := listenAddr(d, self)
	if err != nil {
		return err
	}
	hs := &http.Server{
		Addr:              addr,
		Handler:           srv.Handler(),
		ReadHeaderTimeout: 10 * time.Second,
		IdleTimeout:       60 * time.Second,
	}
	go func() {
		sig := make(chan os.Signal, 1)
		signal.Notify(sig, syscall.SIGINT, syscall.SIGTERM)
		<-sig
		logger.Info("shutting down")
		c, cancel := context.WithTimeout(context.Background(), 15*time.Second)
		defer cancel()
		_ = hs.Shutdown(c)
	}()
	logger.Info("runner listening", "addr", addr, "maxConcurrentBuilds", maxBuilds, "gitHosts", git.AllowedHosts)
	if err := hs.ListenAndServe(); err != nil && err != http.ErrServerClosed {
		return err
	}
	return nil
}

// listenAddr binds to RUNNER_LISTEN, or — when RUNNER_LISTEN_NETWORK is set —
// to this container's address on that Docker network only. The runner is
// attached to application networks for health probes, so it must not listen
// on 0.0.0.0 where application containers could reach it.
func listenAddr(d *docker.Client, self string) (string, error) {
	netName := os.Getenv("RUNNER_LISTEN_NETWORK")
	port := env("RUNNER_PORT", "7070")
	if netName == "" {
		return env("RUNNER_LISTEN", "127.0.0.1:"+port), nil
	}
	if self == "" {
		return "", fmt.Errorf("RUNNER_LISTEN_NETWORK requires RUNNER_ATTACH_SELF=true")
	}
	for i := 0; i < 30; i++ {
		ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
		c, err := d.InspectContainer(ctx, self)
		cancel()
		if err == nil {
			if ep, ok := c.NetworkSettings.Networks[netName]; ok && ep.IPAddress != "" {
				return net.JoinHostPort(ep.IPAddress, port), nil
			}
		}
		time.Sleep(time.Second)
	}
	return "", fmt.Errorf("could not determine this container's address on network %q", netName)
}
