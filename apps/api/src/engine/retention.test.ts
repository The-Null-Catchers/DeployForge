import { describe, expect, it } from 'vitest';
import { decideRetention, type RetentionDeployment } from './retention';

const now = new Date('2026-09-29T12:00:00Z');
const hoursAgo = (h: number) => new Date(now.getTime() - h * 3600_000);
const dep = (number: number, status: string, imageId: string | null, extra: Partial<RetentionDeployment> = {}): RetentionDeployment => ({
  id: `d${number}`,
  number,
  status,
  imageId,
  imagePrunedAt: null,
  pinned: false,
  finishedAt: hoursAgo(10),
  ...extra,
});

describe('image retention', () => {
  it('keeps the active release, pinned releases and the newest N', () => {
    const deployments = [dep(1, 'succeeded', 'i1', { pinned: true }), dep(2, 'succeeded', 'i2'), dep(3, 'succeeded', 'i3'), dep(4, 'succeeded', 'i4'), dep(5, 'succeeded', 'i5')];
    const images = ['i1', 'i2', 'i3', 'i4', 'i5'].map((id) => ({ id, createdAt: hoursAgo(20) }));
    const r = decideRetention({ deployments, images, activeDeploymentId: 'd2', keep: 2, now, graceMs: 3600_000 });
    expect(r.removeImages.sort()).toEqual(['i3']);
    expect(r.protectedImages.sort()).toEqual(['i1', 'i2', 'i4', 'i5']);
    expect(r.markPruned).toEqual(['d3']);
  });

  it('protects an image shared by a rollback deployment', () => {
    // #3 is a rollback to #1 and reuses its image; #3 is active.
    const deployments = [dep(1, 'succeeded', 'i1'), dep(2, 'succeeded', 'i2'), dep(3, 'succeeded', 'i1')];
    const images = [{ id: 'i1', createdAt: hoursAgo(20) }, { id: 'i2', createdAt: hoursAgo(20) }];
    const r = decideRetention({ deployments, images, activeDeploymentId: 'd3', keep: 1, now, graceMs: 3600_000 });
    expect(r.removeImages).toEqual(['i2']);
    expect(r.protectedImages).toContain('i1');
  });

  it('keeps failed images during the grace period and never touches in-progress ones', () => {
    const deployments = [dep(1, 'succeeded', 'i1'), dep(2, 'failed', 'i2', { finishedAt: hoursAgo(0.1) }), dep(3, 'failed', 'i3', { finishedAt: hoursAgo(5) }), dep(4, 'checking_health', 'i4')];
    const images = ['i1', 'i2', 'i3', 'i4'].map((id) => ({ id, createdAt: hoursAgo(6) }));
    const r = decideRetention({ deployments, images, activeDeploymentId: 'd1', keep: 5, now, graceMs: 3600_000 });
    expect(r.removeImages).toEqual(['i3']);
  });

  it('removes unreferenced owned images only after the grace period', () => {
    const r = decideRetention({
      deployments: [],
      images: [{ id: 'old', createdAt: hoursAgo(3) }, { id: 'new', createdAt: hoursAgo(0.2) }],
      activeDeploymentId: null,
      keep: 5,
      now,
      graceMs: 3600_000,
    });
    expect(r.removeImages).toEqual(['old']);
  });
});
