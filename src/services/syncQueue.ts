import type { DocumentContent, Project, ProjectPage } from '@/src/types/capture';
import { idbGet, idbSet, idbSetMany } from '@/src/services/idbStore';
import { normalizeJottathingBlockIds } from '@/src/extensions/jottathingBlockIds';
import type {
  SyncBlockOperation as BlockSyncOp,
  SyncBlockDeliveryConflict,
} from '@/src/types/sync';
import type { SyncConflictDiff } from '@/src/types/sync';
export type { BlockSyncOp };

const PENDING_SYNC_OPS_KEY = 'pending_sync_ops';
const PENDING_PROJECT_SYNC_EVENTS_KEY = 'pending_project_sync_events';
const PROJECT_SYNC_CONFLICT_BACKUPS_KEY = 'project_sync_conflict_backups';
const SYNC_SEQUENCE_KEY = 'pending_sync_sequence';
const LOCAL_SYNC_VERSIONS_KEY = 'local_sync_versions';
const SYNC_QUEUES_BY_ACCOUNT_KEY = 'sync_queues_by_account';
const ACCOUNT_SCOPED_QUEUE_KEYS = [
  PENDING_SYNC_OPS_KEY,
  PENDING_PROJECT_SYNC_EVENTS_KEY,
  PROJECT_SYNC_CONFLICT_BACKUPS_KEY,
  SYNC_SEQUENCE_KEY,
  LOCAL_SYNC_VERSIONS_KEY,
] as const;
const JOTTATHING_BLOCK_ID_ATTR = 'jottathingBlockId';
const queueChangeListeners = new Set<() => void>();
let queueMutation = Promise.resolve();

export type ProjectSyncBlock = {
  code: 'unmapped_notion_content';
  message: string;
  blockedAt: string;
  diff?: SyncConflictDiff;
};

export type ProjectUpsertSyncEvent = {
  eventId: string;
  type: 'project_upsert' | 'project_archive';
  projectId: string;
  sequence: number;
  createdAt: string;
  deliveryBlocked?: ProjectSyncBlock;
  payload: {
    project: Project;
    selectedParentPageId?: string;
  };
};

export type ProjectSourceSyncEvent = {
  eventId: string;
  type: 'project_source_upsert';
  projectId: string;
  sequence: number;
  createdAt: string;
  deliveryBlocked?: ProjectSyncBlock;
  payload: {
    project: Omit<Project, 'stateContent'>;
    blockId: string;
    block: DocumentContent;
    selectedParentPageId?: string;
  };
};

export type ProjectSyncEvent = ProjectUpsertSyncEvent | ProjectSourceSyncEvent;

type ProjectSyncConflictBackup = {
  backupId: string;
  projectId: string;
  capturedAt: string;
  events: ProjectSyncEvent[];
};

