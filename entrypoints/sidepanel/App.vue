<!--
  Created: September 12, 2026
  Author: Aidan
  Description: Coordinates side-panel state, editor behavior, persistence, media capture, and extracted presentation components.
-->
<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, onMounted, ref, watch } from 'vue';
import { EditorContent, useEditor } from '@tiptap/vue-3';
import AudioRecorder from '@/src/components/AudioRecorder.vue';
import ArchiveDialog from './components/ArchiveDialog.vue';
import MediaPanel from './components/MediaPanel.vue';
import SettingsPanel from './components/SettingsPanel.vue';
import SidePanelHeader from './components/SidePanelHeader.vue';
import SyncPanel from './components/SyncPanel.vue';
import { NodeSelection, TextSelection } from '@tiptap/pm/state';
import type { EditorView } from '@tiptap/pm/view';
import StarterKit from '@tiptap/starter-kit';
import { TableKit } from '@tiptap/extension-table';
import { CodeNotebook } from '@/src/extensions/codeNotebook';
import {
  decodeInkwellSource,
  isAccessibleInkwellSource,
  INKWELL_SOURCE_ATTR,
  InkwellLink,
  safeInkwellSourceUrl,
} from '@/src/extensions/inkwellLink';
import { PortableTextEditingKit } from '@/src/extensions/textFormatting';
import { MediaKit } from '@/src/extensions/media';
import { InkwellBlockIds, normalizeInkwellBlockIds } from '@/src/extensions/inkwellBlockIds';
import {
  capturedBlockId,
  sourceFromProjectState,
} from '@/src/extensions/sourceRegistry';
import {
  AUDIO_UPLOAD_MAX_BYTES,
  IMAGE_UPLOAD_MAX_BYTES,
  isUploadableAudioFile,
  isUploadableImageFile,
  peekUploadableAudioDrop,
  peekUploadableImageDrop,
  readAudioDropSrc,
  readImageDropSrc,
  readYoutubeDropSrc,
} from '@/src/extensions/mediaDrop';
import {
  type InkwellImageMovePayload,
  isEditorInternalDrop,
  readInkwellImageMovePayload,
} from '@/src/extensions/inkwellImageMove';
import {
  createCapturedContent,
  createLinkedHeadingContent,
  notionClient,
} from '@/src/services/notionClient';
import {
  hasAcceptedCurrentLegalTerms,
  LEGAL_PRIVACY_URL,
  LEGAL_TERMS_URL,
  storeCurrentLegalAcceptance,
} from '@/src/services/legal';
import {
  DEFAULT_INTERFACE_SCALE,
  INTERFACE_SCALE_STEP,
  loadUserPreferences,
  MAX_INTERFACE_SCALE,
  MIN_INTERFACE_SCALE,
  normalizeInterfaceScale,
  saveUserPreferences,
} from '@/src/services/preferences';
import { useInkwellStore } from '@/src/stores/inkwell';
import type { DocumentContent } from '@/src/types/capture';
import type {
  CaptureSelectionPayload,
  ConsumeHeadingDragMessage,
  ConsumeTextDragMessage,
  OpenSourceRequestMessage,
  SourceOpenPayload,
} from '@/src/types/messages';

const INKWELL_DRAG_MIME = 'application/x-inkwell-capture';
const INKWELL_HEADING_DRAG_MIME = 'application/x-inkwell-heading-capture';
const blockTypes = [
  { label: 'Paragraph', value: 'paragraph' },
  { label: 'Heading 1', value: 'heading-1' },
  { label: 'Heading 2', value: 'heading-2' },
  { label: 'Heading 3', value: 'heading-3' },
  { label: 'Heading 4', value: 'heading-4' },
  { label: 'Heading 5', value: 'heading-5' },
  { label: 'Heading 6', value: 'heading-6' },
  { label: 'Quote', value: 'blockquote' },
  { label: 'Code block', value: 'codeBlock' },
] as const;
const fontSizes = [
  { label: 'Default', value: '' },
  { label: '12', value: '12px' },
  { label: '14', value: '14px' },
  { label: '16', value: '16px' },
  { label: '18', value: '18px' },
  { label: '24', value: '24px' },
  { label: '32', value: '32px' },
] as const;
const textColors = [
  { label: 'Default', value: '' },
  { label: 'Gray', value: '#6b6f76' },
  { label: 'Red', value: '#c2410c' },
  { label: 'Yellow', value: '#a16207' },
  { label: 'Green', value: '#15803d' },
  { label: 'Blue', value: '#173494' },
  { label: 'Purple', value: '#7e22ce' },
] as const;
const highlightColors = [
  { label: 'None', value: '' },
  { label: 'Yellow', value: '#fef08a' },
  { label: 'Green', value: '#bbf7d0' },
  { label: 'Blue', value: '#bfdbfe' },
  { label: 'Pink', value: '#fbcfe8' },
  { label: 'Gray', value: '#e4e4e7' },
] as const;

const store = useInkwellStore();
const saveTimer = ref<number>();
const pageTitleDraft = ref('');
const projectNameDraft = ref('');
const projectCategoryDraft = ref('');
const newProjectNameDraft = ref('');
const linkUrlDraft = ref('');
const mediaUrlDraft = ref('');
const mediaKind = ref<'image' | 'video' | 'audio'>('image');
const serverUrlDraft = ref('');
const parentPageSearchDraft = ref('');
const parentPageTitleDraft = ref('');
const uiMessage = ref('');
const hasAcceptedLegalTerms = ref(false);
const isLegalAcceptanceLoaded = ref(false);
const activeTab = ref<'editor' | 'settings'>('editor');
const interfaceScale = ref(DEFAULT_INTERFACE_SCALE);
const editorToolbarMode = ref<'style' | 'insert' | 'controls'>('style');
const editorContextMenuRef = ref<HTMLElement | null>(null);
const editorContextMenu = ref({
  visible: false,
  left: 0,
  top: 0,
});
const editorContextMenuHasSelection = ref(false);
const editorContextMenuSource = ref<SourceOpenPayload | null>(null);
const editorContextMenuPanel = ref<'main' | 'link' | 'color'>('main');
const contextMenuLinkDraft = ref('');
let editorContextSelection: { from: number; to: number } | null = null;
const activeEditorMenu = ref<
  | 'type'
  | 'marks'
  | 'color'
  | 'link'
  | 'lists'
  | 'blocks'
  | 'table'
  | 'history'
  | 'media'
  | 'record'
  | null
>(null);
const archiveTarget = ref<{
  kind: 'project' | 'page';
  id: string;
  title: string;
} | null>(null);
const isSigningIn = ref(false);
const editorStateVersion = ref(0);
type RecordingPhase = 'idle' | 'requesting_permission' | 'recording' | 'processing';
const recordingPhase = ref<RecordingPhase>('idle');
const audioStream = ref<MediaStream | null>(null);
let activePageId = '';
let isApplyingStoredContent = false;
let lastAppliedContent = '';
let pendingSaveVersion = 0;
let shouldSkipNextUpdateSave = false;
let isEditorSaveInFlight = false;
let editorSavePromise: Promise<void> | undefined;
let shouldSaveAgainAfterCurrentSave = false;
let sessionPollTimer: number | undefined;
let audioRecorder: MediaRecorder | undefined;
let audioChunks: Blob[] = [];

const editor = useEditor({
  extensions: [
    StarterKit.configure({
      heading: {
        levels: [1, 2, 3, 4, 5, 6],
      },
      link: false,
      underline: false,
      codeBlock: false,
    }),
    CodeNotebook,
    InkwellLink,
    InkwellBlockIds,
    PortableTextEditingKit,
    TableKit.configure({
      table: {
        resizable: true,
      },
    }),
    MediaKit,
  ],
  content: {
    type: 'doc',
    content: [{ type: 'paragraph' }],
  },
  editorProps: {
    attributes: {
      'aria-label': 'Project page editor',
    },
    handleDOMEvents: {
      contextmenu: (view, event) => {
        if (!(event instanceof MouseEvent)) {
          return false;
        }

        showEditorContextMenu(view, event);
        return true;
      },
    },
    handleClick: (_view, _pos, event) => {
      const anchor =
        event.target instanceof Element ? event.target.closest('a') : null;

      if (!anchor?.href) {
        return false;
      }

      event.preventDefault();

      const sourcePayload = decodeInkwellSource(
        anchor.getAttribute(`data-${kebabCase(INKWELL_SOURCE_ATTR)}`),
      );

      if (sourcePayload) {
        void browser.runtime.sendMessage({
          type: 'inkwell.openSourceRequest',
          payload: sourcePayload,
        } satisfies OpenSourceRequestMessage);
        return true;
      }

      void browser.tabs.create({ active: true, url: anchor.href });
      return true;
    },
    handleDrop: (view, event) => {
      const inkwellPayload = readInkwellDropPayload(event);

      if (inkwellPayload?.highlightMeta.isHeading) {
        event.preventDefault();
        insertLinkedHeadingAtDrop(view, event, inkwellPayload);
        return true;
      }

      if (inkwellPayload) {
        event.preventDefault();
        insertCapturedTextAtDrop(view, event, inkwellPayload);
        return true;
      }

      const imageMovePayload = readInkwellImageMovePayload(event.dataTransfer);
      if (imageMovePayload) {
        event.preventDefault();
        if (moveImageNodeAtDrop(view, event, imageMovePayload)) {
          void saveEditorContentOptimistically();
        }
        return true;
      }

      const selectedImageMovePayload = readSelectedImageMovePayload(view, event);
      if (selectedImageMovePayload) {
        event.preventDefault();
        if (moveImageNodeAtDrop(view, event, selectedImageMovePayload)) {
          void saveEditorContentOptimistically();
        }
        return true;
      }

      if (isEditorInternalDrop(event.dataTransfer)) {
        return false;
      }

      const uploadableInfo = peekUploadableImageDrop(event.dataTransfer);
      if (uploadableInfo) {
        event.preventDefault();
        moveEditorSelectionToDrop(view, event);
        void handleUploadableImageDrop(uploadableInfo);
        return true;
      }

      const uploadableAudioInfo = peekUploadableAudioDrop(event.dataTransfer);
      if (uploadableAudioInfo) {
        event.preventDefault();
        moveEditorSelectionToDrop(view, event);
        void handleUploadableAudioDrop(uploadableAudioInfo);
        return true;
      }

      const youtubeSrc = readYoutubeDropSrc(event.dataTransfer);

      if (youtubeSrc) {
        event.preventDefault();
        moveEditorSelectionToDrop(view, event);
        editor.value?.chain().focus().setYoutubeVideo({ src: youtubeSrc }).run();
        void saveEditorContentOptimistically();
        return true;
      }

      const audioSrc = readAudioDropSrc(event.dataTransfer);

      if (audioSrc) {
        event.preventDefault();
        moveEditorSelectionToDrop(view, event);
        editor.value?.chain().focus().setAudio({ src: audioSrc }).run();
        void saveEditorContentOptimistically();
        return true;
      }

      const imageSrc = readImageDropSrc(event.dataTransfer);

      if (imageSrc) {
        event.preventDefault();
        moveEditorSelectionToDrop(view, event);
        editor.value?.chain().focus().setImage({ src: imageSrc }).run();
        void saveEditorContentOptimistically();
        return true;
      }

      if (isLikelyTextCaptureDrop(event)) {
        // Capture synchronously — dataTransfer is cleared after the event handler returns
        // text/plain is set by the browser automatically and is accessible cross-origin
        const fallbackText = event.dataTransfer?.getData('text/plain') ?? '';

        event.preventDefault();

        void consumeTextDragPayload(fallbackText).then((dragPayload) => {
          if (dragPayload) {
            insertCapturedTextAtDrop(view, event, dragPayload);
          } else if (fallbackText) {
            moveEditorSelectionToDrop(view, event);
            shouldSkipNextUpdateSave = true;
            editor.value?.chain().focus().insertContent(fallbackText).run();
            queueMicrotask(() => {
              shouldSkipNextUpdateSave = false;
            });
            if (editor.value) {
              void saveEditorContentOptimistically();
            }
          }
        });

        return true;
      }

      if (!isLikelyHeadingDrop(event)) {
        return false;
      }

      const dropPosition = view.posAtCoords({
        left: event.clientX,
        top: event.clientY,
      });

      event.preventDefault();

      void consumeHeadingDropPayload(event).then((dragPayload) => {
        if (!dragPayload) {
          return;
        }

        insertLinkedHeadingAtDrop(view, event, dragPayload, dropPosition?.pos);
      });

      return true;
    },
  },
  onUpdate: ({ editor }) => {
    editorStateVersion.value += 1;

    if (isApplyingStoredContent) {
      return;
    }

    if (shouldSkipNextUpdateSave) {
      shouldSkipNextUpdateSave = false;
      return;
    }

    window.clearTimeout(saveTimer.value);
    saveTimer.value = window.setTimeout(() => {
      void saveEditorContentOptimistically();
    }, 450);
  },
  onSelectionUpdate: () => {
    editorStateVersion.value += 1;
  },
});

