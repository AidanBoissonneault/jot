import type {
  Capture,
  DocumentContent,
  NotionParentPage,
  Project,
  ProjectPage,
  SaveStatus,
  SyncConfig,
} from '@/src/types/capture';
import { idbGet, idbGetMany, idbSet, idbSetMany } from '@/src/services/idbStore';
import { encodeInkwellSource, INKWELL_SOURCE_ATTR } from '@/src/extensions/inkwellLink';
import type {
  CaptureSelectionPayload,
  SourceOpenPayload,
} from '@/src/types/messages';
import type {
  CreateNotionPageResponse,
  ListNotionPagesResponse,
  MediaUploadResponse,
  MediaRefreshResponse,
  SyncEnqueueResponse,
  SyncEventMessage,
  SyncPageResponse,
  SyncProjectResponse,
  SyncReloadResponse,
  SyncSessionResponse,
  SyncValidationResponse,
} from '@/src/types/sync';
import { markUnrecoverableTransientMedia } from '@/src/extensions/mediaContent';
import { normalizeInkwellBlockIds } from '@/src/extensions/inkwellBlockIds';
import {
  addPendingSyncOps,
  buildPageSyncOps,
  compactPendingSyncOps,
  listPendingSyncOps,
  removePendingSyncOps,
  replacePendingSyncOps,
  type BlockSyncOp,
} from '@/src/services/syncQueue';

type InkwellStorage = {
  activePageIdsByProject?: Record<string, string>;
  captures?: Capture[];
  currentProjectId?: string;
  hasMigratedCapturesToPages?: boolean;
  pages?: ProjectPage[];
  projects?: Project[];
  syncConfig?: SyncConfig;
};

export type OptimisticProjectCreation = {
  page: ProjectPage;
  project: Project;
  settled: Promise<{ page: ProjectPage; project: Project }>;
};

export type OptimisticPageCreation = {
  page: ProjectPage;
  settled: Promise<ProjectPage>;
};

const STORAGE_KEYS: Array<keyof InkwellStorage> = [
  'activePageIdsByProject',
  'captures',
  'currentProjectId',
  'hasMigratedCapturesToPages',
  'pages',
  'projects',
  'syncConfig',
];

