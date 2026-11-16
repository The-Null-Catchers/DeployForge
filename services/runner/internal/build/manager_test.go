package build

import (
	"context"
	"errors"
	"fmt"
	"io"
	"os"
	"path/filepath"
	"strings"
	"sync/atomic"
	"testing"
	"time"

	"github.com/the-null-catchers/deployforge/services/runner/internal/gitops"
	"github.com/the-null-catchers/deployforge/services/runner/internal/protocol"
)

func request() protocol.BuildRequest {
	return protocol.BuildRequest{OperationID: "build-operation001", WorkspaceID: "workspace001", ApplicationID: "application001", DeploymentID: "deployment001",
		Repository: protocol.Repository{CloneURL: "https://github.com/acme/app.git", CommitSHA: strings.Repeat("a", 40)},
		ContextDir: ".", DockerfilePath: "Dockerfile", ImageTag: "deployforge/application001:deployment001", TimeoutSeconds: 30}
}

func manager(t *testing.T, concurrent int) *Manager {
	t.Helper()
	return NewManager(Config{Instance: "test", WorkDir: t.TempDir(), MaxConcurrent: concurrent, Git: gitops.Policy{AllowedHosts: []string{"github.com"}}}, nil)
}

func waitStatus(t *testing.T, m *Manager, id string, want func(protocol.BuildStatus) bool) protocol.BuildStatus {
	t.Helper()
	deadline := time.Now().Add(5 * time.Second)
	for time.Now().Before(deadline) {
		if s, ok := m.Status(id, 0, 1000); ok && want(s) {
			return s
		}
		time.Sleep(time.Millisecond)
	}
	s, _ := m.Status(id, 0, 1000)
	t.Fatalf("operation did not reach expected state: %+v", s)
	return s
}

func terminal(s protocol.BuildStatus) bool { return s.Phase == "done" }

func TestValidation(t *testing.T) {
	m := manager(t, 2)
	cases := map[string]func(*protocol.BuildRequest){
		"identity":         func(r *protocol.BuildRequest) { r.OperationID = "../../x" },
		"sha":              func(r *protocol.BuildRequest) { r.Repository.CommitSHA = "main" },
		"url":              func(r *protocol.BuildRequest) { r.Repository.CloneURL = "file:///etc" },
		"credential URL":   func(r *protocol.BuildRequest) { r.Repository.CloneURL = "https://secret@github.com/acme/app.git" },
		"context":          func(r *protocol.BuildRequest) { r.ContextDir = "../private" },
		"Dockerfile":       func(r *protocol.BuildRequest) { r.DockerfilePath = "/etc/passwd" },
		"foreign image":    func(r *protocol.BuildRequest) { r.ImageTag = "ubuntu:latest" },
		"timeout":          func(r *protocol.BuildRequest) { r.TimeoutSeconds = 1 },
		"argument":         func(r *protocol.BuildRequest) { r.BuildArgs = map[string]string{"--output": "type=local"} },
		"secret path":      func(r *protocol.BuildRequest) { r.BuildSecrets = []protocol.BuildSecret{{ID: "../escape"}} },
		"duplicate secret": func(r *protocol.BuildRequest) { r.BuildSecrets = []protocol.BuildSecret{{ID: "TOKEN"}, {ID: "TOKEN"}} },
	}
	for name, mutate := range cases {
		t.Run(name, func(t *testing.T) {
			r := request()
			mutate(&r)
			_, err := m.Submit(r)
			var validation *ValidationError
			if !errors.As(err, &validation) {
				t.Fatalf("expected validation error, got %v", err)
			}
		})
	}
	if len(m.ops) != 0 {
		t.Fatal("invalid requests must not enter the queue")
	}
}

func TestConcurrentLimitQueuedCancelAndIdempotency(t *testing.T) {
	m := manager(t, 2)
	var active, peak atomic.Int32
	started := make(chan struct{}, 4)
	m.clone = func(ctx context.Context, _, _, _ string, _ *gitops.Auth, _ io.Writer) error {
		n := active.Add(1)
		defer active.Add(-1)
		for old := peak.Load(); n > old && !peak.CompareAndSwap(old, n); old = peak.Load() {
		}
		started <- struct{}{}
		<-ctx.Done()
		return ctx.Err()
	}
	for i := 0; i < 4; i++ {
		r := request()
		r.OperationID = fmt.Sprintf("build-operation%03d", i)
		if _, err := m.Submit(r); err != nil {
			t.Fatal(err)
		}
	}
	for i := 0; i < 2; i++ {
		select {
		case <-started:
		case <-time.After(5 * time.Second):
			t.Fatal("workers did not start")
		}
	}
	if a, max := m.Active(); a != 2 || max != 2 {
		t.Fatalf("active/max %d/%d", a, max)
	}
	var queued string
	for i := 0; i < 4; i++ {
		id := fmt.Sprintf("build-operation%03d", i)
		s, _ := m.Status(id, 0, 1)
		if s.State == "queued" {
			queued = id
			break
		}
	}
	if queued == "" || !m.Cancel(queued) {
		t.Fatal("no queued operation to cancel")
	}
	if s := waitStatus(t, m, queued, terminal); s.State != "canceled" {
		t.Fatalf("queued cancel: %+v", s)
	}
	r := request()
	r.OperationID = queued
	if s, err := m.Submit(r); err != nil || s.State != "canceled" {
		t.Fatalf("duplicate restarted canceled build: %+v %v", s, err)
	}
	r.DeploymentID = "deployment999"
	r.ImageTag = "deployforge/" + r.ApplicationID + ":" + r.DeploymentID
	if _, err := m.Submit(r); err == nil {
		t.Fatal("cross-deployment operation ID accepted")
	}
	for i := 0; i < 4; i++ {
		m.Cancel(fmt.Sprintf("build-operation%03d", i))
	}
	for i := 0; i < 4; i++ {
		waitStatus(t, m, fmt.Sprintf("build-operation%03d", i), terminal)
	}
	if peak.Load() != 2 {
		t.Fatalf("concurrent clones: %d", peak.Load())
	}
	if m.Cancel("unknown-operation") {
		t.Fatal("unknown cancel succeeded")
	}
	if _, ok := m.Status("unknown-operation", 0, 1); ok {
		t.Fatal("unknown status succeeded")
	}
}

