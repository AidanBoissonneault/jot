/** @file Starts and tears down sidepanel listeners, startup work, and store reactions. */
import { onBeforeUnmount, onMounted, watch } from 'vue';
import type { Ref, ShallowRef } from 'vue';
import type { Editor } from '@tiptap/core';
import { useInkwellStore } from '@/src/stores/inkwell';
import type { CaptureSelectionPayload } from '@/src/types/messages';

type SidepanelStore = ReturnType<typeof useInkwellStore>;

/** Callbacks and reactive state shared by the sidepanel lifecycle. */
interface SidepanelLifecycleOptions {
  activeTab: Ref<'editor' | 'settings'>;
  editor: ShallowRef<Editor | undefined>;
  handleEditorContextMenuKeydown: (event: KeyboardEvent) => void;
  handleEditorContextMenuPointerDown: (event: PointerEvent) => void;
  handlePanelExit: () => void;
  handleVisibilityChange: () => void;
  hideEditorContextMenu: () => void;
  insertCaptureAtCursor: (payload: CaptureSelectionPayload) => Promise<boolean>;
  loadCategoryColors: () => Promise<void> | void;
  loadLegalAcceptance: () => Promise<void> | void;
  loadPreferences: () => Promise<void> | void;
  parentPageSearchDraft: Ref<string>;
  projectNameDraft: Ref<string>;
  saveTimer: Ref<number | undefined>;
  stopAudioStream: () => void;
  stopSessionPolling: () => void;
  store: SidepanelStore;
}

/** Owns browser listeners and cross-tab state reactions for the sidepanel root. */
export function useSidepanelLifecycle({
  activeTab,
  editor,
  handleEditorContextMenuKeydown,
  handleEditorContextMenuPointerDown,
  handlePanelExit,
  handleVisibilityChange,
  hideEditorContextMenu,
  insertCaptureAtCursor,
  loadCategoryColors,
  loadLegalAcceptance,
  loadPreferences,
  parentPageSearchDraft,
  projectNameDraft,
  saveTimer,
  stopAudioStream,
  stopSessionPolling,
  store,
}: SidepanelLifecycleOptions): void {
  onMounted(() => {
    store.startRuntimeListener();
    store.registerCaptureInsertHandler(insertCaptureAtCursor);
    window.addEventListener('pagehide', handlePanelExit);
    window.addEventListener('online', store.handleOnline);
    window.addEventListener('offline', store.handleOffline);
    window.addEventListener('resize', hideEditorContextMenu);
    document.addEventListener('visibilitychange', handleVisibilityChange);
    document.addEventListener('pointerdown', handleEditorContextMenuPointerDown);
    document.addEventListener('keydown', handleEditorContextMenuKeydown);
    void loadLegalAcceptance();
    void loadPreferences();
    void loadCategoryColors();
    void store.initialize();
  });

  onBeforeUnmount(() => {
    window.clearTimeout(saveTimer.value);
    stopSessionPolling();
    window.removeEventListener('pagehide', handlePanelExit);
    window.removeEventListener('online', store.handleOnline);
    window.removeEventListener('offline', store.handleOffline);
    window.removeEventListener('resize', hideEditorContextMenu);
    document.removeEventListener('visibilitychange', handleVisibilityChange);
    document.removeEventListener('pointerdown', handleEditorContextMenuPointerDown);
    document.removeEventListener('keydown', handleEditorContextMenuKeydown);
    handlePanelExit();
    stopAudioStream();
    editor.value?.destroy();
  });

  watch(
    () => store.currentProject?.name,
    (name) => {
      projectNameDraft.value = name ?? '';
    },
    { immediate: true },
  );

  watch(
    () => store.syncConfig.connected,
    (connected) => {
      if (connected && activeTab.value === 'settings') {
        activeTab.value = 'editor';
      }
    },
  );

  watch(activeTab, (tab) => {
    hideEditorContextMenu();
    if (tab === 'settings' && store.syncConfig.connected) {
      void store.loadNotionParentPages(parentPageSearchDraft.value);
    }
  });
}
