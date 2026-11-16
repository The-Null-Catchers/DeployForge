// Package gitops clones exact commits with the git CLI.
//
// Security properties:
//   - git is executed with an argument array, never through a shell;
//   - credentials are passed as an http.extraHeader through GIT_CONFIG_*
//     environment variables, so they never appear in the remote URL, in
//     .git/config, in the process argument list, or in the image;
//   - only https (and, for the hermetic test fixture, explicitly allowed
//     http hosts) transports are permitted; ext::, file:: and ssh are blocked;
//   - global/system git config and credential helpers are ignored.
package gitops

import (
	"bufio"
	"bytes"
	"context"
	"encoding/base64"
	"errors"
	"fmt"
	"io"
	"net/url"
	"os"
	"os/exec"
	"regexp"
	"strings"
	"syscall"
	"time"
)

var (
	shaRe    = regexp.MustCompile(`^[0-9a-f]{40}$`)
	branchRe = regexp.MustCompile(`^[A-Za-z0-9._/-]{1,200}$`)
	ownerRe  = regexp.MustCompile(`^[A-Za-z0-9_.-]{1,100}$`)
)

type Auth struct {
	Username string
	Token    string
}

type Policy struct {
	// AllowedHosts for https URLs, e.g. github.com.
	AllowedHosts []string
	// InsecureHTTPHosts are allowed over plain http. Only for the local git
	// fixture used by automated tests; empty in production.
	InsecureHTTPHosts []string
}

var ErrURLNotAllowed = errors.New("repository URL is not allowed")

// ValidateURL enforces the transport and host allowlist.
func (p Policy) ValidateURL(raw string) (*url.URL, error) {
	u, err := url.Parse(raw)
	if err != nil || u.User != nil || u.RawQuery != "" || u.Fragment != "" {
		return nil, ErrURLNotAllowed
	}
	host := strings.ToLower(u.Host)
	ok := false
	switch u.Scheme {
	case "https":
		ok = contains(p.AllowedHosts, host)
	case "http":
		ok = contains(p.InsecureHTTPHosts, host)
	}
	if !ok {
		return nil, ErrURLNotAllowed
	}
	parts := strings.Split(strings.Trim(u.Path, "/"), "/")
	if len(parts) != 2 || !ownerRe.MatchString(parts[0]) || !ownerRe.MatchString(parts[1]) || parts[1] == ".." || parts[0] == ".." {
		return nil, ErrURLNotAllowed
	}
	return u, nil
}

func contains(list []string, v string) bool {
	for _, x := range list {
		if strings.EqualFold(x, v) {
			return true
		}
	}
	return false
}

func (p Policy) env(home string, u *url.URL, auth *Auth) []string {
	env := []string{
		"PATH=" + os.Getenv("PATH"),
		"HOME=" + home,
		"GIT_TERMINAL_PROMPT=0",
		"GIT_CONFIG_NOSYSTEM=1",
		"GIT_CONFIG_GLOBAL=/dev/null",
		"GIT_ASKPASS=/bin/false",
		"SSH_ASKPASS=/bin/false",
		"GIT_LFS_SKIP_SMUDGE=1",
	}
	// Preserve outbound proxy/CA settings of the runner host, if any.
	for _, k := range []string{"HTTPS_PROXY", "https_proxy", "NO_PROXY", "no_proxy", "SSL_CERT_FILE", "GIT_SSL_CAINFO"} {
		if v, ok := os.LookupEnv(k); ok {
			env = append(env, k+"="+v)
		}
	}
	proto := "https"
	if u.Scheme == "http" {
		proto = "http"
	}
	cfg := [][2]string{
		{"protocol.allow", "never"},
		{"protocol." + proto + ".allow", "always"},
		{"credential.helper", ""},
		{"core.hooksPath", "/dev/null"},
		{"advice.detachedHead", "false"},
		{"http.followRedirects", "false"},
	}
	if auth != nil && auth.Token != "" {
		basic := base64.StdEncoding.EncodeToString([]byte(auth.Username + ":" + auth.Token))
		cfg = append(cfg, [2]string{"http." + u.Scheme + "://" + u.Host + "/.extraheader", "AUTHORIZATION: basic " + basic})
	}
	env = append(env, fmt.Sprintf("GIT_CONFIG_COUNT=%d", len(cfg)))
	for i, kv := range cfg {
		env = append(env, fmt.Sprintf("GIT_CONFIG_KEY_%d=%s", i, kv[0]), fmt.Sprintf("GIT_CONFIG_VALUE_%d=%s", i, kv[1]))
	}
	return env
}

