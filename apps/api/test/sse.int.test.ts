import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { addMember, createApp, createHarness, setupOwner, type BrowserClient, type Harness } from './harness';

let h: Harness;
let owner: BrowserClient;
let viewer: BrowserClient;
let outsider: BrowserClient;
let deploymentId: string;
let port: number;

beforeAll(async () => {
  h = await createHarness();
  await h.app.listen(0, '127.0.0.1');
  port = (h.app.getHttpServer().address() as AddressInfo).port;
  owner = await setupOwner(h);
  viewer = await addMember(h, owner, 'viewer@example.com', 'viewer');
  const ws = await owner.agent.post('/api/workspaces').set('x-csrf-token', owner.csrf).send({ name: 'Other' }).expect(201);
  outsider = await addMember(h, owner, 'out@example.com', 'owner', ws.body.id);
  const app = await createApp(h, owner, 'sse-app', { env: [{ key: 'TOKEN', value: 'secret-token-value', secret: true }] });
  const d = await owner.agent.post(`/api/apps/${app.id}/deployments`).set('x-csrf-token', owner.csrf).send({}).expect(201);
  deploymentId = d.body.id;
  // Simulate a finished deployment with logs.
  const now = Date.now();
  await h.prisma.deploymentLog.createMany({
    data: Array.from({ length: 5 }, (_, i) => ({ deploymentId, ts: new Date(now + i), stream: 'stdout', text: `line ${i + 1} <script>alert(1)</script>` })),
  });
  await h.prisma.deployment.update({ where: { id: deploymentId }, data: { status: 'failed', finishedAt: new Date() } });
});
afterAll(async () => h.close());

function cookieOf(client: BrowserClient): string {
  const jar = (client.agent as unknown as { jar: { getCookies(o: object): { name: string; value: string }[] } }).jar;
  return jar
    .getCookies({ domain: '127.0.0.1', path: '/', secure: false, script: false })
    .map((c) => `${c.name}=${c.value}`)
    .join('; ');
}

interface SseEvent {
  id?: string;
  event: string;
  data: unknown;
}

/** Read an SSE stream until it ends (the server closes finished deployments). */
function readStream(path: string, cookie: string, lastEventId?: string): Promise<{ status: number; events: SseEvent[] }> {
  return new Promise((resolve, reject) => {
    const req = http.get({ host: '127.0.0.1', port, path, headers: { cookie, ...(lastEventId ? { 'last-event-id': lastEventId } : {}) } }, (res) => {
      let buf = '';
      const events: SseEvent[] = [];
      res.on('data', (c: Buffer) => {
        buf += c.toString();
        let i: number;
        while ((i = buf.indexOf('\n\n')) >= 0) {
          const frame = buf.slice(0, i);
          buf = buf.slice(i + 2);
          const ev: Partial<SseEvent> & { event: string } = { event: 'message' };
          for (const line of frame.split('\n')) {
            if (line.startsWith('id: ')) ev.id = line.slice(4);
            if (line.startsWith('event: ')) ev.event = line.slice(7);
            if (line.startsWith('data: ')) ev.data = JSON.parse(line.slice(6));
          }
          if (ev.data !== undefined) events.push(ev as SseEvent);
        }
      });
      res.on('end', () => resolve({ status: res.statusCode ?? 0, events }));
    });
    req.on('error', reject);
    req.setTimeout(10_000, () => req.destroy(new Error('timeout')));
  });
}

describe('deployment SSE stream', () => {
  it('streams logs, events and status with stable resumable IDs, then ends', async () => {
    const r = await readStream(`/api/deployments/${deploymentId}/stream`, cookieOf(owner));
    expect(r.status).toBe(200);
    const logs = r.events.filter((e) => e.event === 'log');
    expect(logs.map((e) => (e.data as { text: string }).text.split(' ')[1])).toEqual(['1', '2', '3', '4', '5']);
    // Untrusted output is delivered as data, never interpreted.
    expect((logs[0]!.data as { text: string }).text).toContain('<script>');
    expect(r.events.some((e) => e.event === 'status')).toBe(true);
    expect(r.events[r.events.length - 1]!.event).toBe('end');
    // Resume after the third line: only lines 4 and 5 are replayed.
    const third = logs[2]!.id!;
    const resumed = await readStream(`/api/deployments/${deploymentId}/stream`, cookieOf(owner), third);
    expect(resumed.events.filter((e) => e.event === 'log').map((e) => (e.data as { text: string }).text.split(' ')[1])).toEqual(['4', '5']);
  });

  it('allows viewers and hides the stream from other workspaces', async () => {
    expect((await readStream(`/api/deployments/${deploymentId}/stream`, cookieOf(viewer))).status).toBe(200);
    expect((await readStream(`/api/deployments/${deploymentId}/stream`, cookieOf(outsider))).status).toBe(404);
    expect((await readStream(`/api/deployments/${deploymentId}/stream`, '')).status).toBe(401);
  });

  it('supports search and pagination on stored logs', async () => {
    const all = await owner.agent.get(`/api/deployments/${deploymentId}/logs?limit=2`).expect(200);
    expect(all.body.items).toHaveLength(2);
    expect(all.body.nextCursor).not.toBeNull();
    const next = await owner.agent.get(`/api/deployments/${deploymentId}/logs?limit=10&after=${all.body.nextCursor}`).expect(200);
    expect(next.body.items).toHaveLength(3);
    const q = await owner.agent.get(`/api/deployments/${deploymentId}/logs?q=line%204`).expect(200);
    expect(q.body.items).toHaveLength(1);
    const dl = await owner.agent.get(`/api/deployments/${deploymentId}/logs/download`).expect(200);
    expect(dl.headers['content-type']).toContain('text/plain');
    expect(dl.headers['content-disposition']).toContain('attachment');
    expect(dl.text.split('\n').filter(Boolean)).toHaveLength(5);
  });
});
