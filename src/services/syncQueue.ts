import type { DocumentContent, Project, ProjectPage } from '@/src/types/capture';
import { idbGet, idbSet } from '@/src/services/idbStore';
import type { SyncBlockOperation as BlockSyncOp } from '@/src/types/sync';
export type { BlockSyncOp };

const PENDING_SYNC_OPS_KEY = 'pending_sync_ops';
const PENDING_PROJECT_SYNC_EVENTS_KEY = 'pending_project_sync_events';
const SYNC_SEQUENCE_KEY = 'pending_sync_sequence';
const LOCAL_SYNC_VERSIONS_KEY = 'local_sync_versions';
const INKWELL_BLOCK_ID_ATTR = 'inkwellBlockId';
const queueChangeListeners = new Set<() => void>();
let queueMutation = Promise.resolve();

export type ProjectSyncEvent = {
  eventId: string;
  type: 'project_upsert' | 'project_archive';
  projectId: string;
  sequence: number;
  createdAt: string;
  payload: {
    project: Project;
    selectedParentPageId?: string;
  };
};

export async function addPendingSyncOps(ops: Omit<BlockSyncOp, 'opId' | 'sequence' | 'createdAt' | 'localVersion'>[]): Promise<BlockSyncOp[]> {
  if (!ops.length) return [];

  return mutateQueue(async () => {
    const pending = await readPendingSyncOps();
    const localVersions = await nextLocalVersions(ops.map((op) => op.pageId));
    let sequence = await nextSequence(ops.length);
    const now = new Date().toISOString();
    const created = ops.map((op, index) => ({
      ...op,
      opId: crypto.randomUUID(),
      sequence: sequence++,
      createdAt: now,
      localVersion: localVersions[index],
    }));

    await idbSet(PENDING_SYNC_OPS_KEY, compactPendingSyncOps([...pending, ...created]));
    notifyQueueChanged();
    return created;
  });
}

export async function replacePendingSyncOps(ops: BlockSyncOp[]): Promise<void> {
  await mutateQueue(async () => {
    await idbSet(PENDING_SYNC_OPS_KEY, ops);
    notifyQueueChanged();
  });
}

export async function removePendingSyncOps(opIds: string[]): Promise<void> {
  if (!opIds.length) return;
  await mutateQueue(async () => {
    const ids = new Set(opIds);
    const ops = await readPendingSyncOps();
    await idbSet(PENDING_SYNC_OPS_KEY, ops.filter((op) => !ids.has(op.opId)));
    notifyQueueChanged();
  });
}

export async function listPendingSyncOps(): Promise<BlockSyncOp[]> {
  await queueMutation;
  return readPendingSyncOps();
}

export async function compactStoredPendingSyncOps(): Promise<BlockSyncOp[]> {
  return mutateQueue(async () => {
    const compacted = compactPendingSyncOps(await readPendingSyncOps());
    await idbSet(PENDING_SYNC_OPS_KEY, compacted);
    notifyQueueChanged();
    return compacted;
  });
}

export async function addPendingProjectSyncEvent(
  project: Project,
  selectedParentPageId?: string,
): Promise<ProjectSyncEvent> {
  return mutateQueue(async () => {
    const pending = await readPendingProjectSyncEvents();
    const sequence = await nextSequence(1);
    const event: ProjectSyncEvent = {
      eventId: crypto.randomUUID(),
      type: project.status === 'archived' ? 'project_archive' : 'project_upsert',
      projectId: project.id,
      sequence,
      createdAt: new Date().toISOString(),
      payload: { project, selectedParentPageId },
    };
    const compacted = pending.filter((queued) => queued.projectId !== project.id);
    await idbSet(PENDING_PROJECT_SYNC_EVENTS_KEY, [...compacted, event]);
    notifyQueueChanged();
    return event;
  });
}

export async function listPendingProjectSyncEvents(): Promise<ProjectSyncEvent[]> {
  await queueMutation;
  return readPendingProjectSyncEvents();
}

export async function removePendingProjectSyncEvents(eventIds: string[]): Promise<void> {
  if (!eventIds.length) return;
  await mutateQueue(async () => {
    const ids = new Set(eventIds);
    const events = await readPendingProjectSyncEvents();
    await idbSet(
      PENDING_PROJECT_SYNC_EVENTS_KEY,
      events.filter((event) => !ids.has(event.eventId)),
    );
    notifyQueueChanged();
  });
}

export async function pendingSyncEventCount(): Promise<number> {
  const [pageOps, projectEvents] = await Promise.all([
    listPendingSyncOps(),
    listPendingProjectSyncEvents(),
  ]);
  return new Set(pageOps.map((op) => op.pageId)).size +
    new Set(projectEvents.map((event) => event.projectId)).size;
}

export function onSyncQueueChange(listener: () => void): () => void {
  queueChangeListeners.add(listener);
  return () => queueChangeListeners.delete(listener);
}

