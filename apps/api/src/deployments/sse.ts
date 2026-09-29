import type { Request, Response } from 'express';

const perUser = new Map<string, number>();
export const MAX_STREAMS_PER_USER = 20;

/**
 * Minimal Server-Sent Events writer with backpressure: `send` resolves only
 * once the socket buffer has drained, so a slow client never causes
 * unbounded buffering on the server.
 */
export class SseStream {
  closed = false;
  private heartbeat: NodeJS.Timeout;
  private readonly closeHandlers: (() => void)[] = [];

  private constructor(
    private readonly req: Request,
    private readonly res: Response,
    private readonly userId: string,
  ) {
    res.status(200);
    res.setHeader('Content-Type', 'text/event-stream; charset=utf-8');
    res.setHeader('Cache-Control', 'no-cache, no-transform');
    res.setHeader('Connection', 'keep-alive');
    res.setHeader('X-Accel-Buffering', 'no');
    res.flushHeaders();
    res.write('retry: 3000\n\n');
    this.heartbeat = setInterval(() => {
      if (!this.closed) res.write(': keep-alive\n\n');
    }, 15_000);
    const onClose = () => this.close();
    req.on('close', onClose);
    res.on('error', onClose);
  }

  /** Returns null (after sending 429) if the user has too many open streams. */
  static open(req: Request, res: Response, userId: string): SseStream | null {
    const n = perUser.get(userId) ?? 0;
    if (n >= MAX_STREAMS_PER_USER) {
      res.status(429).json({ statusCode: 429, error: 'Too Many Requests', code: 'too_many_streams', message: 'Too many open live streams' });
      return null;
    }
    perUser.set(userId, n + 1);
    return new SseStream(req, res, userId);
  }

  onClose(fn: () => void): void {
    if (this.closed) fn();
    else this.closeHandlers.push(fn);
  }

  async send(event: string, data: unknown, id?: string): Promise<void> {
    if (this.closed) return;
    let frame = '';
    if (id) frame += `id: ${id}\n`;
    frame += `event: ${event}\n`;
    // JSON never contains raw newlines, so one data line is enough; clients
    // render text as text (never HTML), which keeps untrusted logs inert.
    frame += `data: ${JSON.stringify(data)}\n\n`;
    if (!this.res.write(frame)) {
      await new Promise<void>((resolve) => {
        const done = () => {
          this.res.off('drain', done);
          resolve();
        };
        this.res.on('drain', done);
        this.onClose(done);
      });
    }
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    clearInterval(this.heartbeat);
    const n = (perUser.get(this.userId) ?? 1) - 1;
    if (n <= 0) perUser.delete(this.userId);
    else perUser.set(this.userId, n);
    for (const fn of this.closeHandlers.splice(0)) fn();
    try {
      this.res.end();
    } catch {
      /* already closed */
    }
  }

  get request(): Request {
    return this.req;
  }
}

/** Wait until notified, the timeout elapses, or the stream closes. */
export function waitFor(subscribe: (fn: () => void) => () => void, stream: SseStream, ms: number): Promise<void> {
  return new Promise((resolve) => {
    let unsub: () => void = () => undefined;
    const done = () => {
      clearTimeout(t);
      unsub();
      resolve();
    };
    const t = setTimeout(done, ms);
    unsub = subscribe(done);
    stream.onClose(done);
  });
}