const isCurrentPageSyncedToNotion = computed(() =>
  store.saveStatus === 'saved' && Boolean(store.currentPage?.notionPageId),
);

const saveLabel = computed(() => {
  if (store.pullMessage) {
    return store.pullMessage;
  }

  if (store.isLoading) {
    return 'Loading';
  }

  if (store.isSavingLocally) {
    return 'Saving locally';
  }

  if (store.saveStatus === 'creating') {
    return 'Creating';
  }

  if (store.saveStatus === 'error') {
    return 'Save failed';
  }

  if (!store.isOnline) {
    return 'Offline · saved locally';
  }

  if (!store.syncConfig.connected) {
    return 'Saved locally only';
  }

  if (store.pendingSyncCount > 0) {
    return `Saved locally · ${store.pendingSyncCount} ${store.pendingSyncCount === 1 ? 'change' : 'changes'} queued`;
  }

  if (store.saveStatus === 'saving') {
    return 'Syncing to Notion';
  }

  if (store.saveStatus === 'stale') {
    return 'Notion has newer changes';
  }

  return isCurrentPageSyncedToNotion.value ? 'Synced to Notion' : 'Saved locally';
});

const syncBadgeTitle = computed(() => {
  if (store.errorMessage) {
    return store.errorMessage;
  }

  if (store.isSavingLocally) {
    return 'Saving changes on this device.';
  }

  if (!store.isOnline) {
    return 'You are offline. Changes are saved on this device and will sync automatically when you reconnect.';
  }

  if (!store.syncConfig.connected) {
    return 'Changes are saved on this device. Connect Notion when you are ready to sync.';
  }

  if (store.pendingSyncCount > 0) {
    return `${store.pendingSyncCount} ${store.pendingSyncCount === 1 ? 'change is' : 'changes are'} saved on this device and waiting to sync with Notion.`;
  }

  if (store.saveStatus === 'saving') {
    return 'Changes are saved on this device and are syncing to Notion.';
  }

  if (!isCurrentPageSyncedToNotion.value) {
    return 'Changes are saved on this device. This page has not been linked to Notion yet.';
  }

  const sseNote = store.sseStatus === 'connected'
    ? 'Live updates active'
    : store.sseStatus === 'connecting'
      ? 'Connecting…'
      : 'Live updates disconnected';

  if (!store.syncConfig.selectedParentPageId) {
    return `Synced to Notion · ${sseNote}`;
  }

  const base = store.syncConfig.selectedParentPageTitle
    ? `Synced to Notion inside ${store.syncConfig.selectedParentPageTitle}`
    : saveLabel.value;

  return `${base} · ${sseNote}`;
});

const syncBadgeClass = computed(() => ({
  'sync-badge': true,
  error: store.saveStatus === 'error',
  stale:
    store.saveStatus === 'stale' ||
    !store.syncConfig.connected ||
    !store.isOnline ||
    store.pendingSyncCount > 0,
  saving:
    store.isSavingLocally ||
    (store.saveStatus === 'saving' && store.pendingSyncCount === 0) ||
    store.saveStatus === 'creating' ||
    store.isLoading,
  saved:
    isCurrentPageSyncedToNotion.value &&
    store.syncConfig.connected &&
    store.isOnline &&
    store.pendingSyncCount === 0,
}));

const canUseEditor = computed(() => !store.isLoading && store.projects.length > 0);
const canLoginWithNotion = computed(
  () => isLegalAcceptanceLoaded.value && hasAcceptedLegalTerms.value && !isSigningIn.value,
);

const interfaceScaleLabel = computed(() => {
  if (interfaceScale.value < 100) {
    return 'Compact';
  }

  if (interfaceScale.value === 100) {
    return 'Default';
  }

  if (interfaceScale.value <= 120) {
    return 'Large';
  }

  return 'Extra large';
});

const editorToolbarModes = [
  { id: 'style', label: 'Style', icon: ['fas', 'wand-magic-sparkles'] },
  { id: 'insert', label: 'Insert', icon: ['fas', 'plus'] },
  { id: 'controls', label: 'Controls', icon: ['fas', 'sliders'] },
] as const;

const activeToolbarItems = computed(() => {
  if (editorToolbarMode.value === 'insert') {
    return [
      { id: 'link', label: 'Link', icon: ['fas', 'link'], title: 'Link' },
      { id: 'lists', label: 'Lists', icon: ['fas', 'list-ul'], title: 'Lists' },
      { id: 'blocks', label: 'Blocks', icon: ['fas', 'quote-left'], title: 'Blocks and divider' },
      { id: 'table', label: 'Table', icon: ['fas', 'table'], title: 'Insert or edit table' },
      { id: 'record', label: 'Record', icon: ['fas', 'microphone'], title: 'Record audio note' },
    ] as const;
  }

  if (editorToolbarMode.value === 'controls') {
    return [
      { id: 'history', label: 'History', icon: ['fas', 'rotate-left'], title: 'Undo, redo, clear formatting' },
    ] as const;
  }

  return [
    { id: 'type', label: 'Type', icon: ['fas', 'heading'], title: 'Block type and size' },
    { id: 'marks', label: 'Marks', icon: ['fas', 'bold'], title: 'Inline formatting' },
    { id: 'color', label: 'Color', icon: ['fas', 'palette'], title: 'Text and highlight color' },
  ] as const;
});

const accountLabel = computed(() =>
  store.syncConfig.userEmail ||
  store.syncConfig.userName ||
  (store.syncConfig.connected ? 'Connected' : 'Local only'),
);

const workspaceLabel = computed(() =>
  store.syncConfig.workspaceName
    ? `Workspace: ${store.syncConfig.workspaceName}`
    : 'No workspace selected',
);

const parentPageLabel = computed(() =>
  store.syncConfig.selectedParentPageTitle ||
  (store.syncConfig.selectedParentPageId ? 'Selected Notion page' : 'Default Inkwell root page'),
);

const hasInlineMessage = computed(() => Boolean(uiMessage.value || store.errorMessage));

const editorContextMenuSourceHost = computed(() => {
  const payload = editorContextMenuSource.value;
  const sourceUrl = payload ? safeInkwellSourceUrl(payload) : null;

  try {
    return sourceUrl ? new URL(sourceUrl).hostname.replace(/^www\./, '') : '';
  } catch {
    return '';
  }
});

const activeBlockType = computed(() => {
  editorStateVersion.value;

  if (!editor.value) {
    return 'paragraph';
  }

  for (const level of [1, 2, 3, 4, 5, 6]) {
    if (editor.value.isActive('heading', { level })) {
      return `heading-${level}`;
    }
  }

  if (editor.value.isActive('blockquote')) {
    return 'blockquote';
  }

  if (editor.value.isActive('codeBlock')) {
    return 'codeBlock';
  }

  return 'paragraph';
});

const activeFontSize = computed(() => {
  editorStateVersion.value;
  return String(editor.value?.getAttributes('textStyle').fontSize ?? '');
});

const activeTextColor = computed(() => {
  editorStateVersion.value;
  return String(editor.value?.getAttributes('textStyle').color ?? '');
});

const activeHighlightColor = computed(() => {
  editorStateVersion.value;
  return String(editor.value?.getAttributes('textStyle').backgroundColor ?? '');
});
const isTableActive = computed(() => {
  editorStateVersion.value;
  return editor.value?.isActive('table') ?? false;
});

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
  void initializePanel();
});

watch(
  interfaceScale,
  (scale) => {
    document.documentElement.style.setProperty(
      '--inkwell-base-font-size',
      `${14 * scale / 100}px`,
    );
  },
  { immediate: true },
);

