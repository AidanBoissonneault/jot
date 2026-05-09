import { computed, ref } from 'vue';
import { defineStore } from 'pinia';
import { mergeSyncedMediaContent } from '@/src/extensions/mediaContent';
import { notionClient, connectSyncEvents, applySyncResult, clearStalePages } from '@/src/services/notionClient';
import type { SyncEventMessage } from '@/src/types/sync';
import type {
  DocumentContent,
  NotionParentPage,
  Project,
  ProjectPage,
  SaveStatus,
  SyncConfig,
} from '@/src/types/capture';
import type {
  CaptureSelectionPayload,
  JotRuntimeMessage,
  ProjectPageUpdatedMessage,
} from '@/src/types/messages';

type CaptureInsertHandler = (payload: CaptureSelectionPayload) => Promise<boolean>;
type SaveOptions = {
  preserveLocalContent?: boolean;
  title?: string;
};

export const useJotStore = defineStore('jot', () => {
  const projects = ref<Project[]>([]);
  const pages = ref<ProjectPage[]>([]);
  const currentPage = ref<ProjectPage>();
  const currentProjectId = ref<string>('');
  const errorMessage = ref<string>('');
  const isLoading = ref(false);
  const saveStatus = ref<SaveStatus>('idle');
  const sseStatus = ref<'disconnected' | 'connecting' | 'connected'>('disconnected');
  const stalePageIds = ref<string[]>([]);
  const aheadPageIds = ref<string[]>([]);
  const notionParentPages = ref<NotionParentPage[]>([]);
  const pullMessage = ref('');
  let pullMessageTimer: number | undefined;
  const syncConfig = ref<SyncConfig>({
    serverUrl: 'http://localhost:8787',
    authenticated: false,
    connected: false,
  });
  let captureInsertHandler: CaptureInsertHandler | undefined;
  let isListeningForRuntimeMessages = false;
  let syncEventsSource: EventSource | undefined;

  const currentProject = computed(() =>
    projects.value.find((project) => project.id === currentProjectId.value),
  );

  async function initialize() {
    isLoading.value = true;
    errorMessage.value = '';

    try {
      syncConfig.value = await notionClient.getSyncConfig();
      syncConfig.value = await notionClient
        .refreshSyncSession()
        .catch(() => syncConfig.value);
      const validateResult = await notionClient.validateNotionCache().catch(() => ({ stalePageIds: [], aheadPageIds: [] }));
      stalePageIds.value = validateResult.stalePageIds;
      aheadPageIds.value = validateResult.aheadPageIds;
      syncConfig.value = await notionClient.getSyncConfig();
      projects.value = await notionClient.listProjects();
      const storedProjectId = await notionClient.getCurrentProjectId();
      currentProjectId.value = projects.value.some(
        (project) => project.id === storedProjectId,
      )
        ? storedProjectId
        : projects.value[0]?.id ?? '';
      await loadCurrentPage();
      openSyncEvents();
    } catch (error) {
      errorMessage.value =
        error instanceof Error ? error.message : 'Unable to load Jot data.';
      saveStatus.value = 'error';
    } finally {
      isLoading.value = false;
    }
  }

  async function selectProject(projectId: string) {
    if (projectId === currentProjectId.value) {
      return;
    }

    currentProjectId.value = projectId;
    await notionClient.setCurrentProjectId(projectId);
    await loadCurrentPage();
  }

  async function createProject(name: string) {
    saveStatus.value = 'creating';

    try {
      const creation = await notionClient.createProject(name);
      projects.value = [...projects.value, creation.project];
      pages.value = [creation.page];
      currentProjectId.value = creation.project.id;
      currentPage.value = creation.page;
      applyProjectOrPageSyncState(creation.project, creation.page);

      void creation.settled.then(async ({ page, project }) => {
        const wasViewingProject = currentProjectId.value === creation.project.id;
        const wasViewingPage = currentPage.value?.id === creation.page.id;

        projects.value = await notionClient.listProjects();
        if (wasViewingProject) {
          currentProjectId.value = project.id;
        }

        if (currentProjectId.value === project.id) {
          await loadProjectPages();
        }

        if (wasViewingPage) {
          currentPage.value = page;
          applyPageSyncState(page);
        }
      }).catch(async (error) => {
        const message =
          error instanceof Error ? error.message : 'Unable to create this project.';
        projects.value = await notionClient.listProjects();
        const storedProjectId = await notionClient.getCurrentProjectId();
        currentProjectId.value = storedProjectId;
        await loadCurrentPage();
        errorMessage.value = message;
        saveStatus.value = 'error';
      });
    } catch (error) {
      errorMessage.value =
        error instanceof Error ? error.message : 'Unable to create this project.';
      saveStatus.value = 'error';
    }
  }

  async function renameCurrentProject(name: string) {
    if (!currentProjectId.value) {
      return;
    }

    saveStatus.value = 'saving';

    try {
      const project = await notionClient.renameProject(currentProjectId.value, name);
      projects.value = projects.value.map((storedProject) =>
        storedProject.id === project.id ? project : storedProject,
      );
      saveStatus.value = 'saved';
      errorMessage.value = '';
    } catch (error) {
      errorMessage.value =
        error instanceof Error ? error.message : 'Unable to rename this project.';
      saveStatus.value = 'error';
    }
  }

  async function updateCurrentProjectMetadata(metadata: {
    category?: string;
    stateText?: string;
  }) {
    if (!currentProjectId.value) {
      return;
    }

    saveStatus.value = 'saving';

    try {
      const project = await notionClient.updateProjectMetadata(currentProjectId.value, {
        category: metadata.category,
        stateContent: metadata.stateText === undefined
          ? undefined
          : documentFromPlainText(metadata.stateText),
      });
      projects.value = projects.value
        .map((storedProject) =>
          storedProject.id === project.id ? project : storedProject,
        )
        .sort(sortProjectsByUpdatedDesc);
      saveStatus.value = 'saved';
      errorMessage.value = '';
    } catch (error) {
      errorMessage.value =
        error instanceof Error ? error.message : 'Unable to update this project.';
      saveStatus.value = 'error';
    }
  }

  async function archiveCurrentProject() {
    if (!currentProjectId.value) {
      return;
    }

    saveStatus.value = 'saving';

    try {
      const result = await notionClient.archiveProject(currentProjectId.value);
      projects.value = await notionClient.listProjects();
      currentProjectId.value = result.currentProjectId;
      await loadCurrentPage();
    } catch (error) {
      errorMessage.value =
        error instanceof Error ? error.message : 'Unable to archive this project.';
      saveStatus.value = 'error';
    }
  }

  async function selectPage(pageId: string) {
    const page = await notionClient.setActiveProjectPage(pageId);

    if (!page) {
      return;
    }

    currentPage.value = page;
    await loadProjectPages();
    applyPageSyncState(page);
    void refreshSelectedPage(page.id);
  }

  async function loadCurrentPage() {
    if (!currentProjectId.value) {
      pages.value = [];
      currentPage.value = undefined;
      return;
    }

    await loadProjectPages();
    currentPage.value = await notionClient.getProjectPage(currentProjectId.value);
    if (currentPage.value) {
      applyPageSyncState(currentPage.value);
      void notionClient.prefetchProjectPages(
        currentProjectId.value,
        currentPage.value.id,
      );
    } else {
      saveStatus.value = 'idle';
    }
  }

  async function loadProjectPages() {
    if (!currentProjectId.value) {
      pages.value = [];
      return;
    }

    pages.value = await notionClient.listProjectPages(currentProjectId.value);
  }

  async function saveCurrentPageContent(
    content: DocumentContent,
    options: SaveOptions = {},
  ) {
    if (!currentPage.value) {
      return;
    }

    saveStatus.value = 'saving';
    const activePageId = currentPage.value.id;
    const optimisticPage = {
      ...currentPage.value,
      content,
      localRevision: crypto.randomUUID(),
      title: options.title ?? currentPage.value.title,
      updatedAt: new Date().toISOString(),
      syncState: 'saving' as const,
    };
    const optimisticRevision = optimisticPage.localRevision;
    currentPage.value = optimisticPage;

    try {
      const savedPage = await notionClient.updateProjectPage({
        ...optimisticPage,
        content,
      });

      if (currentPage.value?.id !== activePageId) {
        return;
      }

      const currentRevision = currentPage.value.localRevision;
      const nextPage = currentRevision === optimisticRevision
        ? mergeSavedPage(optimisticPage, savedPage, options)
        : mergePageSyncMetadata(currentPage.value, savedPage);

      currentPage.value = nextPage;
      pages.value = pages.value.map((storedPage) =>
        storedPage.id === activePageId ? nextPage : storedPage,
      );
      applyPageSyncState(nextPage);
    } catch (error) {
      errorMessage.value =
        error instanceof Error ? error.message : 'Unable to save this page.';
      saveStatus.value = 'error';
    }
  }

  async function savePageContentSnapshot(
    page: ProjectPage,
    content: DocumentContent,
    options: SaveOptions = {},
  ) {
    const activePageId = page.id;
    const optimisticPage = {
      ...page,
      content,
      localRevision: crypto.randomUUID(),
      title: options.title ?? page.title,
      updatedAt: new Date().toISOString(),
      syncState: 'saving' as const,
    };
    const optimisticRevision = optimisticPage.localRevision;

    pages.value = pages.value.map((storedPage) =>
      storedPage.id === activePageId ? optimisticPage : storedPage,
    );

    if (currentPage.value?.id === activePageId) {
      currentPage.value = optimisticPage;
      saveStatus.value = 'saving';
    }

    try {
      const savedPage = await notionClient.updateProjectPage(optimisticPage);
      const storedPage = pages.value.find((page) => page.id === activePageId);
      const nextPage = storedPage?.localRevision === optimisticRevision
        ? mergeSavedPage(optimisticPage, savedPage, options)
        : storedPage
          ? mergePageSyncMetadata(storedPage, savedPage)
          : mergeSavedPage(optimisticPage, savedPage, options);

      pages.value = pages.value.map((storedPage) =>
        storedPage.id === activePageId ? nextPage : storedPage,
      );

      if (currentPage.value?.id === activePageId) {
        currentPage.value = nextPage;
        applyPageSyncState(nextPage);
      }
    } catch (error) {
      if (currentPage.value?.id !== activePageId) {
        return;
      }

      errorMessage.value =
        error instanceof Error ? error.message : 'Unable to save this page.';
      saveStatus.value = 'error';
    }
  }

  async function createPage() {
    if (!currentProjectId.value) {
      return;
    }

    saveStatus.value = 'creating';

    try {
      const creation = await notionClient.createProjectPage(
        currentProjectId.value,
        nextPageTitle(),
      );
      currentPage.value = creation.page;
      pages.value = [...pages.value, creation.page];
      applyPageSyncState(creation.page);

      void creation.settled.then(async (page) => {
        const wasViewingPage = currentPage.value?.id === creation.page.id;
        await loadProjectPages();

        if (wasViewingPage) {
          currentPage.value = page;
          applyPageSyncState(page);
        }
      }).catch(async (error) => {
        const message =
          error instanceof Error ? error.message : 'Unable to create this page.';
        await loadCurrentPage();
        errorMessage.value = message;
        saveStatus.value = 'error';
      });
    } catch (error) {
      errorMessage.value =
        error instanceof Error ? error.message : 'Unable to create this page.';
      saveStatus.value = 'error';
    }
  }

  async function renameCurrentPage(title: string) {
    if (!currentPage.value) {
      return;
    }

    saveStatus.value = 'saving';

    try {
      currentPage.value = await notionClient.renameProjectPage(
        currentPage.value.id,
        title,
      );
      await loadProjectPages();
      applyPageSyncState(currentPage.value);
    } catch (error) {
      errorMessage.value =
        error instanceof Error ? error.message : 'Unable to rename this page.';
      saveStatus.value = 'error';
    }
  }

  async function archiveCurrentPage() {
    if (!currentPage.value) {
      return;
    }

    saveStatus.value = 'saving';

    try {
      currentPage.value = await notionClient.archiveProjectPage(currentPage.value.id);
      await loadProjectPages();
      applyPageSyncState(currentPage.value);
    } catch (error) {
      errorMessage.value =
        error instanceof Error ? error.message : 'Unable to archive this page.';
      saveStatus.value = 'error';
    }
  }

  function registerCaptureInsertHandler(handler: CaptureInsertHandler) {
    captureInsertHandler = handler;
  }

  function startRuntimeListener() {
    if (isListeningForRuntimeMessages) {
      return;
    }

    browser.runtime.onMessage.addListener((message: JotRuntimeMessage) => {
      if (message?.type === 'jot.insertCaptureRequest') {
        return captureInsertHandler?.(message.payload) ?? false;
      }

      if (message?.type === 'jot.projectPageUpdated') {
        handleProjectPageUpdated(message);
      }

      return false;
    });

    isListeningForRuntimeMessages = true;
  }

  function handleProjectPageUpdated(message: ProjectPageUpdatedMessage) {
    if (message.payload.page.projectId !== currentProjectId.value) {
      return;
    }

    const updatedPage = message.payload.page;
    const existingPage = pages.value.find((page) => page.id === updatedPage.id);
    const nextPage = existingPage && isNewerLocalPage(existingPage, updatedPage)
      ? mergePageSyncMetadata(existingPage, updatedPage)
      : updatedPage;

    pages.value = pages.value.map((page) =>
      page.id === updatedPage.id ? nextPage : page,
    );

    if (currentPage.value?.id === updatedPage.id) {
      currentPage.value = isNewerLocalPage(currentPage.value, updatedPage)
        ? mergePageSyncMetadata(currentPage.value, updatedPage)
        : nextPage;
    }

    void loadProjectPages();
    applyPageSyncState(currentPage.value?.id === updatedPage.id ? currentPage.value : nextPage);
  }

  function openSyncEvents() {
    syncEventsSource?.close();
    sseStatus.value = 'disconnected';
    if (!syncConfig.value.connected) return;
    sseStatus.value = 'connecting';
    const es = connectSyncEvents(syncConfig.value, handleSyncEvent);
    es.onopen = () => { sseStatus.value = 'connected'; };
    es.onerror = () => { sseStatus.value = 'disconnected'; };
    syncEventsSource = es;
  }

  async function handleSyncEvent(event: SyncEventMessage) {
    if (event.status === 'stale') {
      if (event.pageId === currentPage.value?.id) {
        await refreshSelectedPage(event.pageId);
        if (currentPage.value?.syncState === 'saved') {
          stalePageIds.value = stalePageIds.value.filter((id) => id !== event.pageId);
          await clearStalePages([event.pageId]);
          clearTimeout(pullMessageTimer);
          pullMessage.value = 'Updated from Notion';
          pullMessageTimer = window.setTimeout(() => { pullMessage.value = ''; }, 5000);
        } else if (!stalePageIds.value.includes(event.pageId)) {
          stalePageIds.value = [...stalePageIds.value, event.pageId];
        }
      } else if (!stalePageIds.value.includes(event.pageId)) {
        stalePageIds.value = [...stalePageIds.value, event.pageId];
      }
      return;
    }

    const updated = await applySyncResult(event);
    if (!updated) return;

    pages.value = pages.value.map((p) => (p.id === updated.id ? updated : p));

    if (currentPage.value?.id === updated.id) {
      currentPage.value = updated;
    }

    applyPageSyncState(updated);
  }

  async function confirmReloadPage(pageId: string) {
    const refreshed = await notionClient.syncProjectPage(pageId);

    stalePageIds.value = stalePageIds.value.filter((id) => id !== pageId);
    aheadPageIds.value = aheadPageIds.value.filter((id) => id !== pageId);
    await clearStalePages([pageId]);

    if (refreshed) {
      pages.value = pages.value.map((p) => (p.id === pageId ? refreshed : p));
      if (currentPage.value?.id === pageId) {
        currentPage.value = refreshed;
        applyPageSyncState(refreshed);
      }
    }
  }

  function dismissStalePage(pageId: string) {
    stalePageIds.value = stalePageIds.value.filter((id) => id !== pageId);
    aheadPageIds.value = aheadPageIds.value.filter((id) => id !== pageId);
  }

  async function updateServerUrl(serverUrl: string) {
    syncConfig.value = await notionClient.updateSyncConfig({ serverUrl });
  }

  async function refreshSyncSession() {
    try {
      syncConfig.value = await notionClient.refreshSyncSession();
      if (!syncConfig.value.connected) {
        saveStatus.value = 'stale';
      }
    } catch (error) {
      errorMessage.value =
        error instanceof Error ? error.message : 'Unable to reach the sync server.';
      saveStatus.value = 'error';
    }
  }

  async function logout() {
    syncConfig.value = {
      ...syncConfig.value,
      authenticated: false,
      userName: undefined,
      userEmail: undefined,
      connected: false,
      workspaceId: undefined,
      workspaceName: undefined,
      selectedDatabaseId: undefined,
      selectedDatabaseTitle: undefined,
      selectedDataSourceId: undefined,
    };
    saveStatus.value = 'stale';
    errorMessage.value = '';
    syncEventsSource?.close();
    syncEventsSource = undefined;
    sseStatus.value = 'disconnected';

    try {
      await notionClient.logoutSyncSession();
    } catch {
      // best-effort
    }
  }

  async function loadNotionParentPages(query = '') {
    try {
      notionParentPages.value = await notionClient.listNotionParentPages(query);
    } catch (error) {
      errorMessage.value =
        error instanceof Error ? error.message : 'Unable to load Notion pages.';
      saveStatus.value = 'error';
    }
  }

  async function createNotionParentPage(title: string) {
    try {
      const parentPage = await notionClient.createNotionParentPage(title);
      notionParentPages.value = [
        parentPage,
        ...notionParentPages.value.filter((page) => page.id !== parentPage.id),
      ];
      syncConfig.value = await notionClient.selectNotionParentPage(
        parentPage.id,
        parentPage.title,
      );

      if (currentPage.value) {
        await saveCurrentPageContent(currentPage.value.content);
      }
    } catch (error) {
      errorMessage.value =
        error instanceof Error ? error.message : 'Unable to create a Notion parent page.';
      saveStatus.value = 'error';
    }
  }

  async function selectNotionParentPage(pageId: string) {
    const parentPage = notionParentPages.value.find((page) => page.id === pageId);
    syncConfig.value = await notionClient.selectNotionParentPage(
      pageId,
      parentPage?.title,
    );

    if (currentPage.value) {
      await saveCurrentPageContent(currentPage.value.content);
    }
  }

  function getSyncLoginUrl() {
    const serverUrl = syncConfig.value.serverUrl.replace(/\/+$/, '');
    return `${serverUrl}/auth/notion/start`;
  }

  function applyPageSyncState(page: ProjectPage) {
    saveStatus.value = page.syncState ?? 'saved';
    errorMessage.value =
      page.syncState === 'error' || page.syncState === 'stale'
        ? page.syncMessage ?? ''
        : '';
  }

  function applyProjectOrPageSyncState(project: Project, page?: ProjectPage) {
    const status = page?.syncState ?? project.syncState ?? 'saved';
    saveStatus.value = status;
    errorMessage.value =
      status === 'error' || status === 'stale'
        ? page?.syncMessage ?? project.syncMessage ?? ''
        : '';
  }

  async function refreshSelectedPage(pageId: string) {
    const startingRevision = currentPage.value?.id === pageId
      ? currentPage.value.localRevision
      : undefined;
    const syncedPage = await notionClient.syncProjectPage(pageId);

    if (!syncedPage || currentPage.value?.id !== pageId) {
      return;
    }

    currentPage.value = currentPage.value.localRevision === startingRevision
      ? syncedPage
      : mergePageSyncMetadata(currentPage.value, syncedPage);
    await loadProjectPages();
    pages.value = pages.value.map((page) =>
      page.id === pageId ? currentPage.value ?? page : page,
    );
    applyPageSyncState(currentPage.value);
  }

  async function reloadFromNotion() {
    isLoading.value = true;
    saveStatus.value = 'saving';
    errorMessage.value = '';

    try {
      const reloaded = await notionClient.reloadFromNotion();
      syncConfig.value = reloaded.syncConfig;
      projects.value = reloaded.projects;
      currentProjectId.value = reloaded.currentProjectId;
      pages.value = reloaded.pages.filter(
        (page) => page.projectId === currentProjectId.value && page.status !== 'archived',
      );
      currentPage.value = pages.value[0];
      saveStatus.value = currentPage.value?.syncState ?? 'saved';
      errorMessage.value = '';
    } catch (error) {
      errorMessage.value =
        error instanceof Error ? error.message : 'Unable to reload Jot from Notion.';
      saveStatus.value = 'error';
    } finally {
      isLoading.value = false;
    }
  }

  function mergeSavedPage(
    localPage: ProjectPage,
    savedPage: ProjectPage,
    options: SaveOptions,
  ): ProjectPage {
    return options.preserveLocalContent
      ? {
          ...savedPage,
          content: mergeSyncedMediaContent(localPage.content, savedPage.content),
          title: localPage.title,
          localRevision: savedPage.localRevision ?? localPage.localRevision,
        }
      : savedPage;
  }

  function mergePageSyncMetadata(localPage: ProjectPage, syncedPage: ProjectPage): ProjectPage {
    return {
      ...localPage,
      notionPageId: syncedPage.notionPageId ?? localPage.notionPageId,
      notionDatabaseId: syncedPage.notionDatabaseId ?? localPage.notionDatabaseId,
      notionDataSourceId: syncedPage.notionDataSourceId ?? localPage.notionDataSourceId,
      notionParentPageId: syncedPage.notionParentPageId ?? localPage.notionParentPageId,
      notionLastEditedTime: syncedPage.notionLastEditedTime ?? localPage.notionLastEditedTime,
      remoteRevision: syncedPage.remoteRevision ?? localPage.remoteRevision,
      syncMessage: syncedPage.syncMessage,
      syncState: syncedPage.syncState ?? localPage.syncState,
      updatedAt: syncedPage.updatedAt ?? localPage.updatedAt,
      content: mergeSyncedMediaContent(localPage.content, syncedPage.content),
    };
  }

  function isNewerLocalPage(localPage: ProjectPage, incomingPage: ProjectPage) {
    return Boolean(
      localPage.localRevision &&
      incomingPage.localRevision &&
      localPage.localRevision !== incomingPage.localRevision,
    );
  }

  function nextPageTitle() {
    const nextNumber = pages.value.length + 1;
    return `Page ${nextNumber}`;
  }

  function documentFromPlainText(text: string): DocumentContent {
    const lines = text.split(/\r?\n/);
    return {
      type: 'doc',
      content: lines.length
        ? lines.map((line) => ({
            type: 'paragraph',
            ...(line
              ? { content: [{ type: 'text', text: line }] }
              : {}),
          }))
        : [{ type: 'paragraph' }],
    };
  }

  function sortProjectsByUpdatedDesc(first: Project, second: Project) {
    return new Date(second.updatedAt).getTime() - new Date(first.updatedAt).getTime();
  }

  return {
    archiveCurrentProject,
    archiveCurrentPage,
    createProject,
    createPage,
    currentPage,
    currentProject,
    currentProjectId,
    createNotionParentPage,
    errorMessage,
    initialize,
    isLoading,
    loadCurrentPage,
    loadProjectPages,
    loadNotionParentPages,
    logout,
    notionParentPages,
    pages,
    projects,
    registerCaptureInsertHandler,
    renameCurrentProject,
    updateCurrentProjectMetadata,
    renameCurrentPage,
    reloadFromNotion,
    refreshSelectedPage,
    refreshSyncSession,
    savePageContentSnapshot,
    saveCurrentPageContent,
    pullMessage,
    saveStatus,
    sseStatus,
    stalePageIds,
    aheadPageIds,
    confirmReloadPage,
    dismissStalePage,
    selectPage,
    selectNotionParentPage,
    selectProject,
    startRuntimeListener,
    syncConfig,
    updateServerUrl,
    getSyncLoginUrl,
  };
});