export async function addPendingSyncOps(ops: Omit<BlockSyncOp, 'opId' | 'sequence' | 'createdAt' | 'localVersion'>[]): Promise<BlockSyncOp[]> {
  if (!ops.length) return [];

  return mutateQueue(async () => {
    const pending = await readPendingSyncOps();
    const localVersions = await nextLocalVersions(ops.map((op) => op.pageId));
    let sequence = await nextSequence(ops.length);
    const now = new Date().toISOString();
    const blockedByPage = new Map(
      pending.filter((op) => op.deliveryBlocked).map((op) => [op.pageId, op.deliveryBlocked!]),
    );
    const created = ops.map((op, index) => ({
      ...op,
      ...(blockedByPage.has(op.pageId) ? { deliveryBlocked: blockedByPage.get(op.pageId) } : {}),
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

/** Parks one account's durable queue and restores the next account's queue. */
export async function switchPendingSyncQueueAccount(
  previousAccountId: string,
  nextAccountId: string,
): Promise<void> {
  if (!previousAccountId || !nextAccountId || previousAccountId === nextAccountId) return;

  await mutateQueue(async () => {
    const accounts = (await idbGet<Record<string, Record<string, unknown>>>(
      SYNC_QUEUES_BY_ACCOUNT_KEY,
    )) ?? {};
    const current = Object.fromEntries(await Promise.all(
      ACCOUNT_SCOPED_QUEUE_KEYS.map(async (key) => [key, await idbGet(key)] as const),
    ));
    accounts[previousAccountId] = current;
    const nextUserId = nextAccountId.split('::')[0];
    const fallbackKey = [`${nextUserId}::connected-workspace`, nextUserId]
      .find((key) => key !== nextAccountId && key in accounts);
    const next = accounts[nextAccountId] ?? (fallbackKey ? accounts[fallbackKey] : undefined) ?? {};
    delete accounts[nextAccountId];
    if (fallbackKey) delete accounts[fallbackKey];

    await idbSetMany({
      [SYNC_QUEUES_BY_ACCOUNT_KEY]: accounts,
      [PENDING_SYNC_OPS_KEY]: next[PENDING_SYNC_OPS_KEY] ?? [],
      [PENDING_PROJECT_SYNC_EVENTS_KEY]: next[PENDING_PROJECT_SYNC_EVENTS_KEY] ?? [],
      [PROJECT_SYNC_CONFLICT_BACKUPS_KEY]: next[PROJECT_SYNC_CONFLICT_BACKUPS_KEY] ?? [],
      [SYNC_SEQUENCE_KEY]: next[SYNC_SEQUENCE_KEY] ?? 0,
      [LOCAL_SYNC_VERSIONS_KEY]: next[LOCAL_SYNC_VERSIONS_KEY] ?? {},
    });
    notifyQueueChanged();
  });
}

export async function addPendingProjectSyncEvent(
  project: Project,
  selectedParentPageId?: string,
): Promise<ProjectSyncEvent> {
  return mutateQueue(async () => {
    const pending = await readPendingProjectSyncEvents();
    const sequence = await nextSequence(1);
    const deliveryBlocked = inheritedProjectDeliveryBlock(pending, project.id);
    const { syncConflicts: _syncConflicts, ...projectForSync } = project;
    const event: ProjectSyncEvent = {
      eventId: crypto.randomUUID(),
      type: project.status === 'archived' ? 'project_archive' : 'project_upsert',
      projectId: project.id,
      sequence,
      createdAt: new Date().toISOString(),
      ...(deliveryBlocked ? { deliveryBlocked } : {}),
      payload: { project: projectForSync, selectedParentPageId },
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

/** Keeps a project's delivery block when a newer event replaces its queued work. */
function inheritedProjectDeliveryBlock(
  events: ProjectSyncEvent[],
  projectId: string,
): ProjectSyncBlock | undefined {
  return events.find((event) => event.projectId === projectId && event.deliveryBlocked)
    ?.deliveryBlocked;
}

export async function listBlockedProjectSyncIds(): Promise<string[]> {
  const events = await listPendingProjectSyncEvents();
  return [...new Set(events.filter((event) => event.deliveryBlocked).map((event) => event.projectId))];
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

export async function blockPendingProjectSyncEvents(
  projectId: string,
  block: Omit<ProjectSyncBlock, 'blockedAt'>,
): Promise<void> {
  await mutateQueue(async () => {
    const events = await readPendingProjectSyncEvents();
    await idbSet(
      PENDING_PROJECT_SYNC_EVENTS_KEY,
      events.map((event) => event.projectId === projectId
        ? { ...event, deliveryBlocked: { ...block, blockedAt: new Date().toISOString() } }
        : event),
    );
    notifyQueueChanged();
  });
}

export async function blockPendingSyncOps(
  pageId: string,
  block: SyncBlockDeliveryConflict,
): Promise<void> {
  await mutateQueue(async () => {
    const ops = await readPendingSyncOps();
    await idbSet(PENDING_SYNC_OPS_KEY, ops.map((op) => op.pageId === pageId
      ? { ...op, deliveryBlocked: block }
      : op));
    notifyQueueChanged();
  });
}

export async function unblockPendingSyncOps(): Promise<void> {
  await mutateQueue(async () => {
    const ops = await readPendingSyncOps();
    await idbSet(PENDING_SYNC_OPS_KEY, ops.map((op) => {
      if (!op.deliveryBlocked) return op;
      const { deliveryBlocked: _deliveryBlocked, ...unblocked } = op;
      return unblocked;
    }));
    notifyQueueChanged();
  });
}

/** Retries blocked project events when the user explicitly requests a resync. */
export async function unblockPendingProjectSyncEvents(): Promise<void> {
  await mutateQueue(async () => {
    const events = await readPendingProjectSyncEvents();
    const next = events.map((event) => {
      if (!event.deliveryBlocked) return event;
      const { deliveryBlocked: _deliveryBlocked, ...unblocked } = event;
      return unblocked;
    });
    await idbSet(PENDING_PROJECT_SYNC_EVENTS_KEY, next);
    notifyQueueChanged();
  });
}

/** Persists a user-merged project snapshot and replaces its blocked queue with a deliverable event. */
export async function resolveBlockedProjectSyncEvent(
  project: Project,
  persistProject: (project: Project) => Promise<void>,
  selectedParentPageId?: string,
): Promise<boolean> {
  return mutateQueue(async () => {
    const pending = await readPendingProjectSyncEvents();
    const events = pending.filter((event) => event.projectId === project.id);
    const hasBlockedConflict = events.some((event) => event.deliveryBlocked);
    const hasPendingReviewedMerge = events.some((event) =>
      event.type !== 'project_source_upsert' &&
      event.payload.project.stateContent?.attrs?.jottathingConflictResolution === true,
    );
    if (!hasBlockedConflict && !hasPendingReviewedMerge) return false;

    const backups = (await idbGet<ProjectSyncConflictBackup[]>(PROJECT_SYNC_CONFLICT_BACKUPS_KEY)) ?? [];
    const backedUpEventIds = new Set(backups.flatMap((backup) => backup.events.map((event) => event.eventId)));
    const unbackedEvents = events.filter((event) =>
      (event.deliveryBlocked || !hasPendingReviewedMerge) &&
      !backedUpEventIds.has(event.eventId),
    );
    if (unbackedEvents.length) {
      await idbSet(PROJECT_SYNC_CONFLICT_BACKUPS_KEY, [
        ...backups,
        {
          backupId: crypto.randomUUID(),
          projectId: project.id,
          capturedAt: new Date().toISOString(),
          events: unbackedEvents,
        },
      ]);
    }

    await persistProject(project);
    const sequence = await nextSequence(1);
    const replacement: ProjectUpsertSyncEvent = {
      eventId: crypto.randomUUID(),
      type: project.status === 'archived' ? 'project_archive' : 'project_upsert',
      projectId: project.id,
      sequence,
      createdAt: new Date().toISOString(),
      payload: { project, selectedParentPageId: selectedParentPageId ?? events.at(-1)?.payload.selectedParentPageId },
    };
    await idbSet(
      PENDING_PROJECT_SYNC_EVENTS_KEY,
      [...pending.filter((event) => event.projectId !== project.id), replacement]
        .sort((first, second) => first.sequence - second.sequence),
    );
    notifyQueueChanged();
    return true;
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
  const { content: _pageContent, ...pageContext } = page;
  const { stateContent: _projectStateContent, syncConflicts: _syncConflicts, ...projectContext } = project;
  const base = {
    pageId: page.id,
    projectId: project.id,
    baseKnownSyncVersion: page.knownSyncVersion,
    payload: { page: pageContext, project: projectContext, selectedParentPageId },
  };

  if (page.status === 'archived') {
    return [{ ...base, type: 'page_archive' }];
  }

  const previousBlocks = blocksById(previousPage?.content);
  const nextBlocks = blocksById(page.content);
  const previousOrder = Array.from(previousBlocks.keys());
  const nextOrder = Array.from(nextBlocks.keys());

  // Full snapshots are represented as a reset followed by one message per
  // top-level block. This keeps the Cloudflare Queue payload bounded even for
  // large pages and makes every block create independently retryable.
  if (!previousPage) {
    return fullPageReplacementOps(base, nextBlocks, nextOrder);
  }

  const ops: Omit<BlockSyncOp, 'opId' | 'sequence' | 'createdAt' | 'localVersion'>[] = [];

  if (pageMetadataChanged(previousPage, page)) {
    ops.push({ ...base, type: 'page_upsert' });
  }

  for (const [jottathingBlockId, block] of nextBlocks) {
    const index = nextOrder.indexOf(jottathingBlockId);
    const previousBlock = previousBlocks.get(jottathingBlockId);
    if (!previousBlock) {
      ops.push({
        ...base,
        type: 'block_create',
        jottathingBlockId,
        payload: {
          ...base.payload,
          block,
          index,
          afterJottathingBlockId: nextOrder[index - 1],
        },
      });
    } else if (stableJson(previousBlock) !== stableJson(block)) {
      ops.push({
        ...base,
        type: 'block_update',
        jottathingBlockId,
        payload: {
          ...base.payload,
          block,
          previousBlock,
          index,
          afterJottathingBlockId: nextOrder[index - 1],
        },
      });
    }
  }

  for (const [jottathingBlockId, previousBlock] of previousBlocks) {
    if (!nextBlocks.has(jottathingBlockId)) {
      ops.push({
        ...base,
        type: 'block_delete',
        jottathingBlockId,
        payload: { ...base.payload, previousBlock },
      });
    }
  }

  const previousCommonOrder = previousOrder.filter((id) => nextBlocks.has(id));
  const nextCommonOrder = nextOrder.filter((id) => previousBlocks.has(id));
  if (previousCommonOrder.join('\n') !== nextCommonOrder.join('\n')) {
    return fullPageReplacementOps(base, nextBlocks, nextOrder);
  }

  return ops;
}

export async function addPendingProjectSourceSyncEvent(
  project: Project,
  blockId: string,
  block: DocumentContent,
  selectedParentPageId?: string,
): Promise<ProjectSourceSyncEvent> {
  return mutateQueue(async () => {
    const pending = await readPendingProjectSyncEvents();
    const sequence = await nextSequence(1);
    const deliveryBlocked = inheritedProjectDeliveryBlock(pending, project.id);
    const { stateContent: _stateContent, syncConflicts: _syncConflicts, ...projectContext } = project;
    const event: ProjectSourceSyncEvent = {
      eventId: crypto.randomUUID(),
      type: 'project_source_upsert',
      projectId: project.id,
      sequence,
      createdAt: new Date().toISOString(),
      ...(deliveryBlocked ? { deliveryBlocked } : {}),
      payload: {
        project: projectContext,
        blockId,
        block,
        selectedParentPageId,
      },
    };
    const compacted = pending.filter((queued) =>
      queued.type !== 'project_source_upsert' ||
      queued.projectId !== project.id ||
      queued.payload.blockId !== blockId,
    );
    await idbSet(PENDING_PROJECT_SYNC_EVENTS_KEY, [...compacted, event]);
    notifyQueueChanged();
    return event;
  });
}

function fullPageReplacementOps(
  base: Omit<BlockSyncOp, 'opId' | 'sequence' | 'createdAt' | 'localVersion' | 'type'>,
  blocks: Map<string, DocumentContent>,
  order: string[],
): Omit<BlockSyncOp, 'opId' | 'sequence' | 'createdAt' | 'localVersion'>[] {
  return [
    { ...base, type: 'blocks_reset' },
    ...order.map((jottathingBlockId, index) => ({
      ...base,
      type: 'block_create' as const,
      jottathingBlockId,
      payload: {
        ...base.payload,
        block: blocks.get(jottathingBlockId),
        index,
        afterJottathingBlockId: order[index - 1],
      },
    })),
  ];
}

export function compactPendingSyncOps(ops: BlockSyncOp[]): BlockSyncOp[] {
  const sorted = removeOpsSupersededByResetSnapshots(ops
    .map((op) => ({ ...op, payload: { ...op.payload } }))
    .sort((first, second) => first.sequence - second.sequence));
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

function removeOpsSupersededByResetSnapshots(ops: BlockSyncOp[]): BlockSyncOp[] {
  const latestSnapshotByPage = new Map<string, BlockSyncOp>();

  for (const op of ops) {
    if (op.type !== 'blocks_reset') continue;
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

function blocksById(content: DocumentContent | undefined): Map<string, DocumentContent> {
  const result = new Map<string, DocumentContent>();

  for (const block of content?.content ?? []) {
    const id = blockId(block);
    if (id) result.set(id, block);
  }

  return result;
}

function blockId(block: DocumentContent): string {
  const value = block.attrs?.[JOTTATHING_BLOCK_ID_ATTR];
  return typeof value === 'string' ? value : '';
}

function opBlockKey(op: BlockSyncOp): string {
  return op.jottathingBlockId ? `${op.pageId}:${op.jottathingBlockId}` : '';
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
