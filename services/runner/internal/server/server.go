// Package server exposes the runner protocol v1 over HTTP.
package server

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"log/slog"
	"net"
	"net/http"
	"regexp"
	"strconv"
	"strings"
	"sync"
	"time"

	"github.com/the-null-catchers/deployforge/services/runner/internal/auth"
	"github.com/the-null-catchers/deployforge/services/runner/internal/build"
	"github.com/the-null-catchers/deployforge/services/runner/internal/docker"
	"github.com/the-null-catchers/deployforge/services/runner/internal/gitops"
	"github.com/the-null-catchers/deployforge/services/runner/internal/protocol"
)

const (
	RunnerVersion = "0.1.0"
	maxBody       = 2 << 20
)

var (
	containerNameRe = regexp.MustCompile(`^df-[a-z0-9-]{3,100}$`)
	idRe            = regexp.MustCompile(`^[a-z0-9]{8,40}$`)
	opIDRe          = regexp.MustCompile(`^[A-Za-z0-9_-]{8,80}$`)
	dockerRefRe     = regexp.MustCompile(`^[A-Za-z0-9_.:-]{1,128}$`)
	envKeyRe        = regexp.MustCompile(`^[A-Za-z_][A-Za-z0-9_]{0,127}$`)
)

type Config struct {
	Secret []byte
	// Instance scopes ownership labels to this installation.
	Instance string
	// SelfContainer is this runner's container ID/hostname when it runs in
	// Docker; it is attached to application networks for health probes.
	SelfContainer string
	Git           gitops.Policy
	Logger        *slog.Logger
}

type Server struct {
	cfg      Config
	docker   *docker.Client
	builds   *build.Manager
	verifier *auth.Verifier
	netMu    sync.Mutex
}

func New(cfg Config, d *docker.Client, b *build.Manager) *Server {
	return &Server{cfg: cfg, docker: d, builds: b, verifier: auth.NewVerifier(cfg.Secret)}
}

func NetworkName(applicationID string) string { return "df-app-" + applicationID }

// ours reports whether labels mark an object as owned by this installation.
func (s *Server) ours(labels map[string]string) bool {
	return labels[protocol.LabelManaged] == "true" && labels[protocol.LabelInstance] == s.cfg.Instance
}

func (s *Server) ownedFilter(extra ...string) []string {
	return append([]string{protocol.LabelManaged + "=true", protocol.LabelInstance + "=" + s.cfg.Instance}, extra...)
}

func (s *Server) Handler() http.Handler {
	mux := http.NewServeMux()
	mux.HandleFunc("GET /healthz", func(w http.ResponseWriter, _ *http.Request) { w.WriteHeader(http.StatusNoContent) })
	api := http.NewServeMux()
	api.HandleFunc("GET /v1/health", s.health)
	api.HandleFunc("POST /v1/git/resolve", s.gitResolve)
	api.HandleFunc("POST /v1/builds", s.submitBuild)
	api.HandleFunc("GET /v1/builds/{op}", s.buildStatus)
	api.HandleFunc("POST /v1/builds/{op}/cancel", s.cancelBuild)
	api.HandleFunc("POST /v1/networks", s.ensureNetwork)
	api.HandleFunc("DELETE /v1/networks/{app}", s.removeNetwork)
	api.HandleFunc("GET /v1/containers", s.listContainers)
	api.HandleFunc("POST /v1/containers", s.createContainer)
	api.HandleFunc("GET /v1/containers/{id}", s.inspectContainer)
	api.HandleFunc("POST /v1/containers/{id}/probe", s.probe)
	api.HandleFunc("POST /v1/containers/{id}/promote", s.promote)
	api.HandleFunc("POST /v1/containers/{id}/start", s.lifecycle("start"))
	api.HandleFunc("POST /v1/containers/{id}/stop", s.lifecycle("stop"))
	api.HandleFunc("POST /v1/containers/{id}/restart", s.lifecycle("restart"))
	api.HandleFunc("DELETE /v1/containers/{id}", s.lifecycle("remove"))
	api.HandleFunc("GET /v1/containers/{id}/logs", s.logs)
	api.HandleFunc("GET /v1/containers/{id}/stats", s.stats)
	api.HandleFunc("GET /v1/images", s.listImages)
	api.HandleFunc("DELETE /v1/images/{id}", s.removeImage)
	mux.Handle("/v1/", s.authenticate(api))
	return mux
}

