package build

import (
	"regexp"
	"strings"

	"github.com/the-null-catchers/deployforge/services/runner/internal/paths"
	"github.com/the-null-catchers/deployforge/services/runner/internal/protocol"
)

var (
	idPattern  = regexp.MustCompile(`^[a-z0-9]{8,40}$`)
	opPattern  = regexp.MustCompile(`^[A-Za-z0-9_-]{8,80}$`)
	shaPattern = regexp.MustCompile(`^[0-9a-f]{40}$`)
	keyPattern = regexp.MustCompile(`^[A-Za-z_][A-Za-z0-9_]{0,127}$`)
)

func validate(cfg Config, r protocol.BuildRequest) error {
	bad := func(msg string) error { return &ValidationError{Msg: msg} }
	if !opPattern.MatchString(r.OperationID) || !idPattern.MatchString(r.WorkspaceID) || !idPattern.MatchString(r.ApplicationID) || !idPattern.MatchString(r.DeploymentID) {
		return bad("invalid build identity")
	}
	if !shaPattern.MatchString(r.Repository.CommitSHA) {
		return bad("an exact lowercase 40-character commit SHA is required")
	}
	if _, err := cfg.Git.ValidateURL(r.Repository.CloneURL); err != nil {
		return bad("repository URL is not allowed")
	}
	if paths.CheckStatic(r.ContextDir) != nil || paths.CheckStatic(r.DockerfilePath) != nil {
		return bad("build context and Dockerfile must be safe repository-relative paths")
	}
	if r.ImageTag != "deployforge/"+r.ApplicationID+":"+r.DeploymentID {
		return bad("image tag must belong to this application and deployment")
	}
	if r.TimeoutSeconds < 30 || r.TimeoutSeconds > 7200 {
		return bad("timeout must be between 30 and 7200 seconds")
	}
	if len(r.BuildArgs) > 128 || len(r.BuildSecrets) > 64 || len(r.Redact) > 256 {
		return bad("too many build arguments, secrets or redaction values")
	}
	for k, v := range r.BuildArgs {
		if !keyPattern.MatchString(k) || len(v) > 16384 || strings.ContainsRune(v, 0) {
			return bad("invalid build argument")
		}
	}
	seen := map[string]bool{}
	for _, s := range r.BuildSecrets {
		if !keyPattern.MatchString(s.ID) || seen[s.ID] || len(s.Value) > 65536 {
			return bad("invalid or duplicate build secret")
		}
		seen[s.ID] = true
	}
	if r.Repository.Auth != nil && (len(r.Repository.Auth.Username) > 512 || len(r.Repository.Auth.Token) > 65536) {
		return bad("repository credential is too large")
	}
	for _, value := range r.Redact {
		if len(value) > 65536 {
			return bad("redaction value is too large")
		}
	}
	return nil
}
