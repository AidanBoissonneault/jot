<script setup lang="ts">
/**
 * Sidepanel composition root. Connects feature composables to typed view contexts
 * and places the top-level editor, settings, and archive regions in the shell.
 * Feature-specific state and effects live in their components or composables.
 */
import { computed, nextTick, ref } from 'vue';
import ArchiveConfirmModal from './components/shared/ArchiveConfirmModal.vue';
import TopBar from './components/layout/TopBar.vue';
import type { TopBarContext } from './components/layout/topBarContext';
import SettingsPage from './components/settings/SettingsPage.vue';
import type { SettingsPageContext } from './components/settings/settingsPageContext';
import EditorContextMenu from './components/editor/EditorContextMenu.vue';
import type { EditorContextMenuContext } from './components/editor/editorContextMenuContext';
import EditorToolbar from './components/editor/EditorToolbar.vue';
import type { EditorToolbarContext } from './components/editor/editorToolbarContext';
import EditorPageTitle from './components/editor/EditorPageTitle.vue';
import type { EditorPageTitleContext } from './components/editor/editorPageTitleContext';
import EditorCanvas from './components/editor/EditorCanvas.vue';
import { notionClient } from '@/src/services/notionClient';
import { LEGAL_PRIVACY_URL, LEGAL_TERMS_URL } from '@/src/services/legal';
import {
  INTERFACE_SCALE_STEP,
  MAX_INTERFACE_SCALE,
  MIN_INTERFACE_SCALE,
} from './composables/useInterfaceScale';
import { useInterfaceScale } from './composables/useInterfaceScale';
import { useProjectCategories } from './composables/useProjectCategories';
import { useEditorFormatting } from './composables/useEditorFormatting';
import { useEditorContextMenu } from './composables/useEditorContextMenu';
import { useAudioRecording } from './composables/useAudioRecording';
import { useWorkspaceActions } from './composables/useWorkspaceActions';
import { useNotionConnection } from './composables/useNotionConnection';
import { useEditorMedia } from './composables/useEditorMedia';
import { useEditorPersistence } from './composables/useEditorPersistence';
import { useEditorCaptureInsertion } from './composables/useEditorCaptureInsertion';
import { useEditorDropHandling } from './composables/useEditorDropHandling';
import { useSettingsActions } from './composables/useSettingsActions';
import { useProjectSettings } from './composables/useProjectSettings';
import { useTopBarStatus } from './composables/useTopBarStatus';
import { useInkwellEditor } from './composables/useInkwellEditor';
import type { InkwellEditorHandlers } from './composables/useInkwellEditor';
import { useSidepanelLifecycle } from './composables/useSidepanelLifecycle';
import { useEditorToolbar } from './composables/useEditorToolbar';
import type { EditorToolbarHandlers } from './composables/useEditorToolbar';
import { useEditorLinkActions } from './composables/useEditorLinkActions';
import {
  blockTypes,
  fontSizes,
  highlightColors,
  textColors,
} from './components/editor/editorOptions';
import { useInkwellStore } from '@/src/stores/inkwell';
import type { DocumentContent } from '@/src/types/capture';
import type { CaptureSelectionPayload } from '@/src/types/messages';