const DEFAULT_SYNC_CONFIG: SyncConfig = {
  serverUrl: import.meta.env.VITE_API_URL ?? 'http://localhost:8787',
  authenticated: false,
  connected: false,
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
const pendingTempPageSaves = new Map<string, ProjectPage>();
const projectReconciliations = new Map<string, Promise<string>>();
let queueDeliveryPromise: Promise<void> | undefined;
let queueDeliveryTimer: ReturnType<typeof setTimeout> | undefined;
let forcedQueueDeliveryPromise: Promise<void> | undefined;

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

function sourcePayloadFromCapture(payload: CaptureSelectionPayload): SourceOpenPayload {
  return {
    sourceUrl: payload.sourceUrl,
    pageTitle: payload.pageTitle,
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

function sourceLinkAttrs(payload: CaptureSelectionPayload) {
  return {
    href: payload.highlightMeta.sourceLink || payload.sourceUrl,
    target: '_blank',
    rel: 'noopener noreferrer nofollow',
    class: null,
    [INKWELL_SOURCE_ATTR]: encodeInkwellSource(sourcePayloadFromCapture(payload)),
  };
}

export function createCapturedContent(payload: CaptureSelectionPayload): DocumentContent[] {
  if (payload.highlightMeta.isHeading) {
    return createLinkedHeadingContent(payload);
  }

  return [
    {
      type: 'blockquote',
      attrs: {
        inkwellCaptureId: crypto.randomUUID(),
      },
      content: [textParagraph(payload.text)],
    },
    textParagraph(`Source: ${payload.pageTitle || 'Untitled page'} - ${payload.sourceUrl}`, [
      {
        type: 'link',
        attrs: sourceLinkAttrs(payload),
      },
    ]),
    {
      type: 'paragraph',
    },
  ];
}

export function createLinkedHeadingContent(
  payload: CaptureSelectionPayload,
): DocumentContent[] {
  const level = payload.highlightMeta.headingLevel ?? 2;

  return [
    {
      type: 'heading',
      attrs: {
        inkwellCaptureId: crypto.randomUUID(),
        level,
      },
      content: [
        {
          type: 'text',
          text: payload.text,
          marks: [
            {
              type: 'link',
              attrs: sourceLinkAttrs(payload),
            },
          ],
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

async function readStorage(): Promise<Required<InkwellStorage>> {
  await migrateStorageToIdb();
  const stored = (await idbGetMany(STORAGE_KEYS)) as InkwellStorage;

  const storedProjects = stored.projects !== undefined ? stored.projects : defaultProjects;
  const projects = (isLegacyStubProjectSet(storedProjects)
    ? defaultProjects
    : storedProjects
  ).map(normalizeProject)
    .sort(sortProjectsByUpdatedDesc);
  const captures = stored.captures ?? [];
  const shouldCreatePages =
    !stored.pages?.length ||
    !stored.hasMigratedCapturesToPages ||
    isLegacyStubProjectSet(storedProjects);
  const pages = (shouldCreatePages
    ? createDefaultPages(projects)
    : stored.pages ?? createDefaultPages(projects)
  ).map(normalizeStoredPage);
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

  if (
    !stored.activePageIdsByProject ||
    !hasCompatibleActivePages ||
    !hasCompatiblePageStatuses ||
    !stored.projects ||
    !stored.currentProjectId ||
    !stored.syncConfig ||
    shouldCreatePages ||
    stored.hasMigratedCapturesToPages !== true
  ) {
    await idbSetMany({
      activePageIdsByProject,
      projects,
      currentProjectId,
      pages,
      syncConfig,
      hasMigratedCapturesToPages: true,
    });
  }

  return {
    captures,
    currentProjectId,
    activePageIdsByProject,
    hasMigratedCapturesToPages: true,
    pages,
    projects,
    syncConfig,
  };
}

function isLegacyStubProjectSet(projects: Project[]) {
  return projects.some((project) =>
    ['project-product-research', 'project-writing'].includes(project.id),
  );
}

async function writeStorage(storage: Partial<InkwellStorage>) {
  await idbSetMany(storage as Record<string, unknown>);
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

  if (!syncConfig.connected) {
    return;
  }

  const response = await requestServer<SyncProjectResponse>('/sync/project', {
    method: 'POST',
    body: JSON.stringify({
      project,
      selectedParentPageId: syncConfig.selectedParentPageId,
    }),
  }, syncConfig);

  if (response.parentPage) {
    await updateStoredSyncConfig({
      selectedParentPageId: response.parentPage.id,
      selectedParentPageTitle: response.parentPage.title,
    });
  }

  if (response.status === 'error') {
    throw new Error(response.message ?? 'Unable to sync this project.');
  }

  return response.project;
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

function cleanServerUrl(url: string) {
  return url.trim().replace(/\/+$/, '') || DEFAULT_SYNC_CONFIG.serverUrl;
}

async function requestServer<T>(
  path: string,
  init?: RequestInit,
  config?: SyncConfig,
): Promise<T> {
  const syncConfig = config ?? (await readStorage()).syncConfig;
  const headers = {
    ...(init?.body ? { 'Content-Type': 'application/json' } : {}),
    ...init?.headers,
  };
  const response = await fetch(`${cleanServerUrl(syncConfig.serverUrl)}${path}`, {
    ...init,
    headers,
    credentials: 'include',
  });

  const payload = (await response.json().catch(() => ({}))) as T & {
    error?: string;
    message?: string;
  };

  if (!response.ok) {
    throw new Error(payload.message ?? payload.error ?? `Sync server returned ${response.status}.`);
  }

  return payload;
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

  await addPendingSyncOps(buildPageSyncOps({
    previousPage,
    page: normalizedPage,
    project,
    selectedParentPageId: syncConfig.selectedParentPageId,
  }));
  triggerQueueDelivery();

  return syncConfig.connected
    ? withSyncStatus(normalizedPage, 'saved')
    : withSyncStatus(normalizedPage, 'stale', 'Connect Notion to sync this page.');

}

function triggerQueueDelivery(): void {
  if (queueDeliveryPromise) return;
  if (queueDeliveryTimer) {
    clearTimeout(queueDeliveryTimer);
  }
  queueDeliveryTimer = setTimeout(() => {
    queueDeliveryTimer = undefined;
    runQueueDelivery();
  }, 0);
}

function runQueueDelivery(): void {
  if (queueDeliveryPromise || forcedQueueDeliveryPromise) return;
  queueDeliveryPromise = deliverPendingSyncOps({ force: false })
    .catch(() => {
      scheduleNextQueueDelivery(LOCAL_QUEUE_DELIVERY_DELAY_MS);
    })
    .finally(() => {
      queueDeliveryPromise = undefined;
    });
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
  const es = new EventSource(`${syncConfig.serverUrl}/sync/events`, { withCredentials: true });
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
        }
      : withSyncStatus(page, 'error', 'Notion sync failed. Will retry.');

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

  if (!syncConfig.connected || !page.notionPageId) {
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
  const syncedProject = await syncProject(updatedProject);
  const savedProject = syncedProject ?? updatedProject;
  await writeStorage({
    projects: projects
      .map((p) => (p.id === projectId ? savedProject : p))
      .sort(sortProjectsByUpdatedDesc),
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
  const { activePageIdsByProject, currentProjectId, pages, projects } = await readStorage();
  const nextActivePageIds = { ...activePageIdsByProject };
  const tempActivePageId = nextActivePageIds[tempProject.id];

  delete nextActivePageIds[tempProject.id];
  nextActivePageIds[realProject.id] =
    tempActivePageId === tempPage.id ? realPage.id : tempActivePageId;

  await writeStorage({
    activePageIdsByProject: nextActivePageIds,
    currentProjectId: currentProjectId === tempProject.id ? realProject.id : currentProjectId,
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
  const { activePageIdsByProject, currentProjectId, pages, projects } = await readStorage();
  const nextActivePageIds = { ...activePageIdsByProject };
  delete nextActivePageIds[tempProject.id];
  pendingTempPageSaves.delete(tempPage.id);

  await writeStorage({
    activePageIdsByProject: nextActivePageIds,
    currentProjectId: currentProjectId === tempProject.id ? previousProjectId : currentProjectId,
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
  if (options.force) {
    if (queueDeliveryTimer) {
      clearTimeout(queueDeliveryTimer);
      queueDeliveryTimer = undefined;
    }

    if (forcedQueueDeliveryPromise) {
      return forcedQueueDeliveryPromise;
    }

    forcedQueueDeliveryPromise = deliverPendingSyncOps({ force: true })
      .catch((error) => {
        scheduleNextQueueDelivery(LOCAL_QUEUE_DELIVERY_DELAY_MS);
        throw error;
      })
      .finally(() => {
        forcedQueueDeliveryPromise = undefined;
      });

    return forcedQueueDeliveryPromise;
  }

  triggerQueueDelivery();
}

async function deliverPendingSyncOps({ force }: { force: boolean }): Promise<void> {
  const { syncConfig } = await readStorage();
  if (!syncConfig.connected) return;

  const pending = await listPendingSyncOps();
  if (!pending.length) return;

  const compacted = compactPendingSyncOps(pending);
  if (compacted.length !== pending.length) {
    await replacePendingSyncOps(compacted);
  }

  const now = Date.now();
  const eligible = force
    ? compacted
    : compacted.filter((op) => now - Date.parse(op.createdAt) >= LOCAL_QUEUE_DELIVERY_DELAY_MS);

  if (!eligible.length) {
    scheduleNextQueueDelivery(msUntilOldestOpIsEligible(compacted, now));
    return;
  }

  const response = await requestServer<SyncEnqueueResponse>('/sync/push', {
    method: 'POST',
    body: JSON.stringify({ ops: eligible }),
  }, syncConfig);

  await removePendingSyncOps(eligible.map((op) => op.opId));
  await applyQueuedVersions(eligible, response);

  const remaining = await listPendingSyncOps();
  if (remaining.length) {
    scheduleNextQueueDelivery(msUntilOldestOpIsEligible(remaining));
  }
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

async function updateStoredSyncConfig(config: Partial<SyncConfig>): Promise<SyncConfig> {
  const { syncConfig } = await readStorage();
  const nextConfig = {
    ...syncConfig,
    ...config,
    serverUrl: config.serverUrl
      ? cleanServerUrl(config.serverUrl)
      : syncConfig.serverUrl,
  };

  await writeStorage({ syncConfig: nextConfig });
  return nextConfig;
}

export const notionClient = {
  flushPendingSyncOps,

  async listProjects(): Promise<Project[]> {
    await waitForStub();
    const { projects } = await readStorage();
    return projects
      .filter((project) => project.status !== 'archived')
      .sort(sortProjectsByUpdatedDesc);
  },

  async getCurrentProjectId(): Promise<string> {
    const { currentProjectId } = await readStorage();
    return currentProjectId;
  },

  async setCurrentProjectId(projectId: string): Promise<void> {
    const { projects } = await readStorage();

    if (!projects.some((project) => project.id === projectId && project.status !== 'archived')) {
      return;
    }

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
        const syncedProject = await syncProject(realProject);
        const savedProject = syncedProject ?? realProject;
        await replaceTempProject({
          tempPage: page,
          tempProject: project,
          realPage,
          realProject: savedProject,
        });
        const savedPage = await replayTempPageSave(page.id, realPage);
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

    const syncedProject = await syncProject(archivedProject);
    const savedProject = syncedProject ?? archivedProject;

    await writeStorage({
      currentProjectId: replacementProject?.id ?? '',
      projects: projects.map((storedProject) =>
        storedProject.id === projectId ? savedProject : storedProject,
      ),
      activePageIdsByProject: {
        ...activePageIdsByProject,
        ...(replacementProject && replacementPage
          ? { [replacementProject.id]: replacementPage.id }
        : {}),
      },
    });

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

  async getSyncConfig(): Promise<SyncConfig> {
    const { syncConfig } = await readStorage();
    return { ...syncConfig };
  },

  async updateSyncConfig(config: Partial<SyncConfig>): Promise<SyncConfig> {
    return updateStoredSyncConfig(config);
  },

  async refreshSyncSession(): Promise<SyncConfig> {
    const { syncConfig } = await readStorage();
    const session = await requestServer<SyncSessionResponse>(
      '/session',
      undefined,
      syncConfig,
    );

    const nextConfig = await updateStoredSyncConfig({
      authenticated: session.authenticated,
      userName: session.userName,
      userEmail: session.userEmail,
      connected: session.connected,
      workspaceId: session.workspaceId,
      workspaceName: session.workspaceName,
    });

    if (session.connected) {
      triggerQueueDelivery();
    }

    return nextConfig;
  },

  async validateNotionCache(): Promise<{ stalePageIds: string[]; aheadPageIds: string[] }> {
    const { pages, projects, syncConfig } = await readStorage();

    if (!syncConfig.connected) {
      return { stalePageIds: [], aheadPageIds: [] };
    }

    const knownVersions: Record<string, number> = {};
    for (const page of pages) {
      if (typeof page.knownSyncVersion === 'number') {
        knownVersions[page.id] = page.knownSyncVersion;
      }
    }

    const response = await requestServer<SyncValidationResponse>('/sync/validate', {
      method: 'POST',
      body: JSON.stringify({ pages, projects, knownVersions }),
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
    };
  },

  async reloadFromNotion(): Promise<{
    currentProjectId: string;
    pages: ProjectPage[];
    projects: Project[];
    syncConfig: SyncConfig;
  }> {
    const { currentProjectId, pages: localPages, projects: localProjects, syncConfig } = await readStorage();

    if (!syncConfig.connected) {
      throw new Error('Connect Notion before reloading from Notion.');
    }

    const validation = await this.validateNotionCache();
    if (!validation.stalePageIds.length && !validation.aheadPageIds.length) {
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
    const projects = response.projects.map(normalizeProject).sort(sortProjectsByUpdatedDesc);
    const pages = response.pages.map(normalizeStoredPage);
    const activePageIdsByProject = createCompatibleActivePageIds(
      projects,
      pages,
      response.activePageIdsByProject,
    );
    const nextCurrentProjectId = projects.some((project) => project.id === response.currentProjectId)
      ? response.currentProjectId ?? ''
      : projects[0]?.id ?? '';
    const nextSyncConfig = response.clearSelectedParentPage
      ? {
          ...syncConfig,
          selectedParentPageId: undefined,
          selectedParentPageTitle: undefined,
        }
      : syncConfig;

    await writeStorage({
      activePageIdsByProject,
      currentProjectId: nextCurrentProjectId,
      hasMigratedCapturesToPages: true,
      pages,
      projects,
      syncConfig: nextSyncConfig,
    });

    return {
      currentProjectId: nextCurrentProjectId,
      pages,
      projects,
      syncConfig: nextSyncConfig,
    };
  },

  async logoutSyncSession(): Promise<SyncConfig> {
    const { syncConfig } = await readStorage();

    await requestServer<{ connected: false }>('/auth/notion/logout', {
      method: 'POST',
      body: JSON.stringify({}),
    }, syncConfig).catch(() => undefined);

    return updateStoredSyncConfig({
      authenticated: false,
      userName: undefined,
      userEmail: undefined,
      connected: false,
      workspaceId: undefined,
      workspaceName: undefined,
      selectedDatabaseId: undefined,
      selectedDatabaseTitle: undefined,
      selectedDataSourceId: undefined,
    });
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

    const updatedPage = appendContent(page, createCapturedContent(payload));

    await writeStorage({
      pages: pages.map((storedPage) =>
        storedPage.id === updatedPage.id ? updatedPage : storedPage,
      ),
    });

    const syncedPage = await enqueuePageSync(updatedPage, project, page);
    await persistPage(syncedPage);
    return syncedPage;
  },

  async uploadMedia(blob: Blob, mimeType: string, filename: string): Promise<string> {
    const { syncConfig } = await readStorage();
    if (!syncConfig.connected) {
      throw new Error('Connect Notion before uploading media.');
    }

    const buf = await blob.arrayBuffer();
    const bytes = new Uint8Array(buf);
    // Build base64 in chunks to avoid call-stack limits on large media files.
    let binary = '';
    const chunkSize = 8192;
    for (let i = 0; i < bytes.length; i += chunkSize) {
      binary += String.fromCharCode(...bytes.subarray(i, i + chunkSize));
    }
    const dataBase64 = btoa(binary);

    const response = await requestServer<MediaUploadResponse>('/media/upload', {
      method: 'POST',
      body: JSON.stringify({ dataBase64, mimeType, filename }),
    });

    if (!response.fileUploadId) {
      throw new Error('The sync server did not return a Notion file upload id.');
    }

    return response.fileUploadId;
  },

  async refreshMediaUrl(fileUploadId: string): Promise<string> {
    if (!fileUploadId) {
      throw new Error('Missing Notion file upload id.');
    }

    const response = await requestServer<MediaRefreshResponse>('/media/refresh', {
      method: 'POST',
      body: JSON.stringify({ fileUploadId }),
    });

    if (!response.url) {
      throw new Error('The sync server did not return a media URL.');
    }

    return response.url;
  },
};
