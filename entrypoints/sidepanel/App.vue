<script setup lang="ts">
/**
 * Sidepanel composition root. Connects feature composables to typed view contexts
 * and places the top-level editor, settings, and archive regions in the shell.
 * Feature-specific state and effects live in their components or composables.
 */
import { computed, nextTick, onBeforeUnmount, ref } from 'vue';
import ArchiveConfirmModal from './components/shared/ArchiveConfirmModal.vue';
import SyncConflictModal from './components/shared/SyncConflictModal.vue';
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
import type { SyncContentConflict } from '@/src/types/sync';
import type { CaptureSelectionPayload, InkwellRuntimeMessage } from '@/src/types/messages';
import { autoMergeUniquePageAdditions } from '@/src/lib/syncConflictAutoMerge';

const store = useInkwellStore();

function handleConnectionDeletionMessage(message: InkwellRuntimeMessage) {
  if (message.type === 'inkwell.abortConnectionDeletion') {
    void notionClient.abortConnectionDeletion().catch(() => undefined);
  } else if (message.type === 'inkwell.completeConnectionDeletion') {
    void notionClient.completeConnectionDeletion()
      .catch(() => undefined)
      .finally(() => window.location.reload());
  }
}

browser.runtime.onMessage.addListener(handleConnectionDeletionMessage);
onBeforeUnmount(() => {
  browser.runtime.onMessage.removeListener(handleConnectionDeletionMessage);
});

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
  isProjectCategoryDraftDirty,
  projectCategoryDraftRevision,
  markCategoryDraftEdited,
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
projectSettings = useProjectSettings(
  store,
  projectCategoryDraft,
  isProjectCategoryDraftDirty,
  projectCategoryDraftRevision,
  flushEditorContent,
);
const projectStateDraft = projectSettings.projectStateDraft;
const saveTimer = ref<number | undefined>();
let editorPersistence: ReturnType<typeof useEditorPersistence> | undefined;
const pageTitleDraft = ref('');
const isPageTitleEditing = ref(false);
const isPageTitleDraftDirty = ref(false);
const pageTitleDraftRevision = ref(0);
const pageTitleInputRef = ref<HTMLInputElement | null>(null);
const projectNameDraft = ref('');
const isProjectNameDraftDirty = ref(false);
const projectNameDraftRevision = ref(0);
let projectNameEditOriginal = '';
let pageTitleEditOriginal = '';
let projectNameEditOriginalRevision = 0;
let pageTitleEditOriginalRevision = 0;
let projectNameEditOriginalDirty = false;
let pageTitleEditOriginalDirty = false;
const newProjectNameDraft = ref('');
const uiMessage = ref('');
const isResyncing = ref(false);
const isResolvingSyncConflict = ref(false);
const syncConflictError = ref('');
const syncConflicts = ref<SyncContentConflict[]>([]);
const activeSyncConflict = computed(() => syncConflicts.value.find((conflict) => conflict.targetType === 'project'));
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

async function prepareForConnectionDeletion() {
  window.clearTimeout(saveTimer.value);
  saveTimer.value = undefined;
  await editorPersistence?.flushEditorContent();
}

function resetEditorAfterConnectionDeletion() {
  editorPersistence?.resetEditorToCurrentPage();
}

const {
  hasAcceptedLegalTerms,
  isLegalAcceptanceLoaded,
  isSigningIn,
  isDeletingConnection,
  canLoginWithNotion,
  loadLegalAcceptance,
  stopSessionPolling,
  loginWithNotion,
  openLegalUrl,
  logout,
  deleteConnection,
} = useNotionConnection(
  store,
  activeTab,
  uiMessage,
  prepareForConnectionDeletion,
  resetEditorAfterConnectionDeletion,
);
const isProjectNameEditing = ref(false);
const projectNameInputRef = ref<HTMLInputElement | null>(null);
const editorStateVersion = ref(0);
const isApplyingStoredContent = ref(false);
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
  resolveSyncConflict: resolveInlinePageSyncConflict,
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
  isPageTitleEditing,
  isPageTitleDraftDirty,
  pageTitleDraftRevision,
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
  isProjectNameEditing,
  isProjectNameDraftDirty,
  projectNameDraftRevision,
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

  closeActiveTitleMenu();
  if (!projectNameDraft.value) {
    projectNameDraft.value = store.currentProject.name;
  }
  projectNameEditOriginal = projectNameDraft.value;
  projectNameEditOriginalRevision = projectNameDraftRevision.value;
  projectNameEditOriginalDirty = isProjectNameDraftDirty.value;
  isProjectNameEditing.value = true;
  await nextTick();
  projectNameInputRef.value?.focus();
  projectNameInputRef.value?.select();
}

