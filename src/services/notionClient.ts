import type {
  Capture,
  DocumentContent,
  NotionParentPage,
  Project,
  ProjectPage,
  SaveStatus,
  SyncConfig,
} from '@/src/types/capture';
import { encodeJotSource, JOT_SOURCE_ATTR } from '@/src/extensions/jotLink';
import type {
  CaptureSelectionPayload,
  SourceOpenPayload,
} from '@/src/types/messages';

type JotStorage = {
  activePageIdsByProject?: Record<string, string>;
  captures?: Capture[];
  currentProjectId?: string;
  hasMigratedCapturesToPages?: boolean;
  pages?: ProjectPage[];
  projects?: Project[];
  syncConfig?: SyncConfig;
};

type SyncSessionResponse = {
  authenticated?: boolean;
  userName?: string;
  userEmail?: string;
  connected: boolean;
  workspaceId?: string;
  workspaceName?: string;
};

type SyncPageResponse = {
  message?: string;
  page?: ProjectPage;
  parentPage?: NotionParentPage;
  status: Exclude<SaveStatus, 'idle' | 'saving'>;
};

type SyncProjectResponse = {
  message?: string;
  parentPage?: NotionParentPage;
  status: Exclude<SaveStatus, 'idle' | 'saving'>;
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
    tags: ['jot'],
  },
];

const waitForStub = () => new Promise((resolve) => setTimeout(resolve, 80));
const pendingTempPageSaves = new Map<string, ProjectPage>();
const projectReconciliations = new Map<string, Promise<string>>();

function emptyDocument(): DocumentContent {
  return {
    type: 'doc',
    content: [
      {
        type: 'paragraph',
      },
    ],
  };
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
  return {
    id,
    name: name.trim() || 'Untitled Project',
    status: 'active',
    tags: [],
    syncState: 'saved',
  };
}

async function readStorage(): Promise<Required<JotStorage>> {
  const stored = (await browser.storage.local.get(STORAGE_KEYS)) as JotStorage;

  const storedProjects = stored.projects?.length ? stored.projects : defaultProjects;
  const projects = (isLegacyStubProjectSet(storedProjects)
    ? defaultProjects
    : storedProjects
  ).map((project) => ({
    ...project,
    syncState: project.syncState ?? 'saved',
  }));
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
    await browser.storage.local.set({
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
  await browser.storage.local.set(storage);
}

function appendContent(page: ProjectPage, content: DocumentContent[]): ProjectPage {
  const existingContent = page.content.content ?? [];

  return markPageDirty({
    ...page,
    content: {
      ...page.content,
      type: 'doc',
      content: [...existingContent, ...content],
    },
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

async function syncProject(project: Project): Promise<void> {
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
      selectedParentPageId: response.parentPage.parentPageId,
      selectedParentPageTitle: response.parentPage.parentPageId
        ? syncConfig.selectedParentPageTitle
        : undefined,
    });
  }

  if (response.status === 'error') {
    throw new Error(response.message ?? 'Unable to sync this project.');
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
    message?: string;
  };

  if (!response.ok) {
    throw new Error(payload.message ?? `Sync server returned ${response.status}.`);
  }

  return payload;
}

async function syncPushPage(page: ProjectPage, project: Project): Promise<ProjectPage> {
  const { syncConfig } = await readStorage();

  if (!syncConfig.connected) {
    return withSyncStatus(page, 'stale', 'Connect Notion to sync this page.');
  }

  try {
    const response = await requestServer<SyncPageResponse>('/sync/push', {
      method: 'POST',
      body: JSON.stringify({
        page,
        project,
        selectedParentPageId: syncConfig.selectedParentPageId,
        defaultParentTitle: project.name,
      }),
    }, syncConfig);

    if (response.parentPage) {
      await updateStoredSyncConfig({
        selectedParentPageId: response.parentPage.parentPageId,
        selectedParentPageTitle: response.parentPage.parentPageId
          ? syncConfig.selectedParentPageTitle
          : undefined,
      });
    }

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
      error instanceof Error ? error.message : 'Unable to sync this page.',
    );
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
    projects: projects.map((project) =>
      project.id === tempProject.id ? realProject : project,
    ),
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
          ? { ...project, syncState: 'error', syncMessage: message }
          : project,
      ),
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
    return projects.filter((project) => project.status !== 'archived');
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
      projects: [...projects, project],
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
        await syncProject(realProject);
        await replaceTempProject({
          tempPage: page,
          tempProject: project,
          realPage,
          realProject,
        });
        const savedPage = await replayTempPageSave(page.id, realPage);
        return { page: savedPage, project: realProject };
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

    const updatedProject = {
      ...project,
      name: name.trim() || 'Untitled Project',
    };

    await syncProject(updatedProject);

    await writeStorage({
      projects: projects.map((storedProject) =>
        storedProject.id === projectId ? updatedProject : storedProject,
      ),
    });

    return updatedProject;
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

    const archivedProject = {
      ...project,
      status: 'archived' as const,
    };
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

    await syncProject(archivedProject);

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

    return {
      currentProjectId: replacementProject?.id ?? '',
      project: archivedProject,
    };
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

    return updateStoredSyncConfig({
      authenticated: session.authenticated,
      userName: session.userName,
      userEmail: session.userEmail,
      connected: session.connected,
      workspaceId: session.workspaceId,
      workspaceName: session.workspaceName,
    });
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
    const response = await requestServer<{ pages: NotionParentPage[] }>(
      `/notion/pages${search}`,
    );
    return response.pages;
  },

  async createNotionParentPage(title: string): Promise<NotionParentPage> {
    const response = await requestServer<{ page: NotionParentPage }>('/notion/pages', {
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
    const { activePageIdsByProject, pages } = await readStorage();
    const page = pages.find((storedPage) => storedPage.id === pageId);

    if (!page) {
      throw new Error('This page is no longer available.');
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

    return replacementPage;
  },

  async updateProjectPage(page: ProjectPage): Promise<ProjectPage> {
    const { pages, projects } = await readStorage();
    const project = projects.find((storedProject) => storedProject.id === page.projectId);

    if (!project) {
      throw new Error('This project is no longer available.');
    }

    const updatedPage = markPageDirty(page);

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
};
