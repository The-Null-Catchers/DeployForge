//go:build docker

// Real Docker integration tests. Run with:
//
//	go test -tags docker -timeout 20m ./internal/server/
//
// Requires a running Docker daemon with buildx, and the `git` CLI.
package server

import (
	"bytes"
	"context"
	"crypto/rand"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"io"
	"log/slog"
	"net/http"
	"net/http/httptest"
	"net/url"
	"os"
	"os/exec"
	"path/filepath"
	"strconv"
	"strings"
	"testing"
	"time"

	"github.com/the-null-catchers/deployforge/services/runner/internal/auth"
	"github.com/the-null-catchers/deployforge/services/runner/internal/build"
	"github.com/the-null-catchers/deployforge/services/runner/internal/docker"
	"github.com/the-null-catchers/deployforge/services/runner/internal/gitops"
	"github.com/the-null-catchers/deployforge/services/runner/internal/protocol"
)

const secret = "integration-secret-integration-secret"

type harness struct {
	t      *testing.T
	srv    *httptest.Server
	docker *docker.Client
	shas   map[string]string
	repo   string
}

func newHarness(t *testing.T) *harness {
	t.Helper()
	root := t.TempDir()
	script := filepath.Join("..", "..", "..", "..", "scripts", "make-fixture-repo.sh")
	out, err := exec.Command("bash", script, root).CombinedOutput()
	if err != nil {
		t.Fatalf("fixture: %v\n%s", err, out)
	}
	shas := map[string]string{}
	raw, _ := os.ReadFile(filepath.Join(root, "shas.json"))
	if err := json.Unmarshal(raw, &shas); err != nil {
		t.Fatal(err)
	}
	fh, err := gitops.FixtureHandler(root, "fixture-token-123456")
	if err != nil {
		t.Fatal(err)
	}
	gitSrv := httptest.NewServer(fh)
	t.Cleanup(gitSrv.Close)
	u, _ := url.Parse(gitSrv.URL)

	d := docker.New("/var/run/docker.sock")
	if _, err := d.Negotiate(context.Background()); err != nil {
		t.Skipf("docker unavailable: %v", err)
	}
	logger := slog.New(slog.NewTextHandler(io.Discard, nil))
	pol := gitops.Policy{InsecureHTTPHosts: []string{u.Host}}
	bm := build.NewManager(build.Config{WorkDir: t.TempDir(), DockerHost: "unix:///var/run/docker.sock", MaxConcurrent: 2, Git: pol, Logger: logger}, d)
	s := New(Config{Secret: []byte(secret), Git: pol, Logger: logger}, d, bm)
	srv := httptest.NewServer(s.Handler())
	t.Cleanup(srv.Close)
	return &harness{t: t, srv: srv, docker: d, shas: shas, repo: gitSrv.URL + "/demo/sample-app.git"}
}

func nonce() string {
	b := make([]byte, 12)
	_, _ = rand.Read(b)
	return hex.EncodeToString(b)
}

func (h *harness) call(method, path string, body any, out any) int {
	h.t.Helper()
	var raw []byte
	if body != nil {
		raw, _ = json.Marshal(body)
	}
	req, _ := http.NewRequest(method, h.srv.URL+path, bytes.NewReader(raw))
	ts := strconv.FormatInt(time.Now().Unix(), 10)
	n := nonce()
	req.Header.Set(protocol.HeaderProtocol, "1")
	req.Header.Set(protocol.HeaderTimestamp, ts)
	req.Header.Set(protocol.HeaderNonce, n)
	req.Header.Set(protocol.HeaderSignature, auth.Sign([]byte(secret), auth.Canonical(method, path, ts, n, raw)))
	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		h.t.Fatal(err)
	}
	defer resp.Body.Close()
	b, _ := io.ReadAll(resp.Body)
	if out != nil && len(b) > 0 {
		if err := json.Unmarshal(b, out); err != nil {
			h.t.Fatalf("decode %s %s (%d): %v: %s", method, path, resp.StatusCode, err, b)
		}
	}
	return resp.StatusCode
}

func id(prefix string) string { return prefix + nonce()[:12] }