func run(ctx context.Context, dir string, env []string, out io.Writer, args ...string) error {
	cmd := exec.CommandContext(ctx, "git", args...)
	cmd.SysProcAttr = &syscall.SysProcAttr{Setpgid: true}
	cmd.Cancel = func() error {
		err := syscall.Kill(-cmd.Process.Pid, syscall.SIGKILL)
		if errors.Is(err, syscall.ESRCH) {
			return os.ErrProcessDone
		}
		return err
	}
	cmd.WaitDelay = 2 * time.Second
	cmd.Dir = dir
	cmd.Env = env
	cmd.Stdout = out
	cmd.Stderr = out
	return cmd.Run()
}

// Clone fetches exactly commitSHA into dir (which must exist and be empty).
func (p Policy) Clone(ctx context.Context, dir, cloneURL, commitSHA string, auth *Auth, log io.Writer) error {
	if !shaRe.MatchString(commitSHA) {
		return fmt.Errorf("invalid commit sha")
	}
	u, err := p.ValidateURL(cloneURL)
	if err != nil {
		return err
	}
	home, err := os.MkdirTemp("", "df-git-home-")
	if err != nil {
		return err
	}
	defer os.RemoveAll(home)
	env := p.env(home, u, auth)
	steps := [][]string{
		{"init", "--quiet"},
		{"remote", "add", "origin", u.String()},
		{"fetch", "--depth=1", "--no-tags", "--no-recurse-submodules", "origin", commitSHA},
		{"checkout", "--quiet", "--detach", "FETCH_HEAD"},
	}
	for _, s := range steps {
		if err := run(ctx, dir, env, log, s...); err != nil {
			return fmt.Errorf("git %s failed: %w", s[0], err)
		}
	}
	var head bytes.Buffer
	if err := run(ctx, dir, env, &head, "rev-parse", "HEAD"); err != nil {
		return err
	}
	if got := strings.TrimSpace(head.String()); got != commitSHA {
		return fmt.Errorf("checked out %s, expected %s", got, commitSHA)
	}
	// Remove the remote so no URL lingers; credentials were never written.
	_ = run(ctx, dir, env, io.Discard, "remote", "remove", "origin")
	return nil
}

// CommitMessage returns the subject line of HEAD.
func CommitMessage(ctx context.Context, dir string) string {
	var out bytes.Buffer
	cmd := exec.CommandContext(ctx, "git", "log", "-1", "--format=%s")
	cmd.Dir = dir
	cmd.Env = []string{"PATH=" + os.Getenv("PATH"), "GIT_CONFIG_NOSYSTEM=1", "GIT_CONFIG_GLOBAL=/dev/null", "HOME=" + dir}
	cmd.Stdout = &out
	if cmd.Run() != nil {
		return ""
	}
	s := strings.TrimSpace(out.String())
	if len(s) > 300 {
		s = s[:300]
	}
	return s
}

// ResolveBranch returns the commit SHA at the head of branch, or found=false.
func (p Policy) ResolveBranch(ctx context.Context, cloneURL, branch string, auth *Auth) (string, bool, error) {
	if !branchRe.MatchString(branch) || strings.Contains(branch, "..") || strings.HasPrefix(branch, "-") {
		return "", false, fmt.Errorf("invalid branch")
	}
	u, err := p.ValidateURL(cloneURL)
	if err != nil {
		return "", false, err
	}
	home, err := os.MkdirTemp("", "df-git-home-")
	if err != nil {
		return "", false, err
	}
	defer os.RemoveAll(home)
	var out, errBuf bytes.Buffer
	cmd := exec.CommandContext(ctx, "git", "ls-remote", "--heads", "--", u.String(), "refs/heads/"+branch)
	cmd.Dir = home
	cmd.Env = p.env(home, u, auth)
	cmd.Stdout = &out
	cmd.Stderr = &errBuf
	if err := cmd.Run(); err != nil {
		msg := strings.TrimSpace(errBuf.String())
		if len(msg) > 300 {
			msg = msg[:300]
		}
		return "", false, fmt.Errorf("git ls-remote failed: %s", msg)
	}
	sc := bufio.NewScanner(&out)
	for sc.Scan() {
		f := strings.Fields(sc.Text())
		if len(f) == 2 && f[1] == "refs/heads/"+branch && shaRe.MatchString(f[0]) {
			return f[0], true, nil
		}
	}
	return "", false, nil
}
