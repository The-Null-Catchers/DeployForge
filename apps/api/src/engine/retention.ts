/**
 * Image retention policy (pure function; unit tested).
 *
 * Protected images, never removed:
 *  - the image of the active release,
 *  - images of pinned releases,
 *  - images of the newest `keep` successful releases (distinct images),
 *  - images referenced by any deployment that is still in progress.
 * Removable:
 *  - images only referenced by older successful releases,
 *  - images of failed/canceled/interrupted deployments older than the grace period,
 *  - images labeled with the application but referenced by no deployment,
 *    older than the grace period.
 * Rollback deployments reuse their source image, so protection is computed
 * per image, not per deployment.
 */
export interface RetentionDeployment {
  id: string;
  number: number;
  status: string;
  imageId: string | null;
  imagePrunedAt: Date | null;
  pinned: boolean;
  finishedAt: Date | null;
}

export interface RetentionImage {
  id: string;
  createdAt: Date;
}

export interface RetentionInput {
  deployments: RetentionDeployment[];
  images: RetentionImage[];
  activeDeploymentId: string | null;
  keep: number;
  now: Date;
  graceMs: number;
}

export interface RetentionDecision {
  removeImages: string[];
  markPruned: string[];
  protectedImages: string[];
}

const IN_PROGRESS = new Set(['queued', 'preparing', 'cloning', 'building', 'starting', 'checking_health', 'promoting']);

export function decideRetention(input: RetentionInput): RetentionDecision {
  const protectedSet = new Set<string>();
  const byNumber = [...input.deployments].sort((a, b) => b.number - a.number);
  const active = input.deployments.find((d) => d.id === input.activeDeploymentId);
  if (active?.imageId) protectedSet.add(active.imageId);
  for (const d of input.deployments) {
    if (!d.imageId) continue;
    if (d.pinned || IN_PROGRESS.has(d.status)) protectedSet.add(d.imageId);
  }
  const recent = new Set<string>();
  for (const d of byNumber) {
    if (recent.size >= input.keep) break;
    if (d.status === 'succeeded' && d.imageId && !d.imagePrunedAt) recent.add(d.imageId);
  }
  for (const id of recent) protectedSet.add(id);

  const referenced = new Map<string, RetentionDeployment[]>();
  for (const d of input.deployments) {
    if (!d.imageId) continue;
    referenced.set(d.imageId, [...(referenced.get(d.imageId) ?? []), d]);
  }

  const removeImages: string[] = [];
  for (const img of input.images) {
    if (protectedSet.has(img.id)) continue;
    const refs = referenced.get(img.id) ?? [];
    const oldEnough = input.now.getTime() - img.createdAt.getTime() > input.graceMs;
    if (refs.length === 0) {
      if (oldEnough) removeImages.push(img.id);
      continue;
    }
    const allRemovable = refs.every((d) => {
      if (d.status === 'succeeded') return true;
      const finished = d.finishedAt?.getTime() ?? 0;
      return input.now.getTime() - finished > input.graceMs;
    });
    if (allRemovable) removeImages.push(img.id);
  }
  const removeSet = new Set(removeImages);
  const markPruned = input.deployments.filter((d) => d.imageId && removeSet.has(d.imageId) && !d.imagePrunedAt).map((d) => d.id);
  return { removeImages, markPruned, protectedImages: [...protectedSet] };
}