// ---- middleware & helpers ----

func (s *Server) authenticate(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		body, err := io.ReadAll(io.LimitReader(r.Body, maxBody+1))
		if err != nil || len(body) > maxBody {
			writeErr(w, http.StatusRequestEntityTooLarge, "body_too_large", "request body too large", false)
			return
		}
		h := auth.Headers{
			Protocol:  r.Header.Get(protocol.HeaderProtocol),
			Timestamp: r.Header.Get(protocol.HeaderTimestamp),
			Nonce:     r.Header.Get(protocol.HeaderNonce),
			Signature: r.Header.Get(protocol.HeaderSignature),
		}
		if err := s.verifier.Verify(r.Method, r.URL.RequestURI(), h, body); err != nil {
			s.cfg.Logger.Warn("rejected unauthenticated runner request", "path", r.URL.Path, "reason", err.Error(), "remote", r.RemoteAddr)
			status := http.StatusUnauthorized
			if errors.Is(err, auth.ErrProtocol) {
				status = http.StatusBadRequest
			}
			writeErr(w, status, "unauthorized", err.Error(), false)
			return
		}
		r.Body = io.NopCloser(bytes.NewReader(body))
		next.ServeHTTP(w, r)
	})
}

func writeJSON(w http.ResponseWriter, status int, v any) {
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(status)
	_ = json.NewEncoder(w).Encode(v)
}

func writeErr(w http.ResponseWriter, status int, code, msg string, retryable bool) {
	writeJSON(w, status, protocol.Error{Code: code, Message: msg, Retryable: retryable})
}

func (s *Server) dockerErr(w http.ResponseWriter, err error) {
	switch {
	case docker.IsNotFound(err):
		writeErr(w, http.StatusNotFound, "not_found", "resource not found", false)
	case docker.IsConflict(err):
		writeErr(w, http.StatusConflict, "conflict", err.Error(), false)
	default:
		s.cfg.Logger.Error("docker error", "err", err)
		writeErr(w, http.StatusBadGateway, "docker_error", err.Error(), true)
	}
}

func decode(r *http.Request, v any) error {
	dec := json.NewDecoder(r.Body)
	dec.DisallowUnknownFields()
	return dec.Decode(v)
}

// owned loads a container and requires the DeployForge ownership label.
func (s *Server) owned(ctx context.Context, id string) (*docker.ContainerJSON, error) {
	if !dockerRefRe.MatchString(id) {
		return nil, &docker.APIError{Status: 404, Message: "invalid id"}
	}
	c, err := s.docker.InspectContainer(ctx, id)
	if err != nil {
		return nil, err
	}
	if !s.ours(c.Config.Labels) || c.Config.Labels[protocol.LabelRole] != "app" {
		return nil, &docker.APIError{Status: 404, Message: "not a DeployForge application container"}
	}
	return c, nil
}

func summarize(c *docker.ContainerJSON) protocol.ContainerSummary {
	sum := protocol.ContainerSummary{
		ID: c.ID, Name: strings.TrimPrefix(c.Name, "/"), Image: c.Image, State: c.State.Status, Running: c.State.Running,
		ExitCode: c.State.ExitCode, OOMKilled: c.State.OOMKilled, RestartCount: c.RestartCount, Labels: c.Config.Labels,
	}
	if !strings.HasPrefix(c.State.StartedAt, "0001") {
		sum.StartedAt = c.State.StartedAt
	}
	if !strings.HasPrefix(c.State.FinishedAt, "0001") {
		sum.FinishedAt = c.State.FinishedAt
	}
	if app := c.Config.Labels[protocol.LabelApplication]; app != "" {
		if ep, ok := c.NetworkSettings.Networks[NetworkName(app)]; ok {
			sum.IPAddress = ep.IPAddress
		}
	}
	if sum.Labels == nil {
		sum.Labels = map[string]string{}
	}
	return sum
}

// ---- handlers ----

