/** @file Project and page selection, creation, renaming, and archive actions. */
import { ref, type Ref } from 'vue';
import { notionClient } from '@/src/services/notionClient';
import type { useInkwellStore } from '@/src/stores/inkwell';

type InkwellStore = ReturnType<typeof useInkwellStore>;

export interface ArchiveTarget {
  kind: 'project' | 'page';
  id: string;
  title: string;
}

interface WorkspaceActionOptions {
  store: InkwellStore;
  pageTitleDraft: Ref<string>;
  projectNameDraft: Ref<string>;
  newProjectNameDraft: Ref<string>;
  activeTitleMenu: Ref<'project' | 'page' | 'category' | null>;
  activeTab: Ref<'editor' | 'settings'>;
  flushEditorContent: () => Promise<void>;
  saveEditorContentInBackground: () => Promise<void>;
}

/** Owns project/page selection, creation, renaming, and archive confirmation actions. */
export function useWorkspaceActions(options: WorkspaceActionOptions) {
  const {
    store,
    pageTitleDraft,
    projectNameDraft,
    newProjectNameDraft,
    activeTitleMenu,
    activeTab,
    flushEditorContent,
    saveEditorContentInBackground,
  } = options;
  const archiveTarget = ref<ArchiveTarget | null>(null);

  async function selectPage(pageId: string) {
    if (!pageId || pageId === store.currentPage?.id) return;
    activeTitleMenu.value = null;
    await saveEditorContentInBackground();
    void notionClient.flushPendingSyncOps({ force: true }).catch(() => undefined);
    await store.selectPage(pageId);
  }

  async function selectProject(projectId: string) {
    if (!projectId || projectId === store.currentProjectId) return;
    activeTitleMenu.value = null;
    await saveEditorContentInBackground();
    void notionClient.flushPendingSyncOps({ force: true }).catch(() => undefined);
    await store.selectProject(projectId);
  }

  async function createProject() {
    activeTitleMenu.value = null;
    await flushEditorContent();
    const name = newProjectNameDraft.value.trim() || 'Untitled Project';
    await store.createProject(name);
    newProjectNameDraft.value = '';
    activeTab.value = 'editor';
  }

  async function renameProject(name = projectNameDraft.value) {
    if (!store.currentProject) return;
    await store.renameCurrentProject(name);
  }

  async function createPage() {
    activeTitleMenu.value = null;
    await flushEditorContent();
    await store.createPage();
  }

  async function renamePage(title = pageTitleDraft.value) {
    const page = store.currentPage;
    if (!page) return;
    await flushEditorContent();
    if (store.currentPage?.id !== page.id || title === store.currentPage.title) return;
    await store.renameCurrentPage(title);
  }

  async function archiveProject() {
    if (!store.currentProject) return;
    activeTitleMenu.value = null;
    archiveTarget.value = {
      kind: 'project',
      id: store.currentProject.id,
      title: store.currentProject.name,
    };
  }

  async function archivePage() {
    if (!store.currentPage) return;
    activeTitleMenu.value = null;
    archiveTarget.value = {
      kind: 'page',
      id: store.currentPage.id,
      title: store.currentPage.title,
    };
  }

  async function confirmArchive() {
    if (!archiveTarget.value) return;
    const target = archiveTarget.value;
    archiveTarget.value = null;
    await flushEditorContent();

    if (target.kind === 'project' && store.currentProject?.id === target.id) {
      await store.archiveCurrentProject();
      return;
    }
    if (target.kind === 'page' && store.currentPage?.id === target.id) {
      await store.archiveCurrentPage();
    }
  }

  function cancelArchive() {
    archiveTarget.value = null;
  }

  return {
    archiveTarget,
    selectPage,
    selectProject,
    createProject,
    renameProject,
    createPage,
    renamePage,
    archiveProject,
    archivePage,
    confirmArchive,
    cancelArchive,
  };
}
