import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createApp, createHarness, resetDatabase, setupOwner, type BrowserClient, type Harness } from './harness';
import { CoordinationService } from '../src/engine/coordination.service';
import { WorkerService } from '../src/engine/worker.service';
import { QueuesService, jobIdFor } from '../src/engine/queues';

let h: Harness;
let owner: BrowserClient;
let app: { id: string };

beforeAll(async () => {
  h = await createHarness();
});
afterAll(async () => h.close());
beforeEach(async () => {
  await resetDatabase(h.prisma);
  await h.redis.client.flushdb();
  owner = await setupOwner(h);
  app = await createApp(h, owner, 'engine');
});

const deploy = (headers: Record<string, string> = {}) => {
  const r = owner.agent.post(`/api/apps/${app.id}/deployments`).set('x-csrf-token', owner.csrf);
  for (const [k, v] of Object.entries(headers)) r.set(k, v);
  return r.send({});
};

describe('durable enqueueing (outbox)', () => {
  it('persists the deployment and its outbox event together', async () => {
    const d = await deploy().expect(201);
    expect(d.body.status).toBe('queued');
    expect(d.body.commitSha).toBe('a'.repeat(40));
    const events = await h.prisma.outboxEvent.findMany();
    expect(events).toHaveLength(1);
    expect(events[0]!.kind).toBe('deployment.run');
    expect(events[0]!.payload).toEqual({ deploymentId: d.body.id });
  });

  it('dispatches outbox rows to BullMQ exactly once even when dispatched repeatedly', async () => {
    const d = await deploy().expect(201);
    const worker = h.app.get(WorkerService);
    const queues = h.app.get(QueuesService);
    await queues.deployments.obliterate({ force: true });
    expect(await worker.dispatch()).toBe(1);
    expect(await worker.dispatch()).toBe(0);
    // Simulate a crash after enqueue but before marking dispatched: replay.
    await h.prisma.outboxEvent.updateMany({ data: { dispatchedAt: null } });
    expect(await worker.dispatch()).toBe(1);
    const jobs = await queues.deployments.getJobs(['waiting', 'delayed', 'active']);
    expect(jobs.map((j) => j.id)).toEqual([jobIdFor(`deployment.run:${d.body.id}`)]);
    await queues.deployments.obliterate({ force: true });
  });

  it('refuses to deploy a branch that does not exist', async () => {
    await owner.agent.patch(`/api/apps/${app.id}`).set('x-csrf-token', owner.csrf).send({ branch: 'gone' }).expect(200);
    const r = await deploy().expect(422);
    expect(r.body.code).toBe('branch_not_found');
    expect(await h.prisma.deployment.count()).toBe(0);
  });
});

describe('per-application queue policy', () => {
  it('cancels older queued deployments as superseded (latest request wins)', async () => {
    const a = await deploy().expect(201);
    const b = await deploy().expect(201);
    const c = await deploy().expect(201);
    const rows = await h.prisma.deployment.findMany({ orderBy: { number: 'asc' } });
    expect(rows.map((r) => [r.id, r.status, r.failureCategory])).toEqual([
      [a.body.id, 'canceled', 'superseded'],
      [b.body.id, 'canceled', 'superseded'],
      [c.body.id, 'queued', null],
    ]);
    expect(rows.map((r) => r.number)).toEqual([1, 2, 3]);
  });

  it('does not supersede a deployment that is already running', async () => {
    const a = await deploy().expect(201);
    await h.prisma.deployment.update({ where: { id: a.body.id }, data: { status: 'building' } });
    await deploy().expect(201);
    expect((await h.prisma.deployment.findUniqueOrThrow({ where: { id: a.body.id } })).status).toBe('building');
  });

  it('honors idempotency keys (duplicate requests create one deployment)', async () => {
    const r1 = await deploy({ 'idempotency-key': 'retry-abc-123' }).expect(201);
    const r2 = await deploy({ 'idempotency-key': 'retry-abc-123' }).expect(201);
    expect(r2.body.id).toBe(r1.body.id);
    expect(await h.prisma.deployment.count()).toBe(1);
  });

  it('allocates unique, monotonically increasing numbers under concurrency', async () => {
    const results = await Promise.all(Array.from({ length: 6 }, () => deploy()));
    expect(results.every((r) => r.status === 201)).toBe(true);
    const numbers = (await h.prisma.deployment.findMany()).map((d) => d.number).sort((x, y) => x - y);
    expect(numbers).toEqual([1, 2, 3, 4, 5, 6]);
    expect(await h.prisma.deployment.count({ where: { status: 'queued' } })).toBe(1);
  });

  it('cancels queued deployments directly and refuses to cancel after promotion starts', async () => {
    const a = await deploy().expect(201);
    const c = await owner.agent.post(`/api/deployments/${a.body.id}/cancel`).set('x-csrf-token', owner.csrf).expect(200);
    expect(c.body.status).toBe('canceled');
    const b = await deploy().expect(201);
    await h.prisma.deployment.update({ where: { id: b.body.id }, data: { status: 'promoting' } });
    await owner.agent.post(`/api/deployments/${b.body.id}/cancel`).set('x-csrf-token', owner.csrf).expect(409);
  });
});

describe('application coordination lease', () => {
  it('is exclusive, fenced and recoverable after expiry', async () => {
    const coord = h.app.get(CoordinationService);
    const t1 = await coord.acquire(app.id, 'dep-1', 60);
    expect(t1).toBe(1);
    expect(await coord.acquire(app.id, 'dep-2', 60)).toBeNull();
    // The holder itself cannot re-acquire (a redelivered job must wait for expiry).
    expect(await coord.acquire(app.id, 'dep-1', 60)).toBeNull();
    expect(await coord.renew(app.id, 'dep-1', t1!, 60)).toBe(true);
    // Simulate a crashed holder: lease expires and another worker takes over.
    await h.prisma.application.update({ where: { id: app.id }, data: { lockExpiresAt: new Date(Date.now() - 1000) } });
    const t2 = await coord.acquire(app.id, 'dep-2', 60);
    expect(t2).toBe(2);
    // The stale holder can no longer renew or release the new holder's lease.
    expect(await coord.renew(app.id, 'dep-1', t1!, 60)).toBe(false);
    await coord.release(app.id, 'dep-1', t1!);
    expect((await coord.holder(app.id)).holderId).toBe('dep-2');
    await coord.release(app.id, 'dep-2', t2!);
    expect((await coord.holder(app.id)).holderId).toBeNull();
  });

  it('refuses lifecycle operations while a deployment holds the lease', async () => {
    const d = await deploy().expect(201);
    await h.prisma.deployment.update({ where: { id: d.body.id }, data: { status: 'succeeded', containerId: 'abc', releaseState: 'active' } });
    await h.prisma.application.update({ where: { id: app.id }, data: { activeDeploymentId: d.body.id } });
    await h.app.get(CoordinationService).acquire(app.id, 'other-deployment', 60);
    const r = await owner.agent.post(`/api/apps/${app.id}/restart`).set('x-csrf-token', owner.csrf).expect(409);
    expect(r.body.code).toBe('busy');
  });
});