func (s *Server) health(w http.ResponseWriter, r *http.Request) {
	ctx, cancel := context.WithTimeout(r.Context(), 5*time.Second)
	defer cancel()
	active, max := s.builds.Active()
	h := protocol.Health{ProtocolVersion: protocol.Version, RunnerVersion: RunnerVersion, ActiveBuilds: active, MaxConcurrentBuilds: max}
	if v, err := s.docker.Negotiate(ctx); err != nil {
		h.Docker = protocol.ComponentStatus{OK: false, Error: err.Error()}
	} else {
		h.Docker = protocol.ComponentStatus{OK: true, Version: v.Version}
	}
	h.Buildx = BuildxStatus(ctx)
	h.OK = h.Docker.OK && h.Buildx.OK
	writeJSON(w, http.StatusOK, h)
}

func (s *Server) gitResolve(w http.ResponseWriter, r *http.Request) {
	var req protocol.GitResolveRequest
	if err := decode(r, &req); err != nil {
		writeErr(w, http.StatusBadRequest, "bad_request", "invalid request body", false)
		return
	}
	ctx, cancel := context.WithTimeout(r.Context(), 30*time.Second)
	defer cancel()
	var a *gitops.Auth
	if req.Auth != nil {
		a = &gitops.Auth{Username: req.Auth.Username, Token: req.Auth.Token}
	}
	sha, found, err := s.cfg.Git.ResolveBranch(ctx, req.CloneURL, req.Branch, a)
	if err != nil {
		if errors.Is(err, gitops.ErrURLNotAllowed) {
			writeErr(w, http.StatusBadRequest, "url_not_allowed", err.Error(), false)
			return
		}
		msg := err.Error()
		if req.Auth != nil {
			msg = strings.ReplaceAll(msg, req.Auth.Token, "[REDACTED]")
		}
		writeErr(w, http.StatusBadGateway, "git_error", msg, true)
		return
	}
	writeJSON(w, http.StatusOK, protocol.GitResolveResponse{CommitSHA: sha, Found: found})
}

func (s *Server) submitBuild(w http.ResponseWriter, r *http.Request) {
	var req protocol.BuildRequest
	if err := decode(r, &req); err != nil {
		writeErr(w, http.StatusBadRequest, "bad_request", "invalid request body", false)
		return
	}
	st, err := s.builds.Submit(req)
	if err != nil {
		var ve *build.ValidationError
		if errors.As(err, &ve) {
			writeErr(w, http.StatusUnprocessableEntity, "invalid_request", ve.Msg, false)
			return
		}
		writeErr(w, http.StatusInternalServerError, "internal", err.Error(), true)
		return
	}
	writeJSON(w, http.StatusAccepted, st)
}

func (s *Server) buildStatus(w http.ResponseWriter, r *http.Request) {
	after, _ := strconv.ParseInt(r.URL.Query().Get("after"), 10, 64)
	limit, _ := strconv.Atoi(r.URL.Query().Get("limit"))
	st, ok := s.builds.Status(r.PathValue("op"), after, limit)
	if !ok {
		writeErr(w, http.StatusNotFound, "operation_not_found", "unknown build operation (the runner may have restarted)", true)
		return
	}
	writeJSON(w, http.StatusOK, st)
}

func (s *Server) cancelBuild(w http.ResponseWriter, r *http.Request) {
	if !s.builds.Cancel(r.PathValue("op")) {
		writeErr(w, http.StatusNotFound, "operation_not_found", "unknown build operation", false)
		return
	}
	w.WriteHeader(http.StatusNoContent)
}