const store = useInkwellStore();
const {
  accountLabel,
  canUseEditor,
  contextLabel,
  saveLabel,
  syncBadgeClass,
  syncBadgeTitle,
  workspaceLabel,
} = useTopBarStatus(store);
const activeTitleMenu = ref<'project' | 'page' | 'category' | null>(null);
const {
  interfaceScale,
  interfaceScaleLabel,
  loadPreferences,
  previewInterfaceScale,
  persistInterfaceScale,
  setInterfaceScale,
} = useInterfaceScale();
const {
  projectCategoryDraft,
  categoryColorOptions,
  knownCategories,
  currentCategoryColor,
  currentCategoryStyle,
  colorForCategory,
  loadCategoryColors,
  chooseCategoryColor,
  selectCategory,
  commitCategory,
} = useProjectCategories(activeTitleMenu, saveProjectMetadata);
let projectSettings: ReturnType<typeof useProjectSettings> | undefined;
projectSettings = useProjectSettings(store, projectCategoryDraft, flushEditorContent);
const projectStateDraft = projectSettings.projectStateDraft;
const saveTimer = ref<number | undefined>();
const pageTitleDraft = ref('');
const projectNameDraft = ref('');
const newProjectNameDraft = ref('');
const uiMessage = ref('');
const activeTab = ref<'editor' | 'settings'>('editor');
const {
  createParentPage,
  parentPageLabel,
  parentPageSearchDraft,
  parentPageTitleDraft,
  saveServerUrl,
  searchParentPages,
  selectParentPage,
  serverUrlDraft,
} = useSettingsActions(store, uiMessage);
const {
  hasAcceptedLegalTerms,
  isLegalAcceptanceLoaded,
  isSigningIn,
  canLoginWithNotion,
  loadLegalAcceptance,
  stopSessionPolling,
  loginWithNotion,
  openLegalUrl,
  logout,
} = useNotionConnection(store, activeTab, uiMessage);
const isProjectNameEditing = ref(false);
const projectNameInputRef = ref<HTMLInputElement | null>(null);
const editorStateVersion = ref(0);
const isApplyingStoredContent = ref(false);
let editorPersistence: ReturnType<typeof useEditorPersistence> | undefined;
const editorHandlers: InkwellEditorHandlers = {
  handleDrop: () => false,
  showContextMenu: () => undefined,
};

const {
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
} = useWorkspaceActions({
  store,
  pageTitleDraft,
  projectNameDraft,
  newProjectNameDraft,
  activeTitleMenu,
  activeTab,
  flushEditorContent,
  saveEditorContentInBackground,
});

const { editor, skipNextEditorUpdate, clearEditorUpdateSkip } = useInkwellEditor({
  editorStateVersion,
  handlers: editorHandlers,
  isApplyingStoredContent,
  saveEditorContent: saveEditorContentOptimistically,
  saveTimer,
});

const { applyLink, clearFormatting, linkUrlDraft, runEditorFormattingCommand, setLink } =
  useEditorLinkActions(editor, saveTimer, saveEditorContentOptimistically);

const editorToolbarHandlers: EditorToolbarHandlers = {
  isRecording: () => false,
  stopAudioRecording: () => undefined,
};
const {
  activeEditorMenu,
  activeToolbarItemsForComponent,
  closeEditorMenu,
  editorToolbarMode,
  editorToolbarModesForComponent,
  openLinkTools,
  setEditorToolbarMode,
  toggleEditorMenu,
} = useEditorToolbar(editor, linkUrlDraft, editorToolbarHandlers);

editorPersistence = useEditorPersistence(
  editor,
  store,
  pageTitleDraft,
  isApplyingStoredContent,
  saveTimer,
);

const captureInsertion = useEditorCaptureInsertion(
  editor,
  store,
  saveEditorContentOptimistically,
  skipNextEditorUpdate,
);

const {
  imageUrlDraft,
  videoUrlDraft,
  audioUrlDraft,
  insertImage,
  insertVideo,
  insertAudio,
  handleUploadableImageDrop,
  handleUploadableAudioDrop,
  handleUploadableAudioFile,
} = useEditorMedia(
  editor,
  store,
  activeEditorMenu,
  uiMessage,
  skipNextEditorUpdate,
  clearEditorUpdateSkip,
  saveEditorContentOptimistically,
);

editorHandlers.handleDrop = useEditorDropHandling({
  captureInsertion,
  editor,
  handleUploadableAudioDrop,
  handleUploadableImageDrop,
  saveEditorContent: saveEditorContentOptimistically,
}).handleDrop;

const {
  recordingPhase,
  audioStream,
  stopAudioStream,
  stopRecording: stopAudioRecording,
  toggleAudioRecording,
} = useAudioRecording(editor, uiMessage, handleUploadableAudioFile);
editorToolbarHandlers.isRecording = () => recordingPhase.value === 'recording';
editorToolbarHandlers.stopAudioRecording = stopAudioRecording;