async function readPendingSyncOps(): Promise<BlockSyncOp[]> {
  return ((await idbGet<BlockSyncOp[]>(PENDING_SYNC_OPS_KEY)) ?? [])
    .slice()
    .sort((first, second) => first.sequence - second.sequence);
}

async function readPendingProjectSyncEvents(): Promise<ProjectSyncEvent[]> {
  return ((await idbGet<ProjectSyncEvent[]>(PENDING_PROJECT_SYNC_EVENTS_KEY)) ?? [])
    .slice()
    .sort((first, second) => first.sequence - second.sequence);
}

function mutateQueue<T>(mutation: () => Promise<T>): Promise<T> {
  const result = queueMutation.then(mutation, mutation);
  queueMutation = result.then(() => undefined, () => undefined);
  return result;
}

function notifyQueueChanged() {
  for (const listener of queueChangeListeners) listener();
}

export function buildPageSyncOps({
  previousPage,
  page,
  project,
  selectedParentPageId,
}: {
  previousPage?: ProjectPage;
  page: ProjectPage;
  project: Project;
  selectedParentPageId?: string;
}): Omit<BlockSyncOp, 'opId' | 'sequence' | 'createdAt' | 'localVersion'>[] {
  const base = {
    pageId: page.id,
    projectId: project.id,
    baseKnownSyncVersion: page.knownSyncVersion,
    payload: { page, project, selectedParentPageId },
  };

  if (page.status === 'archived') {
    return [{ ...base, type: 'page_archive' }];
  }

  const previousBlocks = blocksById(previousPage?.content);
  const nextBlocks = blocksById(page.content);
  const previousOrder = Array.from(previousBlocks.keys());
  const nextOrder = Array.from(nextBlocks.keys());

  // A page without a previous local snapshot is a complete snapshot, not a
  // series of new blocks. Replacing the managed contents is both smaller and
  // prevents an existing Notion page from receiving every block a second time
  // when its local block mappings are missing or stale.
  if (!previousPage) {
    return [{
      ...base,
      type: 'block_reorder',
      payload: { ...base.payload, order: nextOrder, replaceAll: true },
    }];
  }

  const ops: Omit<BlockSyncOp, 'opId' | 'sequence' | 'createdAt' | 'localVersion'>[] = [];

  if (pageMetadataChanged(previousPage, page)) {
    ops.push({ ...base, type: 'page_upsert' });
  }

  for (const [inkwellBlockId, block] of nextBlocks) {
    const previousBlock = previousBlocks.get(inkwellBlockId);
    if (!previousBlock) {
      ops.push({
        ...base,
        type: 'block_create',
        inkwellBlockId,
        payload: { ...base.payload, block },
      });
    } else if (stableJson(previousBlock) !== stableJson(block)) {
      ops.push({
        ...base,
        type: 'block_update',
        inkwellBlockId,
        payload: { ...base.payload, block, previousBlock },
      });
    }
  }

  for (const [inkwellBlockId, previousBlock] of previousBlocks) {
    if (!nextBlocks.has(inkwellBlockId)) {
      ops.push({
        ...base,
        type: 'block_delete',
        inkwellBlockId,
        payload: { ...base.payload, previousBlock },
      });
    }
  }

  if (previousOrder.length && nextOrder.length && previousOrder.join('\n') !== nextOrder.join('\n')) {
    ops.push({
      ...base,
      type: 'block_reorder',
      payload: { ...base.payload, order: nextOrder },
    });
  }

  return ops;
}

export function compactPendingSyncOps(ops: BlockSyncOp[]): BlockSyncOp[] {
  const sorted = removeOpsSupersededByFullSnapshots(
    collapseLegacyFullPageSnapshots(ops
      .map((op) => ({ ...op, payload: { ...op.payload } }))
      .sort((first, second) => first.sequence - second.sequence)),
  );
  const keep = new Set(sorted.map((op) => op.opId));
  const latestUpdateByBlock = new Map<string, string>();
  const createByBlock = new Map<string, BlockSyncOp>();
  const latestPageUpsert = new Map<string, string>();

  for (const op of sorted) {
    const key = opBlockKey(op);

    if (op.type === 'page_upsert') {
      const previous = latestPageUpsert.get(op.pageId);
      if (previous) keep.delete(previous);
      latestPageUpsert.set(op.pageId, op.opId);
      continue;
    }

    if (op.type === 'block_create' && key) {
      const previousCreate = createByBlock.get(key);
      if (previousCreate) keep.delete(previousCreate.opId);
      const previousUpdate = latestUpdateByBlock.get(key);
      if (previousUpdate) {
        keep.delete(previousUpdate);
        latestUpdateByBlock.delete(key);
      }
      createByBlock.set(key, op);
      continue;
    }

    if (op.type === 'block_update' && key) {
      const createOp = createByBlock.get(key);
      if (createOp) {
        createOp.payload = {
          ...createOp.payload,
          page: op.payload.page,
          block: op.payload.block,
        };
        createOp.localVersion = Math.max(createOp.localVersion, op.localVersion);
        keep.delete(op.opId);
        continue;
      }

      const previous = latestUpdateByBlock.get(key);
      if (previous) keep.delete(previous);
      latestUpdateByBlock.set(key, op.opId);
      continue;
    }

    if (op.type === 'block_delete' && key) {
      const createOp = createByBlock.get(key);
      if (createOp) {
        keep.delete(createOp.opId);
        keep.delete(op.opId);
        createByBlock.delete(key);
        latestUpdateByBlock.delete(key);
        continue;
      }

      const previous = latestUpdateByBlock.get(key);
      if (previous) {
        keep.delete(previous);
        latestUpdateByBlock.delete(key);
      }
    }
  }

  return sorted.filter((op) => keep.has(op.opId));
}

