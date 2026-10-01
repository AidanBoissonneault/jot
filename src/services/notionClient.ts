import type {
  Capture,
  DocumentContent,
  NotionParentPage,
  Project,
  ProjectPage,
  SaveStatus,
  SyncConfig,
} from '@/src/types/capture';
import {
  idbClear,
  idbGet,
  idbGetMany,
  idbSet,
  idbSetMany,
  pauseIdbWrites,
  resumeIdbWrites,
} from '@/src/services/idbStore';
import { createInkwellBlockId, normalizeInkwellBlockIds } from '@/src/extensions/inkwellBlockIds';
import { INKWELL_SOURCE_ATTR, storeInkwellSource } from '@/src/extensions/inkwellLink';
import {
  addSourceToProjectState,
  capturedBlockId,
  migratePageSourcesToProjectState,
  sourceEntryForProjectState,
} from '@/src/extensions/sourceRegistry';
import type {
  CaptureSelectionPayload,
  SourceOpenPayload,
} from '@/src/types/messages';
import { normalizeCodeLanguage } from '@/src/lib/codeLanguages';
import { cleanSyncServerUrl } from '@/src/lib/syncServerUrl';
import { pruneOrphanedProjectStateSources } from '@/src/lib/projectStateSources';
import { stripSyncConflictBlocks } from '@/src/lib/syncConflictReview';
import type {
  CreateNotionPageResponse,
  ListNotionPagesResponse,
  MediaUploadResponse,
  MediaRefreshResponse,
  SyncEnqueueResponse,
  SyncEventMessage,
  SyncPageResponse,
  SyncProjectResponse,
  SyncConflictDiff,
  SyncContentConflict,
  SyncReloadResponse,
  SyncSessionResponse,
  SyncValidationResponse,
} from '@/src/types/sync';
import { markUnrecoverableTransientMedia, sanitizeMediaForSync } from '@/src/extensions/mediaContent';
import {
  addPendingProjectSyncEvent,
  addPendingProjectSourceSyncEvent,
  addPendingSyncOps,
  blockPendingProjectSyncEvents,
  blockPendingSyncOps,
  buildPageSyncOps,
  compactStoredPendingSyncOps,
  listPendingProjectSyncEvents,
  listBlockedProjectSyncIds,
  listPendingSyncOps,
  pendingSyncEventCount as queuedSyncEventCount,
  removePendingProjectSyncEvents,
  removePendingSyncOps,
  resolveBlockedProjectSyncEvent,
  unblockPendingProjectSyncEvents,
  unblockPendingSyncOps,
  type BlockSyncOp,
  type ProjectSyncEvent,
} from '@/src/services/syncQueue';

type InkwellStorage = {
  activePageIdsByProject?: Record<string, string>;
  captures?: Capture[];
  currentProjectId?: string;
  hasExplicitlyLoggedOut?: boolean;
  hasMigratedCapturesToPages?: boolean;
  notionHydrationSource?: string;
  pages?: ProjectPage[];
  projects?: Project[];
  syncConfig?: SyncConfig;
};

type OptimisticProjectCreation = {
  page: ProjectPage;
  project: Project;
  settled: Promise<{ page: ProjectPage; project: Project }>;
};

type OptimisticPageCreation = {
  page: ProjectPage;
  settled: Promise<ProjectPage>;
};


const STORAGE_KEYS: Array<keyof InkwellStorage> = [
  'activePageIdsByProject',
  'captures',
  'currentProjectId',
  'hasExplicitlyLoggedOut',
  'hasMigratedCapturesToPages',
  'notionHydrationSource',
  'pages',
  'projects',
  'syncConfig',
];

const DEFAULT_SYNC_CONFIG: SyncConfig = {
  serverUrl: import.meta.env.DEV
    ? 'http://localhost:8787'
    : import.meta.env.VITE_API_URL ?? '',
  authenticated: false,
  connected: false,
};
const PENDING_CONNECTION_DELETION_KEY = 'inkwellPendingConnectionDeletion';

type PendingConnectionDeletion = {
  requestId: string;
  serverUrl: string;
  userId?: string;
  userEmail?: string;
  workspaceId?: string;
};

const defaultProjects: Project[] = [
  {
    id: 'project-inkwell',
    name: 'Inkwell',
    status: 'active',
    category: 'General',
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    stateContent: emptyDocument(),
    tags: ['inkwell'],
  },
];

const waitForStub = () => new Promise((resolve) => setTimeout(resolve, 80));
const LOCAL_QUEUE_DELIVERY_DELAY_MS = 10_000;
const MAX_QUEUE_RETRY_DELAY_MS = 5 * 60_000;
const pendingTempPageSaves = new Map<string, ProjectPage>();
const projectReconciliations = new Map<string, Promise<string>>();
const inFlightProjectSyncRequests = new Map<string, Promise<SyncProjectResponse>>();
let queueDeliveryPromise: Promise<void> | undefined;
let queueDeliveryTimer: ReturnType<typeof setTimeout> | undefined;
let forcedQueueDeliveryPromise: Promise<void> | undefined;
let queueDeliveryRetryAttempt = 0;
let queueDeliveryRetryDelayMs = 0;
let isSessionLogoutPending = false;
let isConnectionDeletionPending = false;
let idbWriteRecoveryPromise: Promise<void> | undefined;
let currentProjectSelectionRevision = 0;
let requestedCurrentProjectId: string | undefined;

function emptyDocument(): DocumentContent {
  return normalizeInkwellBlockIds({
    type: 'doc',
    content: [
      {
        type: 'paragraph',
      },
    ],
  });
}

function textParagraph(text: string, marks?: DocumentContent['marks']): DocumentContent {
  return {
    type: 'paragraph',
    content: [
      {
        type: 'text',
        text,
        ...(marks ? { marks } : {}),
      },
    ],
  };
}

export function sourcePayloadFromCapture(payload: CaptureSelectionPayload): SourceOpenPayload {
  return {
    sourceUrl: payload.sourceUrl,
    highlightMeta: {
      text: payload.highlightMeta.text || payload.text,
      sourceLink: payload.highlightMeta.sourceLink,
      xpath: payload.highlightMeta.xpath,
      offset: payload.highlightMeta.offset,
      prefix: payload.highlightMeta.prefix,
      suffix: payload.highlightMeta.suffix,
    },
  };
}

export function createCapturedContent(payload: CaptureSelectionPayload): DocumentContent[] {
  const source = storeInkwellSource(sourcePayloadFromCapture(payload));

  if (payload.highlightMeta.isHeading) {
    return createLinkedHeadingContent(payload);
  }

  if (payload.highlightMeta.isCodeBlock) {
    return [
      {
        type: 'codeBlock',
        attrs: {
          language: normalizeCodeLanguage(payload.highlightMeta.codeLanguage),
          inkwellBlockId: createInkwellBlockId(),
          [INKWELL_SOURCE_ATTR]: source,
        },
        content: payload.text ? [{ type: 'text', text: payload.text }] : undefined,
      },
      {
        type: 'paragraph',
      },
    ];
  }

  return [
    {
      type: 'blockquote',
      attrs: {
        inkwellBlockId: createInkwellBlockId(),
        [INKWELL_SOURCE_ATTR]: source,
      },
      content: [textParagraph(payload.text)],
    },
    {
      type: 'paragraph',
    },
  ];
}

export function createLinkedHeadingContent(
  payload: CaptureSelectionPayload,
): DocumentContent[] {
  const level = payload.highlightMeta.headingLevel ?? 2;
  const source = storeInkwellSource(sourcePayloadFromCapture(payload));

  return [
    {
      type: 'heading',
      attrs: {
        inkwellBlockId: createInkwellBlockId(),
        [INKWELL_SOURCE_ATTR]: source,
        level,
      },
      content: [
        {
          type: 'text',
          text: payload.text,
        },
      ],
    },
    {
      type: 'paragraph',
    },
  ];
}

function createDefaultPages(projects: Project[]): ProjectPage[] {
  const now = new Date().toISOString();

  return projects.map((project) => {
    return {
      id: `page-${project.id}`,
      projectId: project.id,
      kind: 'page',
      title: 'Untitled Page',
      status: 'active',
      content: emptyDocument(),
      createdAt: now,
      updatedAt: now,
      localRevision: crypto.randomUUID(),
      syncState: 'saved',
    };
  });
}

function createProjectRecord(name: string, id = `project-${crypto.randomUUID()}`): Project {
  const now = new Date().toISOString();

  return {
    id,
    name: name.trim() || 'Untitled Project',
    status: 'active',
    category: '',
    createdAt: now,
    updatedAt: now,
    stateContent: emptyDocument(),
    tags: [],
    syncState: 'saved',
  };
}

function normalizeProject(project: Project): Project {
  const now = new Date().toISOString();
  const createdAt = project.createdAt ?? now;

  return {
    ...project,
    category: project.category ?? project.tags?.[0] ?? '',
    createdAt,
    updatedAt: project.updatedAt ?? createdAt,
    stateContent: project.stateContent ?? emptyDocument(),
    tags: project.tags ?? [],
    syncState: project.syncState ?? 'saved',
  };
}

function touchProject(project: Project, updates: Partial<Project> = {}): Project {
  return {
    ...project,
    ...updates,
    updatedAt: new Date().toISOString(),
  };
}

function sortProjectsByUpdatedDesc(first: Project, second: Project) {
  return new Date(second.updatedAt).getTime() - new Date(first.updatedAt).getTime();
}

async function migrateStorageToIdb(): Promise<void> {
  const done = await idbGet<boolean>('__idb_migrated__');
  if (done) return;
  const existing = (await browser.storage.local.get(STORAGE_KEYS)) as InkwellStorage;
  if (Object.keys(existing).length > 0) {
    await idbSetMany(existing as Record<string, unknown>);
  }
  await idbSet('__idb_migrated__', true);
}

/** Recovers the write fence after a crash between clearing local data and resuming IndexedDB. */
async function recoverIdbWriteFence(): Promise<void> {
  if (!idbWriteRecoveryPromise) {
    idbWriteRecoveryPromise = (async () => {
      const deletionState = await browser.storage.local.get(PENDING_CONNECTION_DELETION_KEY) as Record<
        string,
        PendingConnectionDeletion | undefined
      >;
      if (deletionState[PENDING_CONNECTION_DELETION_KEY]) {
        isConnectionDeletionPending = true;
        await pauseIdbWrites();
        return;
      }

      await resumeIdbWrites({ adoptCurrentEpoch: true });
    })().catch((error) => {
      idbWriteRecoveryPromise = undefined;
      throw error;
    });
  }
  await idbWriteRecoveryPromise;
}

async function readStorage(): Promise<Required<InkwellStorage>> {
  await recoverIdbWriteFence();
  await migrateStorageToIdb();
  const stored = (await idbGetMany(STORAGE_KEYS)) as InkwellStorage;

  const storedProjects = stored.projects !== undefined ? stored.projects : defaultProjects;
  let projects = (isLegacyStubProjectSet(storedProjects)
    ? defaultProjects
    : storedProjects
  ).map(normalizeProject)
    .sort(sortProjectsByUpdatedDesc);
  const captures = stored.captures ?? [];
  const shouldCreatePages =
    !stored.pages?.length ||
    !stored.hasMigratedCapturesToPages ||
    isLegacyStubProjectSet(storedProjects);
  let pages = (shouldCreatePages
    ? createDefaultPages(projects)
    : stored.pages ?? createDefaultPages(projects)
  ).map(normalizeStoredPage);
  const stateByProjectId = new Map(
    projects.map((project) => [project.id, project.stateContent]),
  );
  let sourceMigrationChanged = false;
  pages = pages.map((page) => {
    const migration = migratePageSourcesToProjectState(
      page.content,
      stateByProjectId.get(page.projectId),
    );
    if (!migration.changed) {
      return page;
    }

    sourceMigrationChanged = true;
    stateByProjectId.set(page.projectId, migration.stateContent);
    return { ...page, content: migration.content };
  });

  if (sourceMigrationChanged) {
    projects = projects.map((project) => ({
      ...project,
      stateContent: stateByProjectId.get(project.id) ?? project.stateContent,
    }));
  }
  const activeProjects = projects.filter((project) => project.status !== 'archived');
  const currentProjectId = activeProjects.some((project) => project.id === stored.currentProjectId)
    ? stored.currentProjectId ?? ''
    : activeProjects[0]?.id ?? '';
  const activePageIdsByProject = createCompatibleActivePageIds(
    projects,
    pages,
    stored.activePageIdsByProject,
  );
  const hasCompatibleActivePages =
    JSON.stringify(activePageIdsByProject) ===
    JSON.stringify(stored.activePageIdsByProject ?? {});
  const hasCompatiblePageStatuses =
    !stored.pages || stored.pages.every((page) => page.status);
  const syncConfig = {
    ...DEFAULT_SYNC_CONFIG,
    ...stored.syncConfig,
  };
  const hasExplicitlyLoggedOut = stored.hasExplicitlyLoggedOut ?? Boolean(
    stored.syncConfig && !stored.syncConfig.authenticated && !stored.syncConfig.connected,
  );
  const notionHydrationSource = stored.notionHydrationSource ?? (
    hasRemoteBackedData(projects, pages) ? hydrationSource(syncConfig) : ''
  );

  if (
    !stored.activePageIdsByProject ||
    !hasCompatibleActivePages ||
    !hasCompatiblePageStatuses ||
    !stored.projects ||
    !stored.currentProjectId ||
    stored.notionHydrationSource === undefined ||
    !stored.syncConfig ||
    (stored.hasExplicitlyLoggedOut === undefined && hasExplicitlyLoggedOut) ||
    shouldCreatePages ||
    stored.hasMigratedCapturesToPages !== true ||
    sourceMigrationChanged
  ) {
    await idbSetMany({
      activePageIdsByProject,
      projects,
      currentProjectId,
      pages,
      syncConfig,
      hasExplicitlyLoggedOut,
      notionHydrationSource,
      hasMigratedCapturesToPages: true,
    });
  }

  return {
    captures,
    currentProjectId,
    hasExplicitlyLoggedOut,
    activePageIdsByProject,
    hasMigratedCapturesToPages: true,
    pages,
    projects,
    syncConfig,
    notionHydrationSource,
  };
}