async function finishProjectNameEdit() {
  if (!isProjectNameEditing.value) {
    return;
  }

  const name = projectNameDraft.value.trim();
  const project = store.currentProject;
  isProjectNameEditing.value = false;

  if (!isProjectNameDraftDirty.value) {
    projectNameDraft.value = project?.name ?? '';
    return;
  }

  if (!name) {
    projectNameDraft.value = projectNameEditOriginal;
    projectNameDraftRevision.value = projectNameEditOriginalRevision;
    isProjectNameDraftDirty.value = projectNameEditOriginalDirty;
    return;
  }

  projectNameDraft.value = name;
  const submittedRevision = projectNameDraftRevision.value;
  await renameProject(name);
  if (
    project &&
    store.currentProject?.id === project.id &&
    store.currentProject?.name === name &&
    projectNameDraft.value === name &&
    projectNameDraftRevision.value === submittedRevision
  ) {
    isProjectNameDraftDirty.value = false;
  }
}

function cancelProjectNameEdit() {
  isProjectNameEditing.value = false;
  projectNameDraft.value = projectNameEditOriginal;
  projectNameDraftRevision.value = projectNameEditOriginalRevision;
  isProjectNameDraftDirty.value = projectNameEditOriginalDirty;
}

function markProjectNameDraftEdited() {
  isProjectNameDraftDirty.value = true;
  projectNameDraftRevision.value += 1;
}

async function beginPageTitleEdit() {
  if (!store.currentPage || store.isLoading) {
    return;
  }

  closeActiveTitleMenu();
  if (!pageTitleDraft.value) {
    pageTitleDraft.value = store.currentPage.title;
  }
  pageTitleEditOriginal = pageTitleDraft.value;
  pageTitleEditOriginalRevision = pageTitleDraftRevision.value;
  pageTitleEditOriginalDirty = isPageTitleDraftDirty.value;
  isPageTitleEditing.value = true;
  await nextTick();
  pageTitleInputRef.value?.focus();
  pageTitleInputRef.value?.select();
}

async function finishPageTitleEdit() {
  if (!isPageTitleEditing.value) {
    return;
  }

  const title = pageTitleDraft.value.trim();
  const page = store.currentPage;
  isPageTitleEditing.value = false;

  if (!isPageTitleDraftDirty.value) {
    pageTitleDraft.value = page?.title ?? '';
    return;
  }

  if (!title) {
    pageTitleDraft.value = pageTitleEditOriginal;
    pageTitleDraftRevision.value = pageTitleEditOriginalRevision;
    isPageTitleDraftDirty.value = pageTitleEditOriginalDirty;
    return;
  }

  pageTitleDraft.value = title;
  const submittedRevision = pageTitleDraftRevision.value;
  await renamePage(title);
  if (
    page &&
    store.currentPage?.id === page.id &&
    store.currentPage?.title === title &&
    pageTitleDraft.value === title &&
    pageTitleDraftRevision.value === submittedRevision
  ) {
    isPageTitleDraftDirty.value = false;
  }
}

function cancelPageTitleEdit() {
  isPageTitleEditing.value = false;
  pageTitleDraft.value = pageTitleEditOriginal;
  pageTitleDraftRevision.value = pageTitleEditOriginalRevision;
  isPageTitleDraftDirty.value = pageTitleEditOriginalDirty;
}

function markPageTitleDraftEdited() {
  isPageTitleDraftDirty.value = true;
  pageTitleDraftRevision.value += 1;
}