// build runs a build to completion and returns the final status plus all logs.
func (h *harness) build(app, dep, sha string, secrets []protocol.BuildSecret) (protocol.BuildStatus, []protocol.LogLine) {
	h.t.Helper()
	req := protocol.BuildRequest{
		OperationID: "build-" + dep, WorkspaceID: "wsintegration", ApplicationID: app, DeploymentID: dep,
		Repository: protocol.Repository{CloneURL: h.repo, CommitSHA: sha, Auth: &protocol.RepoAuth{Username: "x-access-token", Token: "fixture-token-123456"}},
		ContextDir: ".", DockerfilePath: "Dockerfile", BuildArgs: map[string]string{"BUILD_LABEL": "it-" + dep},
		BuildSecrets: secrets, ImageTag: "deployforge/" + app + ":" + dep, TimeoutSeconds: 600, Redact: []string{},
	}
	var st protocol.BuildStatus
	if code := h.call("POST", "/v1/builds", req, &st); code != 202 {
		h.t.Fatalf("submit build: %d", code)
	}
	var logs []protocol.LogLine
	var after int64
	deadline := time.Now().Add(10 * time.Minute)
	for time.Now().Before(deadline) {
		h.call("GET", fmt.Sprintf("/v1/builds/build-%s?after=%d", dep, after), nil, &st)
		logs = append(logs, st.Logs...)
		after = st.NextSeq
		if st.State == "succeeded" || st.State == "failed" || st.State == "canceled" {
			return st, logs
		}
		time.Sleep(500 * time.Millisecond)
	}
	h.t.Fatal("build timed out")
	return st, logs
}

func (h *harness) cleanupApp(app string) {
	ctx := context.Background()
	cs, _ := h.docker.ListContainers(ctx, protocol.LabelApplication+"="+app)
	for _, c := range cs {
		_ = h.docker.RemoveContainer(ctx, c.ID)
	}
	h.call("DELETE", "/v1/networks/"+app, nil, nil)
	imgs, _ := h.docker.ListImages(ctx, protocol.LabelApplication+"="+app)
	for _, i := range imgs {
		for _, t := range i.RepoTags {
			_ = h.docker.RemoveImage(ctx, t)
		}
		_ = h.docker.RemoveImage(ctx, i.ID)
	}
}

func joined(logs []protocol.LogLine) string {
	var b strings.Builder
	for _, l := range logs {
		b.WriteString(l.Text + "\n")
	}
	return b.String()
}

