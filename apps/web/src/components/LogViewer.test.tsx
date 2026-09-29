import { describe, expect, it } from 'vitest';
import { render, screen } from '@testing-library/react';
import { appendBounded, LogViewer, stripAnsi } from './LogViewer';

const line = (i: number, text = `line ${i}`) => ({ id: String(i), ts: '2026-09-29T12:00:00.000Z', stream: 'stdout' as const, text });

describe('LogViewer', () => {
  it('renders untrusted output as text, never HTML', () => {
    render(<LogViewer lines={[line(1, '<img src=x onerror=alert(1)><b>bold</b>')]} downloadName="x.log" />);
    expect(screen.getByText('<img src=x onerror=alert(1)><b>bold</b>')).toBeInTheDocument();
    expect(document.querySelector('img')).toBeNull();
    expect(document.querySelector('b')).toBeNull();
  });

  it('strips ANSI escape sequences', () => {
    expect(stripAnsi('\u001b[31mred\u001b[0m text')).toBe('red text');
  });

  it('bounds retained lines and reports how many were dropped', () => {
    const prev = Array.from({ length: 8 }, (_, i) => line(i));
    const r = appendBounded(prev, [line(8), line(9), line(10)], 10);
    expect(r.lines).toHaveLength(10);
    expect(r.lines[0]!.id).toBe('1');
    expect(r.dropped).toBe(1);
  });
});
