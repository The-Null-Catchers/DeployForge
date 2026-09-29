package redact

import (
	"strings"
	"testing"
)

func TestStreamSplitAcrossChunks(t *testing.T) {
	secret := "ghs_16C7e42F292c6912E7710c838347Ae178B4a"
	text := "Cloning https://x-access-token:" + secret + "@github.com/acme/web.git\n" + secret + " again"
	want := strings.ReplaceAll(text, secret, Replacement)
	for i := 0; i <= len(text); i++ {
		s := NewStream([]string{secret})
		got := s.Push(text[:i]) + s.Push(text[i:]) + s.Flush()
		if got != want {
			t.Fatalf("split at %d: got %q", i, got)
		}
	}
	s := NewStream([]string{secret})
	var b strings.Builder
	for i := 0; i < len(text); i++ {
		b.WriteString(s.Push(text[i : i+1]))
	}
	b.WriteString(s.Flush())
	if strings.Contains(b.String(), secret) || b.String() != want {
		t.Fatalf("byte-by-byte: %q", b.String())
	}
}

func TestShortSecretsIgnored(t *testing.T) {
	if n := Needles([]string{"abc", ""}); len(n) != 0 {
		t.Fatalf("expected no needles, got %v", n)
	}
}

func TestMultilineAndEncoded(t *testing.T) {
	n := Needles([]string{"line-one-secret\nline-two-secret", "p@ss w0rd/x"})
	if got := All("x line-two-secret y", n); got != "x "+Replacement+" y" {
		t.Fatal(got)
	}
	if got := All("u=p%40ss%20w0rd%2Fx", n); got != "u="+Replacement {
		t.Fatal(got)
	}
}

func TestNoSecretsPassThrough(t *testing.T) {
	s := NewStream(nil)
	if s.Push("abc") != "abc" {
		t.Fatal("expected passthrough")
	}
}