func TestBuildDeployProbe(t *testing.T) {
	h := newHarness(t)
	app, dep := id("app"), id("dep")
	t.Cleanup(func() { h.cleanupApp(app) })

	buildSecret := "super-secret-build-value-42"
	st, logs := h.build(app, dep, h.shas["A"], []protocol.BuildSecret{{ID: "SAMPLE_BUILD_SECRET", Value: buildSecret}})
	if st.State != "succeeded" || !strings.HasPrefix(st.ImageID, "sha256:") {
		t.Fatalf("build failed: %+v\n%s", st.Error, joined(logs))
	}
	if st.CommitMessage != "Release A" {
		t.Errorf("commit message %q", st.CommitMessage)
	}
	all := joined(logs)
	if strings.Contains(all, buildSecret) || strings.Contains(all, "fixture-token-123456") {
		t.Fatal("secret leaked into build logs")
	}
	if !strings.Contains(all, "build secret present (27 bytes)") {
		t.Errorf("expected BuildKit secret mount to be visible to the build:\n%s", all)
	}
	// The secret must not be in the image history/config.
	hist, _ := exec.Command("docker", "history", "--no-trunc", st.ImageID).CombinedOutput()
	insp, _ := exec.Command("docker", "image", "inspect", st.ImageID).CombinedOutput()
	if strings.Contains(string(hist)+string(insp), buildSecret) {
		t.Fatal("build secret persisted in image metadata")
	}

	// Idempotent resubmission returns the same operation.
	var again protocol.BuildStatus
	h.call("POST", "/v1/builds", protocol.BuildRequest{
		OperationID: "build-" + dep, WorkspaceID: "wsintegration", ApplicationID: app, DeploymentID: dep,
		Repository: protocol.Repository{CloneURL: h.repo, CommitSHA: h.shas["A"]}, ContextDir: ".", DockerfilePath: "Dockerfile",
		BuildArgs: map[string]string{}, BuildSecrets: []protocol.BuildSecret{}, ImageTag: "deployforge/" + app + ":" + dep, TimeoutSeconds: 600, Redact: []string{},
	}, &again)
	if again.ImageID != st.ImageID {
		t.Fatalf("idempotent build returned %s, want %s", again.ImageID, st.ImageID)
	}

	var netResp protocol.NetworkEnsureResponse
	if code := h.call("POST", "/v1/networks", protocol.NetworkEnsureRequest{WorkspaceID: "wsintegration", ApplicationID: app}, &netResp); code != 200 {
		t.Fatalf("network: %d", code)
	}
	create := protocol.ContainerCreateRequest{
		OperationID: "start-" + dep, WorkspaceID: "wsintegration", ApplicationID: app, DeploymentID: dep,
		Name: "df-it-" + dep, Image: st.ImageID, Env: map[string]string{"GREETING": "hi"}, Port: 3000,
		CPULimit: 0.5, MemoryLimitMB: 128, PidsLimit: 128, SecurityProfile: "standard", Network: netResp.Name,
	}
	var cr protocol.ContainerCreateResponse
	if code := h.call("POST", "/v1/containers", create, &cr); code != 201 || !cr.Created {
		t.Fatalf("create: %d %+v", code, cr)
	}
	// Duplicate create is idempotent.
	var cr2 protocol.ContainerCreateResponse
	if code := h.call("POST", "/v1/containers", create, &cr2); code != 200 || cr2.Created || cr2.Container.ID != cr.Container.ID {
		t.Fatalf("duplicate create not idempotent: %d %+v", code, cr2)
	}
	// Hardening applied.
	insp2, _ := h.docker.InspectContainer(context.Background(), cr.Container.ID)
	if insp2.HostConfig.Memory != 128*1024*1024 {
		t.Errorf("memory limit %d", insp2.HostConfig.Memory)
	}
	raw, _ := exec.Command("docker", "inspect", "--format", "{{json .HostConfig.SecurityOpt}} {{json .HostConfig.CapDrop}} {{.HostConfig.Privileged}} {{json .HostConfig.Binds}}", cr.Container.ID).CombinedOutput()
	if !strings.Contains(string(raw), "no-new-privileges:true") || !strings.Contains(string(raw), "NET_RAW") || !strings.Contains(string(raw), "false null") {
		t.Errorf("unexpected hardening: %s", raw)
	}

	var pr protocol.ProbeResult
	ok := false
	for i := 0; i < 40 && !ok; i++ {
		h.call("POST", "/v1/containers/"+cr.Container.ID+"/probe", protocol.ProbeRequest{Port: 3000, Path: "/health", TimeoutMs: 2000}, &pr)
		ok = pr.OK
		if !ok {
			time.Sleep(500 * time.Millisecond)
		}
	}
	if !ok {
		t.Fatalf("probe never succeeded: %+v", pr)
	}

	var stats protocol.ContainerStats
	if code := h.call("GET", "/v1/containers/"+cr.Container.ID+"/stats", nil, &stats); code != 200 || !stats.Running || stats.MemoryLimitBytes != 128*1024*1024 {
		t.Fatalf("stats: %d %+v", code, stats)
	}

	req, _ := http.NewRequest("GET", h.srv.URL+"/v1/containers/"+cr.Container.ID+"/logs?tail=50", nil)
	path := "/v1/containers/" + cr.Container.ID + "/logs?tail=50"
	ts := strconv.FormatInt(time.Now().Unix(), 10)
	n := nonce()
	req.Header.Set(protocol.HeaderProtocol, "1")
	req.Header.Set(protocol.HeaderTimestamp, ts)
	req.Header.Set(protocol.HeaderNonce, n)
	req.Header.Set(protocol.HeaderSignature, auth.Sign([]byte(secret), auth.Canonical("GET", path, ts, n, nil)))
	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		t.Fatal(err)
	}
	body, _ := io.ReadAll(resp.Body)
	resp.Body.Close()
	if !strings.Contains(string(body), "listening on 0.0.0.0:3000") {
		t.Fatalf("runtime logs missing startup line: %s", body)
	}

	// Removing an image in use by a container is refused (409).
	if code := h.call("DELETE", "/v1/images/"+st.ImageID, nil, nil); code != 409 {
		t.Errorf("expected conflict deleting in-use image, got %d", code)
	}
	if code := h.call("DELETE", "/v1/containers/"+cr.Container.ID, nil, nil); code != 204 {
		t.Fatalf("remove: %d", code)
	}
	if code := h.call("DELETE", "/v1/images/"+st.ImageID, nil, nil); code != 204 {
		t.Fatalf("remove image: %d", code)
	}
}

func TestInvalidDockerfileFailsAsBuildError(t *testing.T) {
	h := newHarness(t)
	app, dep := id("app"), id("dep")
	t.Cleanup(func() { h.cleanupApp(app) })
	st, logs := h.build(app, dep, h.shas["broken"], nil)
	if st.State != "failed" || st.FailureKind != "build" {
		t.Fatalf("expected build failure, got %+v", st)
	}
	if !strings.Contains(joined(logs), "exit") {
		t.Errorf("build log should show the failing step:\n%s", joined(logs))
	}
}

func TestMissingCommitFailsAsCloneError(t *testing.T) {
	h := newHarness(t)
	app, dep := id("app"), id("dep")
	st, _ := h.build(app, dep, strings.Repeat("ab", 20), nil)
	if st.State != "failed" || st.FailureKind != "clone" {
		t.Fatalf("expected clone failure, got %+v", st)
	}
}