function removeOpsSupersededByFullSnapshots(ops: BlockSyncOp[]): BlockSyncOp[] {
  const latestSnapshotByPage = new Map<string, BlockSyncOp>();

  for (const op of ops) {
    if (op.type !== 'block_reorder' || !op.payload.replaceAll) continue;
    const previous = latestSnapshotByPage.get(op.pageId);
    if (!previous || previous.sequence < op.sequence) {
      latestSnapshotByPage.set(op.pageId, op);
    }
  }

  return ops.filter((op) => {
    const snapshot = latestSnapshotByPage.get(op.pageId);
    return !snapshot || op.sequence > snapshot.sequence || op.opId === snapshot.opId;
  });
}

function collapseLegacyFullPageSnapshots(ops: BlockSyncOp[]): BlockSyncOp[] {
  const batches = new Map<string, BlockSyncOp[]>();

  for (const op of ops) {
    const key = `${op.pageId}\n${op.createdAt}`;
    const batch = batches.get(key) ?? [];
    batch.push(op);
    batches.set(key, batch);
  }

  const removed = new Set<string>();
  const replacements = new Map<string, BlockSyncOp>();

  for (const batch of batches.values()) {
    const pageUpsert = batch.find((op) => op.type === 'page_upsert');
    const creates = batch.filter((op) => op.type === 'block_create' && op.inkwellBlockId);
    if (!pageUpsert || !creates.length) continue;

    const order = Array.from(blocksById(pageUpsert.payload.page.content).keys());
    const createdIds = new Set(creates.map((op) => op.inkwellBlockId));
    if (!order.length || order.some((id) => !createdIds.has(id))) continue;

    const snapshotOps = [pageUpsert, ...creates];
    removed.add(pageUpsert.opId);
    for (const create of creates) removed.add(create.opId);
    replacements.set(pageUpsert.opId, {
      ...pageUpsert,
      type: 'block_reorder',
      sequence: Math.max(...snapshotOps.map((op) => op.sequence)),
      localVersion: Math.max(...snapshotOps.map((op) => op.localVersion)),
      payload: {
        ...pageUpsert.payload,
        order,
        replaceAll: true,
      },
    });
  }

  return [
    ...ops.filter((op) => !removed.has(op.opId)),
    ...replacements.values(),
  ].sort((first, second) => first.sequence - second.sequence);
}

function blocksById(content: DocumentContent | undefined): Map<string, DocumentContent> {
  const result = new Map<string, DocumentContent>();

  for (const block of content?.content ?? []) {
    const id = blockId(block);
    if (id) result.set(id, block);
  }

  return result;
}

function blockId(block: DocumentContent): string {
  const value = block.attrs?.[INKWELL_BLOCK_ID_ATTR];
  return typeof value === 'string' ? value : '';
}

function opBlockKey(op: BlockSyncOp): string {
  return op.inkwellBlockId ? `${op.pageId}:${op.inkwellBlockId}` : '';
}

function pageMetadataChanged(previousPage: ProjectPage, page: ProjectPage): boolean {
  return previousPage.title !== page.title ||
    previousPage.status !== page.status ||
    previousPage.notionPageId !== page.notionPageId ||
    previousPage.notionParentPageId !== page.notionParentPageId;
}

function stableJson(value: unknown): string {
  return JSON.stringify(value);
}

async function nextSequence(count: number): Promise<number> {
  const current = (await idbGet<number>(SYNC_SEQUENCE_KEY)) ?? 0;
  await idbSet(SYNC_SEQUENCE_KEY, current + count);
  return current + 1;
}

async function nextLocalVersions(pageIds: string[]): Promise<number[]> {
  const counters = { ...((await idbGet<Record<string, number>>(LOCAL_SYNC_VERSIONS_KEY)) ?? {}) };
  const versions = pageIds.map((pageId) => {
    const next = (counters[pageId] ?? 0) + 1;
    counters[pageId] = next;
    return next;
  });

  await idbSet(LOCAL_SYNC_VERSIONS_KEY, counters);
  return versions;
}
