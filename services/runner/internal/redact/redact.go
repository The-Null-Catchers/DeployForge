// Package redact performs best-effort streaming secret redaction. It mirrors
// packages/contracts/src/redaction.ts. It cannot detect transformed secrets.
package redact

import (
	"net/url"
	"sort"
	"strings"
)

const (
	Replacement = "[REDACTED]"
	MinLength   = 6
)

func Needles(secrets []string) []string {
	set := map[string]struct{}{}
	for _, raw := range secrets {
		if raw == "" {
			continue
		}
		cands := append([]string{raw}, strings.Split(strings.ReplaceAll(raw, "\r\n", "\n"), "\n")...)
		for _, c := range cands {
			v := strings.TrimSpace(c)
			if len(v) < MinLength {
				continue
			}
			set[v] = struct{}{}
			if enc := strings.ReplaceAll(url.QueryEscape(v), "+", "%20"); enc != v {
				set[enc] = struct{}{}
			}
		}
	}
	out := make([]string, 0, len(set))
	for k := range set {
		out = append(out, k)
	}
	sort.Slice(out, func(i, j int) bool { return len(out[i]) > len(out[j]) })
	return out
}

func All(s string, needles []string) string {
	for _, n := range needles {
		if strings.Contains(s, n) {
			s = strings.ReplaceAll(s, n, Replacement)
		}
	}
	return s
}

// Stream redacts a byte stream, holding back any suffix that could be the
// start of a secret until more data arrives.
type Stream struct {
	needles []string
	buf     string
}

func NewStream(secrets []string) *Stream { return &Stream{needles: Needles(secrets)} }

func (s *Stream) Push(chunk string) string {
	if len(s.needles) == 0 {
		return chunk
	}
	s.buf = All(s.buf+chunk, s.needles)
	hold := s.partial()
	out := s.buf[:len(s.buf)-hold]
	s.buf = s.buf[len(s.buf)-hold:]
	return out
}

func (s *Stream) Flush() string {
	out := All(s.buf, s.needles)
	s.buf = ""
	return out
}

func (s *Stream) partial() int {
	best := 0
	for _, n := range s.needles {
		max := len(n) - 1
		if len(s.buf) < max {
			max = len(s.buf)
		}
		for k := max; k > best; k-- {
			if strings.HasSuffix(s.buf, n[:k]) {
				best = k
				break
			}
		}
	}
	return best
}