const {
  editorContextMenuRef,
  editorContextMenu,
  editorContextMenuHasSelection,
  editorContextMenuSource,
  editorContextMenuSourceHost,
  editorContextMenuPanel,
  contextMenuLinkDraft,
  showEditorContextMenu,
  restoreEditorContextSelection,
  hideEditorContextMenu,
  openEditorContextSource,
  handleEditorContextMenuPointerDown,
  handleEditorContextMenuKeydown,
  copyEditorSelectionFromContextMenu,
  cutEditorSelectionToClipboard,
  pasteClipboardTextIntoEditor,
  openContextLinkPanel,
  applyContextLink,
  removeContextLink,
} = useEditorContextMenu(editor, store, applyLink);
editorHandlers.showContextMenu = showEditorContextMenu;

const {
  activeBlockType,
  activeFontSize,
  activeTextColor,
  activeHighlightColor,
  setBlockType,
  setContextBlockType,
  setFontSize,
  setContextFontSize,
  setTextColor,
  applyContextTextColor,
  setHighlightColor,
  applyContextHighlightColor,
  runContextMarkCommand,
  runEditorMarkCommand,
  runEditorListCommand,
  runEditorBlockCommand,
} = useEditorFormatting(
  editor,
  editorStateVersion,
  runEditorFormattingCommand,
  restoreEditorContextSelection,
);

const hasInlineMessage = computed(() => Boolean(uiMessage.value || store.errorMessage));

useSidepanelLifecycle({
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
});

async function beginProjectNameEdit() {
  if (!store.currentProject || store.isLoading) {
    return;
  }

  isProjectNameEditing.value = true;
  await nextTick();
  projectNameInputRef.value?.focus();
  projectNameInputRef.value?.select();
}

async function finishProjectNameEdit() {
  if (!isProjectNameEditing.value) {
    return;
  }

  await renameProject();
  isProjectNameEditing.value = false;
}

function insertCaptureAtCursor(payload: CaptureSelectionPayload) {
  return captureInsertion.insertCaptureAtCursor(payload);
}

function saveProjectMetadata() {
  return projectSettings?.saveProjectMetadata() ?? Promise.resolve();
}

async function resync() {
  await flushEditorContent();
  const hadPendingLocalChanges = (await notionClient.pendingSyncEventCount()) > 0;
  await store.syncPendingChanges();

  if (hadPendingLocalChanges) {
    uiMessage.value = 'Changes sent to Notion. They may take a moment to appear.';
    return;
  }

  await store.reloadFromNotion();
  uiMessage.value = 'Up to date with Notion.';
}

function toggleTitleMenu(menu: 'project' | 'page' | 'category') {
  activeTitleMenu.value = activeTitleMenu.value === menu ? null : menu;
}

function blurTitleInput(event: Event) {
  (event.target as HTMLInputElement).blur();
}

function flushEditorContent() {
  return editorPersistence?.flushEditorContent() ?? Promise.resolve();
}

function saveEditorContentInBackground() {
  return editorPersistence?.saveEditorContentInBackground() ?? Promise.resolve();
}

function saveEditorContentOptimistically() {
  return editorPersistence?.saveEditorContentOptimistically() ?? Promise.resolve();
}

function handleVisibilityChange() {
  editorPersistence?.handleVisibilityChange();
}

function handlePanelExit() {
  editorPersistence?.handlePanelExit();
}

const topBarContext: TopBarContext = {
  store,
  syncBadgeClass,
  syncBadgeTitle,
  saveLabel,
  isProjectNameEditing,
  projectNameInputRef,
  projectNameDraft,
  finishProjectNameEdit,
  beginProjectNameEdit,
  contextLabel,
  currentCategoryStyle,
  activeTitleMenu,
  toggleTitleMenu,
  projectCategoryDraft,
  commitCategory,
  knownCategories,
  selectCategory,
  categoryColorOptions,
  currentCategoryColor,
  chooseCategoryColor,
  colorForCategory,
  accountLabel,
  workspaceLabel,
  canUseEditor,
  activeTab,
  createProject,
  createPage,
  resync,
  logout,
  selectProject,
  archiveProject,
};