func TestCrashingContainerIsReported(t *testing.T) {
	h := newHarness(t)
	app, dep := id("app"), id("dep")
	t.Cleanup(func() { h.cleanupApp(app) })
	st, logs := h.build(app, dep, h.shas["crash"], nil)
	if st.State != "succeeded" {
		t.Fatalf("build: %+v\n%s", st, joined(logs))
	}
	var netResp protocol.NetworkEnsureResponse
	h.call("POST", "/v1/networks", protocol.NetworkEnsureRequest{WorkspaceID: "wsintegration", ApplicationID: app}, &netResp)
	var cr protocol.ContainerCreateResponse
	h.call("POST", "/v1/containers", protocol.ContainerCreateRequest{
		OperationID: "start-" + dep, WorkspaceID: "wsintegration", ApplicationID: app, DeploymentID: dep,
		Name: "df-it-" + dep, Image: st.ImageID, Env: map[string]string{}, Port: 3000,
		CPULimit: 0.5, MemoryLimitMB: 128, PidsLimit: 128, SecurityProfile: "strict", Network: netResp.Name,
	}, &cr)
	var pr protocol.ProbeResult
	for i := 0; i < 20; i++ {
		h.call("POST", "/v1/containers/"+cr.Container.ID+"/probe", protocol.ProbeRequest{Port: 3000, Path: "/health", TimeoutMs: 1000}, &pr)
		if !pr.Container.Running {
			break
		}
		time.Sleep(300 * time.Millisecond)
	}
	if pr.OK || pr.Container.Running || pr.Container.ExitCode != 3 {
		t.Fatalf("expected exited container with code 3, got %+v", pr)
	}
}

func TestOwnershipEnforced(t *testing.T) {
	h := newHarness(t)
	ctx := context.Background()
	// A container not created by DeployForge.
	out, err := exec.Command("docker", "run", "-d", "--rm", "alpine:3.20", "sleep", "60").CombinedOutput()
	if err != nil {
		t.Skipf("cannot start foreign container: %s", out)
	}
	foreign := strings.TrimSpace(string(out))
	defer h.docker.RemoveContainer(ctx, foreign)
	for _, p := range []string{"/v1/containers/" + foreign, "/v1/containers/" + foreign + "/stats"} {
		if code := h.call("GET", p, nil, nil); code != 404 {
			t.Errorf("GET %s on foreign container: %d", p, code)
		}
	}
	if code := h.call("DELETE", "/v1/containers/"+foreign, nil, nil); code != 204 {
		// 204 because a non-owned container is reported as not found; it must still exist.
		t.Errorf("delete foreign: %d", code)
	}
	if _, err := h.docker.InspectContainer(ctx, foreign); err != nil {
		t.Fatal("foreign container was removed")
	}
	if code := h.call("DELETE", "/v1/images/alpine:3.20", nil, nil); code != 403 {
		t.Errorf("expected 403 deleting foreign image, got %d", code)
	}
	// Containers may only join their own application network.
	var e protocol.Error
	code := h.call("POST", "/v1/containers", protocol.ContainerCreateRequest{
		OperationID: "start-xxxxxxxx", WorkspaceID: "wsintegration", ApplicationID: "appaaaaaaaa", DeploymentID: "depaaaaaaaa",
		Name: "df-evil-1", Image: "alpine:3.20", Env: map[string]string{}, Port: 80, CPULimit: 1, MemoryLimitMB: 64, PidsLimit: 64,
		SecurityProfile: "standard", Network: "bridge",
	}, &e)
	if code != 422 {
		t.Errorf("expected 422 for foreign network, got %d", code)
	}
	code = h.call("POST", "/v1/containers", protocol.ContainerCreateRequest{
		OperationID: "start-yyyyyyyy", WorkspaceID: "wsintegration", ApplicationID: "appaaaaaaaa", DeploymentID: "depaaaaaaaa",
		Name: "df-evil-2", Image: "alpine:3.20", Env: map[string]string{}, Port: 80, CPULimit: 1, MemoryLimitMB: 64, PidsLimit: 64,
		SecurityProfile: "standard", Network: NetworkName("appaaaaaaaa"),
	}, &e)
	if code != 403 {
		t.Errorf("expected 403 launching a non-DeployForge image, got %d (%+v)", code, e)
	}
}

func TestUnauthenticatedRejected(t *testing.T) {
	h := newHarness(t)
	resp, err := http.Get(h.srv.URL + "/v1/health")
	if err != nil {
		t.Fatal(err)
	}
	resp.Body.Close()
	if resp.StatusCode != 401 {
		t.Fatalf("expected 401, got %d", resp.StatusCode)
	}
	var hl protocol.Health
	if code := h.call("GET", "/v1/health", nil, &hl); code != 200 || !hl.Docker.OK || !hl.Buildx.OK {
		t.Fatalf("health: %d %+v", code, hl)
	}
}