onBeforeUnmount(() => {
  window.clearTimeout(saveTimer.value);
  window.clearInterval(sessionPollTimer);
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
  () => store.currentPage,
  (page) => {
    hideEditorContextMenu();

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
    isApplyingStoredContent = true;
    editor.value.commands.setContent(page.content, { emitUpdate: false });
    isApplyingStoredContent = false;
  },
);

watch(
  () => store.currentPage?.title,
  (title) => {
    pageTitleDraft.value = title ?? '';
  },
);

watch(
  () => store.currentProject?.name,
  (name) => {
    projectNameDraft.value = name ?? '';
  },
  { immediate: true },
);

watch(
  () => store.currentProject,
  (project) => {
    projectNameDraft.value = project?.name ?? '';
    projectCategoryDraft.value = project?.category ?? '';
  },
  { immediate: true },
);

watch(
  () => store.syncConfig.serverUrl,
  (serverUrl) => {
    serverUrlDraft.value = serverUrl;
  },
  { immediate: true },
);

watch(
  () => store.syncConfig.connected,
  (connected) => {
    if (connected && activeTab.value === 'settings') {
      void store.loadNotionParentPages(parentPageSearchDraft.value);
    }
  },
);

watch(
  activeTab,
  (tab) => {
    hideEditorContextMenu();

    if (tab === 'settings' && store.syncConfig.connected) {
      void store.loadNotionParentPages(parentPageSearchDraft.value);
    }
  },
);

async function initializePanel() {
  await store.initialize();
}

/** Loads the persisted legal-consent flag before enabling the Notion sign-in action. */
async function loadLegalAcceptance() {
  hasAcceptedLegalTerms.value = await hasAcceptedCurrentLegalTerms();
  isLegalAcceptanceLoaded.value = true;
}

/** Restores user preferences that affect the side panel's initial presentation. */
async function loadPreferences() {
  const preferences = await loadUserPreferences();
  interfaceScale.value = preferences.interfaceScale;
}

/** Normalizes a slider value so interface-scale previews always remain within supported bounds. */
function previewInterfaceScale(event: Event) {
  interfaceScale.value = normalizeInterfaceScale(
    Number((event.target as HTMLInputElement).value),
  );
}

/** Persists the selected interface scale and applies the normalized value returned by storage. */
async function persistInterfaceScale() {
  const preferences = await saveUserPreferences({
    interfaceScale: interfaceScale.value,
  });
  interfaceScale.value = preferences.interfaceScale;
}

function setInterfaceScale(scale: number) {
  interfaceScale.value = normalizeInterfaceScale(scale);
  void persistInterfaceScale();
}

/** Inserts captured browser content at the current cursor, then saves its document content and source metadata together. */
async function insertCaptureAtCursor(payload: CaptureSelectionPayload) {
  if (!editor.value || !store.currentPage) {
    return false;
  }

  const capturedContent = createCapturedContent(payload);
  shouldSkipNextUpdateSave = true;
  editor.value.chain().focus().insertContent(capturedContent).run();
  queueMicrotask(() => {
    shouldSkipNextUpdateSave = false;
  });
  await Promise.all([
    saveEditorContentOptimistically(),
    registerCapturedSource(capturedContent, payload),
  ]);
  return true;
}

/** Saves the current editor snapshot and starts flushing remote work before changing pages. */
async function selectPage(pageId: string) {
  if (!pageId || pageId === store.currentPage?.id) {
    return;
  }

  await saveEditorContentInBackground();
  void notionClient.flushPendingSyncOps({ force: true }).catch(() => undefined);
  await store.selectPage(pageId);
}

/** Saves the current editor snapshot and starts flushing remote work before changing projects. */
async function selectProject(projectId: string) {
  if (!projectId || projectId === store.currentProjectId) {
    return;
  }

  await saveEditorContentInBackground();
  void notionClient.flushPendingSyncOps({ force: true }).catch(() => undefined);
  await store.selectProject(projectId);
}

/** Flushes the open page before creating a named project from the projects-panel draft. */
async function createProject() {
  await flushEditorContent();
  const name = newProjectNameDraft.value.trim() || 'Untitled Project';
  await store.createProject(name);
  newProjectNameDraft.value = '';
  activeTab.value = 'editor';
}

/** Creates an untitled project from the header after ensuring the open page has been saved. */
async function createQuickProject() {
  await flushEditorContent();
  await store.createProject('Untitled Project');
  activeTab.value = 'editor';
}

/** Persists a changed project name without issuing a redundant store update. */
async function renameProject() {
  if (!store.currentProject || projectNameDraft.value === store.currentProject.name) {
    return;
  }

  await flushEditorContent();
  await store.renameCurrentProject(projectNameDraft.value);
}

/** Saves changed project metadata only after pending editor content has been flushed. */
async function saveProjectMetadata() {
  const project = store.currentProject;

  if (!project) {
    return;
  }

  if (projectCategoryDraft.value === (project.category ?? '')) {
    return;
  }

  await flushEditorContent();
  await store.updateCurrentProjectMetadata({
    category: projectCategoryDraft.value,
  });
}

/** Stages the current project for confirmation rather than deleting it immediately. */
async function archiveProject() {
  if (!store.currentProject) {
    return;
  }

  archiveTarget.value = {
    kind: 'project',
    id: store.currentProject.id,
    title: store.currentProject.name,
  };
}

async function createPage() {
  await flushEditorContent();
  await store.createPage();
}

/** Flushes page content before committing a title change against the still-active page. */
async function renamePage() {
  if (!store.currentPage) {
    return;
  }

  const title = pageTitleDraft.value;

  await flushEditorContent();

  if (!store.currentPage || title === store.currentPage.title) {
    return;
  }

  await store.renameCurrentPage(title);
}

/** Stages the current page for confirmation rather than deleting it immediately. */
async function archivePage() {
  if (!store.currentPage) {
    return;
  }

  archiveTarget.value = {
    kind: 'page',
    id: store.currentPage.id,
    title: store.currentPage.title,
  };
}

/** Executes the staged archive only when its target is still the active project or page. */
async function confirmArchive() {
  if (!archiveTarget.value) {
    return;
  }

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

/** Pushes pending local changes when present; otherwise reloads the workspace from Notion. */
async function resync() {
  await flushEditorContent();
  const hadPendingLocalChanges = await notionClient.pendingSyncEventCount() > 0;
  await store.syncPendingChanges();

  if (hadPendingLocalChanges) {
    uiMessage.value = 'Changes sent to Notion. They may take a moment to appear.';
    return;
  }

  await store.reloadFromNotion();
  uiMessage.value = 'Up to date with Notion.';
}

/** Records legal acceptance, opens the Notion authorization flow, and begins polling for its session. */
async function loginWithNotion() {
  if (!hasAcceptedLegalTerms.value) {
    uiMessage.value = 'Review and accept the Terms and Privacy Policy before connecting Notion.';
    return;
  }

  await storeCurrentLegalAcceptance();
  isSigningIn.value = true;
  await browser.tabs.create({ active: true, url: store.getSyncLoginUrl() });
  startSessionPolling();
}

function openLegalUrl(url: string) {
  void browser.tabs.create({ active: true, url });
}

/** Stops authorization polling, clears the sync session, and returns the user to sync settings. */
async function logout() {
  window.clearInterval(sessionPollTimer);
  isSigningIn.value = false;
  await store.logout();
  activeTab.value = 'settings';
}

function openLinkTools() {
  linkUrlDraft.value = String(editor.value?.getAttributes('link').href ?? '');
}

function setEditorToolbarMode(mode: typeof editorToolbarModes[number]['id']) {
  if (mode === 'insert') {
    editorToolbarMode.value = mode;
    activeEditorMenu.value = activeEditorMenu.value === 'media' ? null : 'media';
    return;
  }

  editorToolbarMode.value = mode;
  activeEditorMenu.value =
    mode === 'controls' ? 'history' : 'type';
}

/** Opens or closes a toolbar panel while keeping link and recording state consistent. */
function toggleEditorMenu(menu: NonNullable<typeof activeEditorMenu.value>) {
  const closing = activeEditorMenu.value === menu;
  activeEditorMenu.value = closing ? null : menu;

  if (activeEditorMenu.value === 'link') {
    openLinkTools();
  }

  if (closing && menu === 'record' && recordingPhase.value === 'recording') {
    audioRecorder?.stop();
  }
}

function closeEditorMenu() {
  activeEditorMenu.value = null;
}

/** Validates and saves the custom synchronization server entered in advanced settings. */
async function saveServerUrl() {
  const serverUrl = serverUrlDraft.value.trim();

  if (!serverUrl) {
    uiMessage.value = 'Enter a sync server URL.';
    return;
  }

  await store.updateServerUrl(serverUrl);
  uiMessage.value = '';
}

async function searchParentPages() {
  await store.loadNotionParentPages(parentPageSearchDraft.value);
}

/** Creates a Notion destination page from the draft and clears the draft after success. */
async function createParentPage() {
  const title = parentPageTitleDraft.value.trim() || 'Inkwell';
  await store.createNotionParentPage(title);
  parentPageTitleDraft.value = '';
}

async function selectParentPage(pageId: string) {
  await store.selectNotionParentPage(pageId);
}

/** Polls the extension session until Notion connects or the authorization attempt times out. */
function startSessionPolling() {
  window.clearInterval(sessionPollTimer);
  let attempts = 0;

  sessionPollTimer = window.setInterval(() => {
    attempts += 1;
    void store.refreshSyncSession().then(() => {
      if (store.syncConfig.connected || attempts >= 30) {
        window.clearInterval(sessionPollTimer);
        isSigningIn.value = false;
      }
    });
  }, 2000);
}

function blurTitleInput(event: Event) {
  (event.target as HTMLInputElement).blur();
}

function closeSwitcher(event: Event) {
  (event.currentTarget as HTMLElement).closest('details')?.removeAttribute('open');
}

function setBlockType(event: Event) {
  applyBlockType((event.target as HTMLSelectElement).value);
}

function setContextBlockType(event: Event) {
  restoreEditorContextSelection();
  applyBlockType((event.target as HTMLSelectElement).value);
}

/** Runs a TipTap formatting command and immediately persists successful document changes. */
function runEditorFormattingCommand(command: () => boolean | undefined) {
  const didRun = command() ?? false;

  if (!didRun) {
    return;
  }

  window.clearTimeout(saveTimer.value);
  void saveEditorContentOptimistically();
}

/** Maps the toolbar's block identifier to the corresponding TipTap block command. */
function applyBlockType(value: string) {
  if (value === 'paragraph') {
    runEditorFormattingCommand(() => editor.value?.chain().focus().setParagraph().run());
    return;
  }

  if (value.startsWith('heading-')) {
    runEditorFormattingCommand(() =>
      editor.value
        ?.chain()
        .focus()
        .toggleHeading({ level: Number(value.replace('heading-', '')) as 1 | 2 | 3 | 4 | 5 | 6 })
        .run(),
    );
    return;
  }

  if (value === 'blockquote') {
    runEditorFormattingCommand(() => editor.value?.chain().focus().toggleBlockquote().run());
    return;
  }

  if (value === 'codeBlock') {
    runEditorFormattingCommand(() => editor.value?.chain().focus().toggleCodeBlock().run());
  }
}

function setFontSize(event: Event) {
  applyFontSize((event.target as HTMLSelectElement).value);
}

function setContextFontSize(event: Event) {
  restoreEditorContextSelection();
  applyFontSize((event.target as HTMLSelectElement).value);
}

/** Applies a font-size mark, or removes the mark when the default option is selected. */
function applyFontSize(value: string) {
  if (value) {
    runEditorFormattingCommand(() => editor.value?.chain().focus().setFontSize(value).run());
  } else {
    runEditorFormattingCommand(() => editor.value?.chain().focus().unsetFontSize().run());
  }
}

function setTextColor(event: Event) {
  applyTextColor((event.target as HTMLSelectElement).value);
}

function applyContextTextColor(value: string) {
  restoreEditorContextSelection();
  applyTextColor(value);
}

/** Applies a text-color mark, or removes it when the default option is selected. */
function applyTextColor(value: string) {
  if (value) {
    runEditorFormattingCommand(() => editor.value?.chain().focus().setTextColor(value).run());
  } else {
    runEditorFormattingCommand(() => editor.value?.chain().focus().unsetTextColor().run());
  }
}

function setHighlightColor(event: Event) {
  applyHighlightColor((event.target as HTMLSelectElement).value);
}

function applyContextHighlightColor(value: string) {
  restoreEditorContextSelection();
  applyHighlightColor(value);
}

/** Applies a highlight mark, or removes it when the none option is selected. */
function applyHighlightColor(value: string) {
  if (value) {
    runEditorFormattingCommand(() => editor.value?.chain().focus().setHighlightColor(value).run());
  } else {
    runEditorFormattingCommand(() => editor.value?.chain().focus().unsetHighlightColor().run());
  }
}

function setLink() {
  applyLink(linkUrlDraft.value);
  linkUrlDraft.value = '';
}

function applyContextLink() {
  restoreEditorContextSelection();
  applyLink(contextMenuLinkDraft.value);
  contextMenuLinkDraft.value = '';
  hideEditorContextMenu();
}

function removeContextLink() {
  restoreEditorContextSelection();
  applyLink('');
  contextMenuLinkDraft.value = '';
  hideEditorContextMenu();
}

/** Validates, applies, or removes a link while preserving source-link metadata rules. */
function applyLink(href: string) {
  if (!editor.value) {
    return;
  }

  const trimmedHref = href.trim();

  if (!trimmedHref) {
    runEditorFormattingCommand(() =>
      editor.value?.chain().focus().extendMarkRange('link').unsetLink().run(),
    );
    return;
  }

  runEditorFormattingCommand(() =>
    editor.value
      ?.chain()
      .focus()
      .extendMarkRange('link')
      .setLink({ href: trimmedHref })
      .run(),
  );
}

/** Captures the clicked editor selection and source context before opening the custom context menu. */
function showEditorContextMenu(view: EditorView, event: MouseEvent) {
  event.preventDefault();
  event.stopPropagation();
  closeEditorMenu();

  const pos = view.posAtCoords({
    left: event.clientX,
    top: event.clientY,
  });

  if (pos) {
    const { selection } = view.state;
    const shouldPreserveSelection =
      !selection.empty &&
      pos.pos >= selection.from &&
      pos.pos <= selection.to;

    if (!shouldPreserveSelection) {
      const resolvedPos = view.state.doc.resolve(pos.pos);
      view.dispatch(view.state.tr.setSelection(TextSelection.near(resolvedPos)));
    }
  }

  view.focus();
  editorContextSelection = {
    from: view.state.selection.from,
    to: view.state.selection.to,
  };
  editorContextMenuHasSelection.value = !view.state.selection.empty;
  editorContextMenuSource.value = sourceForEditorContext(view, pos?.pos);
  contextMenuLinkDraft.value = String(editor.value?.getAttributes('link').href ?? '');
  editorContextMenuPanel.value = 'main';
  editorContextMenu.value = {
    visible: true,
    left: clamp(event.clientX, 8, Math.max(8, window.innerWidth - 320)),
    top: clamp(event.clientY, 8, Math.max(8, window.innerHeight - 48)),
  };

  void nextTick(() => {
    placeEditorContextMenu(event.clientX, event.clientY);
  });
}

/** Positions the context menu inside the viewport after its rendered dimensions are known. */
function placeEditorContextMenu(clientX: number, clientY: number) {
  const menu = editorContextMenuRef.value;

  if (!menu) {
    return;
  }

  const rect = menu.getBoundingClientRect();
  editorContextMenu.value = {
    ...editorContextMenu.value,
    left: clamp(clientX, 8, Math.max(8, window.innerWidth - rect.width - 8)),
    top: clamp(clientY, 8, Math.max(8, window.innerHeight - rect.height - 8)),
  };
}

/** Restores the selection captured when the context menu opened so commands target the intended text. */
function restoreEditorContextSelection() {
  if (!editor.value || !editorContextSelection) {
    return;
  }

  const docSize = editor.value.state.doc.content.size;
  const from = clamp(editorContextSelection.from, 0, docSize);
  const to = clamp(editorContextSelection.to, from, docSize);
  editor.value.commands.setTextSelection({ from, to });
}

function hideEditorContextMenu() {
  editorContextMenu.value.visible = false;
  editorContextMenuSource.value = null;
  editorContextMenuPanel.value = 'main';
}

/** Finds the most relevant captured-source payload for the selected or clicked editor content. */
function sourceForEditorContext(view: EditorView, clickedPosition?: number) {
  const sources = new Map<string, SourceOpenPayload>();
  const blockIds = new Set<string>();
  const { from, to, empty } = view.state.selection;

  if (!empty) {
    view.state.doc.nodesBetween(from, to, (node) => {
      collectNodeSources(node, sources, blockIds);
      return true;
    });
  }

  collectProjectStateSources(blockIds, sources);

  if (sources.size === 1) {
    return sources.values().next().value ?? null;
  }

  if (sources.size > 1 || typeof clickedPosition !== 'number') {
    return null;
  }

  const resolved = view.state.doc.resolve(
    clamp(clickedPosition, 0, view.state.doc.content.size),
  );

  for (let depth = resolved.depth; depth >= 0; depth -= 1) {
    collectNodeSources(resolved.node(depth), sources, blockIds);
  }

  collectNodeSources(resolved.nodeBefore, sources, blockIds);
  collectNodeSources(resolved.nodeAfter, sources, blockIds);
  collectProjectStateSources(blockIds, sources);

  return sources.size === 1 ? sources.values().next().value ?? null : null;
}

/** Recursively collects source payloads and block IDs from a document node tree. */
function collectNodeSources(
  node: { attrs?: Record<string, unknown>; marks?: readonly { attrs?: Record<string, unknown> }[] } | null,
  sources: Map<string, SourceOpenPayload>,
  blockIds: Set<string>,
) {
  if (!node) {
    return;
  }

  collectSource(node.attrs?.[INKWELL_SOURCE_ATTR], sources);
  const blockId = node.attrs?.inkwellBlockId;
  if (typeof blockId === 'string' && blockId) {
    blockIds.add(blockId);
  }

  for (const mark of node.marks ?? []) {
    collectSource(mark.attrs?.[INKWELL_SOURCE_ATTR], sources);
  }
}

/** Resolves source payloads for collected block IDs from the current project's registry. */
function collectProjectStateSources(
  blockIds: Set<string>,
  sources: Map<string, SourceOpenPayload>,
) {
  for (const blockId of blockIds) {
    collectSource(
      sourceFromProjectState(store.currentProject?.stateContent, blockId),
      sources,
    );
  }
}

/** Adds an accessible source payload once, using its serialized value for deduplication. */
function collectSource(
  value: unknown,
  sources: Map<string, SourceOpenPayload>,
) {
  const payload = decodeInkwellSource(value);

  if (!isAccessibleInkwellSource(payload) || !payload) {
    return;
  }

  const key = [
    payload.sourceUrl,
    payload.highlightMeta.xpath,
    payload.highlightMeta.offset,
    payload.highlightMeta.text,
  ].join('\n');
  sources.set(key, payload);
}

/** Requests that the browser open the original location represented by the context-menu source. */
async function openEditorContextSource() {
  const payload = editorContextMenuSource.value;

  if (!payload || !isAccessibleInkwellSource(payload)) {
    return;
  }

  hideEditorContextMenu();

  await browser.runtime.sendMessage({
    type: 'inkwell.openSourceRequest',
    payload,
  } satisfies OpenSourceRequestMessage).catch(async () => {
    const url = safeInkwellSourceUrl(payload);
    if (url) {
      await browser.tabs.create({ active: true, url });
    }
  });
}

/** Dismisses the custom editor menu when a pointer interaction occurs outside it. */
function handleEditorContextMenuPointerDown(event: PointerEvent) {
  if (!editorContextMenu.value.visible) {
    return;
  }

  const target = event.target;

  if (target instanceof Node && editorContextMenuRef.value?.contains(target)) {
    return;
  }

  hideEditorContextMenu();
}

/** Dismisses the custom editor menu when the user presses Escape. */
function handleEditorContextMenuKeydown(event: KeyboardEvent) {
  if (event.key === 'Escape' && editorContextMenu.value.visible) {
    event.preventDefault();
    hideEditorContextMenu();
  }
}

/** Copies the current editor selection and optionally closes the context menu after success. */
async function copyEditorSelectionToClipboard(closeAfterCopy = true) {
  const selectedText = getEditorSelectedText();

  if (!selectedText) {
    return;
  }

  await navigator.clipboard.writeText(selectedText);

  if (closeAfterCopy) {
    hideEditorContextMenu();
  }
}

async function copyEditorSelectionFromContextMenu() {
  await copyEditorSelectionToClipboard();
}

/** Copies selected text, deletes it from the editor, and persists the resulting document. */
async function cutEditorSelectionToClipboard() {
  if (!editor.value) {
    return;
  }

  restoreEditorContextSelection();

  if (editor.value.state.selection.empty) {
    return;
  }

  await copyEditorSelectionToClipboard(false);
  editor.value.chain().focus().deleteSelection().run();
  hideEditorContextMenu();
}

/** Reads plain text from the clipboard, replaces the current selection, and persists the result. */
async function pasteClipboardTextIntoEditor() {
  if (!editor.value) {
    return;
  }

  const text = await navigator.clipboard.readText();

  if (!text) {
    return;
  }

  restoreEditorContextSelection();
  editor.value.chain().focus().insertContent(text).run();
  hideEditorContextMenu();
}

/** Extracts selected plain text while preserving block separators for clipboard operations. */
function getEditorSelectedText() {
  if (!editor.value) {
    return '';
  }

  restoreEditorContextSelection();
  const { from, to, empty } = editor.value.state.selection;

  if (empty) {
    return '';
  }

  return editor.value.state.doc.textBetween(from, to, '\n').trimEnd();
}

function runContextMarkCommand(command: 'bold' | 'italic' | 'underline' | 'strike' | 'code') {
  restoreEditorContextSelection();
  runEditorMarkCommand(command);
}

/** Maps a toolbar mark identifier to its TipTap toggle command. */
function runEditorMarkCommand(command: 'bold' | 'italic' | 'underline' | 'strike' | 'code' | 'superscript' | 'subscript') {
  const commands = {
    bold: () => editor.value?.chain().focus().toggleBold().run(),
    italic: () => editor.value?.chain().focus().toggleItalic().run(),
    underline: () => editor.value?.chain().focus().toggleUnderline().run(),
    strike: () => editor.value?.chain().focus().toggleStrike().run(),
    code: () => editor.value?.chain().focus().toggleCode().run(),
    superscript: () => editor.value?.chain().focus().toggleSuperscript().run(),
    subscript: () => editor.value?.chain().focus().toggleSubscript().run(),
  };

  runEditorFormattingCommand(commands[command]);
}

/** Maps a toolbar list identifier to its TipTap list command. */
function runEditorListCommand(command: 'bullet' | 'ordered' | 'task') {
  const commands = {
    bullet: () => editor.value?.chain().focus().toggleBulletList().run(),
    ordered: () => editor.value?.chain().focus().toggleOrderedList().run(),
    task: () => editor.value?.chain().focus().toggleTaskList().run(),
  };

  runEditorFormattingCommand(commands[command]);
}

/** Maps a toolbar block identifier to its TipTap block toggle. */
function runEditorBlockCommand(command: 'blockquote' | 'codeBlock') {
  const commands = {
    blockquote: () => editor.value?.chain().focus().toggleBlockquote().run(),
    codeBlock: () => editor.value?.chain().focus().toggleCodeBlock().run(),
  };

  runEditorFormattingCommand(commands[command]);
}

/** Inserts a table or changes its rows, columns, and headers. */
function runEditorTableCommand(
  command:
    | 'insert'
    | 'addRow'
    | 'deleteRow'
    | 'addColumn'
    | 'deleteColumn'
    | 'toggleHeaderRow'
    | 'toggleHeaderColumn'
    | 'deleteTable',
) {
  const commands = {
    insert: () => editor.value?.chain().focus().insertTable({
      rows: 3,
      cols: 3,
      withHeaderRow: true,
    }).run(),
    addRow: () => editor.value?.chain().focus().addRowAfter().run(),
    deleteRow: () => editor.value?.chain().focus().deleteRow().run(),
    addColumn: () => editor.value?.chain().focus().addColumnAfter().run(),
    deleteColumn: () => editor.value?.chain().focus().deleteColumn().run(),
    toggleHeaderRow: () => editor.value?.chain().focus().toggleHeaderRow().run(),
    toggleHeaderColumn: () => editor.value?.chain().focus().toggleHeaderColumn().run(),
    deleteTable: () => editor.value?.chain().focus().deleteTable().run(),
  };

  runEditorFormattingCommand(commands[command]);
}

function openContextLinkPanel() {
  restoreEditorContextSelection();
  contextMenuLinkDraft.value = String(editor.value?.getAttributes('link').href ?? '');
  editorContextMenuPanel.value = 'link';
}

function clamp(value: number, min: number, max: number) {
  return Math.min(Math.max(value, min), max);
}

/** Validates and inserts the selected remote media type, then persists the editor change. */
function insertMedia() {
  const src = mediaUrlDraft.value.trim();
  if (!src) {
    return;
  }

  if (mediaKind.value === 'video') {
    const inserted = editor.value?.chain().focus().setYoutubeVideo({ src }).run();

    if (!inserted) {
      uiMessage.value = 'Paste a YouTube video URL.';
      return;
    }
  } else if (mediaKind.value === 'audio') {
    if (!isHttpAudioUrl(src)) {
      uiMessage.value = 'Paste a public http(s) URL to an MP3 or audio file.';
      return;
    }

    editor.value?.chain().focus().setAudio({ src }).run();
  } else {
    editor.value?.chain().focus().setImage({ src }).run();
  }

  uiMessage.value = '';
  mediaUrlDraft.value = '';
  activeEditorMenu.value = null;
  void saveEditorContentOptimistically();
}

function toggleSettings() {
  activeTab.value = activeTab.value === 'settings' ? 'editor' : 'settings';
}

/** Starts an idle recording or stops the currently active MediaRecorder. */
function toggleAudioRecording() {
  if (recordingPhase.value === 'recording') {
    audioRecorder?.stop();
    return;
  }
  if (recordingPhase.value === 'idle') {
    void startAudioRecording();
  }
}

/** Requests microphone access, records supported audio, and inserts the completed recording into the page. */
async function startAudioRecording() {
  if (!editor.value || recordingPhase.value !== 'idle') return;

  if (!navigator.mediaDevices?.getUserMedia) {
    uiMessage.value = 'Audio recording is not available in this browser.';
    return;
  }

  recordingPhase.value = 'requesting_permission';

  try {
    const permState = await navigator.permissions
      .query({ name: 'microphone' as PermissionName })
      .then((r) => r.state)
      .catch(() => 'prompt' as PermissionState);

    if (permState === 'denied') {
      uiMessage.value =
        'Microphone access is blocked. Open Chrome settings → Privacy → Site settings → Microphone and allow this extension.';
      recordingPhase.value = 'idle';
      return;
    }

    audioStream.value = await navigator.mediaDevices.getUserMedia({ audio: true });
    audioChunks = [];
    const mimeType = preferredAudioRecordingMimeType();
    audioRecorder = new MediaRecorder(
      audioStream.value,
      mimeType ? { mimeType } : undefined,
    );

    audioRecorder.addEventListener('dataavailable', (event) => {
      if (event.data.size > 0) {
        audioChunks.push(event.data);
      }
    });

    audioRecorder.addEventListener('stop', () => {
      recordingPhase.value = 'processing';
      const recorderMimeType = audioRecorder?.mimeType || mimeType || 'audio/webm';
      const audioBlob = new Blob(audioChunks, { type: recorderMimeType });
      const extension = audioExtensionFromMimeType(recorderMimeType);
      const now = new Date();
      const date = now.toLocaleDateString('en-CA');
      const hh = String(now.getHours()).padStart(2, '0');
      const mm = String(now.getMinutes()).padStart(2, '0');
      const filename = `Recording ${date} ${hh}.${mm}.${extension}`;
      const file = new File([audioBlob], filename, { type: recorderMimeType });
      audioRecorder = undefined;
      audioChunks = [];
      stopAudioStream();
      void handleUploadableAudioFile(file).finally(() => {
        recordingPhase.value = 'idle';
      });
    });

    audioRecorder.start();
    recordingPhase.value = 'recording';
  } catch (error) {
    const name = error instanceof DOMException ? error.name : '';
    if (name === 'NotAllowedError') {
      uiMessage.value =
        'Microphone access was denied or dismissed. Look for the permission prompt in the Chrome toolbar and click Allow, then try again.';
    } else {
      uiMessage.value =
        error instanceof Error ? error.message : 'Unable to start audio recording.';
    }
    stopAudioStream();
    recordingPhase.value = 'idle';
  }
}

/** Moves the editor selection to the document position nearest a drag-and-drop coordinate. */
function moveEditorSelectionToDrop(view: EditorView, event: DragEvent) {
  const dropPos = view.posAtCoords({ left: event.clientX, top: event.clientY });

  if (typeof dropPos?.pos === 'number') {
    view.dispatch(
      view.state.tr.setSelection(
        TextSelection.near(view.state.doc.resolve(dropPos.pos)),
      ),
    );
  }
}

/** Moves an existing image node to a block boundary while preserving its attributes and selection. */
function moveImageNodeAtDrop(
  view: EditorView,
  event: DragEvent,
  payload: InkwellImageMovePayload,
): boolean {
  const imageType = view.state.schema.nodes.image;
  const source = findImageMoveSource(view, payload);
  const dropPos = view.posAtCoords({ left: event.clientX, top: event.clientY });

  if (!imageType || !source || typeof dropPos?.pos !== 'number') {
    return false;
  }

  const sourceFrom = source.pos;
  const sourceTo = sourceFrom + source.node.nodeSize;

  if (dropPos.pos >= sourceFrom && dropPos.pos <= sourceTo) {
    view.dispatch(
      view.state.tr.setSelection(NodeSelection.create(view.state.doc, sourceFrom)),
    );
    return true;
  }

  const rawInsertPos = imageBlockInsertPos(view.state.doc, dropPos.pos);
  const movedNode = imageType.create(payload.attrs);
  const insertPos = clampDocumentPosition(
    dropPos.pos > sourceFrom ? rawInsertPos - source.node.nodeSize : rawInsertPos,
    view.state.doc.content.size - source.node.nodeSize,
  );
  const tr = view.state.tr.delete(sourceFrom, sourceTo).insert(insertPos, movedNode);

  if (tr.doc.nodeAt(insertPos)?.type === imageType) {
    tr.setSelection(NodeSelection.create(tr.doc, insertPos));
  } else {
    tr.setSelection(TextSelection.near(tr.doc.resolve(insertPos)));
  }

  view.dispatch(tr.scrollIntoView());
  return true;
}

/** Chooses the nearest edge of the surrounding top-level block for an image insertion. */
function imageBlockInsertPos(doc: EditorView['state']['doc'], pos: number) {
  const safePos = clampDocumentPosition(pos, doc.content.size);
  const $pos = doc.resolve(safePos);

  if ($pos.depth === 0) {
    return safePos;
  }

  const blockStart = $pos.before(1);
  const blockEnd = $pos.after(1);
  const blockMiddle = blockStart + (blockEnd - blockStart) / 2;

  return safePos <= blockMiddle ? blockStart : blockEnd;
}

function clampDocumentPosition(pos: number, max: number) {
  return Math.min(Math.max(pos, 0), Math.max(max, 0));
}

/** Recovers a move payload when Chromium exposes a selected extension image as a blob drag. */
function readSelectedImageMovePayload(
  view: EditorView,
  event: DragEvent,
): InkwellImageMovePayload | null {
  const { selection } = view.state;

  if (
    !(selection instanceof NodeSelection) ||
    selection.node.type !== view.state.schema.nodes.image ||
    !isChromeExtensionBlobImageDrop(event)
  ) {
    return null;
  }

  return {
    kind: 'image',
    pos: selection.from,
    attrs: selection.node.attrs,
  };
}

/** Detects Chromium's blob-based drag representation for extension-owned images. */
function isChromeExtensionBlobImageDrop(event: DragEvent) {
  const plainText = event.dataTransfer?.getData('text/plain') ?? '';
  const html = event.dataTransfer?.getData('text/html') ?? '';

  return (
    /^blob:chrome-extension:\/\//i.test(plainText.trim()) ||
    /\bsrc\s*=\s*(?:"blob:chrome-extension:\/\/|'blob:chrome-extension:\/\/|blob:chrome-extension:\/\/)/i.test(
      html,
    )
  );
}

/** Locates a dragged image by position, stable block ID, or source URL. */
function findImageMoveSource(view: EditorView, payload: InkwellImageMovePayload) {
  const imageType = view.state.schema.nodes.image;
  const nodeAtPayloadPos = view.state.doc.nodeAt(payload.pos);

  if (nodeAtPayloadPos?.type === imageType) {
    return { pos: payload.pos, node: nodeAtPayloadPos };
  }

  const payloadBlockId = String(payload.attrs.inkwellBlockId ?? '');
  const payloadSrc = String(payload.attrs.src ?? '');
  let fallback: { pos: number; node: NonNullable<typeof nodeAtPayloadPos> } | null = null;

  view.state.doc.descendants((node, pos) => {
    if (fallback || node.type !== imageType) {
      return true;
    }

    if (payloadBlockId && node.attrs.inkwellBlockId === payloadBlockId) {
      fallback = { pos, node };
      return false;
    }

    if (payloadSrc && node.attrs.src === payloadSrc) {
      fallback = { pos, node };
      return false;
    }

    return true;
  });

  return fallback;
}

function clearFormatting() {
  runEditorFormattingCommand(() => editor.value?.chain().focus().unsetAllMarks().clearNodes().run());
}

/** Cancels the debounce timer and waits for the latest editor content to be saved. */
async function flushEditorContent() {
  window.clearTimeout(saveTimer.value);

  await saveEditorContentOptimistically();
}

/** Stores a best-effort page snapshot without replacing newer local state during panel transitions. */
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

function handleVisibilityChange() {
  if (document.visibilityState === 'hidden') {
    handlePanelExit();
  }
}

/** Starts a final local save and forced remote flush when the panel is hidden or unloaded. */
function handlePanelExit() {
  void saveEditorContentInBackground()
    .catch(() => undefined)
    .finally(() => {
      void notionClient.flushPendingSyncOps({ force: true }).catch(() => undefined);
    });
}

/** Serializes overlapping save requests so edits made during an active save trigger another pass. */
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

/** Persists editor snapshots until no newer change arrived during the preceding save. */
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

/** Uploads media when sync is available and returns the Notion upload identifier for the editor node. */
async function uploadMediaFile(file: File, label: string): Promise<string> {
  queueMicrotask(() => {
    shouldSkipNextUpdateSave = false;
  });

  let fileUploadId = '';

  if (!store.syncConfig.connected || !store.isOnline) {
    return fileUploadId;
  }

  try {
    fileUploadId = await notionClient.uploadMedia(file, file.type, file.name);
  } catch (error) {
    uiMessage.value =
      error instanceof Error ? error.message : `Unable to upload this ${label} to Notion.`;
  }

  return fileUploadId;
}

/** Rewrites a matching media node with its completed upload ID or local-only status. */
function updateMediaNodeUploadState(
  editorInstance: typeof editor.value,
  nodeTypeName: string,
  localSrc: string,
  fileUploadId: string,
) {
  shouldSkipNextUpdateSave = true;
  editorInstance?.state.doc.descendants((node, pos) => {
    if (node.type.name === nodeTypeName && node.attrs.src === localSrc) {
      editorInstance
        ?.chain()
        .command(({ tr }) => {
          tr.setNodeMarkup(pos, undefined, {
            ...node.attrs,
            ...(fileUploadId ? { notionFileUploadId: fileUploadId } : {}),
            uploadState: fileUploadId ? 'done' : 'local',
          });
          return true;
        })
        .run();
    }
  });
  queueMicrotask(() => {
    shouldSkipNextUpdateSave = false;
  });
}

/** Validates a dropped image, inserts a local preview, uploads it, and updates the node's sync state. */
async function handleUploadableImageDrop(info: { kind: 'file'; file: File }): Promise<void> {
  const { file } = info;

  if (!isUploadableImageFile(file)) {
    uiMessage.value = `Images must be ${Math.floor(IMAGE_UPLOAD_MAX_BYTES / 1024 / 1024)} MB or smaller.`;
    return;
  }

  const localSrc = await fileToDataUrl(file);
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  shouldSkipNextUpdateSave = true;
  editor.value?.chain().focus().setImage({
    src: localSrc,
    uploadState: store.syncConfig.connected && store.isOnline ? 'uploading' : 'local',
    filename: file.name,
  } as any).run();
  await saveEditorContentOptimistically();
  const fileUploadId = await uploadMediaFile(file, 'image');
  updateMediaNodeUploadState(editor.value, 'image', localSrc, fileUploadId);

  if (fileUploadId) void saveEditorContentOptimistically();
}

async function handleUploadableAudioDrop(info: { kind: 'file'; file: File }): Promise<void> {
  await handleUploadableAudioFile(info.file);
}

/** Validates audio, inserts a local playable copy, uploads it, and updates the node's sync state. */
async function handleUploadableAudioFile(file: File): Promise<void> {
  if (!isUploadableAudioFile(file)) {
    uiMessage.value = `Audio files must be ${Math.floor(AUDIO_UPLOAD_MAX_BYTES / 1024 / 1024)} MB or smaller.`;
    return;
  }

  const localSrc = await fileToDataUrl(file);
  shouldSkipNextUpdateSave = true;
  const editorInstance = editor.value;
  if (editorInstance) {
    const insertPos = editorInstance.state.selection.from;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    editorInstance.chain().focus(insertPos || 'end').setAudio({
      src: localSrc,
      uploadState: store.syncConfig.connected && store.isOnline ? 'uploading' : 'local',
      mimeType: file.type,
      filename: file.name,
    } as any).run();
  }
  await saveEditorContentOptimistically();
  const fileUploadId = await uploadMediaFile(file, 'audio');
  updateMediaNodeUploadState(editor.value, 'audio', localSrc, fileUploadId);

  if (fileUploadId) void saveEditorContentOptimistically();
}

/** Converts a local file into a data URL suitable for immediate offline editor playback or display. */
async function fileToDataUrl(file: File): Promise<string> {
  const bytes = new Uint8Array(await file.arrayBuffer());
  let binary = '';
  const chunkSize = 8192;
  for (let index = 0; index < bytes.length; index += chunkSize) {
    binary += String.fromCharCode(...bytes.subarray(index, index + chunkSize));
  }
  return `data:${file.type || 'application/octet-stream'};base64,${btoa(binary)}`;
}

function stopAudioStream() {
  audioStream.value?.getTracks().forEach((track) => track.stop());
  audioStream.value = null;
}

/** Selects the first audio recording format supported by the current browser. */
function preferredAudioRecordingMimeType() {
  const supportedTypes = [
    'audio/mpeg',
    'audio/mp3',
    'audio/webm;codecs=opus',
    'audio/webm',
    'audio/ogg;codecs=opus',
    'audio/ogg',
  ];

  return supportedTypes.find((type) => MediaRecorder.isTypeSupported(type)) ?? '';
}

/** Maps a recorder MIME type to a suitable filename extension. */
function audioExtensionFromMimeType(mimeType: string) {
  const normalized = mimeType.toLowerCase();

  if (normalized.includes('mpeg') || normalized.includes('mp3')) return 'mp3';
  if (normalized.includes('ogg') || normalized.includes('opus')) return 'ogg';
  if (normalized.includes('wav')) return 'wav';
  if (normalized.includes('mp4') || normalized.includes('aac')) return 'm4a';
  return 'webm';
}

function isHttpAudioUrl(value: string) {
  return /^https?:\/\/.+\.(mp3|mpeg|m4a|aac|wav|ogg|oga|opus|webm)(\?[^#]*)?(#.*)?$/i.test(value);
}

/** Parses an internal text-capture drag payload without allowing malformed data to escape. */
function readInkwellDropPayload(event: DragEvent): CaptureSelectionPayload | null {
  const rawPayload = event.dataTransfer?.getData(INKWELL_DRAG_MIME);

  if (!rawPayload) {
    return null;
  }

  try {
    return JSON.parse(rawPayload) as CaptureSelectionPayload;
  } catch {
    return null;
  }
}

/** Inserts captured text at a drop location and persists both content and source metadata. */
function insertCapturedTextAtDrop(
  view: EditorView,
  event: DragEvent,
  payload: CaptureSelectionPayload,
) {
  moveEditorSelectionToDrop(view, event);
  const capturedContent = createCapturedContent(payload);
  shouldSkipNextUpdateSave = true;
  editor.value?.chain().focus().insertContent(capturedContent).run();
  queueMicrotask(() => {
    shouldSkipNextUpdateSave = false;
  });

  if (editor.value) {
    void Promise.all([
      saveEditorContentOptimistically(),
      registerCapturedSource(capturedContent, payload),
    ]);
  }
}

function isLikelyHeadingDrop(event: DragEvent) {
  return event.dataTransfer?.types.includes(INKWELL_HEADING_DRAG_MIME) ?? false;
}

function isLikelyTextCaptureDrop(event: DragEvent) {
  const types = event.dataTransfer?.types ?? [];
  return types.includes(INKWELL_DRAG_MIME) && !types.includes(INKWELL_HEADING_DRAG_MIME);
}

/** Consumes the background script's pending text drag when it matches the dropped plain text. */
async function consumeTextDragPayload(text: string) {

  return browser.runtime
    .sendMessage({
      type: 'inkwell.consumeTextDrag',
      payload: { text },
    } satisfies ConsumeTextDragMessage)
    .then((payload: unknown) => {
      const dragPayload = payload as CaptureSelectionPayload | null;

      return dragPayload && !dragPayload.highlightMeta?.isHeading ? dragPayload : null;
    })
    .catch(() => null);
}

/** Consumes and validates a pending heading drag from the background script. */
async function consumeHeadingDropPayload(event: DragEvent) {
  const text = event.dataTransfer?.getData('text/plain')?.replace(/\s+/g, ' ').trim();

  return browser.runtime
    .sendMessage({
      type: 'inkwell.consumeHeadingDrag',
      payload: {
        text,
      },
    } satisfies ConsumeHeadingDragMessage)
    .then((payload: unknown) => {
      const dragPayload = payload as CaptureSelectionPayload | null;

      return dragPayload?.highlightMeta?.isHeading ? dragPayload : null;
    })
    .catch(() => null);
}

/** Inserts a source-linked heading at the resolved drop position and registers its provenance. */
function insertLinkedHeadingAtDrop(
  view: EditorView,
  event: DragEvent,
  payload: CaptureSelectionPayload,
  resolvedDropPosition?: number,
) {
  const dropPosition =
    typeof resolvedDropPosition === 'number'
      ? resolvedDropPosition
      : view.posAtCoords({
          left: event.clientX,
          top: event.clientY,
        })?.pos;

  if (typeof dropPosition === 'number') {
    view.dispatch(
      view.state.tr.setSelection(
        TextSelection.near(view.state.doc.resolve(dropPosition)),
      ),
    );
  }

  shouldSkipNextUpdateSave = true;
  const capturedContent = createLinkedHeadingContent(payload);
  editor.value
    ?.chain()
    .focus()
    .insertContent(capturedContent)
    .run();
  queueMicrotask(() => {
    shouldSkipNextUpdateSave = false;
  });

  if (editor.value) {
    void Promise.all([
      saveEditorContentOptimistically(),
      registerCapturedSource(capturedContent, payload),
    ]);
  }
}

/** Registers the capture payload against the stable block ID created for inserted content. */
async function registerCapturedSource(
  content: DocumentContent[],
  payload: CaptureSelectionPayload,
) {
  const blockId = capturedBlockId(content);
  if (blockId) {
    await store.registerCurrentProjectSource(blockId, payload);
  }
}

function kebabCase(value: string) {
  return value.replace(/[A-Z]/g, (letter) => `-${letter.toLowerCase()}`);
}
</script>

<template>
  <main class="shell">
    <SidePanelHeader
      v-model:project-category="projectCategoryDraft"
      :account-label="accountLabel"
      :can-use-editor="canUseEditor"
      :save-label="saveLabel"
      :settings-open="activeTab === 'settings'"
      :sync-badge-class="syncBadgeClass"
      :sync-badge-title="syncBadgeTitle"
      :workspace-label="workspaceLabel"
      @archive-project="archiveProject"
      @create-page="createPage"
      @create-quick-project="createQuickProject"
      @logout="logout"
      @open-settings="toggleSettings"
      @resync="resync"
      @save-project-metadata="saveProjectMetadata"
      @select-project="selectProject"
    />

    <p v-if="hasInlineMessage" class="error">
      {{ uiMessage || store.errorMessage }}
    </p>

    <section
      v-if="canUseEditor && activeTab === 'editor'"
      class="editor-shell"
      aria-label="Project page"
    >
      <header class="editor-header">
        <div
          v-if="store.currentPage && store.stalePageIds.includes(store.currentPage.id)"
          class="sync-change-banner"
          role="alert"
        >
          <span>This page was updated in Notion.</span>
          <div class="sync-change-banner-actions">
            <button type="button" class="sync-change-banner-btn primary" @click="store.confirmReloadPage(store.currentPage.id)">Sync</button>
            <button type="button" class="sync-change-banner-btn" @click="store.dismissStalePage(store.currentPage.id)">Dismiss</button>
          </div>
        </div>
        <div
          v-else-if="store.currentPage && store.aheadPageIds.includes(store.currentPage.id)"
          class="sync-change-banner"
          role="alert"
        >
          <span>This page was edited on another device.</span>
          <div class="sync-change-banner-actions">
            <button type="button" class="sync-change-banner-btn primary" @click="store.confirmReloadPage(store.currentPage.id)">Sync</button>
            <button type="button" class="sync-change-banner-btn" @click="store.dismissStalePage(store.currentPage.id)">Keep local</button>
          </div>
        </div>
        <div class="editor-title-row">
          <div class="page-title">
            <div class="editor-page-title-control">
              <input
                v-model="pageTitleDraft"
                aria-label="Page title"
                :disabled="store.isLoading || !store.currentPage"
                @blur="renamePage"
                @keydown.enter="blurTitleInput"
              >
              <details class="page-switcher" name="workspace-switcher">
                <summary title="Switch page" aria-label="Switch page">
                  <span class="switcher-chevron" aria-hidden="true" />
                </summary>
                <div class="switcher-popover item-list">
                  <button
                    v-for="page in store.pages"
                    :key="page.id"
                    type="button"
                    class="item-row"
                    :class="{ active: page.id === store.currentPage?.id }"
                    @click="selectPage(page.id); closeSwitcher($event)"
                  >
                    <span>{{ page.title }}</span>
                  </button>
                  <hr class="switcher-divider">
                  <div class="switcher-menu-actions">
                    <button
                      type="button"
                      class="switcher-action"
                      :disabled="store.isLoading || !store.currentProjectId"
                      @click="createPage(); closeSwitcher($event)"
                    >
                      <font-awesome-icon :icon="['fas', 'file-circle-plus']" fixed-width />
                      <span>New page</span>
                    </button>
                    <button
                      type="button"
                      class="switcher-action danger-button"
                      :disabled="store.isLoading || !store.currentPage"
                      @click="archivePage(); closeSwitcher($event)"
                    >
                      <font-awesome-icon :icon="['fas', 'trash-can']" fixed-width />
                      <span>Delete page</span>
                    </button>
                  </div>
                </div>
              </details>
            </div>
            <p>{{ saveLabel }}</p>
          </div>
        </div>

        <div
          class="editor-tools"
          aria-label="Editor toolbar"
        >
          <div class="editor-tool-tabs" role="tablist" aria-label="Editor tool groups">
            <button
              v-for="mode in editorToolbarModes"
              :key="mode.id"
              type="button"
              role="tab"
              class="icon-label-button"
              :aria-selected="editorToolbarMode === mode.id"
              :class="{ active: editorToolbarMode === mode.id }"
              :title="mode.id === 'insert' ? 'Media' : mode.label"
              :aria-label="mode.id === 'insert' ? 'Media' : mode.label"
              @click="setEditorToolbarMode(mode.id)"
            >
              <font-awesome-icon :icon="mode.icon" fixed-width />
              <span>{{ mode.id === 'insert' ? 'Media' : mode.label }}</span>
            </button>
          </div>

          <div class="editor-quickbar" aria-label="Editor actions">
            <button
              v-for="item in activeToolbarItems"
              :key="item.id"
              type="button"
              class="tool-icon-button"
              :class="{ active: activeEditorMenu === item.id }"
              :disabled="!editor"
              :title="item.title"
              :aria-label="item.title"
              @click="toggleEditorMenu(item.id)"
            >
              <font-awesome-icon :icon="item.icon" fixed-width />
              <span>{{ item.label }}</span>
            </button>
          </div>

          <div v-if="activeEditorMenu" class="tool-popover">
            <MediaPanel
              v-if="activeEditorMenu === 'media'"
              v-model:media-kind="mediaKind"
              v-model:media-url="mediaUrlDraft"
              compact
              :editor-available="Boolean(editor)"
              @insert="insertMedia"
              @open-editor="closeEditorMenu"
            />

            <div v-else-if="activeEditorMenu === 'type'" class="tool-panel">
              <label class="field-label">
                Block
                <select
                  class="toolbar-select"
                  aria-label="Block type"
                  :disabled="!editor"
                  :value="activeBlockType"
                  @change="setBlockType"
                >
                  <option
                    v-for="blockType in blockTypes"
                    :key="blockType.value"
                    :value="blockType.value"
                  >
                    {{ blockType.label }}
                  </option>
                </select>
              </label>

              <label class="field-label">
                Size
                <select
                  class="toolbar-select"
                  aria-label="Font size"
                  :disabled="!editor"
                  :value="activeFontSize"
                  @change="setFontSize"
                >
                  <option
                    v-for="fontSize in fontSizes"
                    :key="fontSize.value"
                    :value="fontSize.value"
                  >
                    {{ fontSize.label }}
                  </option>
                </select>
              </label>
            </div>

            <div v-else-if="activeEditorMenu === 'marks'" class="tool-panel button-grid">
              <button
                type="button"
                class="icon-label-button"
                :class="{ active: editor?.isActive('bold') }"
                :disabled="!editor"
                title="Bold"
                aria-label="Bold"
                @click="runEditorMarkCommand('bold')"
              >
                <font-awesome-icon :icon="['fas', 'bold']" fixed-width />
                <span>Bold</span>
              </button>
              <button
                type="button"
                class="icon-label-button"
                :class="{ active: editor?.isActive('italic') }"
                :disabled="!editor"
                title="Italic"
                aria-label="Italic"
                @click="runEditorMarkCommand('italic')"
              >
                <font-awesome-icon :icon="['fas', 'italic']" fixed-width />
                <span>Italic</span>
              </button>
              <button
                type="button"
                class="icon-label-button"
                :class="{ active: editor?.isActive('underline') }"
                :disabled="!editor"
                title="Underline"
                aria-label="Underline"
                @click="runEditorMarkCommand('underline')"
              >
                <font-awesome-icon :icon="['fas', 'underline']" fixed-width />
                <span>Underline</span>
              </button>
              <button
                type="button"
                class="icon-label-button"
                :class="{ active: editor?.isActive('strike') }"
                :disabled="!editor"
                title="Strikethrough"
                aria-label="Strikethrough"
                @click="runEditorMarkCommand('strike')"
              >
                <font-awesome-icon :icon="['fas', 'strikethrough']" fixed-width />
                <span>Strike</span>
              </button>
              <button
                type="button"
                class="icon-label-button"
                :class="{ active: editor?.isActive('code') }"
                :disabled="!editor"
                title="Inline code"
                aria-label="Inline code"
                @click="runEditorMarkCommand('code')"
              >
                <font-awesome-icon :icon="['fas', 'code']" fixed-width />
                <span>Code</span>
              </button>
              <button
                type="button"
                class="icon-label-button"
                :class="{ active: editor?.isActive('superscript') }"
                :disabled="!editor"
                title="Superscript"
                aria-label="Superscript"
                @click="runEditorMarkCommand('superscript')"
              >
                <span aria-hidden="true" class="text-icon">x2</span>
                <span>Super</span>
              </button>
              <button
                type="button"
                class="icon-label-button"
                :class="{ active: editor?.isActive('subscript') }"
                :disabled="!editor"
                title="Subscript"
                aria-label="Subscript"
                @click="runEditorMarkCommand('subscript')"
              >
                <span aria-hidden="true" class="text-icon">x_2</span>
                <span>Sub</span>
              </button>
            </div>

            <div v-else-if="activeEditorMenu === 'color'" class="tool-panel">
              <label class="field-label">
                Text color
                <select
                  class="toolbar-select"
                  aria-label="Text color"
                  :disabled="!editor"
                  :value="activeTextColor"
                  @change="setTextColor"
                >
                  <option
                    v-for="color in textColors"
                    :key="color.value"
                    :value="color.value"
                  >
                    {{ color.label }}
                  </option>
                </select>
              </label>

              <label class="field-label">
                Highlight
                <select
                  class="toolbar-select"
                  aria-label="Highlight"
                  :disabled="!editor"
                  :value="activeHighlightColor"
                  @change="setHighlightColor"
                >
                  <option
                    v-for="color in highlightColors"
                    :key="color.value"
                    :value="color.value"
                  >
                    {{ color.label }}
                  </option>
                </select>
              </label>
            </div>

            <form
              v-else-if="activeEditorMenu === 'link'"
              class="tool-panel link-form"
              aria-label="Link editor"
              @submit.prevent="setLink"
            >
              <input
                v-model="linkUrlDraft"
                type="url"
                aria-label="Link URL"
                placeholder="Paste link URL"
                :disabled="!editor"
                @focus="openLinkTools"
              >
              <button
                type="submit"
                class="icon-label-button"
                :disabled="!editor"
                title="Apply link"
                aria-label="Apply link"
              >
                <font-awesome-icon :icon="['fas', 'check']" fixed-width />
                <span>Apply</span>
              </button>
              <button
                type="button"
                class="icon-label-button secondary-button"
                :disabled="!editor"
                title="Remove link"
                aria-label="Remove link"
                @click="linkUrlDraft = ''; setLink()"
              >
                <font-awesome-icon :icon="['fas', 'xmark']" fixed-width />
                <span>Remove</span>
              </button>
            </form>

            <div v-else-if="activeEditorMenu === 'lists'" class="tool-panel button-grid">
              <button
                type="button"
                class="icon-label-button"
                :class="{ active: editor?.isActive('bulletList') }"
                :disabled="!editor"
                title="Bullet list"
                aria-label="Bullet list"
                @click="runEditorListCommand('bullet')"
              >
                <font-awesome-icon :icon="['fas', 'list-ul']" fixed-width />
                <span>Bullet</span>
              </button>
              <button
                type="button"
                class="icon-label-button"
                :class="{ active: editor?.isActive('orderedList') }"
                :disabled="!editor"
                title="Ordered list"
                aria-label="Ordered list"
                @click="runEditorListCommand('ordered')"
              >
                <font-awesome-icon :icon="['fas', 'list-ol']" fixed-width />
                <span>Number</span>
              </button>
              <button
                type="button"
                class="icon-label-button"
                :class="{ active: editor?.isActive('taskList') }"
                :disabled="!editor"
                title="Task list"
                aria-label="Task list"
                @click="runEditorListCommand('task')"
              >
                <font-awesome-icon :icon="['fas', 'list-check']" fixed-width />
                <span>Task</span>
              </button>
            </div>

            <div v-else-if="activeEditorMenu === 'blocks'" class="tool-panel button-grid">
              <button
                type="button"
                class="icon-label-button"
                :class="{ active: editor?.isActive('blockquote') }"
                :disabled="!editor"
                title="Quote"
                aria-label="Quote"
                @click="runEditorBlockCommand('blockquote')"
              >
                <font-awesome-icon :icon="['fas', 'quote-left']" fixed-width />
                <span>Quote</span>
              </button>
              <button
                type="button"
                class="icon-label-button"
                :class="{ active: editor?.isActive('codeBlock') }"
                :disabled="!editor"
                title="Code block"
                aria-label="Code block"
                @click="runEditorBlockCommand('codeBlock')"
              >
                <font-awesome-icon :icon="['fas', 'code']" fixed-width />
                <span>Code block</span>
              </button>
              <button
                type="button"
                class="icon-label-button"
                :disabled="!editor"
                title="Divider"
                aria-label="Divider"
                @click="editor?.chain().focus().setHorizontalRule().run()"
              >
                <font-awesome-icon :icon="['fas', 'grip-lines']" fixed-width />
                <span>Divider</span>
              </button>
            </div>

            <div v-else-if="activeEditorMenu === 'table'" class="tool-panel button-grid table-tools">
              <button
                v-if="!isTableActive"
                type="button"
                class="icon-label-button"
                :disabled="!editor"
                title="Insert a 3 by 3 table"
                aria-label="Insert a 3 by 3 table"
                @click="runEditorTableCommand('insert')"
              >
                <font-awesome-icon :icon="['fas', 'table']" fixed-width />
                <span>Insert 3 x 3</span>
              </button>
              <template v-else>
                <button type="button" class="icon-label-button" title="Add row below" @click="runEditorTableCommand('addRow')">
                  <span aria-hidden="true" class="text-icon">+R</span>
                  <span>Add row</span>
                </button>
                <button type="button" class="icon-label-button" title="Delete row" @click="runEditorTableCommand('deleteRow')">
                  <span aria-hidden="true" class="text-icon">-R</span>
                  <span>Delete row</span>
                </button>
                <button type="button" class="icon-label-button" title="Add column to the right" @click="runEditorTableCommand('addColumn')">
                  <span aria-hidden="true" class="text-icon">+C</span>
                  <span>Add column</span>
                </button>
                <button type="button" class="icon-label-button" title="Delete column" @click="runEditorTableCommand('deleteColumn')">
                  <span aria-hidden="true" class="text-icon">-C</span>
                  <span>Delete column</span>
                </button>
                <button type="button" class="icon-label-button" title="Toggle header row" @click="runEditorTableCommand('toggleHeaderRow')">
                  <span aria-hidden="true" class="text-icon">HR</span>
                  <span>Header row</span>
                </button>
                <button type="button" class="icon-label-button" title="Toggle header column" @click="runEditorTableCommand('toggleHeaderColumn')">
                  <span aria-hidden="true" class="text-icon">HC</span>
                  <span>Header column</span>
                </button>
                <button type="button" class="icon-label-button danger-button" title="Delete table" @click="runEditorTableCommand('deleteTable')">
                  <font-awesome-icon :icon="['fas', 'trash-can']" fixed-width />
                  <span>Delete table</span>
                </button>
              </template>
            </div>

            <div v-else-if="activeEditorMenu === 'record'" class="tool-panel record-panel">
              <AudioRecorder
                :disabled="!editor || !store.currentPage"
                :phase="recordingPhase"
                :stream="audioStream"
                variant="panel"
                @start="toggleAudioRecording"
                @stop="toggleAudioRecording"
              />
            </div>

            <div v-else-if="activeEditorMenu === 'history'" class="tool-panel button-grid">
              <button
                type="button"
                class="icon-label-button"
                :disabled="!editor"
                title="Undo"
                aria-label="Undo"
                @click="editor?.chain().focus().undo().run()"
              >
                <font-awesome-icon :icon="['fas', 'rotate-left']" fixed-width />
                <span>Undo</span>
              </button>
              <button
                type="button"
                class="icon-label-button"
                :disabled="!editor"
                title="Redo"
                aria-label="Redo"
                @click="editor?.chain().focus().redo().run()"
              >
                <font-awesome-icon :icon="['fas', 'rotate-right']" fixed-width />
                <span>Redo</span>
              </button>
              <button
                type="button"
                class="icon-label-button"
                :disabled="!editor"
                title="Clear formatting"
                aria-label="Clear formatting"
                @click="clearFormatting"
              >
                <font-awesome-icon :icon="['fas', 'eraser']" fixed-width />
                <span>Clear</span>
              </button>
            </div>
          </div>
        </div>
      </header>

      <editor-content
        v-if="editor"
        class="editor"
        :editor="editor"
        @click="closeEditorMenu"
        @scroll="hideEditorContextMenu"
      />

      <div
        v-if="editorContextMenu.visible"
        ref="editorContextMenuRef"
        class="editor-context-menu"
        :style="{
          left: `${editorContextMenu.left}px`,
          top: `${editorContextMenu.top}px`,
        }"
        role="menu"
        aria-label="Text editor context menu"
        @contextmenu.prevent
        @pointerdown.stop
      >
        <div v-if="editorContextMenuPanel === 'main'" class="context-menu-stack">
          <div class="context-menu-row">
            <button
              type="button"
              class="context-menu-button text-action"
              :disabled="!editorContextMenuHasSelection"
              title="Cut"
              aria-label="Cut"
              @mousedown.prevent
              @click="cutEditorSelectionToClipboard"
            >
              Cut
            </button>
            <button
              type="button"
              class="context-menu-button text-action"
              :disabled="!editorContextMenuHasSelection"
              title="Copy"
              aria-label="Copy"
              @mousedown.prevent
              @click="copyEditorSelectionFromContextMenu"
            >
              Copy
            </button>
            <button
              type="button"
              class="context-menu-button text-action"
              title="Paste"
              aria-label="Paste"
              @mousedown.prevent
              @click="pasteClipboardTextIntoEditor"
            >
              Paste
            </button>
          </div>

          <div class="context-menu-divider" />

          <div class="context-menu-row">
            <select
              class="context-menu-select wide"
              aria-label="Text style"
              :value="activeBlockType"
              @change="setContextBlockType"
            >
              <option
                v-for="blockType in blockTypes"
                :key="blockType.value"
                :value="blockType.value"
              >
                {{ blockType.label }}
              </option>
            </select>
            <select
              class="context-menu-select"
              aria-label="Font size"
              :value="activeFontSize"
              @change="setContextFontSize"
            >
              <option
                v-for="fontSize in fontSizes"
                :key="fontSize.value"
                :value="fontSize.value"
              >
                {{ fontSize.label }}
              </option>
            </select>
          </div>

          <div class="context-menu-row">
            <button
              type="button"
              class="context-menu-button"
              :class="{ active: editor?.isActive('bold') }"
              title="Bold"
              aria-label="Bold"
              @mousedown.prevent
              @click="runContextMarkCommand('bold')"
            >
              <font-awesome-icon :icon="['fas', 'bold']" fixed-width />
            </button>
            <button
              type="button"
              class="context-menu-button"
              :class="{ active: editor?.isActive('italic') }"
              title="Italic"
              aria-label="Italic"
              @mousedown.prevent
              @click="runContextMarkCommand('italic')"
            >
              <font-awesome-icon :icon="['fas', 'italic']" fixed-width />
            </button>
            <button
              type="button"
              class="context-menu-button"
              :class="{ active: editor?.isActive('underline') }"
              title="Underline"
              aria-label="Underline"
              @mousedown.prevent
              @click="runContextMarkCommand('underline')"
            >
              <font-awesome-icon :icon="['fas', 'underline']" fixed-width />
            </button>
            <button
              type="button"
              class="context-menu-button"
              :class="{ active: editor?.isActive('strike') }"
              title="Strikethrough"
              aria-label="Strikethrough"
              @mousedown.prevent
              @click="runContextMarkCommand('strike')"
            >
              <font-awesome-icon :icon="['fas', 'strikethrough']" fixed-width />
            </button>
            <button
              type="button"
              class="context-menu-button"
              :class="{ active: editor?.isActive('code') }"
              title="Inline code"
              aria-label="Inline code"
              @mousedown.prevent
              @click="runContextMarkCommand('code')"
            >
              <font-awesome-icon :icon="['fas', 'code']" fixed-width />
            </button>
            <button
              type="button"
              class="context-menu-button"
              :class="{ active: editor?.isActive('link') }"
              title="Link"
              aria-label="Link"
              @mousedown.prevent
              @click="openContextLinkPanel"
            >
              <font-awesome-icon :icon="['fas', 'link']" fixed-width />
            </button>
            <button
              type="button"
              class="context-menu-button"
              title="Color"
              aria-label="Color"
              @mousedown.prevent
              @click="editorContextMenuPanel = 'color'"
            >
              <span aria-hidden="true" class="context-color-icon">A</span>
            </button>
          </div>

          <template v-if="editorContextMenuSource">
            <div class="context-menu-divider" />
            <button
              type="button"
              class="context-menu-button source-action"
              :title="`Open the original text on ${editorContextMenuSourceHost}`"
              aria-label="Go to source"
              @mousedown.prevent
              @click="openEditorContextSource"
            >
              <span>Go to source</span>
              <span v-if="editorContextMenuSourceHost" class="source-action-host">
                {{ editorContextMenuSourceHost }}
              </span>
            </button>
          </template>
        </div>

        <form
          v-else-if="editorContextMenuPanel === 'link'"
          class="context-menu-stack"
          aria-label="Link editor"
          @submit.prevent="applyContextLink"
        >
          <div class="context-menu-row">
            <input
              v-model="contextMenuLinkDraft"
              class="context-menu-input"
              type="url"
              aria-label="Link URL"
              placeholder="Paste link URL"
            >
          </div>
          <div class="context-menu-row">
            <button type="button" class="context-menu-button text-action" @click="editorContextMenuPanel = 'main'">
              Back
            </button>
            <button type="submit" class="context-menu-button text-action">
              Apply
            </button>
            <button type="button" class="context-menu-button text-action" @click="removeContextLink">
              Remove
            </button>
          </div>
        </form>

        <div v-else class="context-menu-stack color-panel">
          <div class="context-menu-section-label">Text</div>
          <div class="context-color-grid">
            <button
              v-for="color in textColors"
              :key="`text-${color.value}`"
              type="button"
              class="context-swatch"
              :class="{ active: activeTextColor === color.value }"
              :title="color.label"
              :aria-label="`Text color ${color.label}`"
              @mousedown.prevent
              @click="applyContextTextColor(color.value)"
            >
              <span
                class="context-swatch-chip"
                :style="{ background: color.value || 'transparent' }"
              />
              <span>{{ color.label }}</span>
            </button>
          </div>
          <div class="context-menu-section-label">Highlight</div>
          <div class="context-color-grid">
            <button
              v-for="color in highlightColors"
              :key="`highlight-${color.value}`"
              type="button"
              class="context-swatch"
              :class="{ active: activeHighlightColor === color.value }"
              :title="color.label"
              :aria-label="`Highlight ${color.label}`"
              @mousedown.prevent
              @click="applyContextHighlightColor(color.value)"
            >
              <span
                class="context-swatch-chip"
                :style="{ background: color.value || 'transparent' }"
              />
              <span>{{ color.label }}</span>
            </button>
          </div>
          <div class="context-menu-row">
            <button type="button" class="context-menu-button text-action" @click="editorContextMenuPanel = 'main'">
              Back
            </button>
          </div>
        </div>
      </div>
    </section>

    <SettingsPanel
      v-if="activeTab === 'settings'"
      v-model="interfaceScale"
      :interface-scale-label="interfaceScaleLabel"
      :maximum-scale="MAX_INTERFACE_SCALE"
      :minimum-scale="MIN_INTERFACE_SCALE"
      :scale-step="INTERFACE_SCALE_STEP"
      @persist="persistInterfaceScale"
      @preview="previewInterfaceScale"
      @select-preset="setInterfaceScale"
    >
      <SyncPanel
        v-model:has-accepted-legal-terms="hasAcceptedLegalTerms"
        v-model:parent-page-search="parentPageSearchDraft"
        v-model:parent-page-title="parentPageTitleDraft"
        v-model:server-url="serverUrlDraft"
        :account-label="accountLabel"
        :can-login="canLoginWithNotion"
        :is-legal-acceptance-loaded="isLegalAcceptanceLoaded"
        :is-signing-in="isSigningIn"
        :parent-page-label="parentPageLabel"
        :privacy-url="LEGAL_PRIVACY_URL"
        :save-label="saveLabel"
        :terms-url="LEGAL_TERMS_URL"
        @create-parent-page="createParentPage"
        @login="loginWithNotion"
        @logout="logout"
        @open-legal-url="openLegalUrl"
        @resync="resync"
        @save-server-url="saveServerUrl"
        @search-parent-pages="searchParentPages"
        @select-parent-page="selectParentPage"
      />
    </SettingsPanel>

    <ArchiveDialog
      v-if="archiveTarget"
      :target="archiveTarget"
      @cancel="cancelArchive"
      @confirm="confirmArchive"
    />
  </main>
</template>

<style src="./sidepanel.css"></style>
