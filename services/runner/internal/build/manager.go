// Package build manages bounded, asynchronous builds of exact Git commits.
package build

import (
	"context"
	"fmt"
	"io"
	"log/slog"
	"os"
	"path/filepath"
	"sync"
	"time"

	"github.com/the-null-catchers/deployforge/services/runner/internal/docker"
	"github.com/the-null-catchers/deployforge/services/runner/internal/gitops"
	"github.com/the-null-catchers/deployforge/services/runner/internal/protocol"
	"github.com/the-null-catchers/deployforge/services/runner/internal/redact"
)

const maxOperations = 128

type Config struct {
	Instance      string
	WorkDir       string
	DockerHost    string
	MaxConcurrent int
	Git           gitops.Policy
	Logger        *slog.Logger
}

type ValidationError struct{ Msg string }

func (e *ValidationError) Error() string { return e.Msg }

type operation struct {
	mu       sync.Mutex
	identity string
	status   protocol.BuildStatus
	logs     []protocol.LogLine
	logBytes int
	nextSeq  int64
	dropped  bool
	finished time.Time
	cancel   context.CancelFunc
}

type Manager struct {
	cfg     Config
	mu      sync.Mutex
	ops     map[string]*operation
	slots   chan struct{}
	active  int
	clone   func(context.Context, string, string, string, *gitops.Auth, io.Writer) error
	inspect func(context.Context, string) (*docker.ImageInspect, error)
}

func NewManager(cfg Config, d *docker.Client) *Manager {
	if cfg.MaxConcurrent <= 0 {
		cfg.MaxConcurrent = 2
	}
	if cfg.MaxConcurrent > 32 {
		cfg.MaxConcurrent = 32
	}
	if cfg.WorkDir == "" {
		cfg.WorkDir = filepath.Join(os.TempDir(), "deployforge-builds")
	}
	if cfg.DockerHost == "" {
		cfg.DockerHost = "unix:///var/run/docker.sock"
	}
	if cfg.Logger == nil {
		cfg.Logger = slog.New(slog.NewTextHandler(io.Discard, nil))
	}
	m := &Manager{cfg: cfg, ops: make(map[string]*operation), slots: make(chan struct{}, cfg.MaxConcurrent), clone: cfg.Git.Clone}
	if d != nil {
		m.inspect = d.InspectImage
	}
	return m
}

func (m *Manager) Active() (int, int) {
	m.mu.Lock()
	defer m.mu.Unlock()
	return m.active, cap(m.slots)
}

func (m *Manager) Submit(req protocol.BuildRequest) (protocol.BuildStatus, error) {
	if err := validate(m.cfg, req); err != nil {
		return protocol.BuildStatus{}, err
	}
	identity := fmt.Sprintf("%s/%s/%s/%s/%s/%s", req.WorkspaceID, req.ApplicationID, req.DeploymentID, req.Repository.CommitSHA, req.Repository.CloneURL, req.ImageTag)
	m.mu.Lock()
	defer m.mu.Unlock()
	if op := m.ops[req.OperationID]; op != nil {
		if op.identity != identity {
			return protocol.BuildStatus{}, &ValidationError{Msg: "operation ID already belongs to another build"}
		}
		return op.snapshot(0, 1000), nil
	}
	// Evict only completed operations. Never lose a running operation's cancel
	// handle, and never grow the queue or terminal-status cache without bound.
	if len(m.ops) >= maxOperations {
		var oldest string
		var when time.Time
		for id, op := range m.ops {
			op.mu.Lock()
			finished := op.finished
			op.mu.Unlock()
			if !finished.IsZero() && (oldest == "" || finished.Before(when)) {
				oldest, when = id, finished
			}
		}
		if oldest == "" {
			return protocol.BuildStatus{}, &ValidationError{Msg: "build queue is full; retry later"}
		}
		delete(m.ops, oldest)
	}
	req = copyRequest(req)
	ctx, cancel := context.WithTimeout(context.Background(), time.Duration(req.TimeoutSeconds)*time.Second)
	op := &operation{identity: identity, nextSeq: 1, cancel: cancel,
		status: protocol.BuildStatus{OperationID: req.OperationID, State: "queued", Phase: "queued", CommitSHA: req.Repository.CommitSHA}}
	m.ops[req.OperationID] = op
	initial := op.snapshot(0, 1000)
	go m.work(ctx, op, req)
	return initial, nil
}

func (m *Manager) Status(id string, after int64, limit int) (protocol.BuildStatus, bool) {
	m.mu.Lock()
	op := m.ops[id]
	m.mu.Unlock()
	if op == nil {
		return protocol.BuildStatus{}, false
	}
	return op.snapshot(after, limit), true
}

func (m *Manager) Cancel(id string) bool {
	m.mu.Lock()
	op := m.ops[id]
	m.mu.Unlock()
	if op == nil {
		return false
	}
	op.mu.Lock()
	defer op.mu.Unlock()
	if op.finished.IsZero() {
		op.cancel()
	}
	return true
}

func (m *Manager) work(ctx context.Context, op *operation, req protocol.BuildRequest) {
	defer op.cancel()
	needles := redact.ExactNeedles(secretValues(req))
	finish := func(image, message, kind string, err error) {
		op.mu.Lock()
		defer op.mu.Unlock()
		if ctx.Err() == context.Canceled {
			kind, err = "canceled", fmt.Errorf("build canceled")
		} else if ctx.Err() == context.DeadlineExceeded {
			kind, err = "timeout", fmt.Errorf("build deadline exceeded")
		}
		op.status.Phase = "done"
		op.status.CommitMessage = redact.All(message, needles)
		if err == nil {
			op.status.State, op.status.ImageID = "succeeded", image
		} else {
			op.status.State = "failed"
			if kind == "canceled" {
				op.status.State = "canceled"
			}
			op.status.FailureKind = kind
			op.status.Error = &protocol.Error{Code: "build_" + kind, Message: redact.All(err.Error(), needles), Retryable: kind == "clone" || kind == "internal"}
		}
		op.finished = time.Now()
	}
	defer func() {
		if recover() != nil {
			m.cfg.Logger.Error("build worker panicked", "operation", req.OperationID)
			finish("", "", "internal", fmt.Errorf("internal build failure"))
		}
	}()
	select {
	case m.slots <- struct{}{}:
		defer func() { <-m.slots }()
	case <-ctx.Done():
		finish("", "", "internal", ctx.Err())
		return
	}
	if ctx.Err() != nil {
		finish("", "", "internal", ctx.Err())
		return
	}
	m.mu.Lock()
	m.active++
	m.mu.Unlock()
	defer func() {
		m.mu.Lock()
		m.active--
		m.mu.Unlock()
	}()
	op.phase("cloning")
	image, message, kind, err := m.execute(ctx, op, req)
	finish(image, message, kind, err)
}

func (op *operation) phase(phase string) {
	op.mu.Lock()
	defer op.mu.Unlock()
	op.status.State, op.status.Phase = "running", phase
}

func copyRequest(r protocol.BuildRequest) protocol.BuildRequest {
	args := make(map[string]string, len(r.BuildArgs))
	for k, v := range r.BuildArgs {
		args[k] = v
	}
	r.BuildArgs = args
	r.BuildSecrets = append([]protocol.BuildSecret(nil), r.BuildSecrets...)
	r.Redact = append([]string(nil), r.Redact...)
	if r.Repository.Auth != nil {
		auth := *r.Repository.Auth
		r.Repository.Auth = &auth
	}
	return r
}
