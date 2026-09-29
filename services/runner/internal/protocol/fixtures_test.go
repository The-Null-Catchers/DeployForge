package protocol

import (
	"bytes"
	"encoding/json"
	"os"
	"path/filepath"
	"testing"
)

// TestFixtures decodes the shared contract fixtures strictly (unknown fields
// are errors) and re-encodes them, proving the Go structs cover every field
// the TypeScript contract defines.
func TestFixtures(t *testing.T) {
	dir := filepath.Join("..", "..", "..", "..", "packages", "contracts", "fixtures", "runner-v1")
	cases := map[string]func() any{
		"health.json":                   func() any { return &Health{} },
		"build-request.json":            func() any { return &BuildRequest{} },
		"build-status.json":             func() any { return &BuildStatus{} },
		"container-create-request.json": func() any { return &ContainerCreateRequest{} },
		"probe-result.json":             func() any { return &ProbeResult{} },
		"container-stats.json":          func() any { return &ContainerStats{} },
	}
	entries, err := os.ReadDir(dir)
	if err != nil {
		t.Fatal(err)
	}
	for _, e := range entries {
		if _, ok := cases[e.Name()]; !ok {
			t.Errorf("fixture %s has no Go type mapping", e.Name())
		}
	}
	for name, mk := range cases {
		t.Run(name, func(t *testing.T) {
			raw, err := os.ReadFile(filepath.Join(dir, name))
			if err != nil {
				t.Fatal(err)
			}
			v := mk()
			dec := json.NewDecoder(bytes.NewReader(raw))
			dec.DisallowUnknownFields()
			if err := dec.Decode(v); err != nil {
				t.Fatalf("decode: %v", err)
			}
			var orig, round map[string]any
			_ = json.Unmarshal(raw, &orig)
			out, _ := json.Marshal(v)
			_ = json.Unmarshal(out, &round)
			for k := range orig {
				if _, ok := round[k]; !ok {
					t.Errorf("field %q lost in round trip", k)
				}
			}
		})
	}
}