function insertCaptureAtCursor(payload: CaptureSelectionPayload) {
  return captureInsertion.insertCaptureAtCursor(payload);
}

function saveProjectMetadata() {
  return projectSettings?.saveProjectMetadata() ?? Promise.resolve();
}

async function resync() {
  if (isResyncing.value) return;
  isResyncing.value = true;
  uiMessage.value = '';

  try {
    await flushEditorContent();
    const hadPendingLocalChanges = (await notionClient.pendingSyncEventCount()) > 0;
    await store.refreshSyncSession();
    if (!store.syncConfig.connected) {
      throw new Error(store.errorMessage || 'Connect Notion before resyncing.');
    }

    const result = await store.resyncPendingChanges();

    const conflictsNeedingInlineReview: SyncContentConflict[] = [];
    const conflictsNeedingModalReview: SyncContentConflict[] = [];
    let autoMergedAdditions = 0;
    let autoMergeError = '';
    for (const conflict of result.conflicts) {
      const mergedContent = autoMergeUniquePageAdditions(conflict);
      if (!mergedContent) {
        (conflict.targetType === 'page'
          ? conflictsNeedingInlineReview
          : conflictsNeedingModalReview).push(conflict);
        continue;
      }

      try {
        await notionClient.resolveSyncConflict(conflict.targetType, conflict.targetId, mergedContent);
        autoMergedAdditions += 1;
      } catch (error) {
        (conflict.targetType === 'page'
          ? conflictsNeedingInlineReview
          : conflictsNeedingModalReview).push(conflict);
        autoMergeError ||= error instanceof Error
          ? error.message
          : 'Unable to sync the new blocks automatically. Your local changes remain saved.';
      }
    }

    syncConflicts.value = conflictsNeedingModalReview;

    if (autoMergedAdditions) {
      await store.refreshWorkspaceFromStorage();
    }

    if (conflictsNeedingModalReview.length) {
      syncConflictError.value = '';
      if (autoMergeError) syncConflictError.value = autoMergeError;
      uiMessage.value = autoMergeError ||
        `${conflictsNeedingInlineReview.length ? 'Page conflicts are ready inside their documents. ' : ''}Review ${conflictsNeedingModalReview.length} project ${conflictsNeedingModalReview.length === 1 ? 'conflict' : 'conflicts'} to merge project state.`;
    } else if (conflictsNeedingInlineReview.length) {
      syncConflictError.value = '';
      uiMessage.value = autoMergeError ||
        `${conflictsNeedingInlineReview.length} page ${conflictsNeedingInlineReview.length === 1 ? 'conflict is' : 'conflicts are'} ready to review inside ${conflictsNeedingInlineReview.length === 1 ? 'the affected document' : 'their affected documents'}.`;
    } else if (autoMergedAdditions) {
      syncConflictError.value = '';
      uiMessage.value = 'New Notion blocks were merged with local content and synced.';
    } else if (result.blockedProjectCount > 0) {
      uiMessage.value = result.blockedMessage
        ? `${result.blockedMessage} Your local snapshot remains saved on this device.`
        : 'Notion still has content that needs review. Your local snapshot remains saved on this device.';
    } else if (result.remainingCount > 0) {
      uiMessage.value = store.errorMessage || 'Some changes remain saved locally and are waiting to sync.';
    } else if (result.reloadedFromNotion && hadPendingLocalChanges) {
      uiMessage.value = 'Notion content was merged with your local changes and resynced.';
    } else if (hadPendingLocalChanges) {
      uiMessage.value = 'Changes sent to Notion. They may take a moment to appear.';
    } else {
      uiMessage.value = 'Up to date with Notion.';
    }
  } catch (error) {
    uiMessage.value = error instanceof Error
      ? error.message
      : 'Unable to resync with Notion. Your local changes remain saved.';
  } finally {
    isResyncing.value = false;
  }
}

function cancelSyncConflict() {
  syncConflicts.value = [];
  syncConflictError.value = '';
  uiMessage.value = 'Sync conflict review paused. Your local changes remain saved.';
}

