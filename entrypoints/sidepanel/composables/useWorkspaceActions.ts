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
    await saveEditorContentInBackground();
    void notionClient.flushPendingSyncOps({ force: true }).catch(() => undefined);
    await store.selectPage(pageId);
    activeTitleMenu.value = null;
  }

  async function selectProject(projectId: string) {
    if (!projectId || projectId === store.currentProjectId) return;
    await saveEditorContentInBackground();
    void notionClient.flushPendingSyncOps({ force: true }).catch(() => undefined);
    await store.selectProject(projectId);
    activeTitleMenu.value = null;
  }

  async function createProject() {
    await flushEditorContent();
    const name = newProjectNameDraft.value.trim() || 'Untitled Project';
    await store.createProject(name);
    newProjectNameDraft.value = '';
    activeTitleMenu.value = null;
    activeTab.value = 'editor';
  }

  async function renameProject() {
    if (!store.currentProject || projectNameDraft.value === store.currentProject.name) return;
    await flushEditorContent();
    await store.renameCurrentProject(projectNameDraft.value);
  }

  async function createPage() {
    await flushEditorContent();
    await store.createPage();
    activeTitleMenu.value = null;
  }

  async function renamePage() {
    if (!store.currentPage) return;
    const title = pageTitleDraft.value;
    await flushEditorContent();
    if (!store.currentPage || title === store.currentPage.title) return;
    await store.renameCurrentPage(title);
  }

  async function archiveProject() {
    if (!store.currentProject) return;
    archiveTarget.value = {
      kind: 'project',
      id: store.currentProject.id,
      title: store.currentProject.name,
    };
  }

  async function archivePage() {
    if (!store.currentPage) return;
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
