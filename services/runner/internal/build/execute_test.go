package build

import (
	"context"
	"fmt"
	"io"
	"os"
	"os/exec"
	"path/filepath"
	"strconv"
	"strings"
	"testing"
	"time"

	"github.com/the-null-catchers/deployforge/services/runner/internal/docker"
	"github.com/the-null-catchers/deployforge/services/runner/internal/gitops"
	"github.com/the-null-catchers/deployforge/services/runner/internal/protocol"
)

const testImage = "sha256:0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef"

func fakeDocker(t *testing.T, body string) string {
	t.Helper()
	bin := t.TempDir()
	metadata := fmt.Sprintf(`previous=''
for arg in "$@"; do
  if [ "$previous" = --metadata-file ]; then
    printf '{"containerimage.config.digest":"%s"}\n' > "$arg"
  fi
  previous="$arg"
done
`, testImage)
	if err := os.WriteFile(filepath.Join(bin, "docker"), []byte("#!/bin/sh\nset -eu\n"+metadata+body), 0700); err != nil {
		t.Fatal(err)
	}
	t.Setenv("PATH", bin+":"+os.Getenv("PATH"))
	return bin
}

func TestBuildUsesConfigDigestAndVerifiesIdentity(t *testing.T) {
	for _, scenario := range []string{"manifest iid", "invalid metadata", "mismatched inspection"} {
		t.Run(scenario, func(t *testing.T) {
			body := fmt.Sprintf(`previous=''
for arg in "$@"; do
  if [ "$previous" = --iidfile ]; then printf 'sha256:%s\n' > "$arg"; fi
`, strings.Repeat("b", 64))
			if scenario == "invalid metadata" {
				body += "  if [ \"$previous\" = --metadata-file ]; then printf '{}' > \"$arg\"; fi\n"
			}
			body += "  previous=\"$arg\"\ndone\n"
			fakeDocker(t, body)
			m := manager(t, 1)
			m.clone = fixtureClone
			m.inspect = func(ctx context.Context, id string) (*docker.ImageInspect, error) {
				if id != testImage {
					t.Errorf("inspected manifest instead of config digest: %s", id)
				}
				img, err := inspectFixture(ctx, id)
				if scenario == "mismatched inspection" {
					img.ID = "sha256:" + strings.Repeat("c", 64)
				}
				return img, err
			}
			if _, err := m.Submit(request()); err != nil {
				t.Fatal(err)
			}
			s := waitStatus(t, m, request().OperationID, terminal)
			if scenario == "manifest iid" {
				if s.State != "succeeded" || s.ImageID != testImage {
					t.Fatalf("config digest not used: %+v", s)
				}
			} else if s.State != "failed" || s.FailureKind != "internal" || s.ImageID != "" {
				t.Fatalf("invalid image identity accepted: %+v", s)
			}
		})
	}
}

func fixtureClone(_ context.Context, dir, _, _ string, _ *gitops.Auth, _ io.Writer) error {
	if err := os.Mkdir(filepath.Join(dir, "nested app"), 0700); err != nil {
		return err
	}
	if err := os.WriteFile(filepath.Join(dir, "Dockerfile"), []byte("FROM scratch\n"), 0600); err != nil {
		return err
	}
	cmd := exec.Command("git", "init", "--quiet", dir)
	if err := cmd.Run(); err != nil {
		return err
	}
	cmd = exec.Command("git", "-C", dir, "-c", "user.name=Fixture", "-c", "user.email=fixture@example.invalid", "commit", "--quiet", "--allow-empty", "-m", "Fixture release")
	return cmd.Run()
}

func inspectFixture(_ context.Context, id string) (*docker.ImageInspect, error) {
	r := request()
	img := &docker.ImageInspect{ID: id}
	img.Config.Labels = map[string]string{protocol.LabelManaged: "true", protocol.LabelInstance: "test", protocol.LabelRole: "app", protocol.LabelApplication: r.ApplicationID, protocol.LabelDeployment: r.DeploymentID, protocol.LabelWorkspace: r.WorkspaceID}
	return img, nil
}