func TestDeadlineAndFailureRedaction(t *testing.T) {
	for _, timeout := range []bool{false, true} {
		t.Run(fmt.Sprint(timeout), func(t *testing.T) {
			m := manager(t, 1)
			r := request()
			r.BuildSecrets = []protocol.BuildSecret{{ID: "TOKEN", Value: "abc"}}
			m.clone = func(ctx context.Context, _, _, _ string, _ *gitops.Auth, out io.Writer) error {
				if timeout {
					<-ctx.Done()
					return ctx.Err()
				}
				io.WriteString(out, "a")
				io.WriteString(out, "bc\n")
				return errors.New("clone rejected abc")
			}
			duration := time.Second
			if timeout {
				duration = 15 * time.Millisecond
			}
			ctx, cancel := context.WithTimeout(context.Background(), duration)
			defer cancel()
			op := &operation{nextSeq: 1, cancel: cancel, status: protocol.BuildStatus{OperationID: r.OperationID, State: "queued", Phase: "queued"}}
			m.work(ctx, op, r)
			s := op.snapshot(0, 1000)
			want := "clone"
			if timeout {
				want = "timeout"
			}
			if s.State != "failed" || s.FailureKind != want {
				t.Fatalf("failure classification: %+v", s)
			}
			if strings.Contains(fmt.Sprint(s), "abc") {
				t.Fatalf("secret in logs/error: %+v", s)
			}
			if entries, _ := os.ReadDir(m.cfg.WorkDir); len(entries) != 0 {
				t.Fatal("workspace was not cleaned")
			}
		})
	}
}

func TestQueueCapacityAndTerminalEviction(t *testing.T) {
	m := manager(t, 1)
	for i := 0; i < maxOperations; i++ {
		m.ops[fmt.Sprint(i)] = &operation{}
	}
	if _, err := m.Submit(request()); err == nil {
		t.Fatal("unbounded queue admitted work")
	}
	m.ops["0"].finished = time.Now().Add(-time.Hour)
	m.clone = func(context.Context, string, string, string, *gitops.Auth, io.Writer) error {
		return errors.New("fixture clone failure")
	}
	if _, err := m.Submit(request()); err != nil {
		t.Fatal(err)
	}
	waitStatus(t, m, request().OperationID, terminal)
	if _, ok := m.ops["0"]; ok {
		t.Fatal("old terminal operation was not evicted")
	}
	if len(m.ops) != maxOperations {
		t.Fatalf("cache grew: %d", len(m.ops))
	}
}

func TestSnapshotPaginationBoundsAndCopies(t *testing.T) {
	op := &operation{nextSeq: 1, status: protocol.BuildStatus{Error: &protocol.Error{Message: "original"}}}
	for i := 0; i < maxLogLines+10; i++ {
		op.addLog("stdout", fmt.Sprint(i))
	}
	var after int64
	seen := map[int64]bool{}
	for {
		s := op.snapshot(after, 7)
		if !s.LogsTruncated {
			t.Fatal("missing truncation marker")
		}
		if len(s.Logs) == 0 {
			break
		}
		for _, line := range s.Logs {
			if seen[line.Seq] {
				t.Fatal("duplicate cursor record")
			}
			seen[line.Seq] = true
		}
		after = s.NextSeq
	}
	if len(seen) != maxLogLines {
		t.Fatalf("lost retained log records: %d", len(seen))
	}
	s := op.snapshot(0, 1)
	s.Logs[0].Text = "mutated"
	s.Error.Message = "mutated"
	if next := op.snapshot(0, 1); next.Logs[0].Text == "mutated" || next.Error.Message != "original" {
		t.Fatal("snapshot exposed mutable status")
	}
	for i := 0; i < 300; i++ {
		op.addLog("stderr", strings.Repeat("x", maxLineBytes))
	}
	if op.logBytes > maxLogBytes {
		t.Fatalf("log memory unbounded: %d", op.logBytes)
	}
}

func TestPostCloneSymlinkEscapeIsConfigFailure(t *testing.T) {
	m := manager(t, 1)
	outside := t.TempDir()
	if err := os.WriteFile(filepath.Join(outside, "Dockerfile"), []byte("FROM scratch"), 0600); err != nil {
		t.Fatal(err)
	}
	m.clone = func(_ context.Context, dir, _, _ string, _ *gitops.Auth, _ io.Writer) error {
		return os.Symlink(outside, filepath.Join(dir, "escape"))
	}
	r := request()
	r.ContextDir = "escape"
	r.DockerfilePath = "escape/Dockerfile"
	if _, err := m.Submit(r); err != nil {
		t.Fatal(err)
	}
	if s := waitStatus(t, m, r.OperationID, terminal); s.FailureKind != "config" {
		t.Fatalf("escape allowed: %+v", s)
	}
}