// ensureNetwork creates the per-application network (idempotent) and attaches
// the proxy and (when containerized) the runner itself.
func (s *Server) ensureNetwork(w http.ResponseWriter, r *http.Request) {
	var req protocol.NetworkEnsureRequest
	if err := decode(r, &req); err != nil || !idRe.MatchString(req.ApplicationID) || !idRe.MatchString(req.WorkspaceID) {
		writeErr(w, http.StatusBadRequest, "bad_request", "invalid request body", false)
		return
	}
	ctx := r.Context()
	s.netMu.Lock()
	defer s.netMu.Unlock()
	name := NetworkName(req.ApplicationID)
	n, err := s.docker.InspectNetwork(ctx, name)
	if docker.IsNotFound(err) {
		_, err = s.docker.CreateNetwork(ctx, name, map[string]string{
			protocol.LabelManaged: "true", protocol.LabelInstance: s.cfg.Instance, protocol.LabelWorkspace: req.WorkspaceID, protocol.LabelApplication: req.ApplicationID,
		})
		if err == nil {
			n, err = s.docker.InspectNetwork(ctx, name)
		}
	}
	if err != nil {
		s.dockerErr(w, err)
		return
	}
	if !s.ours(n.Labels) || n.Labels[protocol.LabelApplication] != req.ApplicationID {
		writeErr(w, http.StatusConflict, "network_not_owned", "a network with this name exists but is not owned by DeployForge", false)
		return
	}
	attach := []string{}
	proxies, err := s.docker.ListContainers(ctx, protocol.LabelRole+"=proxy", protocol.LabelInstance+"="+s.cfg.Instance)
	if err != nil {
		s.dockerErr(w, err)
		return
	}
	for _, p := range proxies {
		if p.State == "running" {
			attach = append(attach, p.ID)
		}
	}
	if s.cfg.SelfContainer != "" {
		if self, err := s.docker.InspectContainer(ctx, s.cfg.SelfContainer); err == nil {
			attach = append(attach, self.ID)
		}
	}
	for _, id := range attach {
		if _, ok := n.Containers[id]; ok {
			continue
		}
		if err := s.docker.ConnectNetwork(ctx, n.ID, id); err != nil && !strings.Contains(err.Error(), "already exists") {
			s.dockerErr(w, err)
			return
		}
	}
	writeJSON(w, http.StatusOK, protocol.NetworkEnsureResponse{Name: n.Name, ID: n.ID})
}

func (s *Server) removeNetwork(w http.ResponseWriter, r *http.Request) {
	app := r.PathValue("app")
	if !idRe.MatchString(app) {
		writeErr(w, http.StatusBadRequest, "bad_request", "invalid application id", false)
		return
	}
	ctx := r.Context()
	s.netMu.Lock()
	defer s.netMu.Unlock()
	n, err := s.docker.InspectNetwork(ctx, NetworkName(app))
	if docker.IsNotFound(err) {
		w.WriteHeader(http.StatusNoContent)
		return
	}
	if err != nil {
		s.dockerErr(w, err)
		return
	}
	if !s.ours(n.Labels) || n.Labels[protocol.LabelApplication] != app {
		writeErr(w, http.StatusConflict, "network_not_owned", "network is not owned by DeployForge", false)
		return
	}
	for id := range n.Containers {
		c, err := s.docker.InspectContainer(ctx, id)
		if err != nil {
			continue
		}
		role := c.Config.Labels[protocol.LabelRole]
		if role == "app" && c.Config.Labels[protocol.LabelApplication] == app {
			writeErr(w, http.StatusConflict, "network_in_use", "application containers are still attached", false)
			return
		}
		_ = s.docker.DisconnectNetwork(ctx, n.ID, id)
	}
	if err := s.docker.RemoveNetwork(ctx, n.ID); err != nil && !docker.IsNotFound(err) {
		s.dockerErr(w, err)
		return
	}
	w.WriteHeader(http.StatusNoContent)
}

func (s *Server) listContainers(w http.ResponseWriter, r *http.Request) {
	labels := s.ownedFilter(protocol.LabelRole + "=app")
	if app := r.URL.Query().Get("applicationId"); app != "" {
		if !idRe.MatchString(app) {
			writeErr(w, http.StatusBadRequest, "bad_request", "invalid application id", false)
			return
		}
		labels = append(labels, protocol.LabelApplication+"="+app)
	}
	items, err := s.docker.ListContainers(r.Context(), labels...)
	if err != nil {
		s.dockerErr(w, err)
		return
	}
	out := []protocol.ContainerSummary{}
	for _, it := range items {
		c, err := s.docker.InspectContainer(r.Context(), it.ID)
		if err != nil {
			continue
		}
		out = append(out, summarize(c))
	}
	writeJSON(w, http.StatusOK, out)
}

