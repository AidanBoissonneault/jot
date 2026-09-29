import type { DocumentContent, Project, ProjectPage } from '@/src/types/capture';
import { idbGet, idbSet } from '@/src/services/idbStore';
import { normalizeInkwellBlockIds } from '@/src/extensions/inkwellBlockIds';
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
const INKWELL_BLOCK_ID_ATTR = 'inkwellBlockId';
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
    const deliveryBlocked = pending.find(
      (queued) => queued.projectId === project.id && queued.deliveryBlocked,
    )?.deliveryBlocked;
    const event: ProjectSyncEvent = {
      eventId: crypto.randomUUID(),
      type: project.status === 'archived' ? 'project_archive' : 'project_upsert',
      projectId: project.id,
      sequence,
      createdAt: new Date().toISOString(),
      ...(deliveryBlocked ? { deliveryBlocked } : {}),
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
      event.payload.project.stateContent?.attrs?.inkwellConflictResolution === true,
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

/** Merges blocked local project content with a reloaded remote snapshot and retains the original queue. */
export async function rebaseBlockedProjectSyncEvents(
  remoteProjects: Project[],
  localProjects: Project[],
  persistMergedProjects: (projects: Project[]) => Promise<void>,
  selectedParentPageId?: string,
): Promise<Project[]> {
  return mutateQueue(async () => {
    const pending = ((await idbGet<ProjectSyncEvent[]>(PENDING_PROJECT_SYNC_EVENTS_KEY)) ?? [])
      .slice()
      .sort((first, second) => first.sequence - second.sequence);
    const projectsById = new Map<string, Project>();
    for (const project of remoteProjects) projectsById.set(project.id, project);
    const localProjectsById = new Map<string, Project>();
    for (const project of localProjects) localProjectsById.set(project.id, project);
    const blockedProjectIds = [...new Set(
      pending
        .filter((event) => event.deliveryBlocked)
        .map((event) => event.projectId),
    )];

    if (!blockedProjectIds.length) return [];

    const backups = (await idbGet<ProjectSyncConflictBackup[]>(PROJECT_SYNC_CONFLICT_BACKUPS_KEY)) ?? [];
    const backedUpEventIds = new Set(backups.flatMap((backup) => backup.events.map((event) => event.eventId)));
    const now = new Date().toISOString();
    const updatedBackups = [...backups];
    const replacements: ProjectSyncEvent[] = [];
    let sequence = await nextSequence(blockedProjectIds.length);

    for (const projectId of blockedProjectIds) {
      const events = pending.filter((event) => event.projectId === projectId);
      const remoteProject = projectsById.get(projectId);
      const fullEventSnapshots = events
        .filter((event) => event.type !== 'project_source_upsert')
        .map((event) => event.payload.project as Project);

      const localSnapshots = [
        localProjectsById.get(projectId),
        ...fullEventSnapshots,
      ].filter((project): project is Project => Boolean(project));
      localSnapshots.sort(
        (first, second) => projectUpdatedAt(first) - projectUpdatedAt(second),
      );
      const sourceProject = events.slice().reverse().find(
        (event): event is ProjectSourceSyncEvent => event.type === 'project_source_upsert',
      )?.payload.project;
      const localProject = localSnapshots.at(-1) ?? (sourceProject
        ? { ...sourceProject, stateContent: { type: 'doc', content: [] } }
        : undefined);
      const baseProject = remoteProject ?? localProject;
      if (!baseProject) continue;
      const mergedProject = mergeReloadedProject(
        baseProject,
        localProject,
        events,
        Boolean(remoteProject),
      );

      const unbackedEvents = events.filter((event) => !backedUpEventIds.has(event.eventId));
      if (unbackedEvents.length) {
        updatedBackups.push({
          backupId: crypto.randomUUID(),
          projectId,
          capturedAt: now,
          events: unbackedEvents,
        });
      }

      const latestEvent = events.at(-1);
      replacements.push({
        eventId: crypto.randomUUID(),
        type: mergedProject.status === 'archived' ? 'project_archive' : 'project_upsert',
        projectId,
        sequence: sequence++,
        createdAt: now,
        payload: {
          project: mergedProject,
          selectedParentPageId: latestEvent?.payload.selectedParentPageId ?? selectedParentPageId,
        },
      });
    }

    const rebasedProjectIds = new Set(replacements.map((event) => event.projectId));
    const mergedProjects = replacements.map((event) => event.payload.project as Project);
    await idbSet(PROJECT_SYNC_CONFLICT_BACKUPS_KEY, updatedBackups);
    // Keep the merged content in primary local storage before making its queue
    // event deliverable. If the extension closes here, the original blocked
    // event and its backup remain durable.
    await persistMergedProjects(mergedProjects);
    const nextPending = pending.filter((event) => !rebasedProjectIds.has(event.projectId));
    await idbSet(
      PENDING_PROJECT_SYNC_EVENTS_KEY,
      [...nextPending, ...replacements].sort((first, second) => first.sequence - second.sequence),
    );
    notifyQueueChanged();
    return mergedProjects;
  });
}

function projectUpdatedAt(project: Project): number {
  const timestamp = Date.parse(project.updatedAt);
  return Number.isFinite(timestamp) ? timestamp : 0;
}

function mergeReloadedProject(
  remoteProject: Project,
  localProject: Project | undefined,
  events: ProjectSyncEvent[],
  hasRemoteProject: boolean,
): Project {
  const remoteBlocks = remoteProject.stateContent?.content ?? [];
  const mergedBlocks = [...remoteBlocks];
  const blockCounts = countProjectStateBlocks(mergedBlocks);

  const appendMissingBlocks = (candidateBlocks: DocumentContent[]) => {
    const requiredCounts = countProjectStateBlocks(candidateBlocks);
    for (const block of candidateBlocks) {
      const signature = projectStateBlockSignature(block);
      const present = blockCounts.get(signature) ?? 0;
      if (present >= (requiredCounts.get(signature) ?? 0)) continue;
      mergedBlocks.push(block);
      blockCounts.set(signature, present + 1);
    }
  };

  appendMissingBlocks(localProject?.stateContent?.content ?? []);
  // Include source-only events too, including queues left behind by a relog.
  for (const event of events) {
    if (event.type === 'project_source_upsert') {
      appendMissingBlocks([event.payload.block]);
    }
  }

  const localMetadata = localProject
    ? (() => {
        const {
          stateContent: _stateContent,
          stateRemoteRevision: _stateRemoteRevision,
          syncMessage: _syncMessage,
          syncState: _syncState,
          ...metadata
        } = localProject;
        return metadata;
      })()
    : {};

  return {
    ...remoteProject,
    ...localMetadata,
    stateRemoteRevision: hasRemoteProject ? remoteProject.stateRemoteRevision : undefined,
    stateContent: normalizeInkwellBlockIds({
      type: remoteProject.stateContent?.type ?? localProject?.stateContent?.type ?? 'doc',
      content: mergedBlocks,
    }),
    syncState: 'saving',
    syncMessage: undefined,
  };
}

function countProjectStateBlocks(blocks: DocumentContent[]): Map<string, number> {
  const counts = new Map<string, number>();
  for (const block of blocks) {
    const signature = projectStateBlockSignature(block);
    counts.set(signature, (counts.get(signature) ?? 0) + 1);
  }
  return counts;
}

function projectStateBlockSignature(block: DocumentContent): string {
  return JSON.stringify(withoutInkwellBlockIds(block));
}

function withoutInkwellBlockIds(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(withoutInkwellBlockIds);
  if (!value || typeof value !== 'object') return value;
  return Object.fromEntries(
    Object.entries(value)
      .filter(([key]) => key !== INKWELL_BLOCK_ID_ATTR)
      .sort(([first], [second]) => first.localeCompare(second))
      .map(([key, nested]) => [key, withoutInkwellBlockIds(nested)]),
  );
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
  const { stateContent: _projectStateContent, ...projectContext } = project;
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

  for (const [inkwellBlockId, block] of nextBlocks) {
    const index = nextOrder.indexOf(inkwellBlockId);
    const previousBlock = previousBlocks.get(inkwellBlockId);
    if (!previousBlock) {
      ops.push({
        ...base,
        type: 'block_create',
        inkwellBlockId,
        payload: {
          ...base.payload,
          block,
          index,
          afterInkwellBlockId: nextOrder[index - 1],
        },
      });
    } else if (stableJson(previousBlock) !== stableJson(block)) {
      ops.push({
        ...base,
        type: 'block_update',
        inkwellBlockId,
        payload: {
          ...base.payload,
          block,
          previousBlock,
          index,
          afterInkwellBlockId: nextOrder[index - 1],
        },
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
    const deliveryBlocked = pending.find(
      (queued) => queued.projectId === project.id && queued.deliveryBlocked,
    )?.deliveryBlocked;
    const { stateContent: _stateContent, ...projectContext } = project;
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
    ...order.map((inkwellBlockId, index) => ({
      ...base,
      type: 'block_create' as const,
      inkwellBlockId,
      payload: {
        ...base.payload,
        block: blocks.get(inkwellBlockId),
        index,
        afterInkwellBlockId: order[index - 1],
      },
    })),
  ];
}

export function compactPendingSyncOps(ops: BlockSyncOp[]): BlockSyncOp[] {
  const sorted = removeOpsSupersededByFullSnapshots(
    expandLegacyFullPageSnapshots(
      collapseLegacyFullPageSnapshots(ops
        .map((op) => ({ ...op, payload: { ...op.payload } }))
        .sort((first, second) => first.sequence - second.sequence)),
    ).map(stripLegacySyncContext),
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

function expandLegacyFullPageSnapshots(ops: BlockSyncOp[]): BlockSyncOp[] {
  return ops.flatMap((op) => {
    if (op.type !== 'block_reorder' || !op.payload.page.content) return [op];
    const blocks = blocksById(op.payload.page.content);
    const order = op.payload.order?.filter((id) => blocks.has(id)) ?? Array.from(blocks.keys());
    const reset: BlockSyncOp = {
      ...op,
      type: 'blocks_reset',
      payload: { ...op.payload, order: undefined, replaceAll: undefined },
    };
    const creates = order.map((inkwellBlockId, index): BlockSyncOp => ({
      ...op,
      opId: `${op.opId}:block:${inkwellBlockId}`,
      type: 'block_create',
      inkwellBlockId,
      sequence: op.sequence + ((index + 1) / (order.length + 1)),
      payload: {
        ...op.payload,
        block: blocks.get(inkwellBlockId),
        order: undefined,
        replaceAll: undefined,
        index,
        afterInkwellBlockId: order[index - 1],
      },
    }));
    return [reset, ...creates];
  });
}

function stripLegacySyncContext(op: BlockSyncOp): BlockSyncOp {
  const { content: _content, ...page } = op.payload.page;
  const { stateContent: _stateContent, ...project } = op.payload.project;
  return {
    ...op,
    payload: { ...op.payload, page, project },
  };
}

function removeOpsSupersededByFullSnapshots(ops: BlockSyncOp[]): BlockSyncOp[] {
  const latestSnapshotByPage = new Map<string, BlockSyncOp>();

  for (const op of ops) {
    if (op.type !== 'blocks_reset' && (op.type !== 'block_reorder' || !op.payload.replaceAll)) continue;
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