function hasRemoteBackedData(projects: Project[], pages: ProjectPage[]) {
  return projects.some((project) => Boolean(project.stateRemoteRevision)) ||
    pages.some((page) => Boolean(
      page.notionPageId ||
      page.notionDatabaseId ||
      page.notionDataSourceId ||
      page.notionParentPageId ||
      page.remoteRevision,
    ));
}

function hydrationSource(syncConfig: SyncConfig) {
  const serverUrl = cleanSyncServerUrl(syncConfig.serverUrl);
  const workspace = syncConfig.workspaceId?.trim() || 'connected-workspace';
  return `${serverUrl}::${workspace}`;
}

function syncQueueBelongsToActiveAccount(syncConfig: SyncConfig): boolean {
  return syncConfig.syncQueueOwnerUserId !== null && (
    syncConfig.syncQueueOwnerUserId === undefined ||
    syncConfig.syncQueueOwnerUserId === syncConfig.userId
  );
}

function isLegacyStubProjectSet(projects: Project[]) {
  return projects.some((project) =>
    ['project-product-research', 'project-writing'].includes(project.id),
  );
}

async function writeStorage(storage: Partial<InkwellStorage>) {
  await idbSetMany(storage as Record<string, unknown>);
}

async function persistRebasedProjectSnapshots(
  snapshots: Project[],
  pagesToPreserve: ProjectPage[] = [],
): Promise<void> {
  const storage = await readStorage();
  const snapshotById = new Map(snapshots.map((project) => [project.id, project]));
  const projects = storage.projects.map((project) => snapshotById.get(project.id) ?? project);
  const projectIds = new Set(projects.map((project) => project.id));
  for (const snapshot of snapshots) {
    if (!projectIds.has(snapshot.id)) projects.push(snapshot);
  }

  const pagesById = new Map(storage.pages.map((page) => [page.id, page]));
  for (const page of pagesToPreserve) pagesById.set(page.id, page);
  const pages = [...pagesById.values()];
  const activePageIdsByProject = createCompatibleActivePageIds(
    projects,
    pages,
    storage.activePageIdsByProject,
  );
  const activeProjects = projects.filter((project) => project.status !== 'archived');
  const currentProjectId = activeProjects.some((project) => project.id === storage.currentProjectId)
    ? storage.currentProjectId
    : activeProjects[0]?.id ?? '';

  await writeStorage({
    activePageIdsByProject,
    currentProjectId,
    pages,
    projects: projects.sort(sortProjectsByUpdatedDesc),
  });
}

function appendContent(page: ProjectPage, content: DocumentContent[]): ProjectPage {
  const existingContent = page.content.content ?? [];

  return markPageDirty({
    ...page,
    content: normalizeInkwellBlockIds({
      ...page.content,
      type: 'doc',
      content: [...existingContent, ...content],
    }),
  });
}

function createCompatibleActivePageIds(
  projects: Project[],
  pages: ProjectPage[],
  storedActivePageIds: Record<string, string> | undefined,
) {
  return projects.reduce<Record<string, string>>((result, project) => {
    const projectPages = pages.filter(
      (page) => page.projectId === project.id && page.status !== 'archived',
    );
    const storedPageId = storedActivePageIds?.[project.id];
    const storedPage = projectPages.find((page) => page.id === storedPageId);

    result[project.id] = storedPage?.id ?? projectPages[0]?.id ?? '';
    return result;
  }, {});
}

async function syncProject(project: Project): Promise<Project | undefined> {
  const { syncConfig } = await readStorage();
  const queuedEvent = await addPendingProjectSyncEvent(
    project,
    syncConfig.selectedParentPageId,
  );

  if (queuedEvent.deliveryBlocked) {
    return withProjectSyncStatus(project, 'error', queuedEvent.deliveryBlocked.message);
  }

  triggerQueueDelivery();

  if (!syncConfig.connected || isBrowserOffline()) {
    return withProjectSyncStatus(
      project,
      'stale',
      syncConfig.connected
        ? 'Saved locally. Will sync when a connection is available.'
        : 'Saved locally. Connect Notion to sync this project.',
    );
  }

  try {
    const response = await requestQueuedProjectSync(queuedEvent, syncConfig);

    if (response.parentPage) {
      await updateStoredSyncConfig({
        selectedParentPageId: response.parentPage.id,
        selectedParentPageTitle: response.parentPage.title,
      });
    }

    if (response.status === 'error') {
      throw new Error(response.message ?? 'Unable to sync this project.');
    }

    await removePendingProjectSyncEvents([queuedEvent.eventId]);
    await clearProjectConflictResolutionMarkers(project.id);
    resetQueueDeliveryBackoff();
    return response.project
      ? { ...response.project, syncConflicts: project.syncConflicts }
      : withProjectSyncStatus(project, 'saved');
  } catch (error) {
    if (isUnmappedContentConflict(error)) {
      await blockPendingProjectSyncEvents(project.id, {
        code: 'unmapped_notion_content',
        message: error.message,
        ...(error.diff ? { diff: { ...error.diff, localContent: project.stateContent } } : {}),
      });
      return withProjectSyncStatus(project, 'error', error.message);
    }

    recordQueueDeliveryFailure(error);
    scheduleNextQueueDelivery(queueDeliveryRetryDelayMs);

    return withProjectSyncStatus(
      project,
      'stale',
      'Saved locally. Will sync when a connection is available.',
    );
  }
}

async function syncProjectSource(
  project: Project,
  blockId: string,
  source: SourceOpenPayload,
): Promise<Project> {
  const { syncConfig } = await readStorage();
  const block = sourceEntryForProjectState(blockId, source);
  const queuedEvent = await addPendingProjectSourceSyncEvent(
    project,
    blockId,
    block,
    syncConfig.selectedParentPageId,
  );

  if (queuedEvent.deliveryBlocked) {
    return withProjectSyncStatus(project, 'error', queuedEvent.deliveryBlocked.message);
  }

  triggerQueueDelivery();

  if (!syncConfig.connected || isBrowserOffline()) {
    return withProjectSyncStatus(
      project,
      'stale',
      syncConfig.connected
        ? 'Saved locally. Will sync when a connection is available.'
        : 'Saved locally. Connect Notion to sync this source.',
    );
  }

  try {
    const response = await requestQueuedProjectSync(queuedEvent, syncConfig);
    if (response.status === 'error') {
      throw new Error(response.message ?? 'Unable to sync this source.');
    }
    await removePendingProjectSyncEvents([queuedEvent.eventId]);
    await clearProjectConflictResolutionMarkers(project.id);
    resetQueueDeliveryBackoff();
    return withProjectSyncStatus(project, 'saved');
  } catch (error) {
    if (isUnmappedContentConflict(error)) {
      await blockPendingProjectSyncEvents(project.id, {
        code: 'unmapped_notion_content',
        message: error.message,
        ...(error.diff ? { diff: { ...error.diff, localContent: project.stateContent } } : {}),
      });
      return withProjectSyncStatus(project, 'error', error.message);
    }

    recordQueueDeliveryFailure(error);
    scheduleNextQueueDelivery(queueDeliveryRetryDelayMs);

    return withProjectSyncStatus(
      project,
      'stale',
      'Saved locally. Will sync when a connection is available.',
    );
  }
}

function createEmptyPage(projectId: string, title: string): ProjectPage {
  const now = new Date().toISOString();

  return {
    id: `page-${projectId}-${crypto.randomUUID()}`,
    projectId,
    kind: 'page',
    title,
    status: 'active',
    content: emptyDocument(),
    createdAt: now,
    updatedAt: now,
    localRevision: crypto.randomUUID(),
    syncState: 'saved',
  };
}

function createOptimisticProjectRecord(name: string): Project {
  return {
    ...createProjectRecord(name, `temp-project-${crypto.randomUUID()}`),
    syncState: 'creating',
  };
}

function createOptimisticPage(projectId: string, title: string): ProjectPage {
  return {
    ...createEmptyPage(projectId, title),
    id: `temp-page-${crypto.randomUUID()}`,
    syncState: 'creating',
  };
}

function isTempProject(project: Project | undefined) {
  return Boolean(project?.id.startsWith('temp-project-') || project?.syncState === 'creating');
}

function isTempPage(page: ProjectPage | undefined) {
  return Boolean(page?.id.startsWith('temp-page-') || page?.syncState === 'creating');
}

function markPageDirty(page: ProjectPage): ProjectPage {
  return {
    ...page,
    updatedAt: new Date().toISOString(),
    localRevision: crypto.randomUUID(),
    syncMessage: undefined,
    syncState: 'saving',
  };
}

function withSyncStatus(
  page: ProjectPage,
  status: Exclude<SaveStatus, 'idle'>,
  message?: string,
): ProjectPage {
  return {
    ...page,
    syncMessage: message,
    syncState: status,
  };
}

function withProjectSyncStatus(
  project: Project,
  status: Exclude<SaveStatus, 'idle' | 'saving' | 'creating'>,
  message?: string,
): Project {
  return {
    ...project,
    syncMessage: message,
    syncState: status,
  };
}

function uncachePageNotionMetadata(page: ProjectPage): ProjectPage {
  return {
    ...page,
    notionPageId: undefined,
    notionDatabaseId: undefined,
    notionDataSourceId: undefined,
    notionParentPageId: undefined,
    notionLastEditedTime: undefined,
    remoteRevision: undefined,
    syncMessage: undefined,
    syncState: 'saved',
  };
}

function isBrowserOffline() {
  return typeof navigator !== 'undefined' && navigator.onLine === false;
}

function collectInkwellBlockIds(content: DocumentContent, ids: Set<string>): void {
  const value = content.attrs?.inkwellBlockId;
  if (typeof value === 'string' && value) ids.add(value);
  for (const child of content.content ?? []) collectInkwellBlockIds(child, ids);
}

class SyncServerError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly code?: string,
    readonly retryAfterMs?: number,
    readonly diff?: SyncConflictDiff,
  ) {
    super(message);
    this.name = 'SyncServerError';
  }
}

function isUnmappedContentConflict(error: unknown): error is SyncServerError {
  return error instanceof SyncServerError && (
    error.code === 'unmapped_notion_content' ||
    error.message.includes('Notion and local content differ in blocks that could not be matched')
  );
}

async function requestServer<T>(
  path: string,
  init?: RequestInit,
  config?: SyncConfig,
): Promise<T> {
  const syncConfig = config ?? (await readStorage()).syncConfig;
  const requiresAccountBinding = path.startsWith('/sync/') || path.startsWith('/media/');
  if (requiresAccountBinding) {
    if (!syncConfig.userId) {
      throw new Error('Refresh the Notion session before syncing local data.');
    }
    if (
      syncConfig.syncQueueOwnerUserId === null ||
      (syncConfig.syncQueueOwnerUserId && syncConfig.syncQueueOwnerUserId !== syncConfig.userId)
    ) {
      throw new Error('Local data is locked to its original Notion account. Reconnect that account to sync it.');
    }
  }
  const headers = {
    ...(init?.body ? { 'Content-Type': 'application/json' } : {}),
    ...(requiresAccountBinding ? { 'X-Inkwell-Account': syncConfig.userId } : {}),
    ...init?.headers,
  };
  const response = await fetch(`${cleanSyncServerUrl(syncConfig.serverUrl)}${path}`, {
    ...init,
    headers,
    credentials: 'include',
  });

  const payload = (await response.json().catch(() => ({}))) as T & {
    code?: string;
    diff?: SyncConflictDiff;
    error?: string;
    message?: string;
  };

  // Content conflicts are expected sync outcomes handled by the merge UI.
  // Interpret their JSON code without returning an HTTP error to the browser.
  if (!response.ok || payload.code === 'unmapped_notion_content') {
    throw new SyncServerError(
      payload.message ?? payload.error ?? `Sync server returned ${response.status}.`,
      response.status,
      payload.code,
      parseRetryAfter(response.headers.get('retry-after')),
      payload.diff,
    );
  }

  return payload;
}

