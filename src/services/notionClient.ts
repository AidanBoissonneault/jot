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
import { encodeJotSource, JOT_SOURCE_ATTR } from '@/src/extensions/jotLink';
import type {
  CaptureSelectionPayload,
  SourceOpenPayload,
} from '@/src/types/messages';
import type {
  CreateNotionPageResponse,
  ListNotionPagesResponse,
  MediaUploadResponse,
  SyncEnqueueResponse,
  SyncPageResponse,
  SyncProjectResponse,
  SyncReloadResponse,
  SyncSessionResponse,
  SyncStatusResponse,
  SyncValidationResponse,
} from '@/src/types/sync';
import { markUnrecoverableTransientMedia } from '@/src/extensions/mediaContent';
import { normalizeJotBlockIds } from '@/src/extensions/jotBlockIds';
import { addPendingSync, listPendingSyncs, removePendingSync } from '@/src/services/syncQueue';

type JotStorage = {
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

const STORAGE_KEYS: Array<keyof JotStorage> = [
  'activePageIdsByProject',
  'captures',
  'currentProjectId',
  'hasMigratedCapturesToPages',
  'pages',
  'projects',
  'syncConfig',
];

const DEFAULT_SYNC_CONFIG: SyncConfig = {
  serverUrl: 'http://localhost:8787',
  authenticated: false,
  connected: false,
};

const defaultProjects: Project[] = [
  {
    id: 'project-jot',
    name: 'Jot',
    status: 'active',
    category: 'General',
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    stateContent: emptyDocument(),
    tags: ['jot'],
  },
];

const waitForStub = () => new Promise((resolve) => setTimeout(resolve, 80));
const pendingTempPageSaves = new Map<string, ProjectPage>();
const projectReconciliations = new Map<string, Promise<string>>();

function emptyDocument(): DocumentContent {
  return normalizeJotBlockIds({
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
    [JOT_SOURCE_ATTR]: encodeJotSource(sourcePayloadFromCapture(payload)),
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
        jotCaptureId: crypto.randomUUID(),
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
        jotCaptureId: crypto.randomUUID(),
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
  const existing = (await browser.storage.local.get(STORAGE_KEYS)) as JotStorage;
  if (Object.keys(existing).length > 0) {
    await idbSetMany(existing as Record<string, unknown>);
  }
  await idbSet('__idb_migrated__', true);
}

async function readStorage(): Promise<Required<JotStorage>> {
  await migrateStorageToIdb();
  const stored = (await idbGetMany(STORAGE_KEYS)) as JotStorage;

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
  ).map((page) => ({
    ...page,
    content: normalizeJotBlockIds(markUnrecoverableTransientMedia(page.content)),
    localRevision: page.localRevision ?? crypto.randomUUID(),
    status: page.status ?? 'active',
    syncState: page.syncState ?? 'saved',
  }));
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

async function writeStorage(storage: Partial<JotStorage>) {
  await idbSetMany(storage as Record<string, unknown>);
}

function appendContent(page: ProjectPage, content: DocumentContent[]): ProjectPage {
  const existingContent = page.content.content ?? [];

  return markPageDirty({
    ...page,
    content: normalizeJotBlockIds({
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

async function syncPushPage(page: ProjectPage, project: Project): Promise<ProjectPage> {
  const { syncConfig } = await readStorage();
  const normalizedPage = {
    ...page,
    content: normalizeJotBlockIds(page.content),
  };

  if (!syncConfig.connected) {
    return withSyncStatus(normalizedPage, 'stale', 'Connect Notion to sync this page.');
  }

  try {
    const response = await requestServer<SyncEnqueueResponse | SyncPageResponse>('/sync/push', {
      method: 'POST',
      body: JSON.stringify({
        page: normalizedPage,
        project,
        selectedParentPageId: syncConfig.selectedParentPageId,
        defaultParentTitle: project.name,
      }),
    }, syncConfig);

    if ('queued' in response && response.queued) {
      const savingPage = withSyncStatus(normalizedPage, 'saving', 'Syncing to Notion...');
      // Fire-and-forget — poll until the queue consumer finishes
      pollSyncStatus(page.id, project, syncConfig).catch(() => undefined);
      return savingPage;
    }

    // Fallback for non-queued response shape
    const syncResponse = response as SyncPageResponse;
    if (syncResponse.parentPage) {
      await updateStoredSyncConfig({
        selectedParentPageId: syncResponse.parentPage.id,
        selectedParentPageTitle: syncResponse.parentPage.title,
      });
    }

    return syncResponse.page
      ? {
          ...normalizedPage,
          ...syncResponse.page,
          syncMessage: syncResponse.message,
          syncState: syncResponse.status,
        }
      : withSyncStatus(normalizedPage, syncResponse.status, syncResponse.message);
  } catch (error) {
    // Network failure (TypeError) while connected — queue for replay on reconnect.
    if (error instanceof TypeError) {
      await addPendingSync(normalizedPage, project).catch(() => undefined);
    }

    return withSyncStatus(
      normalizedPage,
      'error',
      error instanceof Error ? error.message : 'Unable to sync this page.',
    );
  }
}

async function pollSyncStatus(pageId: string, project: Project, syncConfig: SyncConfig): Promise<void> {
  const MAX_POLLS = 10;
  const POLL_INTERVAL_MS = 3000;

  for (let i = 0; i < MAX_POLLS; i++) {
    await new Promise<void>((resolve) => setTimeout(resolve, POLL_INTERVAL_MS));

    try {
      const { syncConfig: currentConfig } = await readStorage();
      if (!currentConfig.connected) return;

      const status = await requestServer<SyncStatusResponse>(
        `/sync/status?pageId=${encodeURIComponent(pageId)}`,
        undefined,
        currentConfig,
      );

      if (status.status === 'synced') {
        const { pages } = await readStorage();
        const currentPage = pages.find((p) => p.id === pageId);
        if (!currentPage) return;

        await persistPage({
          ...currentPage,
          ...(status.notionBlockId ? { notionPageId: status.notionBlockId } : {}),
          syncState: 'saved',
          syncMessage: undefined,
        });
        return;
      }

      if (status.status === 'failed') {
        const { pages } = await readStorage();
        const currentPage = pages.find((p) => p.id === pageId);
        if (!currentPage) return;

        await persistPage(withSyncStatus(currentPage, 'error', 'Notion sync failed. Will retry.'));
        return;
      }
    } catch {
      // Ignore transient poll errors — try again next iteration
    }
  }

  // Max polls reached — mark stale so user knows sync is delayed
  const { pages } = await readStorage();
  const currentPage = pages.find((p) => p.id === pageId);
  if (currentPage?.syncState === 'saving') {
    await persistPage(withSyncStatus(currentPage, 'stale', 'Sync is taking longer than expected.')).catch(() => undefined);
  }
}

async function syncPullPage(page: ProjectPage): Promise<ProjectPage> {
  const { syncConfig } = await readStorage();

  if (!syncConfig.connected || !page.notionPageId) {
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

async function persistPage(page: ProjectPage) {
  const { pages } = await readStorage();

  await writeStorage({
    pages: pages.map((storedPage) =>
      storedPage.id === page.id ? page : storedPage,
    ),
  });
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

async function replayPendingSyncs(): Promise<void> {
  const ops = await listPendingSyncs();
  if (!ops.length) return;

  const { pages } = await readStorage();

  for (const op of ops) {
    const currentPage = pages.find((p) => p.id === op.id);

    if (!currentPage || currentPage.localRevision !== op.page.localRevision) {
      await removePendingSync(op.id).catch(() => undefined);
      continue;
    }

    try {
      const { projects } = await readStorage();
      const project = projects.find((p) => p.id === op.project.id);
      if (!project) {
        await removePendingSync(op.id).catch(() => undefined);
        continue;
      }

      const result = await syncPushPage(op.page, project);
      if (result.syncState !== 'error') {
        await persistPage(result);
      }
    } finally {
      await removePendingSync(op.id).catch(() => undefined);
    }
  }
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
    const project = projects.find((storedProject) => storedProject.id === projectId);

    if (!project || project.status === 'archived') {
      throw new Error('This project is no longer available.');
    }

    const updatedProject = touchProject(project, {
      name: name.trim() || 'Untitled Project',
    });

    const syncedProject = await syncProject(updatedProject);
    const savedProject = syncedProject ?? updatedProject;

    await writeStorage({
      projects: projects
        .map((storedProject) =>
          storedProject.id === projectId ? savedProject : storedProject,
        )
        .sort(sortProjectsByUpdatedDesc),
    });

    return savedProject;
  },

  async archiveProject(projectId: string): Promise<{ currentProjectId: string; project: Project }> {
    const { activePageIdsByProject, pages, projects } = await readStorage();
    const project = projects.find((storedProject) => storedProject.id === projectId);

    if (!project || project.status === 'archived') {
      throw new Error('This project is no longer available.');
    }

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
    const project = projects.find((storedProject) => storedProject.id === projectId);

    if (!project || project.status === 'archived') {
      throw new Error('This project is no longer available.');
    }

    const updatedProject = touchProject(project, {
      category: metadata.category?.trim() ?? project.category,
      stateContent: metadata.stateContent ?? project.stateContent,
    });

    const syncedProject = await syncProject(updatedProject);
    const savedProject = syncedProject ?? updatedProject;

    await writeStorage({
      projects: projects
        .map((storedProject) =>
          storedProject.id === projectId ? savedProject : storedProject,
        )
        .sort(sortProjectsByUpdatedDesc),
    });

    return savedProject;
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
      replayPendingSyncs().catch(() => undefined);
    }

    return nextConfig;
  },

  async validateNotionCache(): Promise<void> {
    const { pages, projects, syncConfig } = await readStorage();

    if (!syncConfig.connected) {
      return;
    }

    const response = await requestServer<SyncValidationResponse>('/sync/validate', {
      method: 'POST',
      body: JSON.stringify({ pages, projects }),
    }, syncConfig);
    const uncachedProjectIds = new Set(response.uncachedProjectIds ?? []);
    const uncachedPageIds = new Set(response.uncachedPageIds ?? []);

    if (!uncachedProjectIds.size && !uncachedPageIds.size && !response.clearSelectedParentPage) {
      return;
    }

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
      pages: pages.map((page) =>
        uncachedPageIds.has(page.id)
          ? uncachePageNotionMetadata(page)
          : page,
      ),
    });
  },

  async reloadFromNotion(): Promise<{
    currentProjectId: string;
    pages: ProjectPage[];
    projects: Project[];
    syncConfig: SyncConfig;
  }> {
    const { syncConfig } = await readStorage();

    if (!syncConfig.connected) {
      throw new Error('Connect Notion before reloading from Notion.');
    }

    const response = await requestServer<SyncReloadResponse>('/sync/reload', {
      method: 'POST',
      body: JSON.stringify({
        selectedParentPageId: syncConfig.selectedParentPageId,
      }),
    }, syncConfig);
    const projects = response.projects.map(normalizeProject).sort(sortProjectsByUpdatedDesc);
    const pages = response.pages.map((page) => ({
      ...page,
      content: normalizeJotBlockIds(markUnrecoverableTransientMedia(page.content)),
      localRevision: page.localRevision ?? crypto.randomUUID(),
      status: page.status ?? 'active',
      syncState: page.syncState ?? 'saved',
    }));
    const activePageIdsByProject = createCompatibleActivePageIds(
      projects,
      pages,
      response.activePageIdsByProject,
    );
    const currentProjectId = projects.some((project) => project.id === response.currentProjectId)
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
      currentProjectId,
      hasMigratedCapturesToPages: true,
      pages,
      projects,
      syncConfig: nextSyncConfig,
    });

    return {
      currentProjectId,
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

    const syncedPage = isTempPage(page) ? page : await syncPullPage(page);

    if (syncedPage !== page) {
      await persistPage(syncedPage);
    }

    return syncedPage;
  },

  async syncProjectPage(pageId: string): Promise<ProjectPage | undefined> {
    const { pages } = await readStorage();
    const page = pages.find((storedPage) => storedPage.id === pageId);

    if (!page || page.status === 'archived') {
      return undefined;
    }

    const syncedPage = isTempPage(page) ? page : await syncPullPage(page);

    if (syncedPage !== page) {
      await persistPage(syncedPage);
    }

    return syncedPage;
  },

  async prefetchProjectPages(projectId: string, excludePageId?: string): Promise<void> {
    const { pages } = await readStorage();
    const projectPages = pages.filter(
      (page) =>
        page.projectId === projectId &&
        page.status !== 'archived' &&
        page.id !== excludePageId &&
        !isTempPage(page),
    );

    for (const page of projectPages) {
      const syncedPage = await syncPullPage(page);

      if (syncedPage !== page) {
        await persistPage(syncedPage);
      }
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
        const syncedPage = await syncPushPage(realPage, realProject);

        if (syncedPage.syncState === 'error') {
          throw new Error(syncedPage.syncMessage ?? 'Unable to create this page.');
        }

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
    const { pages, projects } = await readStorage();
    const page = pages.find((storedPage) => storedPage.id === pageId);

    if (!page) {
      throw new Error('This page is no longer available.');
    }

    const project = projects.find((storedProject) => storedProject.id === page.projectId);

    if (!project) {
      throw new Error('This project is no longer available.');
    }

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

    const syncedPage = await syncPushPage(updatedPage, project);

    await writeStorage({
      pages: pages.map((storedPage) =>
        storedPage.id === syncedPage.id ? syncedPage : storedPage,
      ),
    });

    return syncedPage;
  },

  async archiveProjectPage(pageId: string): Promise<ProjectPage> {
    const { activePageIdsByProject, pages, projects } = await readStorage();
    const page = pages.find((storedPage) => storedPage.id === pageId);

    if (!page) {
      throw new Error('This page is no longer available.');
    }

    const project = projects.find((storedProject) => storedProject.id === page.projectId);

    if (!project) {
      throw new Error('This project is no longer available.');
    }

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
      const syncedArchivedPage = await syncPushPage(archivedPage, project);

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
      content: normalizeJotBlockIds(page.content),
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

    const syncedPage = await syncPushPage(updatedPage, project);
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
      throw new Error('No Jot page is available for this capture.');
    }

    const updatedPage = appendContent(page, createCapturedContent(payload));

    await writeStorage({
      pages: pages.map((storedPage) =>
        storedPage.id === updatedPage.id ? updatedPage : storedPage,
      ),
    });

    const syncedPage = await syncPushPage(updatedPage, project);
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
};