func (s *Server) createContainer(w http.ResponseWriter, r *http.Request) {
	var req protocol.ContainerCreateRequest
	if err := decode(r, &req); err != nil {
		writeErr(w, http.StatusBadRequest, "bad_request", "invalid request body", false)
		return
	}
	if msg := validateCreate(&req); msg != "" {
		writeErr(w, http.StatusUnprocessableEntity, "invalid_request", msg, false)
		return
	}
	ctx := r.Context()

	// Idempotency: the deterministic container name is the key.
	if existing, err := s.docker.InspectContainer(ctx, req.Name); err == nil {
		if existing.Config.Labels[protocol.LabelDeployment] != req.DeploymentID || !s.ours(existing.Config.Labels) {
			writeErr(w, http.StatusConflict, "name_conflict", "container name belongs to another deployment", false)
			return
		}
		if !existing.State.Running && existing.State.Status == "created" {
			_ = s.docker.StartContainer(ctx, existing.ID)
			existing, _ = s.docker.InspectContainer(ctx, existing.ID)
		}
		writeJSON(w, http.StatusOK, protocol.ContainerCreateResponse{Created: false, Container: summarize(existing)})
		return
	} else if !docker.IsNotFound(err) {
		s.dockerErr(w, err)
		return
	}

	// The image must be a DeployForge build of this same application.
	img, err := s.docker.InspectImage(ctx, req.Image)
	if err != nil {
		if docker.IsNotFound(err) {
			writeErr(w, http.StatusNotFound, "image_not_found", "release image no longer exists", false)
			return
		}
		s.dockerErr(w, err)
		return
	}
	if !s.ours(img.Config.Labels) || img.Config.Labels[protocol.LabelApplication] != req.ApplicationID {
		writeErr(w, http.StatusForbidden, "image_not_owned", "image was not built by DeployForge for this application", false)
		return
	}
	net, err := s.docker.InspectNetwork(ctx, req.Network)
	if err != nil {
		s.dockerErr(w, err)
		return
	}
	if !s.ours(net.Labels) || net.Labels[protocol.LabelApplication] != req.ApplicationID {
		writeErr(w, http.StatusForbidden, "network_not_owned", "network is not this application's network", false)
		return
	}

	env := make([]string, 0, len(req.Env)+1)
	for k, v := range req.Env {
		env = append(env, k+"="+v)
	}
	env = append(env, "PORT="+strconv.Itoa(req.Port))
	pids := req.PidsLimit
	capDrop := []string{"NET_RAW", "MKNOD", "AUDIT_WRITE", "SYS_CHROOT", "SETFCAP"}
	if req.SecurityProfile == "strict" {
		capDrop = []string{"ALL"}
	}
	mem := req.MemoryLimitMB * 1024 * 1024
	cfg := docker.ContainerConfig{
		Image: img.ID,
		Env:   env,
		Labels: map[string]string{
			protocol.LabelManaged: "true", protocol.LabelInstance: s.cfg.Instance, protocol.LabelRole: "app",
			protocol.LabelWorkspace: req.WorkspaceID, protocol.LabelApplication: req.ApplicationID, protocol.LabelDeployment: req.DeploymentID,
		},
		ExposedPorts: map[string]struct{}{fmt.Sprintf("%d/tcp", req.Port): {}},
		HostConfig: docker.HostConfig{
			NanoCPUs:      int64(req.CPULimit * 1e9),
			Memory:        mem,
			MemorySwap:    mem,
			PidsLimit:     &pids,
			CapDrop:       capDrop,
			SecurityOpt:   []string{"no-new-privileges:true"},
			NetworkMode:   req.Network,
			RestartPolicy: docker.RestartPolicy{Name: "no"},
			LogConfig:     docker.LogConfig{Type: "json-file", Config: map[string]string{"max-size": "10m", "max-file": "3"}},
		},
	}
	id, err := s.docker.CreateContainer(ctx, req.Name, cfg)
	if err != nil {
		s.dockerErr(w, err)
		return
	}
	if err := s.docker.StartContainer(ctx, id); err != nil {
		s.dockerErr(w, err)
		return
	}
	c, err := s.docker.InspectContainer(ctx, id)
	if err != nil {
		s.dockerErr(w, err)
		return
	}
	s.cfg.Logger.Info("container started", "container", c.Name, "deployment", req.DeploymentID)
	writeJSON(w, http.StatusCreated, protocol.ContainerCreateResponse{Created: true, Container: summarize(c)})
}

