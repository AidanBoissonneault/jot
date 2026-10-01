import { computed, ref } from 'vue';
import { defineStore } from 'pinia';
import { mergeSyncedMediaContent } from '@/src/extensions/mediaContent';
import {
  addSourceToProjectState,
  mergeVisibleProjectState,
} from '@/src/extensions/sourceRegistry';
import {
  notionClient,
  stripStoredSyncCredentials,
  connectSyncEvents,
  applySyncResult,
  clearStalePages,
  sourcePayloadFromCapture,
} from '@/src/services/notionClient';
import { onSyncQueueChange } from '@/src/services/syncQueue';
import { cleanSyncServerUrl } from '@/src/lib/syncServerUrl';
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
  InkwellRuntimeMessage,
  ProjectPageUpdatedMessage,
} from '@/src/types/messages';

type CaptureInsertHandler = (payload: CaptureSelectionPayload) => Promise<boolean>;
type SaveOptions = {
  preserveLocalContent?: boolean;
  title?: string;
};

export const useInkwellStore = defineStore('inkwell', () => {
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
  const pendingSyncCount = ref(0);
  const isOnline = ref(typeof navigator === 'undefined' || navigator.onLine !== false);
  const isRetryingLogoutCleanup = ref(false);
  let pullMessageTimer: number | undefined;
  const syncConfig = ref<SyncConfig>({
    serverUrl: 'http://localhost:8787',
    authenticated: false,
    connected: false,
  });
  let captureInsertHandler: CaptureInsertHandler | undefined;
  let isListeningForRuntimeMessages = false;
  let syncEventsSource: EventSource | undefined;
  let stopQueueListener: (() => void) | undefined;

  const currentProject = computed(() =>
    projects.value.find((project) => project.id === currentProjectId.value),
  );

  async function initialize() {
    isLoading.value = true;
    errorMessage.value = '';
    let reloadDiscoveredPagesAfterQueueDrain = false;

    try {
      syncConfig.value = await notionClient.getSyncConfig();
      isOnline.value = typeof navigator === 'undefined' || navigator.onLine !== false;
      stopQueueListener ??= onSyncQueueChange(() => {
        void refreshPendingSyncCount();
      });
      await refreshPendingSyncCount();

      if (isOnline.value) {
        syncConfig.value = await notionClient
          .refreshSyncSession()
          .catch(() => syncConfig.value);
      }

      const preparedLocalWorkspace = syncConfig.value.connected
        ? await notionClient.prepareLocalWorkspaceForFirstSync().catch(() => false)
        : false;
      const hydrated = isOnline.value && !preparedLocalWorkspace
        ? await hydrateInitialNotionSnapshot().catch(() => false)
        : false;

      if (!hydrated) {
        const validateResult = isOnline.value
          ? await notionClient.validateNotionCache().catch(() => ({
              stalePageIds: [],
              aheadPageIds: [],
              failedPageIds: [],
              newPageIds: [],
            }))
          : { stalePageIds: [], aheadPageIds: [], failedPageIds: [], newPageIds: [] };
        stalePageIds.value = validateResult.stalePageIds;
        aheadPageIds.value = validateResult.aheadPageIds;

        let refreshedForNewPages = false;
        if (validateResult.newPageIds.length) {
          pendingSyncCount.value = await notionClient.pendingSyncEventCount();
          if (pendingSyncCount.value === 0) {
            try {
              const reloaded = await notionClient.reloadFromNotion({ force: true });
              applyReloadedSnapshot(reloaded);
              stalePageIds.value = [];
              aheadPageIds.value = [];
              refreshedForNewPages = true;
            } catch (error) {
              errorMessage.value = error instanceof Error
                ? `Couldn't load new pages from Notion. ${error.message}`
                : "Couldn't load new pages from Notion.";
            }
          } else {
            // Keep the remote page discovery alive while queued local edits finish syncing.
            reloadDiscoveredPagesAfterQueueDrain = true;
          }
        }

        if (!refreshedForNewPages) {
          syncConfig.value = await notionClient.getSyncConfig();
          projects.value = await notionClient.listProjects();
          const storedProjectId = await notionClient.getCurrentProjectId();
          currentProjectId.value = projects.value.some(
            (project) => project.id === storedProjectId,
          )
            ? storedProjectId
            : projects.value[0]?.id ?? '';
        }
      }

      await loadCurrentPage();
      openSyncEvents();
      if (isOnline.value && syncConfig.value.connected && pendingSyncCount.value) {
        if (reloadDiscoveredPagesAfterQueueDrain) {
          void syncPendingChanges()
            .then(async () => {
              if (pendingSyncCount.value > 0) return;
              try {
                const reloaded = await notionClient.reloadFromNotion({ force: true });
                applyReloadedSnapshot(reloaded);
                stalePageIds.value = [];
                aheadPageIds.value = [];
                await loadCurrentPage();
              } catch (error) {
                errorMessage.value = error instanceof Error
                  ? `Couldn't load new pages from Notion. ${error.message}`
                  : "Couldn't load new pages from Notion.";
                saveStatus.value = 'error';
              }
            })
            .catch(() => undefined);
        } else {
          void syncPendingChanges().catch(() => undefined);
        }
      }
    } catch (error) {
      errorMessage.value =
        error instanceof Error ? error.message : 'Unable to load Inkwell data.';
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
      applyProjectOrPageSyncState(project, currentPage.value);
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
          : mergeVisibleProjectState(
              documentFromPlainText(metadata.stateText),
              currentProject.value?.stateContent,
            ),
      });
      projects.value = projects.value
        .map((storedProject) =>
          storedProject.id === project.id ? project : storedProject,
        )
        .sort(sortProjectsByUpdatedDesc);
      applyProjectOrPageSyncState(project, currentPage.value);
    } catch (error) {
      errorMessage.value =
        error instanceof Error ? error.message : 'Unable to update this project.';
      saveStatus.value = 'error';
    }
  }

  async function registerCurrentProjectSource(
    blockId: string,
    payload: CaptureSelectionPayload,
  ) {
    if (!currentProjectId.value || !blockId) {
      return;
    }

    const activeProject = currentProject.value;
    if (activeProject) {
      const optimisticProject = {
        ...activeProject,
        stateContent: addSourceToProjectState(
          activeProject.stateContent,
          blockId,
          sourcePayloadFromCapture(payload),
        ),
      };
      projects.value = projects.value.map((storedProject) =>
        storedProject.id === optimisticProject.id ? optimisticProject : storedProject,
      );
    }

    const project = await notionClient.addProjectSource(
      currentProjectId.value,
      blockId,
      payload,
    );
    projects.value = projects.value
      .map((storedProject) =>
        storedProject.id === project.id ? project : storedProject,
      )
      .sort(sortProjectsByUpdatedDesc);
    applyProjectOrPageSyncState(project, currentPage.value);
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
  ): Promise<boolean> {
    if (!currentPage.value) {
      return false;
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
        return true;
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
      await refreshPendingSyncCount().catch(() => undefined);
      return true;
    } catch (error) {
      errorMessage.value =
        error instanceof Error ? error.message : 'Unable to save this page.';
      saveStatus.value = 'error';
      return false;
    }
  }

  async function savePageContentSnapshot(
    page: ProjectPage,
    content: DocumentContent,
    options: SaveOptions = {},
  ): Promise<boolean> {
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
      await refreshPendingSyncCount().catch(() => undefined);
      return true;
    } catch (error) {
      if (currentPage.value?.id !== activePageId) {
        return false;
      }

      errorMessage.value =
        error instanceof Error ? error.message : 'Unable to save this page.';
      saveStatus.value = 'error';
      return false;
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

    browser.runtime.onMessage.addListener((message: InkwellRuntimeMessage) => {
      if (message?.type === 'inkwell.prepareConnectionDeletion') {
        void notionClient.prepareConnectionDeletion().catch(() => undefined);
        return false;
      }

      if (message?.type === 'inkwell.abortConnectionDeletion') {
        void notionClient.abortConnectionDeletion().catch(() => undefined);
        return false;
      }

      if (message?.type === 'inkwell.completeConnectionDeletion') {
        globalThis.setTimeout(() => window.location.reload(), 0);
        return false;
      }

      if (message?.type === 'inkwell.insertCaptureRequest') {
        return captureInsertHandler?.(message.payload) ?? false;
      }

      if (message?.type === 'inkwell.projectPageUpdated') {
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
    if (!syncConfig.value.connected || !isOnline.value) return;
    if (
      syncConfig.value.syncQueueOwnerUserId === null ||
      (syncConfig.value.syncQueueOwnerUserId &&
        syncConfig.value.syncQueueOwnerUserId !== syncConfig.value.userId)
    ) return;
    sseStatus.value = 'connecting';
    const es = connectSyncEvents(syncConfig.value, handleSyncEvent);
    es.onopen = () => { sseStatus.value = 'connected'; };
    es.onerror = () => { sseStatus.value = 'disconnected'; };
    syncEventsSource = es;
  }

  async function handleSyncEvent(event: SyncEventMessage) {
    if (event.status === 'stale') {
      const stalePage = await applySyncResult(event);
      if (stalePage) {
        pages.value = pages.value.map((p) => (p.id === stalePage.id ? stalePage : p));
        if (currentPage.value?.id === stalePage.id) {
          currentPage.value = mergePageSyncMetadata(currentPage.value, stalePage);
        }
      }

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

  async function assignUnmatchedPendingQueueToCurrentAccount() {
    try {
      syncConfig.value = await notionClient.assignUnmatchedPendingQueueToCurrentAccount();
      await syncPendingChanges();
    } catch (error) {
      errorMessage.value = error instanceof Error ? error.message : 'Unable to assign queued changes.';
      saveStatus.value = 'error';
      throw error;
    }
  }

  async function refreshSyncSession(allowSignedOut = false) {
    try {
      syncConfig.value = await notionClient.refreshSyncSession(allowSignedOut);
      if (syncConfig.value.connected) {
        const preparedLocalWorkspace = await notionClient.prepareLocalWorkspaceForFirstSync();
        if (!preparedLocalWorkspace && await hydrateInitialNotionSnapshot()) {
          await loadCurrentPage();
        }
        await syncPendingChanges();
      } else {
        saveStatus.value = 'stale';
      }
    } catch (error) {
      errorMessage.value =
        error instanceof Error ? error.message : 'Unable to reach the sync server.';
      saveStatus.value = 'error';
    }
  }

  async function refreshPendingSyncCount() {
    pendingSyncCount.value = await notionClient.pendingSyncEventCount();
  }

  async function syncPendingChanges() {
    if (!isOnline.value || !syncConfig.value.connected) {
      await refreshPendingSyncCount();
      return;
    }

    try {
      await notionClient.flushPendingSyncOps({ force: true });
      await refreshWorkspaceFromStorage();
    } finally {
      await refreshPendingSyncCount();
    }
  }

  async function resyncPendingChanges() {
    try {
      const result = await notionClient.resyncPendingChanges();
      await refreshWorkspaceFromStorage();
      return result;
    } finally {
      await refreshPendingSyncCount();
    }
  }

  async function refreshWorkspaceFromStorage() {
    projects.value = await notionClient.listProjects();
    const activePageId = currentPage.value?.id;
    await loadProjectPages();
    const refreshedPage = pages.value.find((page) => page.id === activePageId);
    if (!refreshedPage) return;

    currentPage.value = refreshedPage;
    if (currentProject.value) {
      applyProjectOrPageSyncState(currentProject.value, refreshedPage);
    } else {
      applyPageSyncState(refreshedPage);
    }
  }

  async function handleOnline() {
    isOnline.value = true;

    try {
      syncConfig.value = await notionClient.refreshSyncSession();
      if (syncConfig.value.connected) {
        await notionClient.prepareLocalWorkspaceForFirstSync();
        await syncPendingChanges();
        openSyncEvents();
      }
    } catch {
      isOnline.value = false;
    }
  }

  function handleOffline() {
    isOnline.value = false;
    syncEventsSource?.close();
    syncEventsSource = undefined;
    sseStatus.value = 'disconnected';
  }

  async function logout(): Promise<boolean> {
    syncConfig.value = stripStoredSyncCredentials({
      ...syncConfig.value,
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
    });
    syncEventsSource?.close();
    syncEventsSource = undefined;
    sseStatus.value = 'disconnected';

    let logoutResult: Awaited<ReturnType<typeof notionClient.logoutSyncSession>>;
    try {
      logoutResult = await notionClient.logoutSyncSession();
    } catch {
      errorMessage.value = 'Could not clear the local Inkwell connection state. Try logging out again.';
      saveStatus.value = 'error';
      return false;
    }

    syncConfig.value = {
      ...logoutResult.syncConfig,
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
    };
    saveStatus.value = 'stale';
    errorMessage.value = !logoutResult.serverDataCleanupComplete
      ? logoutResult.syncConfig.logoutCleanupPending
        ? 'You are signed out on this device, but server logout is still pending. Retry logout cleanup when the server is available.'
        : 'You are signed out on this device, but Inkwell could not confirm removal of all server credentials. Sign in again if you need to reconnect.'
      : !logoutResult.notionTokenRevoked
        ? 'You are signed out and Inkwell removed its stored credentials, but Notion did not confirm token revocation. Remove the Inkwell connection in Notion settings if it remains listed.'
        : '';

    return true;
  }

  async function retryLogoutCleanup(): Promise<boolean> {
    if (!syncConfig.value.logoutCleanupPending || isRetryingLogoutCleanup.value) return false;
    isRetryingLogoutCleanup.value = true;
    saveStatus.value = 'saving';
    errorMessage.value = '';
    try {
      const result = await notionClient.logoutSyncSession();
      syncConfig.value = {
        ...result.syncConfig,
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
      };
      saveStatus.value = 'stale';
      errorMessage.value = !result.serverDataCleanupComplete
        ? result.syncConfig.logoutCleanupPending
          ? 'Server logout is still pending. Keep your documents on this device and retry when online.'
          : 'Inkwell could not confirm removal of all server credentials. Sign in again if you need to reconnect.'
        : !result.notionTokenRevoked
          ? 'Inkwell removed its stored credentials, but Notion did not confirm token revocation. Remove the Inkwell connection in Notion settings if it remains listed.'
          : '';
      return result.serverDataCleanupComplete;
    } catch {
      errorMessage.value = 'Server logout is still pending. Retry logout cleanup when the server is available.';
      saveStatus.value = 'error';
      return false;
    } finally {
      isRetryingLogoutCleanup.value = false;
    }
  }

  async function deleteConnection(): Promise<{ notionTokenRevoked: boolean }> {
    syncEventsSource?.close();
    syncEventsSource = undefined;
    sseStatus.value = 'disconnected';
    isOnline.value = false;
    saveStatus.value = 'stale';
    errorMessage.value = '';

    try {
      const result = await notionClient.deleteConnection();
      syncConfig.value = await notionClient.getSyncConfig();
      projects.value = await notionClient.listProjects();
      currentProjectId.value = await notionClient.getCurrentProjectId();
      await loadCurrentPage();
      await refreshPendingSyncCount();
      notionParentPages.value = [];
      isOnline.value = typeof navigator === 'undefined' || navigator.onLine !== false;
      errorMessage.value = '';
      return result;
    } catch (error) {
      errorMessage.value = error instanceof Error
        ? error.message
        : 'Unable to delete the Inkwell connection.';
      saveStatus.value = 'error';
      throw error;
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
    const serverUrl = cleanSyncServerUrl(syncConfig.value.serverUrl);
    return `${serverUrl}/auth/notion/start`;
  }

  function applyPageSyncState(page: ProjectPage) {
    const project = currentProject.value;
    if (project?.syncState === 'error') {
      saveStatus.value = 'error';
      errorMessage.value = project.syncMessage ?? '';
      return;
    }

    saveStatus.value = page.syncState ?? 'saved';
    errorMessage.value =
      page.syncState === 'error' || page.syncState === 'stale'
        ? page.syncMessage ?? ''
        : '';
  }

  function applyProjectOrPageSyncState(project: Project, page?: ProjectPage) {
    const status = project.syncState === 'error'
      ? 'error'
      : page?.syncState ?? project.syncState ?? 'saved';
    saveStatus.value = status;
    errorMessage.value =
      status === 'error' || status === 'stale'
        ? project.syncState === 'error'
          ? project.syncMessage ?? ''
          : page?.syncMessage ?? project.syncMessage ?? ''
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
      const reloaded = await notionClient.reloadFromNotion({ force: true });
      applyReloadedSnapshot(reloaded);
      currentPage.value = pages.value[0];
      saveStatus.value = currentPage.value?.syncState ?? 'saved';
      errorMessage.value = '';
    } catch (error) {
      errorMessage.value =
        error instanceof Error ? error.message : 'Unable to reload Inkwell from Notion.';
      saveStatus.value = 'error';
    } finally {
      isLoading.value = false;
    }
  }

  async function hydrateInitialNotionSnapshot() {
    if (!syncConfig.value.connected || !await notionClient.needsInitialNotionHydration()) {
      return false;
    }

    const reloaded = await notionClient.reloadFromNotion({
      force: true,
      preserveLocalWhenRemoteEmpty: true,
    });
    applyReloadedSnapshot(reloaded);
    return true;
  }

  function applyReloadedSnapshot(reloaded: Awaited<ReturnType<typeof notionClient.reloadFromNotion>>) {
    syncConfig.value = reloaded.syncConfig;
    projects.value = reloaded.projects;
    currentProjectId.value = reloaded.currentProjectId;
    pages.value = reloaded.pages.filter(
      (page) => page.projectId === currentProjectId.value && page.status !== 'archived',
    );
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
      knownSyncVersion: syncedPage.knownSyncVersion ?? localPage.knownSyncVersion,
      serverSyncVersion: syncedPage.serverSyncVersion ?? localPage.serverSyncVersion,
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
    handleOffline,
    handleOnline,
    isOnline,
    isLoading,
    loadCurrentPage,
    loadProjectPages,
    loadNotionParentPages,
    logout,
    retryLogoutCleanup,
    isRetryingLogoutCleanup,
    notionParentPages,
    pages,
    pendingSyncCount,
    refreshWorkspaceFromStorage,
    projects,
    registerCaptureInsertHandler,
    registerCurrentProjectSource,
    renameCurrentProject,
    updateCurrentProjectMetadata,
    renameCurrentPage,
    reloadFromNotion,
    refreshSelectedPage,
    refreshSyncSession,
    deleteConnection,
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
    syncPendingChanges,
    assignUnmatchedPendingQueueToCurrentAccount,
    resyncPendingChanges,
    updateServerUrl,
    getSyncLoginUrl,
  };
});
