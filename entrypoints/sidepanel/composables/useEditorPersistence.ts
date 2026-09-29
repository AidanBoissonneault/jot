/**
 * @file Loads editor pages into Tiptap and coordinates local page-content saves.
 */
import { watch, type Ref, type ShallowRef } from 'vue';
import type { Editor } from '@tiptap/core';
import type { useInkwellStore } from '@/src/stores/inkwell';
import { normalizeInkwellBlockIds } from '@/src/extensions/inkwellBlockIds';
import { notionClient } from '@/src/services/notionClient';
import type { DocumentContent } from '@/src/types/capture';

/** Owns page hydration, serialized editor saves, and exit-time persistence. */
export function useEditorPersistence(
  editor: ShallowRef<Editor | undefined>,
  store: ReturnType<typeof useInkwellStore>,
  pageTitleDraft: Ref<string>,
  isApplyingStoredContent: Ref<boolean>,
  saveTimer: Ref<number | undefined>,
) {
  let activePageId = '';
  let lastAppliedContent = '';
  let pendingSaveVersion = 0;
  let isEditorSaveInFlight = false;
  let editorSavePromise: Promise<void> | undefined;
  let shouldSaveAgainAfterCurrentSave = false;

  watch(
    () => store.currentPage,
    (page) => {
      if (!editor.value || !page) {
        return;
      }

      const editorContent = JSON.stringify(editor.value.getJSON());
      const storedContent = JSON.stringify(page.content);
      const isPageChange = activePageId !== page.id;
      const hasUnsavedEditorContent =
        editorContent !== lastAppliedContent ||
        isEditorSaveInFlight ||
        shouldSaveAgainAfterCurrentSave;

      if (!isPageChange && editorContent === storedContent) {
        pageTitleDraft.value = page.title;
        return;
      }

      if (!isPageChange && hasUnsavedEditorContent) {
        pageTitleDraft.value = page.title;
        return;
      }

      activePageId = page.id;
      pageTitleDraft.value = page.title;
      lastAppliedContent = storedContent;
      isApplyingStoredContent.value = true;
      editor.value.commands.setContent(page.content, { emitUpdate: false });
      isApplyingStoredContent.value = false;
    },
  );

  watch(
    () => store.currentPage?.title,
    (title) => {
      pageTitleDraft.value = title ?? '';
    },
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

        const content = normalizeInkwellBlockIds(editorContent);
        const title = pageTitleDraft.value;
        const serializedContent = JSON.stringify(content);

        if (serializedContent === lastAppliedContent && title === currentPage.title) {
          return;
        }

        lastAppliedContent = serializedContent;
        await store.saveCurrentPageContent(content, {
          preserveLocalContent: true,
          title,
        });
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
    const content = normalizeInkwellBlockIds(editorContent);
    const title = pageTitleDraft.value;
    const serializedContent = JSON.stringify(content);

    if (serializedContent === lastAppliedContent && title === page.title) {
      return;
    }

    lastAppliedContent = serializedContent;
    await store.savePageContentSnapshot(page, content, {
      preserveLocalContent: true,
      title,
    });
  }

  /** Flushes any scheduled save and waits for the latest snapshot to persist. */
  async function flushEditorContent() {
    window.clearTimeout(saveTimer.value);
    await saveEditorContentOptimistically();
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
  };
}
