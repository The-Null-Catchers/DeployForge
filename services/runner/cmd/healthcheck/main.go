// Command runner-healthcheck is the container health check for the runner.
// The runner binds only to its control-network address, which it records in
// a file; this reads it and probes the unauthenticated /healthz endpoint.
package main

import (
	"net/http"
	"os"
	"strings"
	"time"
)

func main() {
	addr, err := os.ReadFile("/tmp/deployforge-runner.addr")
	if err != nil {
		os.Exit(1)
	}
	c := &http.Client{Timeout: 3 * time.Second}
	resp, err := c.Get("http://" + strings.TrimSpace(string(addr)) + "/healthz")
	if err != nil || resp.StatusCode != http.StatusNoContent {
		os.Exit(1)
	}
}
