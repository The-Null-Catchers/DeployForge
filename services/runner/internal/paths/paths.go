// Package paths resolves user-supplied repository paths safely against a
// checked-out repository root, including symlink traversal.
package paths

import (
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"regexp"
	"strings"
)

var (
	ErrInvalid   = errors.New("invalid path")
	ErrEscapes   = errors.New("path escapes the repository root")
	ErrNotFound  = errors.New("path does not exist in the repository")
	ErrWrongType = errors.New("path has the wrong type")
	allowed      = regexp.MustCompile(`^[A-Za-z0-9._\-/ @+]+$`)
)

// CheckStatic validates the syntax of a relative path before any filesystem access.
func CheckStatic(p string) error {
	if p == "" || len(p) > 255 {
		return fmt.Errorf("%w: empty or too long", ErrInvalid)
	}
	if strings.HasPrefix(p, "/") || strings.ContainsAny(p, "\\\x00") || !allowed.MatchString(p) {
		return fmt.Errorf("%w: %q", ErrInvalid, p)
	}
	for _, seg := range strings.Split(p, "/") {
		if seg == ".." {
			return fmt.Errorf("%w: parent segments are not allowed", ErrInvalid)
		}
	}
	return nil
}

// Resolve returns the real (symlink-free) absolute path of rel inside root and
// fails if the resolved path lies outside the resolved root.
func Resolve(root, rel string) (string, error) {
	if err := CheckStatic(rel); err != nil {
		return "", err
	}
	realRoot, err := filepath.EvalSymlinks(root)
	if err != nil {
		return "", fmt.Errorf("resolve root: %w", err)
	}
	joined := filepath.Join(realRoot, filepath.FromSlash(rel))
	real, err := filepath.EvalSymlinks(joined)
	if err != nil {
		if errors.Is(err, os.ErrNotExist) {
			return "", fmt.Errorf("%w: %s", ErrNotFound, rel)
		}
		return "", fmt.Errorf("%w: %s", ErrInvalid, rel)
	}
	if real != realRoot && !strings.HasPrefix(real, realRoot+string(os.PathSeparator)) {
		return "", fmt.Errorf("%w: %s", ErrEscapes, rel)
	}
	return real, nil
}

// ResolveDir resolves rel and requires a directory.
func ResolveDir(root, rel string) (string, error) {
	p, err := Resolve(root, rel)
	if err != nil {
		return "", err
	}
	st, err := os.Stat(p)
	if err != nil || !st.IsDir() {
		return "", fmt.Errorf("%w: %s is not a directory", ErrWrongType, rel)
	}
	return p, nil
}

// ResolveFile resolves rel and requires a regular file no larger than maxBytes.
func ResolveFile(root, rel string, maxBytes int64) (string, error) {
	p, err := Resolve(root, rel)
	if err != nil {
		return "", err
	}
	st, err := os.Stat(p)
	if err != nil || !st.Mode().IsRegular() {
		return "", fmt.Errorf("%w: %s is not a regular file", ErrWrongType, rel)
	}
	if st.Size() > maxBytes {
		return "", fmt.Errorf("%w: %s is too large", ErrInvalid, rel)
	}
	return p, nil
}
