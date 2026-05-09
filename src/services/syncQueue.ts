import type { Project, ProjectPage } from '@/src/types/capture';
import { idbGet, idbSet } from '@/src/services/idbStore';

const PENDING_SYNC_OPS_KEY = 'pending_sync_ops';

export type PendingSyncOp = {
  id: string;
  page: ProjectPage;
  project: Project;
  queuedAt: string;
};

export async function addPendingSync(page: ProjectPage, project: Project): Promise<void> {
  const ops = await listPendingSyncs();
  const next = ops.filter((op) => op.id !== page.id);
  next.push({ id: page.id, page, project, queuedAt: new Date().toISOString() });
  await idbSet(PENDING_SYNC_OPS_KEY, next);
}

export async function removePendingSync(pageId: string): Promise<void> {
  const ops = await listPendingSyncs();
  await idbSet(PENDING_SYNC_OPS_KEY, ops.filter((op) => op.id !== pageId));
}

export async function listPendingSyncs(): Promise<PendingSyncOp[]> {
  return (await idbGet<PendingSyncOp[]>(PENDING_SYNC_OPS_KEY)) ?? [];
}
