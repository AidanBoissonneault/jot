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
import type { SyncEventMessage, SyncProgressUpdate } from '@/src/types/sync';
import type {
  DocumentContent,
  NotionParentPage,
  Project,
  ProjectPage,
  SaveStatus,
  SyncConfig,
  Workspace,
} from '@/src/types/capture';
import type {
  CaptureSelectionPayload,
  JottathingRuntimeMessage,
  ProjectPageUpdatedMessage,
} from '@/src/types/messages';

type CaptureInsertHandler = (payload: CaptureSelectionPayload) => Promise<boolean>;
type SaveOptions = {
  preserveLocalContent?: boolean;
  title?: string;
};

export const useJottathingStore = defineStore('jottathing', () => {
  const projects = ref<Project[]>([]);
  const pages = ref<ProjectPage[]>([]);
  const currentPage = ref<ProjectPage>();
  const currentProjectId = ref<string>('');
  const currentWorkspaceId = ref<string>('');
  const workspaces = ref<Workspace[]>([]);
  const workspaceMenuProjects = ref<Project[]>([]);
  const workspaceMenuPagesByProject = ref<Record<string, ProjectPage[]>>({});
  const workspaceMenuPageLoads = ref<string[]>([]);
  const errorMessage = ref<string>('');
  const isLoading = ref(true);
  const isCheckingSync = ref(false);
  const syncCheckError = ref('');
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
  let initializationPromise: Promise<void> | undefined;
  let notionParentPageRequestId = 0;
  let projectPagesRequestId = 0;
  const isLoadingNotionParentPages = ref(false);
  const syncConfig = ref<SyncConfig>({
    serverUrl: 'http://localhost:8787',
    authenticated: false,
    connected: false,
  });
  let captureInsertHandler: CaptureInsertHandler | undefined;
  const pendingPageCreations = new Map<string, ProjectPage>();
  let isListeningForRuntimeMessages = false;
  let syncEventsSource: EventSource | undefined;
  let stopQueueListener: (() => void) | undefined;
  let remoteReloadPending = false;
  let remoteReloadInFlight: Promise<boolean> | undefined;
  let remoteReloadRetryAfter = 0;
  let remoteReloadFailureAccountKey = '';
  let workspaceMenuAccountKey = '';

  const currentProject = computed(() =>
    projects.value.find((project) => project.id === currentProjectId.value),
  );
  const currentWorkspace = computed(() =>
    workspaces.value.find((workspace) => workspace.id === currentWorkspaceId.value),
  );

  function getWorkspaceMenuAccountKey() {
    return `${syncConfig.value.userId ?? ''}::${syncConfig.value.workspaceId ?? ''}::${Boolean(syncConfig.value.authenticated)}`;
  }

  function createWelcomeGuideContent(): DocumentContent {
    const heading = (level: number, text: string): DocumentContent => ({
      type: 'heading',
      attrs: { level },
      content: [{ type: 'text', text }],
    });
    const paragraph = (text: string): DocumentContent => ({
      type: 'paragraph',
      content: [{ type: 'text', text }],
    });

    return {
      type: 'doc',
      content: [
        heading(1, 'Welcome to Jottathing'),
        paragraph('Turn useful web context into notes you can edit, organize, and sync with Notion.'),
        heading(2, 'Capture from the web'),
        paragraph('Select text on a webpage and send it to Jottathing. The note keeps its source link so you can return to the original.'),
        heading(2, 'Organize your notes'),
        paragraph('Use projects for separate topics and pages for related notes. Add a project in this Notion workspace whenever you need another space.'),
        heading(2, 'Write and edit'),
        paragraph('Format notes with headings, lists, links, images, and audio. Your synced notes remain available locally when you are offline.'),
        heading(2, 'Try it out'),
        paragraph('Capture a highlight from a page, or add a project and start writing. Changes in this workspace sync to Notion when you are online.'),
      ],
    };
  }

  async function refreshWorkspaceMenuTree() {
    const requestAccountKey = getWorkspaceMenuAccountKey();
    const [nextWorkspaces, nextProjects, nextWorkspaceId] = await Promise.all([
      notionClient.listWorkspaces(),
      notionClient.listWorkspaceProjects(),
      notionClient.getCurrentWorkspaceId(),
    ]);
    if (getWorkspaceMenuAccountKey() !== requestAccountKey) return;

    const accountChanged = workspaceMenuAccountKey !== requestAccountKey;
    if (accountChanged) workspaceMenuPageLoads.value = [];
    const cachedProjectIds = !accountChanged
      ? Object.keys(workspaceMenuPagesByProject.value)
      : [];
    const nextPages: Record<string, ProjectPage[]> = {};
    await Promise.all(cachedProjectIds.map(async (projectId) => {
      if (!nextProjects.some((project) => project.id === projectId)) return;
      nextPages[projectId] = await notionClient.listProjectPages(projectId);
    }));
    if (getWorkspaceMenuAccountKey() !== requestAccountKey) return;

    workspaceMenuAccountKey = requestAccountKey;
    workspaces.value = nextWorkspaces;
    currentWorkspaceId.value = nextWorkspaceId;
    workspaceMenuProjects.value = nextProjects;
    workspaceMenuPagesByProject.value = nextPages;
    projects.value = nextProjects.filter((project) => project.workspaceId === nextWorkspaceId);
  }

  async function loadWorkspaceMenuPages(projectId: string) {
    if (workspaceMenuPagesByProject.value[projectId]) return;
    if (workspaceMenuPageLoads.value.includes(projectId)) return;

    const requestAccountKey = getWorkspaceMenuAccountKey();
    workspaceMenuPageLoads.value = [...workspaceMenuPageLoads.value, projectId];
    try {
      const projectPages = await notionClient.listProjectPages(projectId);
      if (
        getWorkspaceMenuAccountKey() === requestAccountKey &&
        workspaceMenuProjects.value.some((project) => project.id === projectId)
      ) {
        workspaceMenuPagesByProject.value = {
          ...workspaceMenuPagesByProject.value,
          [projectId]: projectPages,
        };
      }
    } finally {
      workspaceMenuPageLoads.value = workspaceMenuPageLoads.value.filter((id) => id !== projectId);
    }
  }

  async function initialize() {
    if (initializationPromise) return initializationPromise;

    const initialization = initializeWorkspace();
    initializationPromise = initialization;
    try {
      await initialization;
    } finally {
      if (initializationPromise === initialization) {
        initializationPromise = undefined;
      }
    }
  }

  async function initializeWorkspace() {
    isLoading.value = true;
    errorMessage.value = '';
    syncCheckError.value = '';
    isCheckingSync.value = false;
    let localWorkspaceReady = false;

    try {
      syncConfig.value = await notionClient.getSyncConfig();
      await refreshWorkspaceMenuTree();
      isOnline.value = typeof navigator === 'undefined' || navigator.onLine !== false;
      stopQueueListener ??= onSyncQueueChange(() => {
        void refreshPendingSyncCount();
        void refreshWorkspaceMenuTree().catch(() => undefined);
      });
      const [pendingCount, localProjects, storedProjectId] = await Promise.all([
        notionClient.pendingSyncEventCount(),
        notionClient.listProjects(),
        notionClient.getCurrentProjectId(),
      ]);
      pendingSyncCount.value = pendingCount;
      projects.value = localProjects;
      currentProjectId.value = localProjects.some(
        (project) => project.id === storedProjectId,
      )
        ? storedProjectId
        : localProjects[0]?.id ?? '';
      await loadCurrentPage();
      localWorkspaceReady = true;
    } catch (error) {
      errorMessage.value =
        error instanceof Error ? error.message : 'Unable to load Jottathing data.';
      saveStatus.value = 'error';
    } finally {
      isLoading.value = false;
    }

    if (!localWorkspaceReady || !isOnline.value) return;

    isCheckingSync.value = true;
    try {
      await initializeRemoteWorkspace();
    } catch (error) {
      syncCheckError.value = error instanceof Error
        ? error.message
        : 'Unable to verify the sync server.';
    } finally {
      isCheckingSync.value = false;
    }
  }

  async function initializeRemoteWorkspace() {
    let reloadDiscoveredPagesAfterQueueDrain = false;
    let sessionVerified = true;
    const previousAccountId = syncConfig.value.userId;
    const previousWorkspaceId = syncConfig.value.workspaceId;
    const previousAuthenticated = syncConfig.value.authenticated;
    try {
      syncConfig.value = await notionClient.refreshSyncSession();
      if (
        syncConfig.value.userId !== previousAccountId ||
        syncConfig.value.workspaceId !== previousWorkspaceId ||
        syncConfig.value.authenticated !== previousAuthenticated
      ) {
        await refreshWorkspaceFromStorage();
      }
    } catch (error) {
      sessionVerified = false;
      syncCheckError.value = error instanceof Error
        ? error.message
        : 'Unable to verify the sync server.';
    }

    const preparedLocalWorkspace = syncConfig.value.connected
      ? await notionClient.prepareLocalWorkspaceForFirstSync().catch(() => false)
      : false;
    const hydrated = sessionVerified && isOnline.value && !preparedLocalWorkspace
      ? await hydrateInitialNotionSnapshot().catch((error) => {
          syncCheckError.value = error instanceof Error
            ? `Couldn't load Notion content. ${error.message}`
            : "Couldn't load Notion content.";
          return false;
        })
      : false;

    if (sessionVerified && !hydrated) {
      const validateResult = isOnline.value
        ? await notionClient.validateNotionCache().catch((error) => {
            syncCheckError.value = error instanceof Error
              ? `Couldn't check Notion for changes. ${error.message}`
              : "Couldn't check Notion for changes.";
            return {
              stalePageIds: [],
              aheadPageIds: [],
              failedPageIds: [],
              newPageIds: [],
              workspaceChanged: false,
            };
          })
        : {
            stalePageIds: [],
            aheadPageIds: [],
            failedPageIds: [],
            newPageIds: [],
            workspaceChanged: false,
          };
      stalePageIds.value = validateResult.stalePageIds;
      aheadPageIds.value = validateResult.aheadPageIds;

      let refreshedFromRemoteSnapshot = false;
      if (isOnline.value && syncConfig.value.connected) {
        pendingSyncCount.value = await notionClient.pendingSyncEventCount();
        if (pendingSyncCount.value === 0) {
          refreshedFromRemoteSnapshot = await reloadRemoteWorkspaceWhenSafe();
        } else {
          // Keep remote inventory refresh pending while local edits finish syncing.
          reloadDiscoveredPagesAfterQueueDrain = true;
          remoteReloadPending = true;
        }
      }

      if (!refreshedFromRemoteSnapshot) {
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
    if (isOnline.value && syncConfig.value.connected && pendingSyncCount.value === 0) {
      // Catch edits made while the server check was running before deciding
      // whether to deliver the durable local queue.
      await refreshPendingSyncCount();
    }
    if (sessionVerified) openSyncEvents();
    if (isOnline.value && syncConfig.value.connected && pendingSyncCount.value) {
      if (reloadDiscoveredPagesAfterQueueDrain) {
        void syncPendingChanges()
          .then(async () => {
            if (pendingSyncCount.value > 0) return;
            await loadCurrentPage();
          })
          .catch(() => undefined);
      } else {
        void syncPendingChanges().catch(() => undefined);
      }
    }
  }

  async function selectProject(projectId: string) {
    const targetProject = workspaceMenuProjects.value.find((project) => project.id === projectId);
    const targetWorkspaceId = targetProject?.workspaceId;
    if (targetWorkspaceId && targetWorkspaceId !== currentWorkspaceId.value) {
      await notionClient.setCurrentWorkspaceId(targetWorkspaceId);
      currentWorkspaceId.value = targetWorkspaceId;
      projects.value = await notionClient.listProjects();
    }
    if (projectId === currentProjectId.value) return;

    currentProjectId.value = projectId;
    await notionClient.setCurrentProjectId(projectId);
    await loadCurrentPage();
  }

  async function selectWorkspace(workspaceId: string) {
    if (!workspaceId || workspaceId === currentWorkspaceId.value) return;
    await notionClient.setCurrentWorkspaceId(workspaceId);
    currentWorkspaceId.value = workspaceId;
    projects.value = await notionClient.listProjects();
    currentProjectId.value = await notionClient.getCurrentProjectId();
    await loadCurrentPage();
  }

  async function activateNotionWorkspace() {
    await refreshWorkspaceMenuTree();
    const notionWorkspace = workspaces.value.find((workspace) =>
      workspace.kind === 'notion' &&
      workspace.accountId === syncConfig.value.userId &&
      (!syncConfig.value.workspaceId || workspace.notionWorkspaceId === syncConfig.value.workspaceId),
    );
    if (!notionWorkspace) {
      throw new Error('Jottathing could not create the connected Notion workspace. Try signing in again.');
    }

    await selectWorkspace(notionWorkspace.id);
    const activeProjects = workspaceMenuProjects.value.filter((project) =>
      project.workspaceId === notionWorkspace.id && project.status === 'active',
    );
    if (!activeProjects.length) {
      await createProject(
        'Welcome to Jottathing',
        notionWorkspace.id,
        {
          title: 'Getting started',
          content: createWelcomeGuideContent(),
        },
      );
      return;
    }

    if (!activeProjects.some((project) => project.id === currentProjectId.value)) {
      await selectProject(activeProjects[0].id);
    }
  }

  async function createLocalWorkspace(name: string) {
    const workspace = await notionClient.createLocalWorkspace(name);
    await refreshWorkspaceMenuTree();
    currentWorkspaceId.value = workspace.id;
    currentProjectId.value = await notionClient.getCurrentProjectId();
    await loadCurrentPage();
    return workspace;
  }

  async function renameLocalWorkspace(workspaceId: string, name: string) {
    saveStatus.value = 'saving';
    errorMessage.value = '';
    try {
      await notionClient.renameLocalWorkspace(workspaceId, name);
      await refreshWorkspaceMenuTree();
      saveStatus.value = 'saved';
    } catch (error) {
      errorMessage.value = error instanceof Error ? error.message : 'Unable to rename this workspace.';
      saveStatus.value = 'error';
      throw error;
    }
  }

  async function moveProjectToWorkspace(projectId: string, destinationWorkspaceId: string) {
    if (!projectId || !destinationWorkspaceId) return;
    saveStatus.value = 'saving';
    errorMessage.value = '';
    try {
      await notionClient.moveProjectToWorkspace(projectId, destinationWorkspaceId);
      await refreshWorkspaceFromStorage();
      saveStatus.value = 'saved';
    } catch (error) {
      await refreshWorkspaceFromStorage().catch(() => undefined);
      errorMessage.value = error instanceof Error ? error.message : 'Unable to move this project.';
      saveStatus.value = 'error';
    }
  }

  async function moveCurrentProjectToWorkspace(destinationWorkspaceId: string) {
    if (!currentProjectId.value) return;
    await moveProjectToWorkspace(currentProjectId.value, destinationWorkspaceId);
  }

  async function movePageToProject(
    pageId: string,
    projectId: string,
    targetPageId?: string,
    position: 'before' | 'after' = 'after',
  ) {
    if (!pageId || !projectId) return;
    saveStatus.value = 'saving';
    errorMessage.value = '';
    try {
      await notionClient.movePageToProject(pageId, projectId, targetPageId, position);
      await refreshWorkspaceFromStorage();
      saveStatus.value = 'saved';
    } catch (error) {
      await refreshWorkspaceFromStorage().catch(() => undefined);
      errorMessage.value = error instanceof Error ? error.message : 'Unable to move this page.';
      saveStatus.value = 'error';
    }
  }

  async function deleteLocalWorkspace(workspaceId: string) {
    saveStatus.value = 'saving';
    errorMessage.value = '';
    try {
      await notionClient.deleteLocalWorkspace(workspaceId);
      await refreshWorkspaceFromStorage();
      saveStatus.value = 'saved';
    } catch (error) {
      errorMessage.value = error instanceof Error ? error.message : 'Unable to delete this workspace.';
      saveStatus.value = 'error';
    }
  }

  async function archiveProjectById(projectId: string) {
    const targetProject = workspaceMenuProjects.value.find((project) => project.id === projectId);
    if (!targetProject) return;
    saveStatus.value = 'saving';
    errorMessage.value = '';
    try {
      const result = await notionClient.archiveProject(projectId);
      await refreshWorkspaceMenuTree();
      if (targetProject.workspaceId === currentWorkspaceId.value && projectId === currentProjectId.value) {
        currentProjectId.value = result.currentProjectId;
        projects.value = await notionClient.listProjects();
        await loadCurrentPage();
      }
      saveStatus.value = 'saved';
    } catch (error) {
      await refreshWorkspaceMenuTree().catch(() => undefined);
      errorMessage.value = error instanceof Error ? error.message : 'Unable to delete this project.';
      saveStatus.value = 'error';
    }
  }

  async function archivePageById(pageId: string) {
    const targetPage = Object.values(workspaceMenuPagesByProject.value)
      .flat()
      .find((page) => page.id === pageId);
    if (!targetPage) return;
    saveStatus.value = 'saving';
    errorMessage.value = '';
    try {
      const replacementPage = await notionClient.archiveProjectPage(pageId);
      await refreshWorkspaceMenuTree();
      if (targetPage.projectId === currentProjectId.value) {
        pages.value = await notionClient.listProjectPages(targetPage.projectId);
        if (currentPage.value?.id === pageId) {
          currentPage.value = replacementPage;
          applyPageSyncState(replacementPage);
        }
      }
      saveStatus.value = 'saved';
    } catch (error) {
      await refreshWorkspaceMenuTree().catch(() => undefined);
      errorMessage.value = error instanceof Error ? error.message : 'Unable to delete this page.';
      saveStatus.value = 'error';
    }
  }

  async function createProject(
    name: string,
    workspaceId?: string,
    initialPage?: { title: string; content: DocumentContent },
  ) {
    saveStatus.value = 'creating';

    try {
      const targetWorkspaceId = workspaceId ?? currentWorkspaceId.value;
      const targetWorkspace = workspaces.value.find((workspace) => workspace.id === targetWorkspaceId);
      if (!targetWorkspace) throw new Error('Choose a workspace before creating a project.');
      if (targetWorkspace.kind === 'notion' && !syncConfig.value.connected) {
        throw new Error('Reconnect to Notion before adding a project to this workspace.');
      }
      if (workspaceId && workspaceId !== currentWorkspaceId.value) {
        await selectWorkspace(workspaceId);
      }
      const creation = await notionClient.createProject(name, {
        workspaceId: targetWorkspaceId,
        ...(initialPage
          ? { pageTitle: initialPage.title, pageContent: initialPage.content }
          : {}),
      });
      void refreshWorkspaceMenuTree().catch(() => undefined);
      projects.value = [...projects.value, creation.project];
      pages.value = [creation.page];
      currentProjectId.value = creation.project.id;
      currentPage.value = creation.page;
      applyProjectOrPageSyncState(creation.project, creation.page);

      void creation.settled.then(async ({ page, project }) => {
        const wasViewingProject = currentProjectId.value === creation.project.id;
        const wasViewingPage = currentPage.value?.id === creation.page.id;

        projects.value = await notionClient.listProjects();
        void refreshWorkspaceMenuTree().catch(() => undefined);
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
    const requestId = ++projectPagesRequestId;
    const requestedProjectId = currentProjectId.value;
    if (!requestedProjectId) {
      pages.value = [];
      return;
    }

    const loadedPages = await notionClient.listProjectPages(requestedProjectId);
    if (
      requestId === projectPagesRequestId &&
      currentProjectId.value === requestedProjectId
    ) {
      const pagesById = new Map(loadedPages.map((page) => [page.id, page]));
      for (const [optimisticPageId, pendingPage] of pendingPageCreations) {
        if (pendingPage.projectId !== requestedProjectId) continue;

        const currentDraft = currentPage.value?.id === optimisticPageId
          ? currentPage.value
          : pages.value.find((page) => page.id === optimisticPageId);
        const listedPage = pagesById.get(pendingPage.id);
        const latestPendingPage = currentDraft &&
          currentDraft.localRevision !== pendingPage.localRevision
          ? {
              ...pendingPage,
              title: currentDraft.title,
              content: currentDraft.content,
              status: currentDraft.status,
              pageOrder: currentDraft.pageOrder,
              localRevision: currentDraft.localRevision,
              updatedAt: currentDraft.updatedAt,
              ...(pendingPage.id === optimisticPageId
                ? { syncState: currentDraft.syncState, syncMessage: currentDraft.syncMessage }
                : {}),
            }
          : pendingPage;

        pagesById.delete(optimisticPageId);
        pagesById.set(
          latestPendingPage.id,
          listedPage && listedPage.localRevision === latestPendingPage.localRevision
            ? listedPage
            : latestPendingPage,
        );
      }
      pages.value = [...pagesById.values()];
    }
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

    const requestedProjectId = currentProjectId.value;
    saveStatus.value = 'creating';

    try {
      const creation = await notionClient.createProjectPage(
        requestedProjectId,
        nextPageTitle(),
      );
      pendingPageCreations.set(creation.page.id, creation.page);
      if (currentProjectId.value === requestedProjectId) {
        currentProjectId.value = creation.page.projectId;
      }
      currentPage.value = creation.page;
      pages.value = [...pages.value, creation.page];
      applyPageSyncState(creation.page);

      void creation.settled.then(async (page) => {
        // Keep a durable handoff snapshot available while page-list reloads
        // race with this create's local replacement.
        pendingPageCreations.set(creation.page.id, page);
        // A concurrent project reconciliation or orphan recovery can replace
        // the optimistic project ID while the new page is being saved.
        if (currentProjectId.value === requestedProjectId) {
          currentProjectId.value = page.projectId;
        }

        if (currentProjectId.value === page.projectId) {
          projects.value = await notionClient.listProjects();
          void refreshWorkspaceMenuTree().catch(() => undefined);
          await loadProjectPages();
        }

        if (
          currentProjectId.value === page.projectId &&
          (currentPage.value?.id === creation.page.id || currentPage.value?.id === page.id)
        ) {
          currentPage.value = pages.value.find((storedPage) => storedPage.id === page.id) ?? page;
          applyPageSyncState(currentPage.value);
        }
        pendingPageCreations.delete(creation.page.id);
      }).catch(async (error) => {
        pendingPageCreations.delete(creation.page.id);
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
      await refreshWorkspaceMenuTree();
      await loadProjectPages();
      applyPageSyncState(currentPage.value);
    } catch (error) {
      await refreshWorkspaceFromStorage().catch(() => undefined);
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

    browser.runtime.onMessage.addListener((message: JottathingRuntimeMessage) => {
      if (message?.type === 'jottathing.prepareConnectionDeletion') {
        void notionClient.prepareConnectionDeletion().catch(() => undefined);
        return false;
      }

      if (message?.type === 'jottathing.abortConnectionDeletion') {
        void notionClient.abortConnectionDeletion().catch(() => undefined);
        return false;
      }

      if (message?.type === 'jottathing.completeConnectionDeletion') {
        globalThis.setTimeout(() => window.location.reload(), 0);
        return false;
      }

      if (message?.type === 'jottathing.insertCaptureRequest') {
        return captureInsertHandler?.(message.payload) ?? false;
      }

      if (message?.type === 'jottathing.projectPageUpdated') {
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
    if (event.status === 'queue_idle' || event.status === 'reload_progress') return;

    const updated = await applySyncResult(event);
    if (!updated) {
      if (event.status === 'synced' || event.status === 'stale') {
        await reloadRemoteWorkspaceWhenSafe();
      }
      return;
    }

    pages.value = pages.value.map((p) => (p.id === updated.id ? updated : p));

    if (currentPage.value?.id === updated.id) {
      currentPage.value = updated;
    }

    applyPageSyncState(updated);

    const remoteVersion = event.status === 'failed' ? undefined : event.version;
    const remoteVersionIsNewer = typeof remoteVersion === 'number' &&
      remoteVersion > (updated.knownSyncVersion ?? 0);
    const shouldPullRemotePage = event.status === 'stale' || remoteVersionIsNewer;
    if (!shouldPullRemotePage) return;

    if (await notionClient.pendingSyncEventCount() > 0) {
      remoteReloadPending = true;
      if (event.status === 'stale' && !stalePageIds.value.includes(event.pageId)) {
        stalePageIds.value = [...stalePageIds.value, event.pageId];
      } else if (!aheadPageIds.value.includes(event.pageId)) {
        aheadPageIds.value = [...aheadPageIds.value, event.pageId];
      }
      return;
    }

    const refreshed = await refreshRemotePage(event.pageId);
    if (refreshed?.syncState === 'saved') {
      stalePageIds.value = stalePageIds.value.filter((id) => id !== event.pageId);
      aheadPageIds.value = aheadPageIds.value.filter((id) => id !== event.pageId);
      if (event.status === 'stale') await clearStalePages([event.pageId]);
      if (currentPage.value?.id === event.pageId && event.status === 'stale') {
        clearTimeout(pullMessageTimer);
        pullMessage.value = 'Updated from Notion';
        pullMessageTimer = window.setTimeout(() => { pullMessage.value = ''; }, 5000);
      }
    }
  }

  async function refreshRemotePage(pageId: string): Promise<ProjectPage | undefined> {
    if (currentPage.value?.id === pageId) {
      await refreshSelectedPage(pageId);
      return currentPage.value;
    }

    const syncedPage = await notionClient.syncProjectPage(pageId);
    if (!syncedPage) return undefined;

    const latestPage = pages.value.find((page) => page.id === pageId);
    const nextPage = latestPage && isNewerLocalPage(latestPage, syncedPage)
      ? mergePageSyncMetadata(latestPage, syncedPage)
      : syncedPage;
    pages.value = pages.value.map((page) => page.id === pageId ? nextPage : page);
    return nextPage;
  }

  async function reloadRemoteWorkspaceWhenSafe(): Promise<boolean> {
    if (!syncConfig.value.connected || !isOnline.value) return false;
    const accountKey = getWorkspaceMenuAccountKey();
    if (remoteReloadFailureAccountKey !== accountKey) {
      remoteReloadFailureAccountKey = accountKey;
      remoteReloadRetryAfter = 0;
    }
    if (remoteReloadInFlight) return remoteReloadInFlight;
    if (Date.now() < remoteReloadRetryAfter) {
      remoteReloadPending = true;
      return false;
    }

    const reloadPromise = (async () => {
      try {
        if (await notionClient.pendingSyncEventCount() > 0) {
          remoteReloadPending = true;
          return false;
        }

        remoteReloadPending = false;
        const reloaded = await notionClient.reloadFromNotion({ force: true });
        applyReloadedSnapshot(reloaded);
        stalePageIds.value = [];
        aheadPageIds.value = [];
        syncCheckError.value = '';
        remoteReloadRetryAfter = 0;
        await loadCurrentPage();
        return true;
      } catch (error) {
        remoteReloadPending = true;
        remoteReloadFailureAccountKey = getWorkspaceMenuAccountKey();
        remoteReloadRetryAfter = Date.now() + 30_000;
        syncCheckError.value = error instanceof Error
          ? error.message
          : 'Unable to load the latest Notion content.';
        return false;
      }
    })();
    remoteReloadInFlight = reloadPromise;

    try {
      return await reloadPromise;
    } finally {
      if (remoteReloadInFlight === reloadPromise) remoteReloadInFlight = undefined;
    }
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

  async function refreshSyncSession(allowSignedOut = false, syncAfterRefresh = true) {
    try {
      const previousAccountId = syncConfig.value.userId;
      const previousWorkspaceId = syncConfig.value.workspaceId;
      const previousAuthenticated = syncConfig.value.authenticated;
      syncConfig.value = await notionClient.refreshSyncSession(allowSignedOut);
      if (
        syncConfig.value.userId !== previousAccountId ||
        syncConfig.value.workspaceId !== previousWorkspaceId ||
        syncConfig.value.authenticated !== previousAuthenticated
      ) {
        await refreshWorkspaceFromStorage();
      }
      syncCheckError.value = '';
      if (syncConfig.value.connected && syncAfterRefresh) {
        const preparedLocalWorkspace = await notionClient.prepareLocalWorkspaceForFirstSync();
        if (!preparedLocalWorkspace && await hydrateInitialNotionSnapshot()) {
          await loadCurrentPage();
        }
        await syncPendingChanges();
      } else if (!syncConfig.value.connected) {
        saveStatus.value = 'stale';
      }
    } catch (error) {
      syncCheckError.value = error instanceof Error
        ? error.message
        : 'Unable to reach the sync server.';
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
      syncCheckError.value = '';
    } finally {
      await refreshPendingSyncCount();
    }
    if (pendingSyncCount.value > 0) return;
    if (remoteReloadPending) {
      await reloadRemoteWorkspaceWhenSafe();
      return;
    }

    // A manual sync also checks the remote project/page inventory. Sync event
    // rows are installation-scoped, so another app instance cannot announce
    // its new pages through this installation's event rows.
    let validation: Awaited<ReturnType<typeof notionClient.validateNotionCache>>;
    try {
      validation = await notionClient.validateNotionCache();
    } catch (error) {
      syncCheckError.value = error instanceof Error
        ? `Couldn't check Notion for changes. ${error.message}`
        : "Couldn't check Notion for changes.";
      return;
    }
    stalePageIds.value = validation.stalePageIds;
    aheadPageIds.value = validation.aheadPageIds;
    if (validation.workspaceChanged || validation.newPageIds.length) {
      await reloadRemoteWorkspaceWhenSafe();
    }
  }

  async function resyncPendingChanges(onProgress?: (progress: SyncProgressUpdate) => void) {
    try {
      const result = await notionClient.resyncPendingChanges(onProgress);
      if (result.reloadedFromNotion) {
        remoteReloadPending = false;
      } else if (result.remoteReloadPending) {
        remoteReloadPending = true;
      }
      onProgress?.({ phase: 'updating_view' });
      await refreshWorkspaceFromStorage();
      syncCheckError.value = '';
      return result;
    } finally {
      await refreshPendingSyncCount();
    }
  }

  async function refreshWorkspaceFromStorage() {
    await refreshWorkspaceMenuTree();
    const storedProjectId = await notionClient.getCurrentProjectId();
    const nextProjectId = projects.value.some((project) => project.id === storedProjectId)
      ? storedProjectId
      : projects.value[0]?.id ?? '';
    currentProjectId.value = nextProjectId;
    if (nextProjectId && nextProjectId !== storedProjectId) {
      await notionClient.setCurrentProjectId(nextProjectId);
    }

    // Reload the selected page from the updated active-page map. This handles
    // a remotely deleted current page or project as well as newly discovered pages.
    await loadCurrentPage();
  }

  async function handleOnline() {
    isOnline.value = true;

    try {
      const previousAccountId = syncConfig.value.userId;
      const previousWorkspaceId = syncConfig.value.workspaceId;
      const previousAuthenticated = syncConfig.value.authenticated;
      syncConfig.value = await notionClient.refreshSyncSession();
      if (
        syncConfig.value.userId !== previousAccountId ||
        syncConfig.value.workspaceId !== previousWorkspaceId ||
        syncConfig.value.authenticated !== previousAuthenticated
      ) {
        await refreshWorkspaceFromStorage();
      }
      syncCheckError.value = '';
      if (syncConfig.value.connected) {
        await notionClient.prepareLocalWorkspaceForFirstSync();
        await syncPendingChanges();
        openSyncEvents();
      }
    } catch (error) {
      isOnline.value = false;
      syncCheckError.value = error instanceof Error
        ? error.message
        : 'Unable to reach the sync server.';
    }
  }

  function handleOffline() {
    isOnline.value = false;
    syncEventsSource?.close();
    syncEventsSource = undefined;
    sseStatus.value = 'disconnected';
  }

  async function logout(
    onProgress?: (progress: SyncProgressUpdate) => void,
  ): Promise<boolean> {
    isLoading.value = false;
    isCheckingSync.value = false;
    isLoadingNotionParentPages.value = false;
    syncCheckError.value = '';
    errorMessage.value = '';

    let logoutResult: Awaited<ReturnType<typeof notionClient.logoutSyncSession>>;
    try {
      logoutResult = await notionClient.logoutSyncSession({ onProgress });
    } catch (error) {
      errorMessage.value = error instanceof Error
        ? error.message
        : 'Could not finish syncing. Your Notion workspace is still connected; try signing out again.';
      saveStatus.value = 'error';
      return false;
    }

    remoteReloadPending = false;
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
    syncEventsSource?.close();
    syncEventsSource = undefined;
    sseStatus.value = 'disconnected';
    await refreshWorkspaceFromStorage();
    isLoading.value = false;
    isCheckingSync.value = false;
    saveStatus.value = 'idle';
    errorMessage.value = logoutResult.queueDrainDeferred
      ? 'Signed out while offline or disconnected. Jottathing could not push or verify queued changes; your local notes and pending sync work are saved on this device. Reconnect the same Notion account to sync them.'
      : !logoutResult.serverDataCleanupComplete
      ? logoutResult.syncConfig.logoutCleanupPending
        ? 'You are signed out on this device, but server logout is still pending. Retry logout cleanup when the server is available.'
        : 'You are signed out on this device, but Jottathing could not confirm removal of all server credentials. Sign in again if you need to reconnect.'
      : !logoutResult.notionTokenRevoked
        ? 'You are signed out and Jottathing removed its stored credentials, but Notion did not confirm token revocation. Remove the Jottathing connection in Notion settings if it remains listed.'
        : '';

    return true;
  }

  async function retryLogoutCleanup(): Promise<boolean> {
    if (!syncConfig.value.logoutCleanupPending || isRetryingLogoutCleanup.value) return false;
    isRetryingLogoutCleanup.value = true;
    saveStatus.value = 'saving';
    errorMessage.value = '';
    try {
      const result = await notionClient.logoutSyncSession({ cleanupOnly: true });
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
      await refreshWorkspaceFromStorage();
      isLoading.value = false;
      isCheckingSync.value = false;
      saveStatus.value = 'idle';
      errorMessage.value = !result.serverDataCleanupComplete
        ? result.syncConfig.logoutCleanupPending
          ? 'Server logout is still pending. Keep your documents on this device and retry when online.'
          : 'Jottathing could not confirm removal of all server credentials. Sign in again if you need to reconnect.'
        : !result.notionTokenRevoked
          ? 'Jottathing removed its stored credentials, but Notion did not confirm token revocation. Remove the Jottathing connection in Notion settings if it remains listed.'
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
        : 'Unable to delete the Jottathing connection.';
      saveStatus.value = 'error';
      throw error;
    }
  }

  async function loadNotionParentPages(query = '') {
    const requestId = ++notionParentPageRequestId;
    isLoadingNotionParentPages.value = true;
    try {
      const pages = await notionClient.listNotionParentPages(query);
      if (requestId === notionParentPageRequestId) {
        notionParentPages.value = pages;
      }
    } catch (error) {
      if (requestId === notionParentPageRequestId) {
        errorMessage.value =
          error instanceof Error ? error.message : 'Unable to load Notion pages.';
        saveStatus.value = 'error';
      }
    } finally {
      if (requestId === notionParentPageRequestId) {
        isLoadingNotionParentPages.value = false;
      }
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
    const syncStateRank: Record<string, number> = {
      error: 5,
      stale: 4,
      saving: 3,
      creating: 2,
      saved: 1,
      idle: 0,
    };
    const cachedProjectPages = workspaceMenuPagesByProject.value[page.projectId];
    const knownProjectPages = page.projectId === currentProjectId.value
      ? pages.value
      : cachedProjectPages ?? [];
    const projectPages = [
      ...knownProjectPages.filter((storedPage) => storedPage.id !== page.id),
      page,
    ].filter((storedPage) => storedPage.status !== 'archived');
    const worstPage = projectPages.slice().sort((first, second) =>
      (syncStateRank[second.syncState ?? 'saved'] ?? 0) -
      (syncStateRank[first.syncState ?? 'saved'] ?? 0),
    )[0];
    const pageProject = workspaceMenuProjects.value.find((entry) => entry.id === page.projectId) ??
      projects.value.find((entry) => entry.id === page.projectId);
    if (pageProject) {
      let projectSyncState = worstPage?.syncState;
      let projectSyncMessage = worstPage?.syncMessage;
      const hasCompletePageList = page.projectId === currentProjectId.value || cachedProjectPages !== undefined;
      if (!hasCompletePageList &&
        (syncStateRank[pageProject.syncState ?? 'saved'] ?? 0) >
          (syncStateRank[page.syncState ?? 'saved'] ?? 0)) {
        projectSyncState = pageProject.syncState;
        projectSyncMessage = pageProject.syncMessage;
      }
      const updatedProject = {
        ...pageProject,
        syncState: projectSyncState ?? pageProject.syncState,
        syncMessage: projectSyncMessage,
      };
      workspaceMenuProjects.value = workspaceMenuProjects.value.map((entry) =>
        entry.id === updatedProject.id ? updatedProject : entry,
      );
      projects.value = projects.value.map((entry) =>
        entry.id === updatedProject.id ? updatedProject : entry,
      );
      const workspaceProjects = workspaceMenuProjects.value.filter((entry) =>
        entry.workspaceId === pageProject.workspaceId && entry.status !== 'archived',
      );
      const worstProject = workspaceProjects.slice().sort((first, second) =>
        (syncStateRank[second.syncState ?? 'saved'] ?? 0) -
        (syncStateRank[first.syncState ?? 'saved'] ?? 0),
      )[0];
      workspaces.value = workspaces.value.map((workspace) => workspace.id === pageProject.workspaceId
        ? {
            ...workspace,
            syncState: worstProject?.syncState,
            syncMessage: worstProject?.syncMessage,
          }
        : workspace);
    }
    if (cachedProjectPages) {
      workspaceMenuPagesByProject.value = {
        ...workspaceMenuPagesByProject.value,
        [page.projectId]: cachedProjectPages.map((storedPage) =>
          storedPage.id === page.id ? page : storedPage,
        ),
      };
    }

    saveStatus.value = page.syncState ?? 'saved';
    errorMessage.value =
      page.syncState === 'error' || page.syncState === 'stale'
        ? page.syncMessage ?? ''
        : '';
  }

  function applyProjectOrPageSyncState(project: Project, page?: ProjectPage) {
    const menuProject = workspaceMenuProjects.value.find((entry) => entry.id === project.id);
    const projectStatus = menuProject?.syncState ?? 'saved';
    const projectMessage = menuProject?.syncMessage;
    const pageScopedProject = {
      ...project,
      syncState: projectStatus,
      syncMessage: projectMessage,
    };
    projects.value = projects.value.map((entry) =>
      entry.id === project.id ? pageScopedProject : entry,
    );
    workspaceMenuProjects.value = workspaceMenuProjects.value.map((entry) =>
      entry.id === project.id ? pageScopedProject : entry,
    );
    const status = page?.syncState ?? projectStatus;
    const message = page?.syncMessage ?? projectMessage;
    saveStatus.value = status;
    errorMessage.value =
      status === 'error' || status === 'stale'
        ? message ?? ''
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
      await loadCurrentPage();
      saveStatus.value = currentPage.value?.syncState ?? 'saved';
      errorMessage.value = '';
      syncCheckError.value = '';
    } catch (error) {
      errorMessage.value =
        error instanceof Error ? error.message : 'Unable to reload Jottathing from Notion.';
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
    projects.value = reloaded.projects.filter((project) => project.workspaceId === currentWorkspaceId.value);
    currentProjectId.value = projects.value.some((project) => project.id === currentProjectId.value)
      ? currentProjectId.value
      : projects.value.some((project) => project.id === reloaded.currentProjectId)
        ? reloaded.currentProjectId
        : projects.value[0]?.id ?? '';
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
    archiveProjectById,
    archivePageById,
    createProject,
    createPage,
    createLocalWorkspace,
    activateNotionWorkspace,
    renameLocalWorkspace,
    deleteLocalWorkspace,
    selectWorkspace,
    moveCurrentProjectToWorkspace,
    moveProjectToWorkspace,
    movePageToProject,
    currentPage,
    currentProject,
    currentProjectId,
    currentWorkspace,
    currentWorkspaceId,
    workspaceMenuProjects,
    workspaceMenuPagesByProject,
    workspaceMenuPageLoads,
    createNotionParentPage,
    errorMessage,
    initialize,
    handleOffline,
    handleOnline,
    isOnline,
    isCheckingSync,
    isLoading,
    isLoadingNotionParentPages,
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
    refreshWorkspaceMenuTree,
    loadWorkspaceMenuPages,
    projects,
    workspaces,
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
    selectProject,
    selectNotionParentPage,
    startRuntimeListener,
    syncConfig,
    syncCheckError,
    syncPendingChanges,
    assignUnmatchedPendingQueueToCurrentAccount,
    resyncPendingChanges,
    updateServerUrl,
    getSyncLoginUrl,
  };
});
