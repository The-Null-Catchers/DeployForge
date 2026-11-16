package build

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"regexp"
	"sort"
	"strings"
	"syscall"
	"time"

	"github.com/the-null-catchers/deployforge/services/runner/internal/docker"
	"github.com/the-null-catchers/deployforge/services/runner/internal/gitops"
	"github.com/the-null-catchers/deployforge/services/runner/internal/paths"
	"github.com/the-null-catchers/deployforge/services/runner/internal/protocol"
	"github.com/the-null-catchers/deployforge/services/runner/internal/redact"
)

var imageIDPattern = regexp.MustCompile(`^sha256:[0-9a-f]{64}$`)

func (m *Manager) execute(ctx context.Context, op *operation, r protocol.BuildRequest) (image, message, kind string, err error) {
	secrets := secretValues(r)
	stdout, stderr := newLogWriter(op, "stdout", secrets), newLogWriter(op, "stderr", secrets)
	defer stdout.close()
	defer stderr.close()
	if err = os.MkdirAll(m.cfg.WorkDir, 0o700); err != nil {
		return "", "", "internal", fmt.Errorf("create build workspace: %w", err)
	}
	workspace, err := os.MkdirTemp(m.cfg.WorkDir, "build-")
	if err != nil {
		return "", "", "internal", fmt.Errorf("create build workspace: %w", err)
	}
	defer os.RemoveAll(workspace)
	root := filepath.Join(workspace, "repo")
	if err = os.Mkdir(root, 0o700); err != nil {
		return "", "", "internal", err
	}
	op.addLog("system", "Cloning repository at the requested commit")
	var auth *gitops.Auth
	if r.Repository.Auth != nil {
		auth = &gitops.Auth{Username: r.Repository.Auth.Username, Token: r.Repository.Auth.Token}
	}
	if err = m.clone(ctx, root, r.Repository.CloneURL, r.Repository.CommitSHA, auth, stderr); err != nil {
		return "", "", "clone", fmt.Errorf("clone failed: %w", err)
	}
	message = redact.All(gitops.CommitMessage(ctx, root), redact.ExactNeedles(secrets))
	op.phase("validating")
	buildContext, err := paths.ResolveDir(root, r.ContextDir)
	if err != nil {
		return "", message, "config", fmt.Errorf("invalid build context: %w", err)
	}
	dockerfile, err := paths.ResolveFile(root, r.DockerfilePath, 1<<20)
	if err != nil {
		return "", message, "config", fmt.Errorf("invalid Dockerfile: %w", err)
	}
	// Secrets and Docker client state are siblings of the checkout, never part
	// of the context sent to BuildKit or available to a Dockerfile COPY command.
	secretDir := filepath.Join(workspace, "build-secrets")
	configDir := filepath.Join(workspace, "docker-config")
	for _, dir := range []string{secretDir, configDir} {
		if err = os.Mkdir(dir, 0o700); err != nil {
			return "", message, "internal", err
		}
	}
	iidFile := filepath.Join(workspace, "image-id")
	metadataFile := filepath.Join(workspace, "image-metadata.json")
	args := []string{"buildx", "build", "--load", "--progress=plain", "--provenance=false", "--iidfile", iidFile, "--metadata-file", metadataFile, "--file", dockerfile, "--tag", r.ImageTag}
	labels := map[string]string{
		protocol.LabelManaged: "true", protocol.LabelInstance: m.cfg.Instance,
		protocol.LabelWorkspace: r.WorkspaceID, protocol.LabelApplication: r.ApplicationID,
		protocol.LabelDeployment: r.DeploymentID, protocol.LabelRole: "app",
	}
	for _, key := range sortedKeys(labels) {
		args = append(args, "--label", key+"="+labels[key])
	}
	for _, key := range sortedKeys(r.BuildArgs) {
		args = append(args, "--build-arg", key+"="+r.BuildArgs[key])
	}
	for _, secret := range r.BuildSecrets {
		p := filepath.Join(secretDir, secret.ID)
		if err = os.WriteFile(p, []byte(secret.Value), 0o600); err != nil {
			return "", message, "internal", err
		}
		args = append(args, "--secret", "id="+secret.ID+",src="+p)
	}
	args = append(args, buildContext)
	op.phase("building")
	op.addLog("system", "Building image with BuildKit")
	cmd := exec.CommandContext(ctx, "docker", args...)
	cmd.Dir = workspace
	cmd.Env = []string{"PATH=" + os.Getenv("PATH"), "HOME=" + workspace, "DOCKER_CONFIG=" + configDir, "DOCKER_HOST=" + m.cfg.DockerHost, "DOCKER_BUILDKIT=1"}
	for _, key := range []string{"HTTP_PROXY", "HTTPS_PROXY", "NO_PROXY", "http_proxy", "https_proxy", "no_proxy", "SSL_CERT_FILE"} {
		if value, ok := os.LookupEnv(key); ok {
			cmd.Env = append(cmd.Env, key+"="+value)
		}
	}
	// The Docker CLI spawns the buildx plugin. Kill the whole process group on
	// cancel/timeout rather than leaving that child running a detached build.
	cmd.SysProcAttr = &syscall.SysProcAttr{Setpgid: true}
	cmd.Cancel = func() error {
		err := syscall.Kill(-cmd.Process.Pid, syscall.SIGKILL)
		if errors.Is(err, syscall.ESRCH) {
			return os.ErrProcessDone
		}
		return err
	}
	cmd.WaitDelay = 2 * time.Second
	cmd.Stdout, cmd.Stderr = stdout, stderr
	if err = cmd.Run(); err != nil {
		return "", message, "build", fmt.Errorf("BuildKit build failed: %w", err)
	}
	raw, err := os.ReadFile(iidFile)
	if err != nil {
		return "", message, "internal", fmt.Errorf("BuildKit did not return an image ID: %w", err)
	}
	image = strings.TrimSpace(string(raw))
	if !imageIDPattern.MatchString(image) {
		return "", message, "internal", fmt.Errorf("BuildKit returned an invalid image ID")
	}
	// Some Buildx exporters put the manifest digest in --iidfile. Docker's
	// local image API identifies the loaded image by its config digest instead.
	raw, err = os.ReadFile(metadataFile)
	if err != nil {
		return "", message, "internal", fmt.Errorf("BuildKit did not return image metadata: %w", err)
	}
	var metadata struct {
		ConfigDigest string `json:"containerimage.config.digest"`
	}
	if json.Unmarshal(raw, &metadata) != nil || (metadata.ConfigDigest != "" && !imageIDPattern.MatchString(metadata.ConfigDigest)) {
		return "", message, "internal", fmt.Errorf("BuildKit returned invalid image metadata")
	}
	if m.inspect == nil {
		return "", message, "internal", fmt.Errorf("Docker image inspection is unavailable")
	}
	img, err := m.resolveImage(ctx, image, metadata.ConfigDigest, r.ImageTag)
	if err != nil {
		return "", message, "internal", fmt.Errorf("inspect built image: %w", err)
	}
	for key, value := range labels {
		if img.Config.Labels[key] != value {
			return "", message, "internal", fmt.Errorf("built image ownership labels do not match")
		}
	}
	return img.ID, message, "", nil
}

