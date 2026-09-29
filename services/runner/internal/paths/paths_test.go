package paths

import (
	"errors"
	"os"
	"path/filepath"
	"testing"
)

func setup(t *testing.T) (root, outside string) {
	t.Helper()
	base := t.TempDir()
	root = filepath.Join(base, "repo")
	outside = filepath.Join(base, "secret")
	must(t, os.MkdirAll(filepath.Join(root, "app", "web"), 0o755))
	must(t, os.MkdirAll(outside, 0o755))
	must(t, os.WriteFile(filepath.Join(root, "app", "web", "Dockerfile"), []byte("FROM scratch\n"), 0o644))
	must(t, os.WriteFile(filepath.Join(outside, "Dockerfile"), []byte("FROM scratch\n"), 0o644))
	must(t, os.Symlink(outside, filepath.Join(root, "escape")))
	must(t, os.Symlink(filepath.Join(outside, "Dockerfile"), filepath.Join(root, "Dockerfile.link")))
	must(t, os.Symlink("app/web", filepath.Join(root, "inside")))
	must(t, os.Symlink("/etc", filepath.Join(root, "abs")))
	return root, outside
}

func must(t *testing.T, err error) {
	t.Helper()
	if err != nil {
		t.Fatal(err)
	}
}

func TestResolve(t *testing.T) {
	root, _ := setup(t)
	cases := []struct {
		rel     string
		dir     bool
		wantErr error
	}{
		{"app/web", true, nil},
		{".", true, nil},
		{"inside", true, nil},
		{"app/web/Dockerfile", false, nil},
		{"inside/Dockerfile", false, nil},
		{"escape", true, ErrEscapes},
		{"escape/Dockerfile", false, ErrEscapes},
		{"Dockerfile.link", false, ErrEscapes},
		{"abs", true, ErrEscapes},
		{"../secret", true, ErrInvalid},
		{"/etc", true, ErrInvalid},
		{"app/missing", true, ErrNotFound},
		{"app/web", false, ErrWrongType},
		{"app/web/Dockerfile", true, ErrWrongType},
		{"a\\b", true, ErrInvalid},
	}
	for _, c := range cases {
		var err error
		if c.dir {
			_, err = ResolveDir(root, c.rel)
		} else {
			_, err = ResolveFile(root, c.rel, 1<<20)
		}
		if c.wantErr == nil && err != nil {
			t.Errorf("%s: unexpected error %v", c.rel, err)
		}
		if c.wantErr != nil && !errors.Is(err, c.wantErr) {
			t.Errorf("%s: want %v, got %v", c.rel, c.wantErr, err)
		}
	}
}

func TestFileSizeLimit(t *testing.T) {
	root, _ := setup(t)
	if _, err := ResolveFile(root, "app/web/Dockerfile", 3); !errors.Is(err, ErrInvalid) {
		t.Fatalf("expected size error, got %v", err)
	}
}
