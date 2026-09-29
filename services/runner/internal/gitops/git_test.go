package gitops

import (
	"bytes"
	"context"
	"net/http/httptest"
	"net/url"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"testing"
)

func gitCmd(t *testing.T, dir string, args ...string) string {
	t.Helper()
	cmd := exec.Command("git", args...)
	cmd.Dir = dir
	cmd.Env = append(os.Environ(), "GIT_AUTHOR_NAME=t", "GIT_AUTHOR_EMAIL=t@example.com", "GIT_COMMITTER_NAME=t", "GIT_COMMITTER_EMAIL=t@example.com", "GIT_CONFIG_GLOBAL=/dev/null")
	out, err := cmd.CombinedOutput()
	if err != nil {
		t.Fatalf("git %v: %v\n%s", args, err, out)
	}
	return strings.TrimSpace(string(out))
}

// fixtureRepo creates root/demo/app.git with two commits and returns their SHAs.
func fixtureRepo(t *testing.T) (root, first, second string) {
	t.Helper()
	root = t.TempDir()
	work := t.TempDir()
	gitCmd(t, work, "init", "-q", "-b", "main")
	os.WriteFile(filepath.Join(work, "Dockerfile"), []byte("FROM scratch\n"), 0o644)
	gitCmd(t, work, "add", ".")
	gitCmd(t, work, "commit", "-q", "-m", "first commit")
	first = gitCmd(t, work, "rev-parse", "HEAD")
	os.WriteFile(filepath.Join(work, "README"), []byte("v2\n"), 0o644)
	gitCmd(t, work, "add", ".")
	gitCmd(t, work, "commit", "-q", "-m", "second commit")
	second = gitCmd(t, work, "rev-parse", "HEAD")
	os.MkdirAll(filepath.Join(root, "demo"), 0o755)
	gitCmd(t, root, "clone", "-q", "--bare", work, filepath.Join(root, "demo", "app.git"))
	return
}

func TestCloneExactCommitWithAuth(t *testing.T) {
	root, first, second := fixtureRepo(t)
	h, err := FixtureHandler(root, "s3cr3t-token-value")
	if err != nil {
		t.Fatal(err)
	}
	srv := httptest.NewServer(h)
	defer srv.Close()
	u, _ := url.Parse(srv.URL)
	p := Policy{InsecureHTTPHosts: []string{u.Host}}
	repoURL := srv.URL + "/demo/app.git"

	sha, found, err := p.ResolveBranch(context.Background(), repoURL, "main", &Auth{Username: "x-access-token", Token: "s3cr3t-token-value"})
	if err != nil || !found || sha != second {
		t.Fatalf("resolve: %v %v %s", err, found, sha)
	}
	if _, found, _ := p.ResolveBranch(context.Background(), repoURL, "deleted-branch", &Auth{Username: "x", Token: "s3cr3t-token-value"}); found {
		t.Fatal("expected missing branch")
	}

	// Clone the OLDER commit even though main points at a newer one.
	dir := t.TempDir()
	var log bytes.Buffer
	if err := p.Clone(context.Background(), dir, repoURL, first, &Auth{Username: "x-access-token", Token: "s3cr3t-token-value"}, &log); err != nil {
		t.Fatalf("clone: %v\n%s", err, log.String())
	}
	if _, err := os.Stat(filepath.Join(dir, "README")); !os.IsNotExist(err) {
		t.Fatal("expected first commit tree without README")
	}
	cfg, _ := os.ReadFile(filepath.Join(dir, ".git", "config"))
	if strings.Contains(string(cfg), "s3cr3t") || strings.Contains(string(cfg), "extraheader") {
		t.Fatalf("credential persisted in git config:\n%s", cfg)
	}
	if strings.Contains(log.String(), "s3cr3t") {
		t.Fatal("credential leaked into clone output")
	}
	if msg := CommitMessage(context.Background(), dir); msg != "first commit" {
		t.Fatalf("commit message %q", msg)
	}

	// Wrong token fails.
	if err := p.Clone(context.Background(), t.TempDir(), repoURL, first, &Auth{Username: "x", Token: "wrong-token-value"}, &log); err == nil {
		t.Fatal("expected auth failure")
	}
}

func TestValidateURL(t *testing.T) {
	p := Policy{AllowedHosts: []string{"github.com"}}
	good := []string{"https://github.com/acme/web.git", "https://github.com/acme/web"}
	bad := []string{
		"http://github.com/acme/web.git",
		"https://token@github.com/acme/web.git",
		"https://gitlab.com/acme/web.git",
		"ext::sh -c id",
		"file:///etc/passwd",
		"https://github.com/acme/web.git?x=1",
		"https://github.com/acme/../../etc",
		"https://github.com/acme",
		"ssh://git@github.com/acme/web.git",
		"--upload-pack=touch /tmp/x",
	}
	for _, g := range good {
		if _, err := p.ValidateURL(g); err != nil {
			t.Errorf("%s rejected: %v", g, err)
		}
	}
	for _, b := range bad {
		if _, err := p.ValidateURL(b); err == nil {
			t.Errorf("%s accepted", b)
		}
	}
}
