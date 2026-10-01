/**
 * @file Loads editor pages into Tiptap and coordinates local page-content saves.
 */
import { watch, type Ref, type ShallowRef } from 'vue';
import type { Editor } from '@tiptap/core';
import type { useInkwellStore } from '@/src/stores/inkwell';
import { normalizeInkwellBlockIds } from '@/src/extensions/inkwellBlockIds';
import {
  contentWithSyncConflictBlocks,
  stripSyncConflictBlocks,
} from '@/src/lib/syncConflictReview';
import { notionClient } from '@/src/services/notionClient';
import type { DocumentContent, ProjectPage } from '@/src/types/capture';

/** Owns page hydration, serialized editor saves, and exit-time persistence. */
export function useEditorPersistence(
  editor: ShallowRef<Editor | undefined>,
  store: ReturnType<typeof useInkwellStore>,
  pageTitleDraft: Ref<string>,
  isPageTitleEditing: Ref<boolean>,
  isPageTitleDraftDirty: Ref<boolean>,
  pageTitleDraftRevision: Ref<number>,
  isApplyingStoredContent: Ref<boolean>,
  saveTimer: Ref<number | undefined>,
) {
  let activePageId = '';
  let lastAppliedContent = '';
  let pendingSaveVersion = 0;
  let isEditorSaveInFlight = false;
  let editorSavePromise: Promise<void> | undefined;
  let shouldSaveAgainAfterCurrentSave = false;
  let titleDraftPageId = '';

  function synchronizePageTitleDraft(page: ProjectPage | undefined) {
    const nextPageId = page?.id ?? '';
    const nextTitle = page?.title ?? '';

    if (nextPageId !== titleDraftPageId) {
      pageTitleDraft.value = nextTitle;
      isPageTitleDraftDirty.value = false;
      pageTitleDraftRevision.value = 0;
    } else if (!isPageTitleDraftDirty.value && !isPageTitleEditing.value) {
      pageTitleDraft.value = nextTitle;
    }

    titleDraftPageId = nextPageId;
  }

  watch(
    () => [store.currentPage, store.currentProject?.syncConflicts] as const,
    ([page, syncConflicts]) => {
      synchronizePageTitleDraft(page);
      if (!editor.value || !page) {
        return;
      }

      const editorContent = JSON.stringify(editor.value.getJSON());
      const storedContent = JSON.stringify(contentWithSyncConflictBlocks(
        page.content,
        page.id,
        syncConflicts,
      ));
      const persistedEditorContent = JSON.stringify(stripSyncConflictBlocks(
        editor.value.getJSON() as DocumentContent,
      ));
      const isPageChange = activePageId !== page.id;
      const hasUnsavedEditorContent =
        persistedEditorContent !== JSON.stringify(page.content) ||
        isEditorSaveInFlight ||
        shouldSaveAgainAfterCurrentSave;

      if (!isPageChange && editorContent === storedContent) {
        return;
      }

      if (!isPageChange && hasUnsavedEditorContent) {
        return;
      }

      activePageId = page.id;
      lastAppliedContent = JSON.stringify(page.content);
      isApplyingStoredContent.value = true;
      editor.value.commands.setContent(JSON.parse(storedContent) as DocumentContent, { emitUpdate: false });
      isApplyingStoredContent.value = false;
    },
  );

  watch(
    () => store.currentPage?.title,
    () => synchronizePageTitleDraft(store.currentPage),
  );

  /** Saves the latest editor snapshot while coalescing concurrent requests. */
  async function saveEditorContentOptimistically() {
    if (!editor.value || !store.currentPage) {
      return;
    }

    if (isEditorSaveInFlight) {
      shouldSaveAgainAfterCurrentSave = true;
      await editorSavePromise;
      return;
    }

    isEditorSaveInFlight = true;
    editorSavePromise = runEditorSaveLoop();
    await editorSavePromise;
  }

  async function runEditorSaveLoop() {
    const saveVersion = ++pendingSaveVersion;

    try {
      do {
        shouldSaveAgainAfterCurrentSave = false;
        const editorContent = editor.value?.getJSON() as DocumentContent | undefined;

        if (!editorContent) {
          return;
        }

        const currentPage = store.currentPage;

        if (!currentPage) {
          return;
        }

        const content = normalizeInkwellBlockIds(stripSyncConflictBlocks(editorContent));
        const title = pageTitleDraft.value;
        const serializedContent = JSON.stringify(content);

        if (serializedContent === lastAppliedContent && title === currentPage.title) {
          return;
        }

        const saved = await store.saveCurrentPageContent(content, {
          preserveLocalContent: true,
          title,
        });
        if (saved && activePageId === currentPage.id && store.currentPage?.id === currentPage.id) {
          lastAppliedContent = serializedContent;
        }
      } while (
        shouldSaveAgainAfterCurrentSave &&
        editor.value &&
        store.currentPage &&
        saveVersion === pendingSaveVersion
      );
    } finally {
      isEditorSaveInFlight = false;
      editorSavePromise = undefined;
    }
  }

  /** Persists the current editor snapshot when the sidepanel is leaving. */
  async function saveEditorContentInBackground() {
    window.clearTimeout(saveTimer.value);

    if (!editor.value || !store.currentPage) {
      return;
    }

    const page = { ...store.currentPage };
    const editorContent = editor.value.getJSON() as DocumentContent;
    const content = normalizeInkwellBlockIds(stripSyncConflictBlocks(editorContent));
    const title = pageTitleDraft.value;
    const serializedContent = JSON.stringify(content);

    if (serializedContent === lastAppliedContent && title === page.title) {
      return;
    }

    const saved = await store.savePageContentSnapshot(page, content, {
      preserveLocalContent: true,
      title,
    });
    if (saved && activePageId === page.id && store.currentPage?.id === page.id) {
      lastAppliedContent = serializedContent;
    }
  }

  /** Flushes any scheduled save and waits for the latest snapshot to persist. */
  async function flushEditorContent() {
    window.clearTimeout(saveTimer.value);
    await saveEditorContentOptimistically();
  }

  /** Replaces the visible editor snapshot after local documents have been deleted. */
  function resetEditorToCurrentPage() {
    window.clearTimeout(saveTimer.value);
    saveTimer.value = undefined;
    shouldSaveAgainAfterCurrentSave = false;
    pendingSaveVersion += 1;

    const page = store.currentPage;
    if (!editor.value || !page) return;

    const content = contentWithSyncConflictBlocks(
      page.content,
      page.id,
      store.currentProject?.syncConflicts,
    );
    activePageId = page.id;
    lastAppliedContent = JSON.stringify(page.content);
    isApplyingStoredContent.value = true;
    try {
      editor.value.commands.setContent(content, { emitUpdate: false });
    } finally {
      isApplyingStoredContent.value = false;
    }
  }

  /** Flushes local content and queued sync operations on panel exit. */
  function handlePanelExit() {
    void saveEditorContentInBackground()
      .catch(() => undefined)
      .finally(() => {
        void notionClient.flushPendingSyncOps({ force: true }).catch(() => undefined);
      });
  }

  function handleVisibilityChange() {
    if (document.visibilityState === 'hidden') {
      handlePanelExit();
    }
  }

  return {
    flushEditorContent,
    handlePanelExit,
    handleVisibilityChange,
    saveEditorContentInBackground,
    saveEditorContentOptimistically,
    resetEditorToCurrentPage,
  };
}