func validateCreate(r *protocol.ContainerCreateRequest) string {
	switch {
	case !opIDRe.MatchString(r.OperationID):
		return "invalid operationId"
	case !idRe.MatchString(r.WorkspaceID) || !idRe.MatchString(r.ApplicationID) || !idRe.MatchString(r.DeploymentID):
		return "invalid resource id"
	case !containerNameRe.MatchString(r.Name):
		return "invalid container name"
	case !dockerRefRe.MatchString(strings.TrimPrefix(r.Image, "sha256:")):
		return "invalid image reference"
	case r.Network != NetworkName(r.ApplicationID):
		return "containers may only join their own application network"
	case r.Port < 1 || r.Port > 65535:
		return "invalid port"
	case r.CPULimit < 0.05 || r.CPULimit > 64:
		return "invalid cpu limit"
	case r.MemoryLimitMB < 16 || r.MemoryLimitMB > 1<<20:
		return "invalid memory limit"
	case r.PidsLimit < 16 || r.PidsLimit > 65536:
		return "invalid pids limit"
	case r.SecurityProfile != "standard" && r.SecurityProfile != "strict":
		return "invalid security profile"
	}
	for k, v := range r.Env {
		if !envKeyRe.MatchString(k) || strings.ContainsRune(v, 0) {
			return "invalid environment variable"
		}
	}
	return ""
}

func (s *Server) inspectContainer(w http.ResponseWriter, r *http.Request) {
	c, err := s.owned(r.Context(), r.PathValue("id"))
	if err != nil {
		s.dockerErr(w, err)
		return
	}
	writeJSON(w, http.StatusOK, summarize(c))
}

// probe performs one HTTP health check against the container's own address
// on its application network. It never follows redirects or uses a proxy.
func (s *Server) probe(w http.ResponseWriter, r *http.Request) {
	var req protocol.ProbeRequest
	if err := decode(r, &req); err != nil || req.Port < 1 || req.Port > 65535 || !strings.HasPrefix(req.Path, "/") || req.TimeoutMs < 100 || req.TimeoutMs > 60000 {
		writeErr(w, http.StatusBadRequest, "bad_request", "invalid probe request", false)
		return
	}
	c, err := s.owned(r.Context(), r.PathValue("id"))
	if err != nil {
		s.dockerErr(w, err)
		return
	}
	sum := summarize(c)
	res := protocol.ProbeResult{Container: sum}
	if !c.State.Running {
		res.Error = fmt.Sprintf("container is %s (exit code %d)", c.State.Status, c.State.ExitCode)
		writeJSON(w, http.StatusOK, res)
		return
	}
	if sum.IPAddress == "" {
		res.Error = "container has no address on its application network"
		writeJSON(w, http.StatusOK, res)
		return
	}
	target := "http://" + net.JoinHostPort(sum.IPAddress, strconv.Itoa(req.Port)) + req.Path
	client := &http.Client{
		Timeout:       time.Duration(req.TimeoutMs) * time.Millisecond,
		Transport:     &http.Transport{Proxy: nil, DisableKeepAlives: true},
		CheckRedirect: func(*http.Request, []*http.Request) error { return http.ErrUseLastResponse },
	}
	start := time.Now()
	hreq, _ := http.NewRequestWithContext(r.Context(), http.MethodGet, target, nil)
	hreq.Header.Set("User-Agent", "DeployForge-HealthCheck/1")
	resp, err := client.Do(hreq)
	res.DurationMs = time.Since(start).Milliseconds()
	if err != nil {
		res.Error = sanitizeNetErr(err)
	} else {
		_, _ = io.Copy(io.Discard, io.LimitReader(resp.Body, 64<<10))
		resp.Body.Close()
		res.StatusCode = resp.StatusCode
		res.OK = resp.StatusCode >= 200 && resp.StatusCode < 400
		if !res.OK {
			res.Error = fmt.Sprintf("unexpected status %d", resp.StatusCode)
		}
	}
	writeJSON(w, http.StatusOK, res)
}

func sanitizeNetErr(err error) string {
	var ne net.Error
	if errors.As(err, &ne) && ne.Timeout() {
		return "timed out waiting for a response"
	}
	msg := err.Error()
	switch {
	case strings.Contains(msg, "connection refused"):
		return "connection refused (is the app listening on this port and on 0.0.0.0?)"
	case strings.Contains(msg, "connection reset"):
		return "connection reset by the application"
	}
	if len(msg) > 200 {
		msg = msg[:200]
	}
	return msg
}

