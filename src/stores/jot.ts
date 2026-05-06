import { computed, ref } from 'vue';
import { defineStore } from 'pinia';
import { notionClient } from '@/src/services/notionClient';
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
};

export const useJotStore = defineStore('jot', () => {
  const projects = ref<Project[]>([]);
  const pages = ref<ProjectPage[]>([]);
  const currentPage = ref<ProjectPage>();
  const currentProjectId = ref<string>('');
  const errorMessage = ref<string>('');
  const isLoading = ref(false);
  const saveStatus = ref<SaveStatus>('idle');
  const notionParentPages = ref<NotionParentPage[]>([]);
  const syncConfig = ref<SyncConfig>({
    serverUrl: 'http://localhost:8787',
    authenticated: false,
    connected: false,
  });
  let captureInsertHandler: CaptureInsertHandler | undefined;
  let isListeningForRuntimeMessages = false;

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
      projects.value = await notionClient.listProjects();
      const storedProjectId = await notionClient.getCurrentProjectId();
      currentProjectId.value = projects.value.some(
        (project) => project.id === storedProjectId,
      )
        ? storedProjectId
        : projects.value[0]?.id ?? '';
      await loadCurrentPage();
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
    saveStatus.value = 'saving';

    try {
      const project = await notionClient.createProject(name);
      projects.value = await notionClient.listProjects();
      currentProjectId.value = project.id;
      await loadCurrentPage();
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
      updatedAt: new Date().toISOString(),
      syncState: 'saving' as const,
    };
    currentPage.value = optimisticPage;

    try {
      const savedPage = await notionClient.updateProjectPage({
        ...optimisticPage,
        content,
      });

      if (currentPage.value?.id !== activePageId) {
        return;
      }

      currentPage.value = options.preserveLocalContent
        ? {
            ...savedPage,
            content: optimisticPage.content,
          }
        : savedPage;
      applyPageSyncState(savedPage);
    } catch (error) {
      errorMessage.value =
        error instanceof Error ? error.message : 'Unable to save this page.';
      saveStatus.value = 'error';
    }
  }

  async function createPage() {
    if (!currentProjectId.value) {
      return;
    }

    saveStatus.value = 'saving';

    try {
      currentPage.value = await notionClient.createProjectPage(
        currentProjectId.value,
        nextPageTitle(),
      );
      await loadProjectPages();
      applyPageSyncState(currentPage.value);
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

    currentPage.value = message.payload.page;
    void loadProjectPages();
    applyPageSyncState(message.payload.page);
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

  function nextPageTitle() {
    const nextNumber = pages.value.length + 1;
    return `Page ${nextNumber}`;
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
    renameCurrentPage,
    refreshSyncSession,
    saveCurrentPageContent,
    saveStatus,
    selectPage,
    selectNotionParentPage,
    selectProject,
    startRuntimeListener,
    syncConfig,
    updateServerUrl,
    getSyncLoginUrl,
  };
});
