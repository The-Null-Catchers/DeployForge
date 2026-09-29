package gitops

import (
	"crypto/subtle"
	"net/http"
	"net/http/cgi"
	"os"
	"os/exec"
)

// FixtureHandler serves bare repositories under root with git's smart HTTP
// protocol (git http-backend). It exists only for hermetic tests and the
// acceptance environment; it is not part of a production installation. When
// token is non-empty, requests must carry HTTP basic auth with that password,
// which lets tests exercise authenticated (private repository) cloning.
func FixtureHandler(root, token string) (http.Handler, error) {
	backend, err := exec.Command("git", "--exec-path").Output()
	if err != nil {
		return nil, err
	}
	h := &cgi.Handler{
		Path: string(trimNL(backend)) + "/git-http-backend",
		Env: []string{
			"GIT_PROJECT_ROOT=" + root,
			"GIT_HTTP_EXPORT_ALL=1",
			"GIT_CONFIG_COUNT=1",
			"GIT_CONFIG_KEY_0=uploadpack.allowReachableSHA1InWant",
			"GIT_CONFIG_VALUE_0=true",
			"HOME=" + os.TempDir(),
		},
	}
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Method != http.MethodGet && r.Method != http.MethodPost {
			http.Error(w, "method not allowed", http.StatusMethodNotAllowed)
			return
		}
		if token != "" {
			_, pw, ok := r.BasicAuth()
			if !ok || subtle.ConstantTimeCompare([]byte(pw), []byte(token)) != 1 {
				w.Header().Set("WWW-Authenticate", `Basic realm="fixture"`)
				http.Error(w, "unauthorized", http.StatusUnauthorized)
				return
			}
		}
		h.ServeHTTP(w, r)
	}), nil
}

func trimNL(b []byte) []byte {
	for len(b) > 0 && (b[len(b)-1] == '\n' || b[len(b)-1] == '\r') {
		b = b[:len(b)-1]
	}
	return b
}