func TestBuildCommandSecretsOwnershipAndCleanup(t *testing.T) {
	record := filepath.Join(t.TempDir(), "args")
	fakeDocker(t, fmt.Sprintf(`printf '%%s\n' "$@" > %q
test "$1" = buildx
test "$2" = build
iid=''
while [ "$#" -gt 0 ]; do
  case "$1" in
    --iidfile) iid="$2"; shift 2 ;;
    --secret)
      source="${2#*,src=}"
      test "$(stat -c %%a "$source")" = 600
      case "$source" in */repo/*) exit 77 ;; esac
      cat "$source"
      printf '\n'
      shift 2 ;;
    *) shift ;;
  esac
done
test -n "$iid"
printf '%%s\n' '%s' > "$iid"
`, record, testImage))
	m := manager(t, 1)
	m.clone = fixtureClone
	m.inspect = inspectFixture
	r := request()
	r.ContextDir = "nested app"
	r.BuildArgs = map[string]string{"GREETING": "hello; $(not-a-command)"}
	r.BuildSecrets = []protocol.BuildSecret{{ID: "TOKEN", Value: "private-build-secret"}, {ID: "SHORT", Value: "abc"}}
	r.Repository.Auth = &protocol.RepoAuth{Username: "x-access-token", Token: "private-repository-token"}
	if _, err := m.Submit(r); err != nil {
		t.Fatal(err)
	}
	s := waitStatus(t, m, r.OperationID, terminal)
	if s.State != "succeeded" || s.ImageID != testImage || s.CommitMessage != "Fixture release" {
		t.Fatalf("build: %+v", s)
	}
	for _, secret := range []string{"private-build-secret", "abc", "private-repository-token"} {
		if strings.Contains(fmt.Sprint(s.Logs, s.Error, s.CommitMessage), secret) {
			t.Fatalf("secret escaped redaction: %+v", s)
		}
	}
	if !strings.Contains(fmt.Sprint(s.Logs), "[REDACTED]") {
		t.Fatal("secret fixture did not reach log redactor")
	}
	args, err := os.ReadFile(record)
	if err != nil {
		t.Fatal(err)
	}
	for _, secret := range []string{"private-build-secret", "abc", "private-repository-token"} {
		if strings.Contains(string(args), secret) {
			t.Fatal("secret included in CLI arguments")
		}
	}
	for _, flag := range []string{"--load", "--provenance=false", "io.deployforge.instance=test", "io.deployforge.application=application001", "GREETING=hello; $(not-a-command)", "/nested app"} {
		if !strings.Contains(string(args), flag) {
			t.Fatalf("missing command argument %q", flag)
		}
	}
	if entries, _ := os.ReadDir(m.cfg.WorkDir); len(entries) != 0 {
		t.Fatal("sensitive workspace left behind")
	}
	if _, err := m.Submit(r); err != nil {
		t.Fatal("completed resubmission must be idempotent")
	}
}

func TestRejectBuiltImageFromAnotherInstance(t *testing.T) {
	fakeDocker(t, "while [ \"$1\" != --iidfile ]; do shift; done\nprintf '%s\\n' '"+testImage+"' > \"$2\"\n")
	m := manager(t, 1)
	m.clone = fixtureClone
	m.inspect = func(ctx context.Context, id string) (*docker.ImageInspect, error) {
		img, _ := inspectFixture(ctx, id)
		img.Config.Labels[protocol.LabelInstance] = "other"
		return img, nil
	}
	if _, err := m.Submit(request()); err != nil {
		t.Fatal(err)
	}
	if s := waitStatus(t, m, request().OperationID, terminal); s.State != "failed" || s.FailureKind != "internal" || s.ImageID != "" {
		t.Fatalf("foreign image accepted: %+v", s)
	}
}

func TestCancelBuildKillsPluginChildrenAndCleansWorkspace(t *testing.T) {
	pidFile := filepath.Join(t.TempDir(), "child")
	fakeDocker(t, fmt.Sprintf("sleep 30 &\nprintf '%%s' \"$!\" > %q\nwait\n", pidFile))
	m := manager(t, 1)
	m.clone = fixtureClone
	r := request()
	if _, err := m.Submit(r); err != nil {
		t.Fatal(err)
	}
	var raw []byte
	deadline := time.Now().Add(5 * time.Second)
	for time.Now().Before(deadline) {
		raw, _ = os.ReadFile(pidFile)
		if len(raw) > 0 {
			break
		}
		time.Sleep(time.Millisecond)
	}
	pid, err := strconv.Atoi(string(raw))
	if err != nil {
		t.Fatal("fake plugin did not start")
	}
	if !m.Cancel(r.OperationID) {
		t.Fatal("cancel failed")
	}
	if s := waitStatus(t, m, r.OperationID, terminal); s.State != "canceled" {
		t.Fatalf("cancel: %+v", s)
	}
	stat, err := os.ReadFile(fmt.Sprintf("/proc/%d/stat", pid))
	if err == nil {
		fields := strings.Fields(string(stat))
		if len(fields) > 2 && fields[2] != "Z" && fields[2] != "X" {
			t.Fatalf("plugin child remains alive: %s", fields[2])
		}
	}
	if entries, _ := os.ReadDir(m.cfg.WorkDir); len(entries) != 0 {
		t.Fatal("canceled build leaked workspace")
	}
}

func TestSplitSecretAndLongLogLines(t *testing.T) {
	op := &operation{nextSeq: 1}
	w := newLogWriter(op, "stdout", []string{"abc", "long-private-token", "line-one\nline-two"})
	for _, c := range []byte("abc long-private-token line-one\nline-two\n") {
		w.Write([]byte{c})
	}
	w.Write([]byte(strings.Repeat("x", maxLineBytes*2+17)))
	w.close()
	s := op.snapshot(0, 1000)
	if strings.Contains(fmt.Sprint(s.Logs), "abc") || strings.Contains(fmt.Sprint(s.Logs), "private-token") || strings.Contains(fmt.Sprint(s.Logs), "line-one") {
		t.Fatal("split or multiline secret leaked")
	}
	for _, line := range s.Logs {
		if len(line.Text) > maxLineBytes {
			t.Fatal("unbounded log line")
		}
	}
}