async function resolveInlinePageSyncConflict(
  conflict: SyncContentConflict,
  content: DocumentContent,
): Promise<DocumentContent | void> {
  if (conflict.targetType !== 'page') {
    throw new Error('Only page conflicts can be applied in the editor.');
  }
  if (isResolvingSyncConflict.value) {
    throw new Error('Another sync conflict is already being applied.');
  }
  isResolvingSyncConflict.value = true;
  try {
    await notionClient.resolveSyncConflict('page', conflict.targetId, content);
    await store.refreshWorkspaceFromStorage();
    uiMessage.value = 'Page conflict resolved and synced.';
    return store.currentPage?.id === conflict.targetId
      ? store.currentPage.content
      : content;
  } finally {
    isResolvingSyncConflict.value = false;
  }
}

async function resolveSyncConflict(content: DocumentContent) {
  const conflict = activeSyncConflict.value;
  if (!conflict || isResolvingSyncConflict.value) return;
  isResolvingSyncConflict.value = true;
  syncConflictError.value = '';
  uiMessage.value = '';

  try {
    await notionClient.resolveSyncConflict(conflict.targetType, conflict.targetId, content);
    syncConflicts.value = syncConflicts.value.slice(1);
    syncConflictError.value = '';
    uiMessage.value = syncConflicts.value.length
      ? 'Merge saved. Review the next sync conflict.'
      : 'Local and Notion blocks were merged and synced.';
    try {
      await store.refreshWorkspaceFromStorage();
    } catch (error) {
      const detail = error instanceof Error ? ` ${error.message}` : '';
      uiMessage.value = `Merge synced, but the workspace view could not refresh.${detail}`;
    }
  } catch (error) {
    syncConflictError.value = error instanceof Error
      ? error.message
      : 'Unable to apply the merge. Your local changes remain saved.';
    uiMessage.value = syncConflictError.value;
  } finally {
    isResolvingSyncConflict.value = false;
  }
}

function toggleTitleMenu(menu: 'project' | 'page' | 'category') {
  if (activeTitleMenu.value === menu) {
    if (menu === 'category') {
      void commitCategory();
    } else {
      activeTitleMenu.value = null;
    }
    return;
  }

  if (activeTitleMenu.value === 'category') {
    void commitCategory();
  }
  activeTitleMenu.value = menu;
}

function closeActiveTitleMenu() {
  if (activeTitleMenu.value === 'category') {
    void commitCategory();
    return;
  }

  activeTitleMenu.value = null;
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

const syncBadgeHoverTitle = computed(() => {
  const feedback = store.errorMessage || uiMessage.value;
  return [...new Set([saveLabel.value, syncBadgeTitle.value, feedback].filter(Boolean))].join(' · ');
});

const topBarContext: TopBarContext = {
  store,
  syncBadgeClass,
  syncBadgeHoverTitle,
  saveLabel,
  isProjectNameEditing,
  projectNameInputRef,
  projectNameDraft,
  markProjectNameDraftEdited,
  finishProjectNameEdit,
  cancelProjectNameEdit,
  beginProjectNameEdit,
  contextLabel,
  currentCategoryStyle,
  activeTitleMenu,
  toggleTitleMenu,
  projectCategoryDraft,
  markCategoryDraftEdited,
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
  isResyncing,
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
  isResyncing,
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
  isDeletingConnection,
  loginWithNotion,
  logout,
  deleteConnection,
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
  isPageTitleEditing,
  pageTitleInputRef,
  markPageTitleDraftEdited,
  beginPageTitleEdit,
  finishPageTitleEdit,
  cancelPageTitleEdit,
  toggleTitleMenu,
  selectPage,
  createPage,
  archivePage,
};
</script>

<template>
  <main class="shell">
    <TopBar :context="topBarContext" />

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

    <SyncConflictModal
      v-if="activeSyncConflict"
      :conflict="activeSyncConflict"
      :busy="isResolvingSyncConflict"
      :error="syncConflictError"
      @cancel="cancelSyncConflict"
      @resolve="resolveSyncConflict"
    />
  </main>
</template>