function parseRetryAfter(value: string | null): number | undefined {
  if (!value) return undefined;
  const seconds = Number(value);
  if (Number.isFinite(seconds) && seconds >= 0) return seconds * 1000;
  const timestamp = Date.parse(value);
  return Number.isFinite(timestamp) ? Math.max(0, timestamp - Date.now()) : undefined;
}

function requestQueuedProjectSync(
  event: ProjectSyncEvent,
  syncConfig: SyncConfig,
): Promise<SyncProjectResponse> {
  const existing = inFlightProjectSyncRequests.get(event.eventId);
  if (existing) return existing;

  const isSourceEvent = event.type === 'project_source_upsert';
  const payload = {
    ...event.payload,
    project: withoutLocalSyncConflicts(event.payload.project),
  };
  let request: Promise<SyncProjectResponse>;
  request = requestServer<SyncProjectResponse>(
    isSourceEvent ? '/sync/project/source' : '/sync/project',
    { method: 'POST', body: JSON.stringify(payload) },
    syncConfig,
  ).finally(() => {
    if (inFlightProjectSyncRequests.get(event.eventId) === request) {
      inFlightProjectSyncRequests.delete(event.eventId);
    }
  });
  inFlightProjectSyncRequests.set(event.eventId, request);
  return request;
}

function recordQueueDeliveryFailure(error: unknown): void {
  queueDeliveryRetryAttempt += 1;
  const exponentialDelay = Math.min(
    LOCAL_QUEUE_DELIVERY_DELAY_MS * (2 ** Math.min(queueDeliveryRetryAttempt - 1, 5)),
    MAX_QUEUE_RETRY_DELAY_MS,
  );
  const serverDelay = error instanceof SyncServerError ? error.retryAfterMs ?? 0 : 0;
  queueDeliveryRetryDelayMs = Math.min(
    Math.max(exponentialDelay, serverDelay),
    MAX_QUEUE_RETRY_DELAY_MS,
  );
}

function resetQueueDeliveryBackoff(): void {
  queueDeliveryRetryAttempt = 0;
  queueDeliveryRetryDelayMs = 0;
}

async function pendingLocalWorkCount(): Promise<number> {
  const [{ pages }, queuedCount] = await Promise.all([
    readStorage(),
    queuedSyncEventCount(),
  ]);
  return queuedCount + pages.filter((page) => page.status !== 'archived').reduce(
    (count, page) => count + countPendingLocalMedia(page.content),
    0,
  );
}

function countPendingLocalMedia(node: DocumentContent): number {
  const attrs = node.attrs ?? {};
  const isPendingMedia =
    (node.type === 'image' || node.type === 'audio') &&
    /^data:/i.test(String(attrs.src ?? '')) &&
    !attrs.notionFileUploadId;
  return (isPendingMedia ? 1 : 0) + (node.content ?? []).reduce(
    (count, child) => count + countPendingLocalMedia(child),
    0,
  );
}

async function uploadMediaBlob(
  blob: Blob,
  mimeType: string,
  filename: string,
  syncConfig: SyncConfig,
): Promise<string> {
  const buf = await blob.arrayBuffer();
  const bytes = new Uint8Array(buf);
  let binary = '';
  const chunkSize = 8192;
  for (let index = 0; index < bytes.length; index += chunkSize) {
    binary += String.fromCharCode(...bytes.subarray(index, index + chunkSize));
  }

  const response = await requestServer<MediaUploadResponse>('/media/upload', {
    method: 'POST',
    body: JSON.stringify({ dataBase64: btoa(binary), mimeType, filename }),
  }, syncConfig);

  if (!response.fileUploadId) {
    throw new Error('The sync server did not return a Notion file upload id.');
  }
  return response.fileUploadId;
}

function blobFromDataUrl(src: string): { blob: Blob; mimeType: string } | undefined {
  const match = /^data:([^;,]+)?;base64,([\s\S]+)$/i.exec(src);
  if (!match) return undefined;
  const mimeType = match[1] || 'application/octet-stream';
  const binary = atob(match[2]);
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) {
    bytes[index] = binary.charCodeAt(index);
  }
  return { blob: new Blob([bytes], { type: mimeType }), mimeType };
}

async function uploadLocalMediaInNode(
  node: DocumentContent,
  syncConfig: SyncConfig,
): Promise<{ content: DocumentContent; changed: boolean; failed: boolean }> {
  const attrs = node.attrs ?? {};
  const src = String(attrs.src ?? '');

  if (
    (node.type === 'image' || node.type === 'audio') &&
    /^data:/i.test(src) &&
    !attrs.notionFileUploadId
  ) {
    const decoded = blobFromDataUrl(src);
    if (!decoded) return { content: node, changed: false, failed: true };
    try {
      const fileUploadId = await uploadMediaBlob(
        decoded.blob,
        String(attrs.mimeType || decoded.mimeType),
        String(attrs.filename || `${node.type}-${crypto.randomUUID()}`),
        syncConfig,
      );
      return {
        content: {
          ...node,
          attrs: {
            ...attrs,
            notionFileUploadId: fileUploadId,
            uploadState: 'done',
          },
        },
        changed: true,
        failed: false,
      };
    } catch {
      return { content: node, changed: false, failed: true };
    }
  }

  if (!node.content?.length) {
    return { content: node, changed: false, failed: false };
  }

  let changed = false;
  let failed = false;
  const content: DocumentContent[] = [];
  for (const child of node.content) {
    const result = await uploadLocalMediaInNode(child, syncConfig);
    content.push(result.content);
    changed ||= result.changed;
    failed ||= result.failed;
  }
  return {
    content: changed ? { ...node, content } : node,
    changed,
    failed,
  };
}

async function uploadPendingLocalMedia(syncConfig: SyncConfig): Promise<boolean> {
  const { pages, projects } = await readStorage();
  let hadFailures = false;

  for (const page of pages) {
    if (page.status === 'archived') continue;
    const result = await uploadLocalMediaInNode(page.content, syncConfig);
    hadFailures ||= result.failed;
    if (!result.changed) continue;
    const project = projects.find((candidate) => candidate.id === page.projectId);
    if (!project) continue;
    const updatedPage = markPageDirty({ ...page, content: result.content });
    await persistPage(updatedPage);
    const queuedPage = await enqueuePageSync(updatedPage, project, page);
    await persistPage(queuedPage);
  }

  return hadFailures;
}

async function enqueuePageSync(
  page: ProjectPage,
  project: Project,
  previousPage?: ProjectPage,
): Promise<ProjectPage> {
  const { syncConfig } = await readStorage();
  const normalizedPage = {
    ...page,
    content: normalizeInkwellBlockIds(page.content),
  };
  const syncablePage = {
    ...normalizedPage,
    content: sanitizeMediaForSync(normalizedPage.content),
  };
  const syncablePreviousPage = previousPage
    ? { ...previousPage, content: sanitizeMediaForSync(previousPage.content) }
    : undefined;

  const pendingOps = await addPendingSyncOps(buildPageSyncOps({
    previousPage: syncablePreviousPage,
    page: syncablePage,
    project,
    selectedParentPageId: syncConfig.selectedParentPageId,
  }));
  if (pendingOps.length || countPendingLocalMedia(normalizedPage.content) > 0) {
    triggerQueueDelivery();
  }

  return syncConfig.connected && !isBrowserOffline()
    ? withSyncStatus(normalizedPage, 'saved')
    : withSyncStatus(
        normalizedPage,
        'stale',
        syncConfig.connected
          ? 'Saved locally. Will sync when a connection is available.'
          : 'Connect Notion to sync this page.',
      );

}

function triggerQueueDelivery(): void {
  if (isSessionLogoutPending || isConnectionDeletionPending || queueDeliveryPromise) return;
  scheduleNextQueueDelivery(Math.max(
    LOCAL_QUEUE_DELIVERY_DELAY_MS,
    queueDeliveryRetryDelayMs,
  ));
}

function runQueueDelivery(): void {
  if (isSessionLogoutPending || isConnectionDeletionPending || queueDeliveryPromise || forcedQueueDeliveryPromise) return;
  const delivery = deliverPendingSyncOps({ force: false }).catch((error) => {
    recordQueueDeliveryFailure(error);
    throw error;
  });
  queueDeliveryPromise = delivery;
  void delivery.finally(() => {
    if (queueDeliveryPromise === delivery) queueDeliveryPromise = undefined;
    void scheduleQueueDeliveryIfNeeded();
  }).catch(() => undefined);
}

async function scheduleQueueDeliveryIfNeeded(): Promise<void> {
  if (isSessionLogoutPending || isConnectionDeletionPending) return;
  if (await hasPendingConnectionDeletion()) return;
  const [{ syncConfig, pages }, pendingOps, projectEvents] = await Promise.all([
    readStorage(),
    listPendingSyncOps(),
    listPendingProjectSyncEvents(),
  ]);
  if (!syncQueueBelongsToActiveAccount(syncConfig)) return;
  const hasDeliverableWork = pendingOps.some((op) => !op.deliveryBlocked) ||
    projectEvents.some((event) => !event.deliveryBlocked) ||
    pages.some((page) => countPendingLocalMedia(page.content) > 0);

  if (syncConfig.connected && !isBrowserOffline() && hasDeliverableWork) {
    scheduleNextQueueDelivery(Math.max(
      LOCAL_QUEUE_DELIVERY_DELAY_MS,
      queueDeliveryRetryDelayMs,
    ));
  }
}

function scheduleNextQueueDelivery(delayMs: number): void {
  if (queueDeliveryTimer) {
    clearTimeout(queueDeliveryTimer);
  }
  queueDeliveryTimer = setTimeout(() => {
    queueDeliveryTimer = undefined;
    runQueueDelivery();
  }, Math.max(0, delayMs));
}

export function connectSyncEvents(
  syncConfig: SyncConfig,
  onEvent: (event: SyncEventMessage) => void,
): EventSource {
  const es = new EventSource(`${cleanSyncServerUrl(syncConfig.serverUrl)}/sync/events`, { withCredentials: true });
  es.onmessage = (e) => {
    try {
      onEvent(JSON.parse(e.data as string) as SyncEventMessage);
    } catch { /* ignore malformed */ }
  };
  return es;
}

export async function applySyncResult(event: SyncEventMessage): Promise<ProjectPage | undefined> {
  const { pages } = await readStorage();
  const page = pages.find((p) => p.id === event.pageId);
  if (!page) return undefined;

  if (event.status === 'stale') {
    const stalePage = typeof event.version === 'number'
      ? { ...page, serverSyncVersion: event.version, syncState: 'stale' as const }
      : { ...page, syncState: 'stale' as const };
    await persistPage(stalePage);
    return stalePage;
  }

  const updated =
    event.status === 'synced'
      ? {
          ...page,
          ...(event.notionBlockId ? { notionPageId: event.notionBlockId } : {}),
          ...(typeof event.version === 'number'
            ? { knownSyncVersion: event.version, serverSyncVersion: event.version }
            : {}),
          syncState: 'saved' as const,
          syncMessage: undefined,
          content: stripConflictResolutionMarkers(page.content),
        }
      : withSyncStatus(
          page,
          'error',
          event.message ?? (event.statusCode
            ? `Notion sync failed with HTTP ${event.statusCode}. Check Notion access, then use Resync.`
            : 'Notion sync failed. Will retry.'),
        );

  await persistPage(updated);
  return updated;
}

export async function clearStalePages(pageIds: string[]): Promise<void> {
  if (!pageIds.length) return;
  const { syncConfig } = await readStorage();
  if (!syncConfig.connected) return;
  await requestServer('/sync/clear-stale', {
    method: 'POST',
    body: JSON.stringify({ pageIds }),
  }, syncConfig).catch(() => undefined);
}

async function syncPullPage(page: ProjectPage, options: { force?: boolean } = {}): Promise<ProjectPage> {
  const { syncConfig } = await readStorage();

  if (!syncConfig.connected || isBrowserOffline() || !page.notionPageId) {
    return page;
  }

  if (!options.force && !hasNewerServerVersion(page)) {
    return page;
  }

  try {
    const response = await requestServer<SyncPageResponse>('/sync/pull', {
      method: 'POST',
      body: JSON.stringify({
        page,
      }),
    }, syncConfig);

    return response.page
      ? {
          ...page,
          ...response.page,
          knownSyncVersion: page.serverSyncVersion ?? page.knownSyncVersion,
          syncMessage: response.message,
          syncState: response.status,
        }
      : withSyncStatus(page, response.status, response.message);
  } catch (error) {
    return withSyncStatus(
      page,
      'error',
      error instanceof Error ? error.message : 'Unable to pull Notion changes.',
    );
  }
}