// Exporters differ in whether iid is a config or manifest digest and whether
// they emit config metadata. A tag lookup is safe only when its immutable
// descriptor/repository digest proves it is the exact build result.
func (m *Manager) resolveImage(ctx context.Context, iid, configDigest, tag string) (*docker.ImageInspect, error) {
	expected := iid
	if configDigest != "" {
		expected = configDigest
	}
	img, err := m.inspect(ctx, expected)
	byTag := false
	if docker.IsNotFound(err) {
		img, err = m.inspect(ctx, tag)
		byTag = true
	}
	if err != nil {
		return nil, err
	}
	if img == nil || !imageIDPattern.MatchString(img.ID) {
		return nil, fmt.Errorf("built image identity does not match")
	}
	if configDigest != "" && img.ID != configDigest {
		return nil, fmt.Errorf("built image identity does not match: expected config %s, loaded %s", configDigest, img.ID)
	}
	match := img.ID == expected
	if byTag {
		match = match || img.Descriptor.Digest == iid
		for _, digest := range img.RepoDigests {
			match = match || strings.HasSuffix(digest, "@"+iid)
		}
	}
	if !match {
		return nil, fmt.Errorf("built image identity does not match")
	}
	return img, nil
}

func sortedKeys(values map[string]string) []string {
	keys := make([]string, 0, len(values))
	for key := range values {
		keys = append(keys, key)
	}
	sort.Strings(keys)
	return keys
}
