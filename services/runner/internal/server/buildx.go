package server

import (
	"bytes"
	"context"
	"os"
	"os/exec"
	"strings"

	"github.com/the-null-catchers/deployforge/services/runner/internal/protocol"
)

// BuildxStatus reports whether the buildx plugin is available.
func BuildxStatus(ctx context.Context) protocol.ComponentStatus {
	var out bytes.Buffer
	cmd := exec.CommandContext(ctx, "docker", "buildx", "version")
	cmd.Env = []string{"PATH=" + os.Getenv("PATH"), "HOME=" + os.TempDir(), "DOCKER_CONFIG=" + os.TempDir() + "/df-docker-config"}
	cmd.Stdout = &out
	cmd.Stderr = &out
	if err := cmd.Run(); err != nil {
		return protocol.ComponentStatus{OK: false, Error: strings.TrimSpace(out.String())}
	}
	f := strings.Fields(out.String())
	v := ""
	if len(f) >= 2 {
		v = f[1]
	}
	return protocol.ComponentStatus{OK: true, Version: v}
}
