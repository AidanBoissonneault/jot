import { computed, ref } from 'vue';
import { defineStore } from 'pinia';
import { notionClient } from '@/src/services/notionClient';
import type { DocumentContent, Project, ProjectPage } from '@/src/types/capture';
import type {
  CaptureSelectionPayload,
  JotRuntimeMessage,
  ProjectPageUpdatedMessage,
} from '@/src/types/messages';

type SaveStatus = 'idle' | 'saving' | 'saved' | 'error';
type CaptureInsertHandler = (payload: CaptureSelectionPayload) => Promise<boolean>;

export const useJotStore = defineStore('jot', () => {
  const projects = ref<Project[]>([]);
  const pages = ref<ProjectPage[]>([]);
  const currentPage = ref<ProjectPage>();
  const currentProjectId = ref<string>('');
  const errorMessage = ref<string>('');
  const isLoading = ref(false);
  const saveStatus = ref<SaveStatus>('idle');
  let captureInsertHandler: CaptureInsertHandler | undefined;
  let isListeningForRuntimeMessages = false;

  const currentProject = computed(() =>
    projects.value.find((project) => project.id === currentProjectId.value),
  );

  async function initialize() {
    isLoading.value = true;
    errorMessage.value = '';

    try {
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
    currentProjectId.value = projectId;
    await notionClient.setCurrentProjectId(projectId);
    await loadCurrentPage();
  }

  async function selectPage(pageId: string) {
    const page = await notionClient.setActiveProjectPage(pageId);

    if (!page) {
      return;
    }

    currentPage.value = page;
    await loadProjectPages();
    saveStatus.value = 'saved';
  }

  async function loadCurrentPage() {
    if (!currentProjectId.value) {
      pages.value = [];
      currentPage.value = undefined;
      return;
    }

    await loadProjectPages();
    currentPage.value = await notionClient.getProjectPage(currentProjectId.value);
    saveStatus.value = 'saved';
  }

  async function loadProjectPages() {
    if (!currentProjectId.value) {
      pages.value = [];
      return;
    }

    pages.value = await notionClient.listProjectPages(currentProjectId.value);
  }

  async function saveCurrentPageContent(content: DocumentContent) {
    if (!currentPage.value) {
      return;
    }

    saveStatus.value = 'saving';

    try {
      currentPage.value = await notionClient.updateProjectPage({
        ...currentPage.value,
        content,
      });
      saveStatus.value = 'saved';
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
      saveStatus.value = 'saved';
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
      saveStatus.value = 'saved';
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
      saveStatus.value = 'saved';
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
    saveStatus.value = 'saved';
  }

  function nextPageTitle() {
    const nextNumber = pages.value.length + 1;
    return `Page ${nextNumber}`;
  }

  return {
    archiveCurrentPage,
    createPage,
    currentPage,
    currentProject,
    currentProjectId,
    errorMessage,
    initialize,
    isLoading,
    loadCurrentPage,
    loadProjectPages,
    pages,
    projects,
    registerCaptureInsertHandler,
    renameCurrentPage,
    saveCurrentPageContent,
    saveStatus,
    selectPage,
    selectProject,
    startRuntimeListener,
  };
});