const settingsPageContext: SettingsPageContext = {
  store,
  projectStateDraft,
  saveProjectMetadata,
  resync,
  saveLabel,
  accountLabel,
  parentPageLabel,
  hasAcceptedLegalTerms,
  isLegalAcceptanceLoaded,
  LEGAL_TERMS_URL,
  LEGAL_PRIVACY_URL,
  openLegalUrl,
  canLoginWithNotion,
  isSigningIn,
  loginWithNotion,
  logout,
  serverUrlDraft,
  saveServerUrl,
  parentPageSearchDraft,
  searchParentPages,
  parentPageTitleDraft,
  createParentPage,
  selectParentPage,
  interfaceScaleLabel,
  interfaceScale,
  MIN_INTERFACE_SCALE,
  MAX_INTERFACE_SCALE,
  INTERFACE_SCALE_STEP,
  previewInterfaceScale,
  persistInterfaceScale,
  setInterfaceScale,
};
const editorContextMenuContext: EditorContextMenuContext = {
  editor,
  editorContextMenu,
  editorContextMenuRef,
  editorContextMenuHasSelection,
  editorContextMenuSource,
  editorContextMenuSourceHost,
  editorContextMenuPanel,
  contextMenuLinkDraft,
  activeBlockType,
  activeFontSize,
  activeTextColor,
  activeHighlightColor,
  blockTypes,
  fontSizes,
  textColors,
  highlightColors,
  cutEditorSelectionToClipboard,
  copyEditorSelectionFromContextMenu,
  pasteClipboardTextIntoEditor,
  setContextBlockType,
  setContextFontSize,
  runContextMarkCommand,
  openContextLinkPanel,
  openEditorContextSource,
  applyContextLink,
  removeContextLink,
  applyContextTextColor,
  applyContextHighlightColor,
};
const editorToolbarContext: EditorToolbarContext = {
  editor,
  store,
  audioStream,
  editorToolbarModes: editorToolbarModesForComponent,
  editorToolbarMode,
  setEditorToolbarMode,
  activeToolbarItems: activeToolbarItemsForComponent,
  activeEditorMenu,
  toggleEditorMenu,
  closeEditorMenu,
  activeBlockType,
  blockTypes,
  setBlockType,
  activeFontSize,
  fontSizes,
  setFontSize,
  runEditorMarkCommand,
  activeTextColor,
  textColors,
  setTextColor,
  activeHighlightColor,
  highlightColors,
  setHighlightColor,
  linkUrlDraft,
  setLink,
  openLinkTools,
  runEditorListCommand,
  runEditorBlockCommand,
  imageUrlDraft,
  insertImage,
  videoUrlDraft,
  insertVideo,
  audioUrlDraft,
  insertAudio,
  recordingPhase,
  toggleAudioRecording,
  clearFormatting,
};
const editorPageTitleContext: EditorPageTitleContext = {
  store,
  activeTitleMenu,
  pageTitleDraft,
  renamePage,
  blurTitleInput,
  toggleTitleMenu,
  selectPage,
  createPage,
  archivePage,
};
</script>

<template>
  <main class="shell">
    <TopBar :context="topBarContext" />

    <p v-if="hasInlineMessage" class="error">
      {{ uiMessage || store.errorMessage }}
    </p>

    <section
      v-if="canUseEditor && activeTab === 'editor'"
      class="editor-shell"
      aria-label="Project page"
    >
      <header class="editor-header">
        <EditorPageTitle :context="editorPageTitleContext" />
        <EditorToolbar :context="editorToolbarContext" />
      </header>

      <EditorCanvas
        :editor="editor"
        @close-tools="closeEditorMenu"
        @hide-context-menu="hideEditorContextMenu"
      />

      <EditorContextMenu :context="editorContextMenuContext" />
    </section>

    <SettingsPage v-if="canUseEditor && activeTab === 'settings'" :context="settingsPageContext" />

    <ArchiveConfirmModal
      v-if="archiveTarget"
      :kind="archiveTarget.kind"
      :title="archiveTarget.title"
      @cancel="cancelArchive"
      @confirm="confirmArchive"
    />
  </main>
</template>
