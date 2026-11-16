package build

import (
	"encoding/base64"
	"strings"
	"sync"
	"time"

	"github.com/the-null-catchers/deployforge/services/runner/internal/protocol"
	"github.com/the-null-catchers/deployforge/services/runner/internal/redact"
)

const (
	maxLogLines  = 1000
	maxLogBytes  = 1 << 20
	maxLineBytes = 8192
)

func secretValues(r protocol.BuildRequest) []string {
	values := append([]string(nil), r.Redact...)
	for _, secret := range r.BuildSecrets {
		values = append(values, secret.Value)
	}
	if a := r.Repository.Auth; a != nil && a.Token != "" {
		values = append(values, a.Token, base64.StdEncoding.EncodeToString([]byte(a.Username+":"+a.Token)))
	}
	return values
}

func (op *operation) addLog(stream, text string) {
	op.mu.Lock()
	defer op.mu.Unlock()
	op.logs = append(op.logs, protocol.LogLine{Seq: op.nextSeq, TS: time.Now().UTC().Format(time.RFC3339Nano), Stream: stream, Text: text})
	op.nextSeq++
	op.logBytes += len(text)
	for len(op.logs) > maxLogLines || op.logBytes > maxLogBytes {
		op.logBytes -= len(op.logs[0].Text)
		op.logs[0] = protocol.LogLine{}
		op.logs = op.logs[1:]
		op.dropped = true
	}
}

func (op *operation) snapshot(after int64, limit int) protocol.BuildStatus {
	op.mu.Lock()
	defer op.mu.Unlock()
	if after < 1 {
		after = 1
	}
	if limit <= 0 || limit > maxLogLines {
		limit = maxLogLines
	}
	s := op.status
	if s.Error != nil {
		err := *s.Error
		s.Error = &err
	}
	s.Logs = make([]protocol.LogLine, 0)
	s.NextSeq = after
	s.LogsTruncated = op.dropped
	// `after` is an inclusive next-record cursor, matching nextSeq in protocol
	// fixtures and the control plane's subsequent after=nextSeq requests.
	for _, line := range op.logs {
		if line.Seq >= after {
			s.Logs = append(s.Logs, line)
			s.NextSeq = line.Seq + 1
			if len(s.Logs) == limit {
				break
			}
		}
	}
	return s
}

type logWriter struct {
	mu       sync.Mutex
	op       *operation
	stream   string
	redactor *redact.Stream
	buffer   string
}

func newLogWriter(op *operation, stream string, secrets []string) *logWriter {
	return &logWriter{op: op, stream: stream, redactor: redact.NewExactStream(secrets)}
}

func (w *logWriter) Write(p []byte) (int, error) {
	w.mu.Lock()
	defer w.mu.Unlock()
	w.emit(w.redactor.Push(string(p)), false)
	return len(p), nil
}

func (w *logWriter) close() {
	w.mu.Lock()
	defer w.mu.Unlock()
	w.emit(w.redactor.Flush(), true)
}

func (w *logWriter) emit(text string, flush bool) {
	w.buffer += text
	for len(w.buffer) > 0 {
		end := strings.IndexByte(w.buffer, '\n')
		consume := end + 1
		if end < 0 || end > maxLineBytes {
			if len(w.buffer) <= maxLineBytes && !flush {
				return
			}
			end = min(len(w.buffer), maxLineBytes)
			consume = end
		}
		w.op.addLog(w.stream, strings.TrimSuffix(w.buffer[:end], "\r"))
		w.buffer = w.buffer[consume:]
	}
}