func (s *Server) promote(w http.ResponseWriter, r *http.Request) {
	c, err := s.owned(r.Context(), r.PathValue("id"))
	if err != nil {
		s.dockerErr(w, err)
		return
	}
	if err := s.docker.UpdateRestartPolicy(r.Context(), c.ID, docker.RestartPolicy{Name: "unless-stopped"}); err != nil {
		s.dockerErr(w, err)
		return
	}
	c, _ = s.docker.InspectContainer(r.Context(), c.ID)
	writeJSON(w, http.StatusOK, summarize(c))
}

func (s *Server) lifecycle(action string) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		var req protocol.StopRequest
		if r.ContentLength != 0 && r.Method == http.MethodPost {
			_ = json.NewDecoder(r.Body).Decode(&req)
		}
		if req.TimeoutSeconds <= 0 || req.TimeoutSeconds > 300 {
			req.TimeoutSeconds = 10
		}
		c, err := s.owned(r.Context(), r.PathValue("id"))
		if err != nil {
			if action == "remove" && docker.IsNotFound(err) {
				w.WriteHeader(http.StatusNoContent)
				return
			}
			s.dockerErr(w, err)
			return
		}
		ctx, cancel := context.WithTimeout(context.Background(), time.Duration(req.TimeoutSeconds+30)*time.Second)
		defer cancel()
		switch action {
		case "start":
			err = s.docker.StartContainer(ctx, c.ID)
		case "stop":
			err = s.docker.StopContainer(ctx, c.ID, req.TimeoutSeconds)
		case "restart":
			err = s.docker.RestartContainer(ctx, c.ID, req.TimeoutSeconds)
		case "remove":
			if c.State.Running {
				_ = s.docker.StopContainer(ctx, c.ID, req.TimeoutSeconds)
			}
			err = s.docker.RemoveContainer(ctx, c.ID)
			if err == nil || docker.IsNotFound(err) {
				s.cfg.Logger.Info("container removed", "container", c.Name)
				w.WriteHeader(http.StatusNoContent)
				return
			}
		}
		if err != nil {
			s.dockerErr(w, err)
			return
		}
		c, _ = s.docker.InspectContainer(ctx, c.ID)
		writeJSON(w, http.StatusOK, summarize(c))
	}
}

// logs streams container logs as NDJSON lines {ts, stream, text}.
func (s *Server) logs(w http.ResponseWriter, r *http.Request) {
	c, err := s.owned(r.Context(), r.PathValue("id"))
	if err != nil {
		s.dockerErr(w, err)
		return
	}
	q := r.URL.Query()
	follow := q.Get("follow") == "1"
	tail := q.Get("tail")
	if n, err := strconv.Atoi(tail); tail != "" && (err != nil || n < 0 || n > 5000) {
		tail = "500"
	}
	if tail == "" {
		tail = "500"
	}
	since, _ := strconv.ParseInt(q.Get("since"), 10, 64)
	w.Header().Set("Content-Type", "application/x-ndjson")
	w.WriteHeader(http.StatusOK)
	flusher, _ := w.(http.Flusher)
	enc := json.NewEncoder(w)
	pending := map[string]*strings.Builder{}
	emit := func(stream, line string) error {
		ts := ""
		if i := strings.IndexByte(line, ' '); i > 0 && i < 40 {
			ts, line = line[:i], line[i+1:]
		}
		if len(line) > 8000 {
			line = line[:8000] + " …[line truncated]"
		}
		if err := enc.Encode(map[string]string{"ts": ts, "stream": stream, "text": line}); err != nil {
			return err
		}
		if flusher != nil {
			flusher.Flush()
		}
		return nil
	}
	_ = s.docker.Logs(r.Context(), c.ID, follow, tail, since, func(f docker.LogFrame) error {
		b := pending[f.Stream]
		if b == nil {
			b = &strings.Builder{}
			pending[f.Stream] = b
		}
		b.Write(f.Data)
		data := b.String()
		b.Reset()
		for {
			i := strings.IndexByte(data, '\n')
			if i < 0 {
				b.WriteString(data)
				break
			}
			if err := emit(f.Stream, strings.TrimRight(data[:i], "\r")); err != nil {
				return err
			}
			data = data[i+1:]
		}
		return nil
	})
	for stream, b := range pending {
		if b.Len() > 0 {
			_ = emit(stream, b.String())
		}
	}
}