function hasNewerServerVersion(page: ProjectPage): boolean {
  return typeof page.serverSyncVersion === 'number' &&
    page.serverSyncVersion > (page.knownSyncVersion ?? 0);
}

async function persistPage(page: ProjectPage) {
  const { pages } = await readStorage();

  await writeStorage({
    pages: pages.map((storedPage) =>
      storedPage.id === page.id ? page : storedPage,
    ),
  });
}

async function syncAndPersistPage(page: ProjectPage): Promise<ProjectPage> {
  const synced = isTempPage(page) ? page : await syncPullPage(page);
  if (synced !== page) await persistPage(synced);
  return synced;
}

function findActiveProjectPages(pages: ProjectPage[], projectId: string, excludePageId?: string): ProjectPage[] {
  return pages.filter(
    (page) =>
      page.projectId === projectId &&
      page.status !== 'archived' &&
      page.id !== excludePageId &&
      !isTempPage(page),
  );
}

function normalizeStoredPage<T extends { content?: DocumentContent; localRevision?: string; status?: string; syncState?: string }>(page: T): T {
  return {
    ...page,
    content: normalizeInkwellBlockIds(markUnrecoverableTransientMedia(page.content as DocumentContent)),
    localRevision: page.localRevision ?? crypto.randomUUID(),
    status: page.status ?? 'active',
    syncState: page.syncState ?? 'saved',
  };
}

function requireActiveProject(projects: Project[], projectId: string): Project {
  const project = projects.find((p) => p.id === projectId);
  if (!project || project.status === 'archived') {
    throw new Error('This project is no longer available.');
  }
  return project;
}

async function saveProjectUpdate(projects: Project[], projectId: string, updatedProject: Project): Promise<Project> {
  await writeStorage({
    projects: projects
      .map((project) => (project.id === projectId ? updatedProject : project))
      .sort(sortProjectsByUpdatedDesc),
  });

  const syncedProject = await syncProject(updatedProject);
  const savedProject = syncedProject ?? updatedProject;
  const { projects: latestProjects } = await readStorage();
  const latestProject = latestProjects.find((project) => project.id === projectId);

  if (latestProject?.updatedAt !== updatedProject.updatedAt) {
    return latestProject ?? savedProject;
  }

  await writeStorage({
    projects: latestProjects
      .map((project) => (project.id === projectId ? savedProject : project))
      .sort(sortProjectsByUpdatedDesc),
  });
  return savedProject;
}

async function saveProjectSourceUpdate(
  projects: Project[],
  projectId: string,
  updatedProject: Project,
  blockId: string,
  source: SourceOpenPayload,
): Promise<Project> {
  await writeStorage({
    projects: projects
      .map((storedProject) => storedProject.id === projectId ? updatedProject : storedProject)
      .sort(sortProjectsByUpdatedDesc),
  });
  const savedProject = await syncProjectSource(updatedProject, blockId, source);
  const { projects: latestProjects } = await readStorage();
  if (latestProjects.find((storedProject) => storedProject.id === projectId)?.updatedAt !== updatedProject.updatedAt) {
    return latestProjects.find((storedProject) => storedProject.id === projectId) ?? savedProject;
  }
  await writeStorage({
    projects: latestProjects.map((storedProject) =>
      storedProject.id === projectId ? savedProject : storedProject,
    ),
  });
  return savedProject;
}

async function requirePageWithProject(pageId: string) {
  const storage = await readStorage();
  const page = storage.pages.find((p) => p.id === pageId);
  if (!page) throw new Error('This page is no longer available.');
  const project = storage.projects.find((p) => p.id === page.projectId);
  if (!project) throw new Error('This project is no longer available.');
  return { ...storage, page, project };
}

async function replaceTempProject({
  tempPage,
  tempProject,
  realPage,
  realProject,
}: {
  tempPage: ProjectPage;
  tempProject: Project;
  realPage: ProjectPage;
  realProject: Project;
}) {
  const selectionRevisionAtStart = currentProjectSelectionRevision;
  const { activePageIdsByProject, currentProjectId, pages, projects } = await readStorage();
  const resolvedCurrentProjectId = currentProjectIdForTempProject(
    currentProjectId,
    tempProject.id,
    realProject.id,
    selectionRevisionAtStart,
  );
  const nextActivePageIds = { ...activePageIdsByProject };
  const tempActivePageId = nextActivePageIds[tempProject.id];

  delete nextActivePageIds[tempProject.id];
  nextActivePageIds[realProject.id] =
    tempActivePageId === tempPage.id ? realPage.id : tempActivePageId;

  await writeStorage({
    activePageIdsByProject: nextActivePageIds,
    currentProjectId: resolvedCurrentProjectId,
    pages: pages.map((page) =>
      page.id === tempPage.id
        ? {
            ...page,
            ...realPage,
            content: page.content,
            title: page.title,
            syncState: pendingTempPageSaves.has(tempPage.id) ? 'saving' : 'saved',
          }
        : page.projectId === tempProject.id
          ? { ...page, projectId: realProject.id }
          : page,
    ),
    projects: projects
      .map((project) =>
        project.id === tempProject.id ? realProject : project,
      )
      .sort(sortProjectsByUpdatedDesc),
  });
}

async function rollbackTempProject(
  tempProject: Project,
  tempPage: ProjectPage,
  previousProjectId: string,
  message: string,
) {
  const selectionRevisionAtStart = currentProjectSelectionRevision;
  const { activePageIdsByProject, currentProjectId, pages, projects } = await readStorage();
  const resolvedCurrentProjectId = currentProjectIdForTempProject(
    currentProjectId,
    tempProject.id,
    previousProjectId,
    selectionRevisionAtStart,
  );
  const nextActivePageIds = { ...activePageIdsByProject };
  delete nextActivePageIds[tempProject.id];
  pendingTempPageSaves.delete(tempPage.id);

  await writeStorage({
    activePageIdsByProject: nextActivePageIds,
    currentProjectId: resolvedCurrentProjectId,
    pages: pages.filter((page) => page.projectId !== tempProject.id),
    projects: projects
      .filter((project) => project.id !== tempProject.id)
      .map((project) =>
        project.id === previousProjectId
          ? { ...project, syncState: 'error' as const, syncMessage: message }
          : project,
      )
      .sort(sortProjectsByUpdatedDesc),
  });
}

function currentProjectIdForTempProject(
  storedProjectId: string,
  tempProjectId: string,
  resolvedProjectId: string,
  selectionRevisionAtStart: number,
): string {
  const selectedProjectId = selectionRevisionAtStart === currentProjectSelectionRevision
    ? storedProjectId
    : requestedCurrentProjectId ?? storedProjectId;
  return selectedProjectId === tempProjectId ? resolvedProjectId : selectedProjectId;
}

async function replaceTempPage(tempPage: ProjectPage, realPage: ProjectPage) {
  const { activePageIdsByProject, currentProjectId, pages } = await readStorage();
  const nextActivePageIds = {
    ...activePageIdsByProject,
    [realPage.projectId]:
      activePageIdsByProject[realPage.projectId] === tempPage.id
        ? realPage.id
        : activePageIdsByProject[realPage.projectId],
  };
  const currentStoredPage = pages.find((page) => page.id === tempPage.id);

  await writeStorage({
    activePageIdsByProject: nextActivePageIds,
    currentProjectId,
    pages: pages.map((page) =>
      page.id === tempPage.id
        ? {
            ...page,
            ...realPage,
            content: currentStoredPage?.content ?? page.content,
            title: currentStoredPage?.title ?? page.title,
            syncState: pendingTempPageSaves.has(tempPage.id) ? 'saving' : realPage.syncState,
          }
        : page,
    ),
  });
}

async function rollbackTempPage(
  tempPage: ProjectPage,
  previousActivePageId: string,
  message: string,
) {
  const { activePageIdsByProject, pages } = await readStorage();
  pendingTempPageSaves.delete(tempPage.id);

  await writeStorage({
    activePageIdsByProject: {
      ...activePageIdsByProject,
      [tempPage.projectId]: previousActivePageId,
    },
    pages: pages
      .filter((page) => page.id !== tempPage.id)
      .map((page) =>
        page.id === previousActivePageId
          ? { ...page, syncState: 'error', syncMessage: message }
          : page,
      ),
  });
}

async function replayTempPageSave(tempPageId: string, realPage: ProjectPage) {
  const pendingPage = pendingTempPageSaves.get(tempPageId);
  pendingTempPageSaves.delete(tempPageId);

  if (!pendingPage) {
    return realPage;
  }

  return notionClient.updateProjectPage({
    ...realPage,
    title: pendingPage.title,
    content: pendingPage.content,
  });
}

async function flushPendingSyncOps(options: { force?: boolean } = {}): Promise<void> {
  if (isSessionLogoutPending || isConnectionDeletionPending) return;
  if (await hasPendingConnectionDeletion()) return;

  if (options.force) {
    if (queueDeliveryTimer) {
      clearTimeout(queueDeliveryTimer);
      queueDeliveryTimer = undefined;
    }

    if (forcedQueueDeliveryPromise) {
      return forcedQueueDeliveryPromise;
    }

    const delivery = (async () => {
      if (queueDeliveryPromise) {
        await queueDeliveryPromise;
      }
      try {
        await deliverPendingSyncOps({ force: true });
      } catch (error) {
        recordQueueDeliveryFailure(error);
        throw error;
      }
    })();
    forcedQueueDeliveryPromise = delivery;
    void delivery.finally(() => {
      if (forcedQueueDeliveryPromise === delivery) forcedQueueDeliveryPromise = undefined;
      void scheduleQueueDeliveryIfNeeded();
    }).catch(() => undefined);

    return forcedQueueDeliveryPromise;
  }

  triggerQueueDelivery();
}

async function hasPendingConnectionDeletion(): Promise<boolean> {
  const stored = await browser.storage.local.get(PENDING_CONNECTION_DELETION_KEY) as Record<
    string,
    PendingConnectionDeletion | undefined
  >;
  const pending = Boolean(stored[PENDING_CONNECTION_DELETION_KEY]);
  if (pending) {
    isConnectionDeletionPending = true;
    if (queueDeliveryTimer) {
      clearTimeout(queueDeliveryTimer);
      queueDeliveryTimer = undefined;
    }
  }
  return pending;
}

async function deliverPendingSyncOps({ force }: { force: boolean }): Promise<void> {
  if (isSessionLogoutPending || isConnectionDeletionPending || await hasPendingConnectionDeletion()) return;
  const { syncConfig } = await readStorage();
  if (!syncConfig.connected || isBrowserOffline()) return;
  if (!syncQueueBelongsToActiveAccount(syncConfig)) return;

  await deliverPendingProjectSyncEvents(syncConfig);
  const hadMediaFailures = await uploadPendingLocalMedia(syncConfig);

  const pending = await compactStoredPendingSyncOps();
  if (pending.length) {
    const now = Date.now();
    const eligible = pending.filter((op) => !op.deliveryBlocked && (
      force || now - Date.parse(op.createdAt) >= LOCAL_QUEUE_DELIVERY_DELAY_MS
    ));

    if (!eligible.length) {
      const deliverable = pending.filter((op) => !op.deliveryBlocked);
      if (deliverable.length) scheduleNextQueueDelivery(msUntilOldestOpIsEligible(deliverable, now));
      return;
    }

    const response = await requestServer<SyncEnqueueResponse>('/sync/push', {
      method: 'POST',
      body: JSON.stringify({ ops: eligible }),
    }, syncConfig);

    await removePendingSyncOps(eligible.map((op) => op.opId));
    await applyQueuedVersions(eligible, response);
  }

  if (hadMediaFailures) {
    throw new Error('Some local media is still waiting for a connection.');
  }

  const remaining = (await listPendingSyncOps()).filter((op) => !op.deliveryBlocked);
  if (remaining.length) {
    scheduleNextQueueDelivery(msUntilOldestOpIsEligible(remaining));
  }

  resetQueueDeliveryBackoff();
}

function stripConflictResolutionMarkers(content: DocumentContent): DocumentContent {
  const attrs = { ...(content.attrs ?? {}) };
  delete attrs.inkwellConflictResolution;
  delete attrs.inkwellPreserveRemoteBlocks;
  return {
    ...content,
    ...(content.attrs ? { attrs } : {}),
    ...(content.content ? { content: content.content.map(stripConflictResolutionMarkers) } : {}),
  };
}

async function clearProjectConflictResolutionMarkers(projectId: string): Promise<void> {
  const { projects } = await readStorage();
  await writeStorage({
    projects: projects.map((project) => project.id === projectId
      ? { ...project, stateContent: stripConflictResolutionMarkers(project.stateContent) }
      : project),
  });
}

