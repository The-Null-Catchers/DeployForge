import { ArrowDownToLine, Download, Pause, Play, Search } from 'lucide-react';
import { useEffect, useMemo, useRef, useState } from 'react';
import type { LogEvent } from '@deployforge/contracts';
import { Button, CopyButton, Input, Select, cn } from './ui';

// eslint-disable-next-line no-control-regex
const ANSI = /\u001b\[[0-9;?]*[ -/]*[@-~]/g;
export const stripAnsi = (s: string) => s.replace(ANSI, '');

export const MAX_CLIENT_LINES = 10_000;

/** Append with a hard cap so a long-running stream cannot exhaust memory. */
export function appendBounded(prev: LogEvent[], next: LogEvent[], max = MAX_CLIENT_LINES): { lines: LogEvent[]; dropped: number } {
  const all = prev.concat(next);
  if (all.length <= max) return { lines: all, dropped: 0 };
  return { lines: all.slice(all.length - max), dropped: all.length - max };
}

/**
 * Renders untrusted log text as plain text nodes (never HTML), with search,
 * stream filter, follow/pause, copy and download.
 */
export function LogViewer({
  lines,
  droppedCount = 0,
  emptyText = 'No output yet.',
  downloadName,
  downloadHref,
  status,
  height = 'h-[32rem]',
}: {
  lines: LogEvent[];
  droppedCount?: number;
  emptyText?: string;
  downloadName: string;
  downloadHref?: string;
  status?: React.ReactNode;
  height?: string;
}) {
  const [query, setQuery] = useState('');
  const [stream, setStream] = useState<'all' | 'stdout' | 'stderr' | 'system'>('all');
  const [follow, setFollow] = useState(true);
  const [paused, setPaused] = useState(false);
  const [frozen, setFrozen] = useState<LogEvent[] | null>(null);
  const box = useRef<HTMLDivElement>(null);

  // Pausing freezes the displayed snapshot; new lines keep arriving in the background.
  const source = paused && frozen ? frozen : lines;
  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    return source.filter((l) => (stream === 'all' || l.stream === stream) && (!q || l.text.toLowerCase().includes(q)));
  }, [source, query, stream]);

  useEffect(() => {
    if (follow && !paused && box.current) box.current.scrollTop = box.current.scrollHeight;
  }, [filtered, follow, paused]);

  const asText = () => filtered.map((l) => `${l.ts} [${l.stream}] ${stripAnsi(l.text)}`).join('\n');
  const download = () => {
    const blob = new Blob([asText() + '\n'], { type: 'text/plain' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = downloadName;
    a.click();
    URL.revokeObjectURL(a.href);
  };

  return (
    <div className="overflow-hidden rounded-lg border border-border bg-surface">
      <div className="flex flex-wrap items-center gap-2 border-b border-border p-2">
        <div className="relative min-w-40 flex-1">
          <Search className="pointer-events-none absolute top-2.5 left-2.5 size-4 text-muted" aria-hidden />
          <Input aria-label="Search logs" placeholder="Search output" value={query} onChange={(e) => setQuery(e.target.value)} className="pl-8" />
        </div>
        <Select aria-label="Filter by stream" value={stream} onChange={(e) => setStream(e.target.value as typeof stream)} className="w-32">
          <option value="all">All streams</option>
          <option value="stdout">stdout</option>
          <option value="stderr">stderr</option>
          <option value="system">platform</option>
        </Select>
        <Button
          size="sm"
          variant={paused ? 'primary' : 'secondary'}
          aria-pressed={paused}
          onClick={() => {
            setFrozen(paused ? null : lines);
            setPaused(!paused);
          }}
          icon={paused ? <Play className="size-4" /> : <Pause className="size-4" />}
        >
          {paused ? 'Resume' : 'Pause'}
        </Button>
        <Button size="sm" variant={follow ? 'secondary' : 'ghost'} aria-pressed={follow} onClick={() => setFollow(!follow)} icon={<ArrowDownToLine className="size-4" />}>
          Follow
        </Button>
        <CopyButton value={asText()} label="Copy" />
        {downloadHref ? (
          <a href={downloadHref} className="inline-flex h-8 items-center gap-1.5 rounded-md px-2.5 text-sm text-muted hover:bg-surface-2 hover:text-fg" download>
            <Download className="size-4" aria-hidden /> Download
          </a>
        ) : (
          <Button size="sm" variant="ghost" onClick={download} icon={<Download className="size-4" />}>
            Download
          </Button>
        )}
      </div>
      {status && <div className="border-b border-border px-3 py-1.5 text-xs text-muted">{status}</div>}
      <div
        ref={box}
        role="log"
        aria-live={paused ? 'off' : 'polite'}
        aria-label="Log output"
        tabIndex={0}
        onScroll={(e) => {
          const el = e.currentTarget;
          const atBottom = el.scrollHeight - el.scrollTop - el.clientHeight < 24;
          if (!atBottom && follow) setFollow(false);
        }}
        className={cn('overflow-auto bg-[#0b0b0d] p-3 font-mono text-[12.5px] leading-[1.35rem] text-zinc-200', height)}
      >
        {droppedCount > 0 && <div className="mb-2 text-zinc-500">… {droppedCount.toLocaleString()} earlier lines not shown (display limit {MAX_CLIENT_LINES.toLocaleString()} lines)</div>}
        {filtered.length === 0 ? (
          <div className="text-zinc-500">{query ? 'No lines match your search.' : emptyText}</div>
        ) : (
          filtered.map((l, i) => (
            <div key={`${l.id}-${i}`} className="log-line flex gap-3 whitespace-pre-wrap break-all">
              <span className="shrink-0 select-none text-zinc-500">{l.ts.slice(11, 19)}</span>
              <span className={cn('min-w-0', l.stream === 'stderr' && 'text-amber-200', l.stream === 'system' && 'text-sky-300')}>{stripAnsi(l.text)}</span>
            </div>
          ))
        )}
      </div>
    </div>
  );
}
