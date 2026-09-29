// Package auth verifies HMAC-signed requests from the control plane.
//
// canonical = "v1\n" + METHOD + "\n" + PATH_AND_QUERY + "\n" + TIMESTAMP + "\n" + NONCE + "\n" + hex(sha256(body))
// signature = "v1=" + hex(HMAC-SHA256(secret, canonical))
package auth

import (
	"crypto/hmac"
	"crypto/sha256"
	"encoding/hex"
	"errors"
	"regexp"
	"strconv"
	"strings"
	"sync"
	"time"
)

const MaxSkew = 60 * time.Second

var (
	ErrMissing   = errors.New("missing authentication headers")
	ErrProtocol  = errors.New("unsupported protocol version")
	ErrSkew      = errors.New("request timestamp outside the accepted window")
	ErrReplay    = errors.New("nonce already used")
	ErrSignature = errors.New("invalid signature")
	nonceRe      = regexp.MustCompile(`^[A-Za-z0-9_-]{16,64}$`)
)

func Canonical(method, pathAndQuery, timestamp, nonce string, body []byte) string {
	sum := sha256.Sum256(body)
	return strings.Join([]string{"v1", strings.ToUpper(method), pathAndQuery, timestamp, nonce, hex.EncodeToString(sum[:])}, "\n")
}

func Sign(secret []byte, canonical string) string {
	m := hmac.New(sha256.New, secret)
	m.Write([]byte(canonical))
	return "v1=" + hex.EncodeToString(m.Sum(nil))
}

// Verifier checks signatures and remembers nonces for the skew window so that
// a captured request cannot be replayed.
type Verifier struct {
	secret []byte
	now    func() time.Time
	mu     sync.Mutex
	nonces map[string]time.Time
}

func NewVerifier(secret []byte) *Verifier {
	return &Verifier{secret: secret, now: time.Now, nonces: map[string]time.Time{}}
}

type Headers struct {
	Protocol, Timestamp, Nonce, Signature string
}

func (v *Verifier) Verify(method, pathAndQuery string, h Headers, body []byte) error {
	if h.Timestamp == "" || h.Nonce == "" || h.Signature == "" {
		return ErrMissing
	}
	if h.Protocol != "1" {
		return ErrProtocol
	}
	if !nonceRe.MatchString(h.Nonce) {
		return ErrMissing
	}
	ts, err := strconv.ParseInt(h.Timestamp, 10, 64)
	if err != nil {
		return ErrSkew
	}
	now := v.now()
	d := now.Sub(time.Unix(ts, 0))
	if d > MaxSkew || d < -MaxSkew {
		return ErrSkew
	}
	expected := Sign(v.secret, Canonical(method, pathAndQuery, h.Timestamp, h.Nonce, body))
	if !hmac.Equal([]byte(expected), []byte(h.Signature)) {
		return ErrSignature
	}
	v.mu.Lock()
	defer v.mu.Unlock()
	for n, exp := range v.nonces {
		if now.After(exp) {
			delete(v.nonces, n)
		}
	}
	if _, seen := v.nonces[h.Nonce]; seen {
		return ErrReplay
	}
	v.nonces[h.Nonce] = now.Add(2 * MaxSkew)
	return nil
}