async function clearStoredPageSyncConflict(pageId: string): Promise<void> {
  const { projects } = await readStorage();
  const nextProjects = projects.map((project) => {
    const syncConflicts = project.syncConflicts?.filter((conflict) =>
      conflict.targetType !== 'page' || conflict.targetId !== pageId,
    );
    return {
      ...project,
      ...(syncConflicts?.length ? { syncConflicts } : { syncConflicts: undefined }),
    };
  });
  await writeStorage({ projects: nextProjects });
}

async function persistPageSyncConflicts(conflicts: SyncContentConflict[]): Promise<void> {
  if (!conflicts.length) return;
  const { pages, projects } = await readStorage();
  const projectIdByPageId = new Map(pages.map((page) => [page.id, page.projectId]));
  const conflictsByProject = new Map<string, SyncContentConflict[]>();
  for (const conflict of conflicts) {
    if (conflict.targetType !== 'page') continue;
    const projectId = projectIdByPageId.get(conflict.targetId);
    if (!projectId) continue;
    const group = conflictsByProject.get(projectId) ?? [];
    group.push(conflict);
    conflictsByProject.set(projectId, group);
  }
  if (!conflictsByProject.size) return;

  await writeStorage({
    projects: projects.map((project) => {
      const nextConflicts = conflictsByProject.get(project.id);
      if (!nextConflicts) return project;
      const affectedPageIds = new Set(nextConflicts.map((conflict) => conflict.targetId));
      const retained = (project.syncConflicts ?? []).filter((conflict) =>
        !affectedPageIds.has(conflict.targetId),
      );
      return { ...project, syncConflicts: [...retained, ...nextConflicts] };
    }),
  });
}

function withoutLocalSyncConflicts<T extends { syncConflicts?: SyncContentConflict[] }>(project: T): Omit<T, 'syncConflicts'> {
  const { syncConflicts: _syncConflicts, ...syncable } = project;
  return syncable;
}

async function deliverPendingProjectSyncEvents(syncConfig: SyncConfig): Promise<void> {
  const events = await listPendingProjectSyncEvents();
  const blockedProjectIds = new Set(
    events.filter((event) => event.deliveryBlocked).map((event) => event.projectId),
  );

  for (const event of events) {
    if (blockedProjectIds.has(event.projectId)) continue;

    const isSourceEvent = event.type === 'project_source_upsert';
    let response: SyncProjectResponse;
    try {
      response = await requestQueuedProjectSync(event, syncConfig);
    } catch (error) {
      if (isUnmappedContentConflict(error)) {
        const { projects } = await readStorage();
        const localProject = projects.find((project) => project.id === event.projectId);
        await blockPendingProjectSyncEvents(event.projectId, {
          code: 'unmapped_notion_content',
          message: error.message,
          ...(error.diff ? {
            diff: {
              ...error.diff,
              localContent: localProject?.stateContent ?? error.diff.localContent,
            },
          } : {}),
        });
        blockedProjectIds.add(event.projectId);
        continue;
      }
      throw error;
    }

    if (response.status === 'error') {
      throw new Error(response.message ?? 'Unable to sync this project.');
    }

    if (response.parentPage) {
      await updateStoredSyncConfig({
        selectedParentPageId: response.parentPage.id,
        selectedParentPageTitle: response.parentPage.title,
      });
    }

    await applySyncedProject(event.payload.project, response.project, isSourceEvent);
    await removePendingProjectSyncEvents([event.eventId]);
    await clearProjectConflictResolutionMarkers(event.projectId);
  }
}

async function applySyncedProject(
  queuedProject: Omit<Project, 'stateContent'> | Project,
  responseProject?: Project,
  preserveLocalState = false,
): Promise<void> {
  const { projects } = await readStorage();
  await writeStorage({
    projects: projects.map((project) =>
      project.id === queuedProject.id && project.updatedAt === queuedProject.updatedAt
        ? {
            ...(responseProject ?? project),
            ...(project.syncConflicts?.length
              ? { syncConflicts: project.syncConflicts }
              : { syncConflicts: undefined }),
            ...(preserveLocalState
              ? { stateContent: stripConflictResolutionMarkers(project.stateContent) }
              : {}),
            syncState: 'saved' as const,
            syncMessage: undefined,
          }
        : project,
    ),
  });
}

async function applyQueuedVersions(ops: BlockSyncOp[], response: SyncEnqueueResponse): Promise<void> {
  const versions = response.versions ?? {};
  const opVersions = response.opVersions ?? {};
  const versionByPage = new Map<string, number>();

  for (const op of ops) {
    const version = versions[op.pageId] ?? opVersions[op.opId] ?? response.version ?? op.localVersion;
    if (typeof version === 'number') {
      versionByPage.set(op.pageId, Math.max(versionByPage.get(op.pageId) ?? 0, version));
    }
  }

  if (!versionByPage.size) return;

  const { pages } = await readStorage();
  await writeStorage({
    pages: pages.map((page) => {
      const version = versionByPage.get(page.id);
      return typeof version === 'number'
        ? {
            ...page,
            knownSyncVersion: Math.max(page.knownSyncVersion ?? 0, version),
            serverSyncVersion: Math.max(page.serverSyncVersion ?? 0, version),
          }
        : page;
    }),
  });
}

function msUntilOldestOpIsEligible(ops: BlockSyncOp[], now = Date.now()): number {
  const oldestCreatedAt = Math.min(
    ...ops.map((op) => Date.parse(op.createdAt)).filter((time) => Number.isFinite(time)),
  );

  if (!Number.isFinite(oldestCreatedAt)) {
    return LOCAL_QUEUE_DELIVERY_DELAY_MS;
  }

  return Math.max(0, LOCAL_QUEUE_DELIVERY_DELAY_MS - (now - oldestCreatedAt));
}

async function updateStoredSyncConfig(
  config: Partial<SyncConfig>,
  additionalStorage: Partial<InkwellStorage> = {},
): Promise<SyncConfig> {
  const { syncConfig } = await readStorage();
  const nextConfig = stripStoredSyncCredentials({
    ...syncConfig,
    ...config,
    serverUrl: config.serverUrl
      ? cleanSyncServerUrl(config.serverUrl)
      : syncConfig.serverUrl,
  });

  await writeStorage({ syncConfig: nextConfig, ...additionalStorage });
  return nextConfig;
}

/** Removes legacy or injected credential fields when local auth state is rewritten. */
export function stripStoredSyncCredentials(syncConfig: SyncConfig): SyncConfig {
  const sanitized = { ...syncConfig } as SyncConfig & Record<string, unknown>;
  for (const key of Object.keys(sanitized)) {
    if (/(?:token|secret|credential|authorization)/i.test(key)) {
      delete sanitized[key];
    }
  }
  return sanitized;
}

function markConnectionDeletionPending(): void {
  isConnectionDeletionPending = true;
  if (queueDeliveryTimer) {
    clearTimeout(queueDeliveryTimer);
    queueDeliveryTimer = undefined;
  }
}