func (s *Server) stats(w http.ResponseWriter, r *http.Request) {
	c, err := s.owned(r.Context(), r.PathValue("id"))
	if err != nil {
		s.dockerErr(w, err)
		return
	}
	out := protocol.ContainerStats{SampledAt: time.Now().UTC().Format(time.RFC3339Nano), Running: c.State.Running, RestartCount: c.RestartCount}
	if !strings.HasPrefix(c.State.StartedAt, "0001") {
		out.StartedAt = c.State.StartedAt
	}
	if c.State.Running {
		st, err := s.docker.Stats(r.Context(), c.ID)
		if err != nil {
			s.dockerErr(w, err)
			return
		}
		out.OnlineCPUs = st.CPUStats.OnlineCPUs
		out.CPUPercent = CPUPercent(st)
		out.MemoryBytes = float64(MemoryUsage(st))
		out.MemoryLimitBytes = float64(st.MemoryStats.Limit)
		out.Pids = st.PidsStats.Current
	}
	if c.HostConfig.Memory > 0 {
		out.MemoryLimitBytes = float64(c.HostConfig.Memory)
	}
	writeJSON(w, http.StatusOK, out)
}

// CPUPercent mirrors `docker stats`: 100% equals one fully used CPU core.
func CPUPercent(st *docker.Stats) float64 {
	cpuDelta := float64(st.CPUStats.CPUUsage.TotalUsage) - float64(st.PreCPUStats.CPUUsage.TotalUsage)
	sysDelta := float64(st.CPUStats.SystemUsage) - float64(st.PreCPUStats.SystemUsage)
	cpus := st.CPUStats.OnlineCPUs
	if cpus == 0 {
		cpus = 1
	}
	if cpuDelta <= 0 || sysDelta <= 0 {
		return 0
	}
	return cpuDelta / sysDelta * float64(cpus) * 100
}

// MemoryUsage subtracts reclaimable page cache like the docker CLI does.
func MemoryUsage(st *docker.Stats) uint64 {
	u := st.MemoryStats.Usage
	for _, k := range []string{"inactive_file", "total_inactive_file"} {
		if v, ok := st.MemoryStats.Stats[k]; ok && v < u {
			return u - v
		}
	}
	return u
}

func (s *Server) listImages(w http.ResponseWriter, r *http.Request) {
	labels := s.ownedFilter()
	if app := r.URL.Query().Get("applicationId"); app != "" {
		if !idRe.MatchString(app) {
			writeErr(w, http.StatusBadRequest, "bad_request", "invalid application id", false)
			return
		}
		labels = append(labels, protocol.LabelApplication+"="+app)
	}
	items, err := s.docker.ListImages(r.Context(), labels...)
	if err != nil {
		s.dockerErr(w, err)
		return
	}
	out := []protocol.ImageSummary{}
	for _, it := range items {
		tags := it.RepoTags
		if tags == nil {
			tags = []string{}
		}
		out = append(out, protocol.ImageSummary{ID: it.ID, Tags: tags, SizeBytes: it.Size, CreatedAt: time.Unix(it.Created, 0).UTC().Format(time.RFC3339), Labels: it.Labels})
	}
	writeJSON(w, http.StatusOK, out)
}

func (s *Server) removeImage(w http.ResponseWriter, r *http.Request) {
	id := r.PathValue("id")
	if !dockerRefRe.MatchString(id) {
		writeErr(w, http.StatusBadRequest, "bad_request", "invalid image id", false)
		return
	}
	img, err := s.docker.InspectImage(r.Context(), id)
	if docker.IsNotFound(err) {
		w.WriteHeader(http.StatusNoContent)
		return
	}
	if err != nil {
		s.dockerErr(w, err)
		return
	}
	if !s.ours(img.Config.Labels) {
		writeErr(w, http.StatusForbidden, "image_not_owned", "refusing to remove an image DeployForge did not build", false)
		return
	}
	// Remove tags first, then the image itself; fails with 409 if a container still uses it.
	for _, t := range img.RepoTags {
		if err := s.docker.RemoveImage(r.Context(), t); err != nil && !docker.IsNotFound(err) {
			s.dockerErr(w, err)
			return
		}
	}
	if err := s.docker.RemoveImage(r.Context(), img.ID); err != nil && !docker.IsNotFound(err) {
		s.dockerErr(w, err)
		return
	}
	w.WriteHeader(http.StatusNoContent)
}
