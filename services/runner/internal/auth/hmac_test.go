package auth

import (
	"strconv"
	"testing"
	"time"
)

func signed(secret []byte, method, path string, ts time.Time, nonce string, body []byte) Headers {
	t := strconv.FormatInt(ts.Unix(), 10)
	return Headers{Protocol: "1", Timestamp: t, Nonce: nonce, Signature: Sign(secret, Canonical(method, path, t, nonce, body))}
}

func TestVerify(t *testing.T) {
	secret := []byte("0123456789abcdef0123456789abcdef")
	now := time.Unix(1_800_000_000, 0)
	body := []byte(`{"a":1}`)

	fresh := func() *Verifier {
		v := NewVerifier(secret)
		v.now = func() time.Time { return now }
		return v
	}

	t.Run("valid", func(t *testing.T) {
		v := fresh()
		if err := v.Verify("POST", "/v1/builds", signed(secret, "POST", "/v1/builds", now, "nonce-aaaaaaaaaaaaaaaa", body), body); err != nil {
			t.Fatal(err)
		}
	})
	t.Run("replay rejected", func(t *testing.T) {
		v := fresh()
		h := signed(secret, "POST", "/v1/builds", now, "nonce-bbbbbbbbbbbbbbbb", body)
		if err := v.Verify("POST", "/v1/builds", h, body); err != nil {
			t.Fatal(err)
		}
		if err := v.Verify("POST", "/v1/builds", h, body); err != ErrReplay {
			t.Fatalf("expected replay error, got %v", err)
		}
	})
	t.Run("tampered body", func(t *testing.T) {
		v := fresh()
		h := signed(secret, "POST", "/v1/builds", now, "nonce-cccccccccccccccc", body)
		if err := v.Verify("POST", "/v1/builds", h, []byte(`{"a":2}`)); err != ErrSignature {
			t.Fatalf("expected signature error, got %v", err)
		}
	})
	t.Run("tampered path", func(t *testing.T) {
		v := fresh()
		h := signed(secret, "DELETE", "/v1/containers/a", now, "nonce-dddddddddddddddd", nil)
		if err := v.Verify("DELETE", "/v1/containers/b", h, nil); err != ErrSignature {
			t.Fatalf("expected signature error, got %v", err)
		}
	})
	t.Run("wrong secret", func(t *testing.T) {
		v := fresh()
		h := signed([]byte("another-secret-another-secret-xx"), "GET", "/v1/health", now, "nonce-eeeeeeeeeeeeeeee", nil)
		if err := v.Verify("GET", "/v1/health", h, nil); err != ErrSignature {
			t.Fatalf("expected signature error, got %v", err)
		}
	})
	t.Run("stale timestamp", func(t *testing.T) {
		v := fresh()
		h := signed(secret, "GET", "/v1/health", now.Add(-2*time.Minute), "nonce-ffffffffffffffff", nil)
		if err := v.Verify("GET", "/v1/health", h, nil); err != ErrSkew {
			t.Fatalf("expected skew error, got %v", err)
		}
	})
	t.Run("missing headers", func(t *testing.T) {
		v := fresh()
		if err := v.Verify("GET", "/v1/health", Headers{}, nil); err != ErrMissing {
			t.Fatalf("expected missing error, got %v", err)
		}
	})
	t.Run("protocol version", func(t *testing.T) {
		v := fresh()
		h := signed(secret, "GET", "/v1/health", now, "nonce-gggggggggggggggg", nil)
		h.Protocol = "2"
		if err := v.Verify("GET", "/v1/health", h, nil); err != ErrProtocol {
			t.Fatalf("expected protocol error, got %v", err)
		}
	})
}