export const notionClient = {
  flushPendingSyncOps,
  pendingSyncEventCount: pendingLocalWorkCount,

  /** Stop queued network delivery and drain any request already in flight before a deletion. */
  async prepareConnectionDeletion(): Promise<boolean> {
    markConnectionDeletionPending();
    await Promise.allSettled(
      [queueDeliveryPromise, forcedQueueDeliveryPromise].filter(
        (promise): promise is Promise<void> => Boolean(promise),
      ),
    );
    await pauseIdbWrites();
    return true;
  },

  /** Keep a retry-pending deletion from resuming queued server sync on worker startup. */
  markConnectionDeletionPending,

  /** Unfence this context after an unsuccessful request; pending deletion still blocks sync. */
  async abortConnectionDeletion(): Promise<void> {
    await resumeIdbWrites();
    isConnectionDeletionPending = true;
  },

  /** Adopt the post-wipe IDB generation in the background worker. */
  async completeConnectionDeletion(): Promise<void> {
    await resumeIdbWrites({ adoptCurrentEpoch: true });
    isConnectionDeletionPending = false;
    queueDeliveryRetryAttempt = 0;
    queueDeliveryRetryDelayMs = 0;
  },

  async resyncPendingChanges(): Promise<{
    blockedMessage?: string;
    blockedProjectCount: number;
    conflicts: SyncContentConflict[];
    reloadedFromNotion: boolean;
    remainingCount: number;
  }> {
    const { syncConfig } = await readStorage();
    if (!syncConfig.connected || isBrowserOffline()) {
      throw new Error('Reconnect to Notion before resyncing. Your local changes remain saved.');
    }
    if (!syncQueueBelongsToActiveAccount(syncConfig)) {
      throw new Error('Local data is locked to its original Notion account. Reconnect that account to send local documents.');
    }

    const hadPendingWork = await pendingLocalWorkCount() > 0;
    let reloadedFromNotion = false;
    const pageConflicts: SyncContentConflict[] = [];

    // Retry blocked snapshots only from this explicit user action.
    await unblockPendingSyncOps();
    await unblockPendingProjectSyncEvents();
    const workspace = await readStorage();
    const pendingOps = await listPendingSyncOps();
    const validation = await notionClient.validateNotionCache();
    const pageIdsToReconcile = new Set([
      ...pendingOps.map((op) => op.pageId),
      ...workspace.pages.filter((page) => page.syncState === 'error').map((page) => page.id),
      ...validation.failedPageIds,
    ]);

    for (const pageId of pageIdsToReconcile) {
      const page = workspace.pages.find((entry) => entry.id === pageId);
      const project = page && workspace.projects.find((entry) => entry.id === page.projectId);
      if (!page || !project) continue;

      try {
        const response = await requestServer<SyncPageResponse>('/sync/page/resync', {
          method: 'POST',
          body: JSON.stringify({
            page: { ...page, content: sanitizeMediaForSync(page.content) },
            project: withoutLocalSyncConflicts(project),
            selectedParentPageId: syncConfig.selectedParentPageId,
          }),
        }, syncConfig);
        if (response.status === 'error') throw new Error(response.message ?? 'Unable to sync this page.');
        if (response.page) await persistPage({
          ...response.page,
          content: stripConflictResolutionMarkers(response.page.content),
        });
        await clearStoredPageSyncConflict(pageId);
        await removePendingSyncOps((await listPendingSyncOps())
          .filter((op) => op.pageId === pageId)
          .map((op) => op.opId));
      } catch (error) {
        if (!isUnmappedContentConflict(error) || !error.diff) throw error;
        const currentOps = (await listPendingSyncOps()).filter((op) => op.pageId === pageId);
        if (!currentOps.length) {
          await addPendingSyncOps(buildPageSyncOps({
            page: { ...page, content: sanitizeMediaForSync(page.content) },
            project,
            selectedParentPageId: syncConfig.selectedParentPageId,
          }));
        }
        await blockPendingSyncOps(pageId, {
          code: 'unmapped_notion_content',
          message: error.message,
          diff: error.diff,
        });
        pageConflicts.push({
          targetType: 'page',
          targetId: page.id,
          targetTitle: page.title,
          baseContent: error.diff.baseContent,
          localChangedBlockIds: error.diff.localChangedBlockIds,
          remoteChangedBlockIds: error.diff.remoteChangedBlockIds,
          localContent: error.diff.localContent,
          remoteContent: error.diff.remoteContent,
        });
        await persistPage({ ...page, syncState: 'error', syncMessage: error.message });
      }
    }

    await flushPendingSyncOps({ force: true });
    const projectEvents = await listPendingProjectSyncEvents();
    const blockedEvents = projectEvents.filter((event) => event.deliveryBlocked);
    const { pages, projects } = await readStorage();
    const projectsById = new Map(projects.map((project) => [project.id, project]));
    const blockIdsByProject = new Map<string, Set<string>>();
    for (const page of pages) {
      if (page.status === 'archived') continue;
      const blockIds = blockIdsByProject.get(page.projectId) ?? new Set<string>();
      collectInkwellBlockIds(page.content, blockIds);
      blockIdsByProject.set(page.projectId, blockIds);
    }
    const conflicts = [...pageConflicts];
    const uniqueBlockedEvents = [...new Map(
      blockedEvents.map((event) => [event.projectId, event]),
    ).values()];
    for (const event of uniqueBlockedEvents) {
      let project = projectsById.get(event.projectId) ??
        (event.type === 'project_source_upsert'
          ? { ...event.payload.project, stateContent: { type: 'doc', content: [event.payload.block] } }
          : event.payload.project);
      const diff = event.deliveryBlocked?.diff;
      if (!diff) continue;

      const liveBlockIds = blockIdsByProject.get(event.projectId) ?? new Set<string>();
      const localState = project.stateContent ?? diff.localContent;
      const localContent = pruneOrphanedProjectStateSources(localState, liveBlockIds);
      const remoteContent = diff.remoteContent
        ? pruneOrphanedProjectStateSources(diff.remoteContent, liveBlockIds)
        : null;
      const baseContent = diff.baseContent
        ? pruneOrphanedProjectStateSources(diff.baseContent, liveBlockIds)
        : null;

      if (localContent !== localState && projectsById.has(event.projectId)) {
        project = { ...project, stateContent: localContent };
        projectsById.set(project.id, project);
        await persistRebasedProjectSnapshots([project]);
      }

      conflicts.push({
        targetType: 'project',
        targetId: event.projectId,
        targetTitle: project.name,
        baseContent,
        localChangedBlockIds: diff.localChangedBlockIds,
        remoteChangedBlockIds: diff.remoteChangedBlockIds,
        localContent,
        remoteContent,
      });
    }

    if (!blockedEvents.length && pageConflicts.length === 0 && !hadPendingWork) {
      await notionClient.reloadFromNotion({ force: true });
      reloadedFromNotion = true;
    }

    await persistPageSyncConflicts(pageConflicts);

    return {
      blockedMessage: blockedEvents[0]?.deliveryBlocked?.message,
      blockedProjectCount: new Set(blockedEvents.map((event) => event.projectId)).size,
      conflicts: [...pageConflicts, ...conflicts],
      reloadedFromNotion,
      remainingCount: await pendingLocalWorkCount(),
    };
  },

  async resolveSyncConflict(
    targetType: 'page' | 'project',
    targetId: string,
    content: DocumentContent,
  ): Promise<void> {
    const storage = await readStorage();
    const { projects, syncConfig } = storage;
    if (targetType === 'page') {
      const page = storage.pages.find((entry) => entry.id === targetId);
      const project = page && projects.find((entry) => entry.id === page.projectId);
      if (!page || !project) throw new Error('This page is no longer available.');
      const mergedPage = {
        ...page,
        content: normalizeInkwellBlockIds(content),
        updatedAt: new Date().toISOString(),
        syncState: 'saving' as const,
        syncMessage: undefined,
      };
      const response = await requestServer<SyncPageResponse>('/sync/page/resync', {
        method: 'POST',
        body: JSON.stringify({
          page: {
            ...mergedPage,
            content: sanitizeMediaForSync(stripSyncConflictBlocks(mergedPage.content)),
          },
          project: withoutLocalSyncConflicts(project),
          selectedParentPageId: syncConfig.selectedParentPageId,
        }),
      }, syncConfig);
      if (response.status === 'error') throw new Error(response.message ?? 'Unable to sync the merged page.');
      await removePendingSyncOps((await listPendingSyncOps())
        .filter((op) => op.pageId === targetId)
        .map((op) => op.opId));
      const syncedPage = response.page ?? mergedPage;
      await persistPage({
        ...syncedPage,
        content: stripConflictResolutionMarkers(stripSyncConflictBlocks(syncedPage.content)),
      });
      await clearStoredPageSyncConflict(targetId);
      return;
    }

    const project = projects.find((entry) => entry.id === targetId);
    if (!project) throw new Error('This project is no longer available.');
    const mergedProject: Project = {
      ...project,
      stateContent: normalizeInkwellBlockIds(content),
      updatedAt: new Date().toISOString(),
      syncState: 'saving',
      syncMessage: undefined,
    };
    const replaced = await resolveBlockedProjectSyncEvent(
      mergedProject,
      async (snapshot) => persistRebasedProjectSnapshots([snapshot]),
      syncConfig.selectedParentPageId,
    );
    if (!replaced) throw new Error('This sync conflict has already been resolved.');
    triggerQueueDelivery();
    try {
      await flushPendingSyncOps({ force: true });
    } catch (error) {
      // Project delivery runs before unrelated page and media queue work. If
      // the reviewed project event was removed, its Notion write succeeded;
      // keep that merge resolved even when a separate queued item failed.
      const remainingEvents = await listPendingProjectSyncEvents();
      if (remainingEvents.some((event) => event.projectId === targetId)) throw error;
    }
    const remainingConflict = (await listPendingProjectSyncEvents())
      .find((event) => event.projectId === targetId && event.deliveryBlocked);
    if (remainingConflict?.deliveryBlocked) {
      throw new Error(remainingConflict.deliveryBlocked.message);
    }
  },

  async prepareLocalWorkspaceForFirstSync(): Promise<boolean> {
    const storage = await readStorage();
    const { syncConfig } = storage;

    if (
      !syncConfig.connected ||
      !syncQueueBelongsToActiveAccount(syncConfig) ||
      storage.notionHydrationSource === hydrationSource(syncConfig) ||
      await pendingLocalWorkCount() === 0
    ) {
      return false;
    }

    const pages = storage.pages.map((page) => ({
      ...page,
      content: normalizeInkwellBlockIds(page.content),
    }));
    await writeStorage({ pages });

    for (const project of storage.projects) {
      await addPendingProjectSyncEvent(project, syncConfig.selectedParentPageId);
    }

    for (const page of pages) {
      const project = storage.projects.find((candidate) => candidate.id === page.projectId);
      if (!project) continue;
      await addPendingSyncOps(buildPageSyncOps({
        page: { ...page, content: sanitizeMediaForSync(page.content) },
        project,
        selectedParentPageId: syncConfig.selectedParentPageId,
      }));
    }

    // Mark the destination before delivery. If the extension closes midway,
    // startup keeps the local snapshot and resumes the still-durable queue.
    await writeStorage({ notionHydrationSource: hydrationSource(syncConfig) });
    triggerQueueDelivery();
    return true;
  },

  async needsInitialNotionHydration(): Promise<boolean> {
    const { notionHydrationSource, syncConfig } = await readStorage();

    if (
      !syncConfig.connected ||
      !syncQueueBelongsToActiveAccount(syncConfig) ||
      notionHydrationSource === hydrationSource(syncConfig)
    ) {
      return false;
    }

    // Never replace local edits that have not reached the sync server yet. Once
    // the queue drains, a later startup can safely hydrate this workspace.
    return await pendingLocalWorkCount() === 0;
  },

  async listProjects(): Promise<Project[]> {
    await waitForStub();
    const [{ projects }, pendingEvents] = await Promise.all([
      readStorage(),
      listPendingProjectSyncEvents(),
    ]);
    const blockedMessageByProject = new Map<string, string>();
    for (const event of pendingEvents) {
      if (event.deliveryBlocked) {
        blockedMessageByProject.set(event.projectId, event.deliveryBlocked.message);
      }
    }
    return projects
      .filter((project) => project.status !== 'archived')
      .map((project) => {
        const blockedMessage = blockedMessageByProject.get(project.id);
        return blockedMessage
          ? withProjectSyncStatus(project, 'error', blockedMessage)
          : project;
      })
      .sort(sortProjectsByUpdatedDesc);
  },

  async getCurrentProjectId(): Promise<string> {
    const { currentProjectId } = await readStorage();
    return currentProjectId;
  },

  async setCurrentProjectId(projectId: string): Promise<void> {
    const selectionRevision = ++currentProjectSelectionRevision;
    requestedCurrentProjectId = projectId;
    const { projects } = await readStorage();

    if (!projects.some((project) => project.id === projectId && project.status !== 'archived')) {
      if (selectionRevision === currentProjectSelectionRevision) {
        requestedCurrentProjectId = undefined;
      }
      return;
    }

    if (selectionRevision !== currentProjectSelectionRevision) return;
    await writeStorage({ currentProjectId: projectId });
  },

  async createProject(name = 'Untitled Project'): Promise<OptimisticProjectCreation> {
    const { activePageIdsByProject, currentProjectId, pages, projects } = await readStorage();
    const project = createOptimisticProjectRecord(name);
    const page = createOptimisticPage(project.id, 'Untitled Page');

    await writeStorage({
      activePageIdsByProject: {
        ...activePageIdsByProject,
        [project.id]: page.id,
      },
      currentProjectId: project.id,
      pages: [...pages, page],
      projects: [...projects, project].sort(sortProjectsByUpdatedDesc),
    });

    const settled = (async () => {
      const realProject = createProjectRecord(project.name);
      const realPage = {
        ...page,
        id: `page-${realProject.id}-${crypto.randomUUID()}`,
        projectId: realProject.id,
        syncState: 'saved' as const,
      };

      try {
        // Reconcile temporary IDs before touching the network so the project
        // and its first page remain usable if the request hangs or the panel closes.
        await replaceTempProject({
          tempPage: page,
          tempProject: project,
          realPage,
          realProject,
        });
        const syncedProject = await syncProject(realProject);
        const savedProject = syncedProject ?? realProject;
        const { projects: latestProjects } = await readStorage();
        const latestProject = latestProjects.find(
          (storedProject) => storedProject.id === realProject.id,
        );
        if (latestProject?.updatedAt === realProject.updatedAt) {
          await writeStorage({
            projects: latestProjects.map((storedProject) =>
              storedProject.id === realProject.id ? savedProject : storedProject,
            ),
          });
        }
        const queuedPage = await enqueuePageSync(realPage, savedProject);
        await persistPage(queuedPage);
        const savedPage = await replayTempPageSave(page.id, queuedPage);
        return { page: savedPage, project: savedProject };
      } catch (error) {
        const message =
          error instanceof Error ? error.message : 'Unable to create this project.';
        await rollbackTempProject(project, page, currentProjectId, message);
        throw error;
      } finally {
        projectReconciliations.delete(project.id);
      }
    })();

    const projectReconciliation = settled.then(({ project }) => project.id);
    projectReconciliation.catch(() => undefined);
    projectReconciliations.set(project.id, projectReconciliation);

    return { page, project, settled };
  },

  async renameProject(projectId: string, name: string): Promise<Project> {
    const { projects } = await readStorage();
    const project = requireActiveProject(projects, projectId);
    const updatedProject = touchProject(project, { name: name.trim() || 'Untitled Project' });
    return saveProjectUpdate(projects, projectId, updatedProject);
  },

  async archiveProject(projectId: string): Promise<{ currentProjectId: string; project: Project }> {
    const { activePageIdsByProject, pages, projects } = await readStorage();
    const project = requireActiveProject(projects, projectId);
    const activeProjects = projects.filter((storedProject) => storedProject.status !== 'archived');

    if (activeProjects.length <= 1) {
      throw new Error('Create another project before archiving this one.');
    }

    const archivedProject = touchProject(project, {
      status: 'archived' as const,
    });
    const replacementProject = activeProjects.find(
      (storedProject) => storedProject.id !== projectId,
    );
    const replacementPage = replacementProject
      ? pages.find(
          (page) =>
            page.projectId === replacementProject.id &&
            page.status !== 'archived' &&
            page.id === activePageIdsByProject[replacementProject.id],
        ) ??
        pages.find(
          (page) =>
            page.projectId === replacementProject.id &&
            page.status !== 'archived',
        )
      : undefined;

    await writeStorage({
      currentProjectId: replacementProject?.id ?? '',
      projects: projects.map((storedProject) =>
        storedProject.id === projectId ? archivedProject : storedProject,
      ),
      activePageIdsByProject: {
        ...activePageIdsByProject,
        ...(replacementProject && replacementPage
          ? { [replacementProject.id]: replacementPage.id }
        : {}),
      },
    });

    const syncedProject = await syncProject(archivedProject);
    const savedProject = syncedProject ?? archivedProject;
    const { projects: latestProjects } = await readStorage();
    const latestProject = latestProjects.find((storedProject) => storedProject.id === projectId);

    if (latestProject?.updatedAt === archivedProject.updatedAt) {
      await writeStorage({
        projects: latestProjects.map((storedProject) =>
          storedProject.id === projectId ? savedProject : storedProject,
        ),
      });
    }

    return {
      currentProjectId: replacementProject?.id ?? '',
      project: savedProject,
    };
  },

  async updateProjectMetadata(
    projectId: string,
    metadata: { category?: string; stateContent?: DocumentContent },
  ): Promise<Project> {
    const { projects } = await readStorage();
    const project = requireActiveProject(projects, projectId);
    const updatedProject = touchProject(project, {
      category: metadata.category?.trim() ?? project.category,
      stateContent: metadata.stateContent ?? project.stateContent,
    });
    return saveProjectUpdate(projects, projectId, updatedProject);
  },

  async addProjectSource(
    projectId: string,
    blockId: string,
    payload: CaptureSelectionPayload,
  ): Promise<Project> {
    const { projects } = await readStorage();
    const project = requireActiveProject(projects, projectId);
    const source = sourcePayloadFromCapture(payload);
    const updatedProject = touchProject(project, {
      stateContent: addSourceToProjectState(
        project.stateContent,
        blockId,
        source,
      ),
    });
    return saveProjectSourceUpdate(projects, projectId, updatedProject, blockId, source);
  },

  async getSyncConfig(): Promise<SyncConfig> {
    const { syncConfig } = await readStorage();
    return { ...syncConfig };
  },

  async assignUnmatchedPendingQueueToCurrentAccount(): Promise<SyncConfig> {
    const { syncConfig } = await readStorage();
    if (!syncConfig.connected || !syncConfig.userId || syncConfig.syncQueueOwnerUserId !== null) {
      throw new Error('These queued changes cannot be assigned to the current Notion account.');
    }
    const nextConfig = await updateStoredSyncConfig({ syncQueueOwnerUserId: syncConfig.userId });
    triggerQueueDelivery();
    return nextConfig;
  },

  async updateSyncConfig(config: Partial<SyncConfig>): Promise<SyncConfig> {
    return updateStoredSyncConfig(config);
  },

  async refreshSyncSession(allowSignedOut = false): Promise<SyncConfig> {
    const { hasExplicitlyLoggedOut, syncConfig } = await readStorage();
    const pendingDeletionState = await browser.storage.local.get(PENDING_CONNECTION_DELETION_KEY) as Record<
      string,
      PendingConnectionDeletion | undefined
    >;
    if (pendingDeletionState[PENDING_CONNECTION_DELETION_KEY]) {
      try {
        await notionClient.deleteConnection();
        return (await readStorage()).syncConfig;
      } catch {
        // The explicit deletion request stays available in settings for a safe retry.
        return syncConfig;
      }
    }
    if (!allowSignedOut && hasExplicitlyLoggedOut) {
      return syncConfig;
    }

    const session = await requestServer<SyncSessionResponse>(
      '/session',
      undefined,
      syncConfig,
    );

    const pendingLocalWork = await pendingLocalWorkCount();
    const workspace = await readStorage();
    const hasRetainedLocalData = pendingLocalWork > 0 ||
      Boolean(workspace.notionHydrationSource) ||
      hasRemoteBackedData(workspace.projects, workspace.pages);
    let syncQueueOwnerUserId = syncConfig.syncQueueOwnerUserId;
    if (session.authenticated && session.userId) {
      if (!hasRetainedLocalData) {
        syncQueueOwnerUserId = session.userId;
      } else if (syncQueueOwnerUserId === undefined) {
        const matchesLegacyAccount = syncConfig.authenticated &&
          syncConfig.userEmail === session.userEmail &&
          (!syncConfig.workspaceId || syncConfig.workspaceId === session.workspaceId);
        if (syncConfig.userId) {
          syncQueueOwnerUserId = syncConfig.userId;
        } else if (matchesLegacyAccount) {
          syncQueueOwnerUserId = session.userId;
        } else if (hasExplicitlyLoggedOut || syncConfig.userEmail || syncConfig.workspaceId) {
          // Older releases cleared account identity on logout. Keep their queued
          // content local until the user explicitly assigns it to this account.
          syncQueueOwnerUserId = null;
        } else {
          // Local-only work created before the first Notion connection belongs
          // to the account the user is connecting now.
          syncQueueOwnerUserId = session.userId;
        }
      }
    }

    const nextConfig = await updateStoredSyncConfig({
      authenticated: session.authenticated,
      ...(session.authenticated && session.userId ? { userId: session.userId } : {}),
      ...(session.authenticated && session.userId ? { syncQueueOwnerUserId } : {}),
      userName: session.userName,
      userEmail: session.userEmail,
      connected: session.connected,
      workspaceId: session.workspaceId,
      workspaceName: session.workspaceName,
    }, session.authenticated ? { hasExplicitlyLoggedOut: false } : {});

    if (session.connected && syncQueueBelongsToActiveAccount(nextConfig)) {
      triggerQueueDelivery();
    }

    return nextConfig;
  },

  async validateNotionCache(): Promise<{
    stalePageIds: string[];
    aheadPageIds: string[];
    failedPageIds: string[];
  }> {
    const { pages, projects, syncConfig } = await readStorage();

    if (!syncConfig.connected) {
      return { stalePageIds: [], aheadPageIds: [], failedPageIds: [] };
    }

    if (!syncQueueBelongsToActiveAccount(syncConfig)) {
      throw new Error('Local data is locked to its original Notion account. Reconnect that account to send local documents.');
    }

    const knownVersions: Record<string, number> = {};
    for (const page of pages) {
      if (typeof page.knownSyncVersion === 'number') {
        knownVersions[page.id] = page.knownSyncVersion;
      }
    }

    const response = await requestServer<SyncValidationResponse>('/sync/validate', {
      method: 'POST',
      body: JSON.stringify({
        pages,
        projects: projects.map(withoutLocalSyncConflicts),
        knownVersions,
      }),
    }, syncConfig);
    const uncachedProjectIds = new Set(response.uncachedProjectIds ?? []);
    const uncachedPageIds = new Set(response.uncachedPageIds ?? []);
    const serverVersions = response.serverVersions ?? {};

    const needsWrite = uncachedProjectIds.size || uncachedPageIds.size || response.clearSelectedParentPage || Object.keys(serverVersions).length;

    if (needsWrite) {
      await writeStorage({
        ...(response.clearSelectedParentPage
          ? {
              syncConfig: {
                ...syncConfig,
                selectedParentPageId: undefined,
                selectedParentPageTitle: undefined,
              },
            }
          : {}),
        projects: projects.map((project) =>
          uncachedProjectIds.has(project.id)
            ? {
                ...project,
                stateRemoteRevision: undefined,
                syncMessage: undefined,
                syncState: 'saved' as const,
              }
            : project,
        ),
        pages: pages.map((page) => {
          const withVersion =
            typeof serverVersions[page.id] === 'number'
              ? {
                  ...page,
                  serverSyncVersion: serverVersions[page.id],
                  ...(serverVersions[page.id] <= (page.knownSyncVersion ?? 0)
                    ? { knownSyncVersion: serverVersions[page.id] }
                    : {}),
                }
              : page;
          return uncachedPageIds.has(page.id) ? uncachePageNotionMetadata(withVersion) : withVersion;
        }),
      });
    }

    return {
      stalePageIds: response.stalePageIds ?? [],
      aheadPageIds: response.aheadPageIds ?? [],
      failedPageIds: response.failedPageIds ?? [],
    };
  },

  async reloadFromNotion(options: {
    force?: boolean;
    preserveLocalWhenRemoteEmpty?: boolean;
  } = {}): Promise<{
    currentProjectId: string;
    pages: ProjectPage[];
    projects: Project[];
    syncConfig: SyncConfig;
  }> {
    const { currentProjectId, pages: localPages, projects: localProjects, syncConfig } = await readStorage();

    if (!syncConfig.connected) {
      throw new Error('Connect Notion before reloading from Notion.');
    }

    const validation = options.force
      ? { stalePageIds: [], aheadPageIds: [] }
      : await this.validateNotionCache();
    if (
      !options.force &&
      !validation.stalePageIds.length &&
      !validation.aheadPageIds.length
    ) {
      return {
        currentProjectId,
        pages: localPages,
        projects: localProjects,
        syncConfig,
      };
    }

    const response = await requestServer<SyncReloadResponse>('/sync/reload', {
      method: 'POST',
      body: JSON.stringify({
        selectedParentPageId: syncConfig.selectedParentPageId,
      }),
    }, syncConfig);
    const nextSyncConfig = response.clearSelectedParentPage
      ? {
          ...syncConfig,
          selectedParentPageId: undefined,
          selectedParentPageTitle: undefined,
        }
      : syncConfig;

    if (options.preserveLocalWhenRemoteEmpty && response.projects.length === 0) {
      await writeStorage({
        notionHydrationSource: hydrationSource(nextSyncConfig),
        syncConfig: nextSyncConfig,
      });
      const latestStorage = await readStorage();
      return {
        currentProjectId: latestStorage.currentProjectId,
        pages: latestStorage.pages,
        projects: latestStorage.projects,
        syncConfig: nextSyncConfig,
      };
    }

    const localConflictsByProjectId = new Map(localProjects.map((project) => [
      project.id,
      project.syncConflicts,
    ]));
    const projects = response.projects.map((project) => {
      const normalized = normalizeProject(project);
      const syncConflicts = localConflictsByProjectId.get(normalized.id);
      return syncConflicts?.length ? { ...normalized, syncConflicts } : normalized;
    }).sort(sortProjectsByUpdatedDesc);
    const pages = response.pages.map(normalizeStoredPage);
    const activePageIdsByProject = createCompatibleActivePageIds(
      projects,
      pages,
      response.activePageIdsByProject,
    );
    const nextCurrentProjectId = projects.some((project) => project.id === response.currentProjectId)
      ? response.currentProjectId ?? ''
      : projects[0]?.id ?? '';
    const localStorageToPreserve = await readStorage();
    const localProjectsToPreserve = localStorageToPreserve.projects;
    await writeStorage({
      activePageIdsByProject,
      currentProjectId: nextCurrentProjectId,
      hasMigratedCapturesToPages: true,
      pages,
      projects,
      syncConfig: nextSyncConfig,
      notionHydrationSource: hydrationSource(nextSyncConfig),
    });
    const blockedProjectIds = new Set(await listBlockedProjectSyncIds());
    const blockedLocalProjects = localProjectsToPreserve.filter((project) => blockedProjectIds.has(project.id));
    if (blockedLocalProjects.length) {
      const blockedIds = new Set(blockedLocalProjects.map((project) => project.id));
      await persistRebasedProjectSnapshots(
        blockedLocalProjects,
        localStorageToPreserve.pages.filter((page) => blockedIds.has(page.projectId)),
      );
    }

    const latestStorage = await readStorage();

    return {
      currentProjectId: latestStorage.currentProjectId,
      pages: latestStorage.pages,
      projects: latestStorage.projects,
      syncConfig: nextSyncConfig,
    };
  },

  async logoutSyncSession(): Promise<{
    notionTokenRevoked: boolean;
    serverDataCleanupComplete: boolean;
    syncConfig: SyncConfig;
  }> {
    isSessionLogoutPending = true;
    if (queueDeliveryTimer) {
      clearTimeout(queueDeliveryTimer);
      queueDeliveryTimer = undefined;
    }

    let serverCleanup: { notionTokenRevoked: boolean; serverDataCleanupComplete: boolean } = {
      notionTokenRevoked: false,
      serverDataCleanupComplete: false,
    };
    try {
      const { syncConfig } = await readStorage();
      const nextSyncConfig = await updateStoredSyncConfig({
        authenticated: false,
        userName: undefined,
        userEmail: undefined,
        connected: false,
        workspaceId: undefined,
        workspaceName: undefined,
        selectedParentPageId: undefined,
        selectedParentPageTitle: undefined,
        selectedDatabaseId: undefined,
        selectedDatabaseTitle: undefined,
        selectedDataSourceId: undefined,
      }, { hasExplicitlyLoggedOut: true });
      await Promise.allSettled(
        [queueDeliveryPromise, forcedQueueDeliveryPromise].filter(
          (promise): promise is Promise<void> => Boolean(promise),
        ),
      );
      try {
        const response = await requestServer<{
          connected: false;
          loggedOut: boolean;
          notionTokenRevoked: boolean;
          serverDataCleanupComplete: boolean;
        }>('/auth/notion/logout', {
          method: 'POST',
          body: JSON.stringify({}),
        }, syncConfig);
        serverCleanup = {
          notionTokenRevoked: response.notionTokenRevoked,
          serverDataCleanupComplete: response.serverDataCleanupComplete,
        };
      } catch {
        // A network or server failure must not keep this browser signed in locally.
        // The status returned below tells the UI that remote revocation is unconfirmed.
      }

      return {
        notionTokenRevoked: serverCleanup.notionTokenRevoked,
        serverDataCleanupComplete: serverCleanup.serverDataCleanupComplete,
        syncConfig: nextSyncConfig,
      };
    } catch {
      throw new Error('Unable to clear the local Inkwell account state.');
    } finally {
      isSessionLogoutPending = false;
    }
  },

  async deleteConnection(): Promise<{ notionTokenRevoked: boolean }> {
    const { syncConfig: storedSyncConfig } = await readStorage();
    const extensionStorage = await browser.storage.local.get(PENDING_CONNECTION_DELETION_KEY) as Record<
      string,
      PendingConnectionDeletion | undefined
    >;
    let pendingDeletion = extensionStorage[PENDING_CONNECTION_DELETION_KEY];
    if (pendingDeletion) {
      const isDifferentAuthenticatedConnection = storedSyncConfig.authenticated && (
        cleanSyncServerUrl(storedSyncConfig.serverUrl) !== pendingDeletion.serverUrl ||
        Boolean(pendingDeletion.userId && storedSyncConfig.userId !== pendingDeletion.userId) ||
        Boolean(pendingDeletion.userEmail && storedSyncConfig.userEmail !== pendingDeletion.userEmail) ||
        Boolean(pendingDeletion.workspaceId && storedSyncConfig.workspaceId !== pendingDeletion.workspaceId)
      );
      if (
        !/^[A-Za-z0-9_-]{40,128}$/.test(pendingDeletion.requestId) ||
        isDifferentAuthenticatedConnection
      ) {
        throw new Error('A previous Inkwell deletion is pending for another connection. Reconnect that account to finish it.');
      }
    } else {
      if (!storedSyncConfig.authenticated || !storedSyncConfig.userId) {
        throw new Error('Sign in to the Notion account that owns this Inkwell data before deleting the connection. Your local documents are unchanged.');
      }
      if (
        storedSyncConfig.syncQueueOwnerUserId === null ||
        (storedSyncConfig.syncQueueOwnerUserId &&
          storedSyncConfig.syncQueueOwnerUserId !== storedSyncConfig.userId)
      ) {
        throw new Error('Reconnect the Notion account that owns this local data before deleting the connection. Your local documents are unchanged.');
      }
      pendingDeletion = {
        requestId: `${crypto.randomUUID()}${crypto.randomUUID()}`,
        serverUrl: cleanSyncServerUrl(storedSyncConfig.serverUrl),
        userId: storedSyncConfig.userId,
        ...(storedSyncConfig.userEmail ? { userEmail: storedSyncConfig.userEmail } : {}),
        ...(storedSyncConfig.workspaceId ? { workspaceId: storedSyncConfig.workspaceId } : {}),
      };
      await browser.storage.local.set({
        [PENDING_CONNECTION_DELETION_KEY]: pendingDeletion,
      });
    }
    const syncConfig = {
      ...storedSyncConfig,
      serverUrl: pendingDeletion.serverUrl,
    };
    isConnectionDeletionPending = true;
    if (queueDeliveryTimer) {
      clearTimeout(queueDeliveryTimer);
      queueDeliveryTimer = undefined;
    }

    let serverDeleted = false;
    let localDataCleared = false;
    try {
      const prepared = await browser.runtime.sendMessage({
        type: 'inkwell.prepareConnectionDeletion',
      });
      if (prepared === false) {
        throw new Error('The background service could not pause Inkwell sync before deletion.');
      }
      await pauseIdbWrites();
      await Promise.allSettled(
        [queueDeliveryPromise, forcedQueueDeliveryPromise].filter(
          (promise): promise is Promise<void> => Boolean(promise),
        ),
      );

      const response = await requestServer<{
        deleted: boolean;
        notionTokenRevoked: boolean;
      }>('/auth/notion/delete-connection', {
        method: 'POST',
        body: JSON.stringify({ requestId: pendingDeletion.requestId }),
      }, syncConfig);
      if (!response.deleted) throw new Error('The Inkwell connection could not be deleted.');
      serverDeleted = true;

      await idbClear();
      await browser.storage.local.clear();
      localDataCleared = true;
      queueDeliveryRetryAttempt = 0;
      queueDeliveryRetryDelayMs = 0;
      return { notionTokenRevoked: response.notionTokenRevoked };
    } finally {
      if (!serverDeleted) {
        await resumeIdbWrites();
        void Promise.resolve(browser.runtime.sendMessage({
          type: 'inkwell.abortConnectionDeletion',
        })).catch(() => undefined);
      } else if (localDataCleared) {
        await resumeIdbWrites({ adoptCurrentEpoch: true });
        isConnectionDeletionPending = false;
        void Promise.resolve(browser.runtime.sendMessage({
          type: 'inkwell.completeConnectionDeletion',
        })).catch(() => undefined);
      }
    }
  },

  async listNotionParentPages(query = ''): Promise<NotionParentPage[]> {
    const search = query.trim()
      ? `?query=${encodeURIComponent(query.trim())}`
      : '';
    const response = await requestServer<ListNotionPagesResponse>(
      `/notion/pages${search}`,
    );
    return response.pages;
  },

  async createNotionParentPage(title: string): Promise<NotionParentPage> {
    const response = await requestServer<CreateNotionPageResponse>('/notion/pages', {
      method: 'POST',
      body: JSON.stringify({ title }),
    });
    return response.page;
  },

  async selectNotionParentPage(
    pageId: string,
    title?: string,
  ): Promise<SyncConfig> {
    return updateStoredSyncConfig({
      selectedParentPageId: pageId || undefined,
      selectedParentPageTitle: title,
    });
  },

  async getProjectPage(projectId: string): Promise<ProjectPage | undefined> {
    await waitForStub();
    const { activePageIdsByProject, pages } = await readStorage();
    const activePageId = activePageIdsByProject[projectId];
    const page =
      pages.find((storedPage) => storedPage.id === activePageId && storedPage.status !== 'archived') ??
      pages.find(
        (storedPage) => storedPage.projectId === projectId && storedPage.status !== 'archived',
      );

    if (!page) {
      return undefined;
    }

    return syncAndPersistPage(page);
  },

  async syncProjectPage(pageId: string): Promise<ProjectPage | undefined> {
    const { pages } = await readStorage();
    const page = pages.find((storedPage) => storedPage.id === pageId);

    if (!page || page.status === 'archived') {
      return undefined;
    }

    return syncAndPersistPage(page);
  },

  async prefetchProjectPages(projectId: string, excludePageId?: string): Promise<void> {
    const { pages } = await readStorage();

    for (const page of findActiveProjectPages(pages, projectId, excludePageId)) {
      await syncAndPersistPage(page);
    }
  },

  async listProjectPages(projectId: string): Promise<ProjectPage[]> {
    await waitForStub();
    const { pages } = await readStorage();
    return pages
      .filter((page) => page.projectId === projectId && page.status !== 'archived')
      .sort(
        (first, second) =>
          new Date(first.createdAt).getTime() - new Date(second.createdAt).getTime(),
      );
  },

  async setActiveProjectPage(pageId: string): Promise<ProjectPage | undefined> {
    const { activePageIdsByProject, pages } = await readStorage();
    const page = pages.find((storedPage) => storedPage.id === pageId);

    if (!page || page.status === 'archived') {
      return undefined;
    }

    await writeStorage({
      activePageIdsByProject: {
        ...activePageIdsByProject,
        [page.projectId]: page.id,
      },
    });

    return page;
  },

  async createProjectPage(
    projectId: string,
    title = 'Untitled Page',
  ): Promise<OptimisticPageCreation> {
    const { activePageIdsByProject, pages, projects } = await readStorage();
    const project = projects.find((storedProject) => storedProject.id === projectId);

    if (!project) {
      throw new Error('This project is no longer available.');
    }

    const previousActivePageId = activePageIdsByProject[projectId] ?? '';
    const page = createOptimisticPage(projectId, title.trim() || 'Untitled Page');

    await writeStorage({
      activePageIdsByProject: {
        ...activePageIdsByProject,
        [projectId]: page.id,
      },
      pages: [...pages, page],
    });

    const settled = (async () => {
      try {
        const realProjectId = projectReconciliations.has(projectId)
          ? await projectReconciliations.get(projectId)
          : projectId;
        const { projects: latestProjects } = await readStorage();
        const realProject = latestProjects.find(
          (storedProject) => storedProject.id === realProjectId,
        );

        if (!realProject || isTempProject(realProject)) {
          throw new Error('This project is not ready to sync pages yet.');
        }

        const realPage = markPageDirty({
          ...page,
          id: `page-${realProject.id}-${crypto.randomUUID()}`,
          projectId: realProject.id,
          syncState: 'saving',
        });
        const syncedPage = await enqueuePageSync(realPage, realProject);

        await replaceTempPage(page, syncedPage);
        return replayTempPageSave(page.id, syncedPage);
      } catch (error) {
        const message =
          error instanceof Error ? error.message : 'Unable to create this page.';
        await rollbackTempPage(page, previousActivePageId, message);
        throw error;
      }
    })();

    return { page, settled };
  },

  async renameProjectPage(pageId: string, title: string) {
    const { pages, projects, page, project } = await requirePageWithProject(pageId);

    const updatedPage = markPageDirty({
      ...page,
      title: title.trim() || 'Untitled Page',
    });

    if (isTempPage(updatedPage) || isTempProject(project)) {
      await writeStorage({
        pages: pages.map((storedPage) =>
          storedPage.id === updatedPage.id ? updatedPage : storedPage,
        ),
      });
      pendingTempPageSaves.set(updatedPage.id, updatedPage);
      return updatedPage;
    }

    const syncedPage = await enqueuePageSync(updatedPage, project, page);

    await writeStorage({
      pages: pages.map((storedPage) =>
        storedPage.id === syncedPage.id ? syncedPage : storedPage,
      ),
    });

    return syncedPage;
  },

  async archiveProjectPage(pageId: string): Promise<ProjectPage> {
    const { activePageIdsByProject, pages, projects, page, project } = await requirePageWithProject(pageId);

    const archivedPage = markPageDirty({
      ...page,
      status: 'archived' as const,
    });
    const pagesAfterArchive = pages.map((storedPage) =>
      storedPage.id === archivedPage.id ? archivedPage : storedPage,
    );
    const replacementPage =
      pagesAfterArchive.find(
        (storedPage) =>
          storedPage.projectId === page.projectId && storedPage.status !== 'archived',
      ) ?? createEmptyPage(page.projectId, 'Untitled Page');
    const nextPages = pagesAfterArchive.some(
      (storedPage) => storedPage.id === replacementPage.id,
    )
      ? pagesAfterArchive
      : [...pagesAfterArchive, replacementPage];

    await writeStorage({
      activePageIdsByProject: {
        ...activePageIdsByProject,
        [page.projectId]: replacementPage.id,
      },
      pages: nextPages,
    });

    if (!isTempPage(archivedPage) && !isTempProject(project)) {
      const syncedArchivedPage = await enqueuePageSync(archivedPage, project, page);

      if (syncedArchivedPage.syncState === 'error') {
        throw new Error(syncedArchivedPage.syncMessage ?? 'Unable to archive this page in Notion.');
      }
    }

    return replacementPage;
  },

  async updateProjectPage(page: ProjectPage): Promise<ProjectPage> {
    const { pages, projects } = await readStorage();
    const project = projects.find((storedProject) => storedProject.id === page.projectId);

    if (!project) {
      throw new Error('This project is no longer available.');
    }

    const updatedPage = markPageDirty({
      ...page,
      content: normalizeInkwellBlockIds(page.content),
    });

    await writeStorage({
      pages: pages.map((storedPage) =>
        storedPage.id === updatedPage.id ? updatedPage : storedPage,
      ),
    });

    if (isTempPage(updatedPage) || isTempProject(project)) {
      pendingTempPageSaves.set(updatedPage.id, updatedPage);
      return updatedPage;
    }

    const previousPage = pages.find((storedPage) => storedPage.id === updatedPage.id);
    const syncedPage = await enqueuePageSync(updatedPage, project, previousPage);
    await persistPage(syncedPage);
    return syncedPage;
  },

  async appendCaptureToCurrentPage(
    payload: CaptureSelectionPayload,
  ): Promise<ProjectPage> {
    const { activePageIdsByProject, currentProjectId, pages, projects } =
      await readStorage();
    const projectId = currentProjectId || projects[0]?.id;
    const project = projects.find((storedProject) => storedProject.id === projectId);
    const page =
      pages.find(
        (storedPage) =>
          storedPage.id === activePageIdsByProject[projectId] &&
          storedPage.status !== 'archived',
      ) ??
      pages.find(
        (storedPage) =>
          storedPage.projectId === projectId && storedPage.status !== 'archived',
      );

    if (!page || !project) {
      throw new Error('No Inkwell page is available for this capture.');
    }

    const capturedContent = createCapturedContent(payload);
    const sourceBlockId = capturedBlockId(capturedContent);
    const updatedProject = sourceBlockId
      ? touchProject(project, {
          stateContent: addSourceToProjectState(
            project.stateContent,
            sourceBlockId,
            sourcePayloadFromCapture(payload),
          ),
        })
      : project;
    const savedProject = sourceBlockId
      ? (await saveProjectSourceUpdate(
          projects,
          project.id,
          updatedProject,
          sourceBlockId,
          sourcePayloadFromCapture(payload),
        ))
      : project;
    const updatedPage = appendContent(page, capturedContent);

    await writeStorage({
      pages: pages.map((storedPage) =>
        storedPage.id === updatedPage.id ? updatedPage : storedPage,
      ),
    });

    const syncedPage = await enqueuePageSync(updatedPage, savedProject, page);
    await persistPage(syncedPage);
    return syncedPage;
  },

  async uploadMedia(blob: Blob, mimeType: string, filename: string): Promise<string> {
    const { syncConfig } = await readStorage();
    if (!syncConfig.connected || isBrowserOffline()) {
      throw new Error(
        syncConfig.connected
          ? 'Reconnect before uploading media.'
          : 'Connect Notion before uploading media.',
      );
    }

    return uploadMediaBlob(blob, mimeType, filename, syncConfig);
  },

  async refreshMediaUrl(fileUploadId?: string, notionBlockId?: string): Promise<string> {
    if (!fileUploadId && !notionBlockId) {
      throw new Error('Missing Notion media identity.');
    }

    const response = await requestServer<MediaRefreshResponse>('/media/refresh', {
      method: 'POST',
      body: JSON.stringify({ fileUploadId, notionBlockId }),
    });

    if (!response.url) {
      throw new Error('The sync server did not return a media URL.');
    }

    return response.url;
  },
};
