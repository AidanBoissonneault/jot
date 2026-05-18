<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, onMounted, ref, watch } from 'vue';
import { EditorContent, useEditor } from '@tiptap/vue-3';
import AudioRecorder from '@/src/components/AudioRecorder.vue';
import { NodeSelection, TextSelection } from '@tiptap/pm/state';
import type { EditorView } from '@tiptap/pm/view';
import StarterKit from '@tiptap/starter-kit';
import {
  decodeInkwellSource,
  INKWELL_SOURCE_ATTR,
  InkwellLink,
} from '@/src/extensions/inkwellLink';
import { PortableTextEditingKit } from '@/src/extensions/textFormatting';
import { MediaKit } from '@/src/extensions/media';
import {
  hasPendingTransientMedia,
  sanitizeMediaForSync,
} from '@/src/extensions/mediaContent';
import { InkwellBlockIds, normalizeInkwellBlockIds } from '@/src/extensions/inkwellBlockIds';
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
import { useInkwellStore } from '@/src/stores/inkwell';
import type { DocumentContent } from '@/src/types/capture';
import type {
  CaptureSelectionPayload,
  ConsumeHeadingDragMessage,
  ConsumeTextDragMessage,
  OpenSourceRequestMessage,
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
const projectStateDraft = ref('');
const newProjectNameDraft = ref('');
const linkUrlDraft = ref('');
const imageUrlDraft = ref('');
const videoUrlDraft = ref('');
const audioUrlDraft = ref('');
const serverUrlDraft = ref('');
const parentPageSearchDraft = ref('');
const parentPageTitleDraft = ref('');
const uiMessage = ref('');
const hasAcceptedLegalTerms = ref(false);
const isLegalAcceptanceLoaded = ref(false);
const activeTab = ref<'editor' | 'projects' | 'media' | 'sync'>('editor');
const editorToolbarMode = ref<'style' | 'insert' | 'controls'>('style');
const editorContextMenuRef = ref<HTMLElement | null>(null);
const editorContextMenu = ref({
  visible: false,
  left: 0,
  top: 0,
});
const editorContextMenuHasSelection = ref(false);
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
  | 'history'
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
    }),
    InkwellLink,
    InkwellBlockIds,
    PortableTextEditingKit,
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

const currentPageModel = computed({
  get: () => store.currentPage?.id ?? '',
  set: (pageId: string) => {
    void selectPage(pageId);
  },
});

const currentProjectModel = computed({
  get: () => store.currentProjectId,
  set: (projectId: string) => {
    void selectProject(projectId);
  },
});

const saveLabel = computed(() => {
  if (store.pullMessage) {
    return store.pullMessage;
  }

  if (store.isLoading) {
    return 'Loading';
  }

  if (store.saveStatus === 'saving') {
    return 'Saving';
  }

  if (store.saveStatus === 'creating') {
    return 'Creating';
  }

  if (store.saveStatus === 'error') {
    return 'Save failed';
  }

  if (store.saveStatus === 'stale') {
    return 'Stale';
  }

  return 'Saved locally';
});

const syncBadgeTitle = computed(() => {
  if (store.errorMessage) {
    return store.errorMessage;
  }

  if (!store.syncConfig.connected) {
    return 'Log in with Notion to sync across devices.';
  }

  const sseNote = store.sseStatus === 'connected'
    ? 'Live updates active'
    : store.sseStatus === 'connecting'
      ? 'Connecting…'
      : 'Live updates disconnected';

  if (!store.syncConfig.selectedParentPageId) {
    return `Inkwell will create a root Notion page with project folders on first sync. · ${sseNote}`;
  }

  const base = store.syncConfig.selectedParentPageTitle
    ? `Synced inside ${store.syncConfig.selectedParentPageTitle}`
    : saveLabel.value;

  return `${base} · ${sseNote}`;
});

const syncBadgeClass = computed(() => ({
  'sync-badge': true,
  error: store.saveStatus === 'error',
  stale:
    store.saveStatus === 'stale' ||
    !store.syncConfig.connected,
  saving:
    store.saveStatus === 'saving' ||
    store.saveStatus === 'creating' ||
    store.isLoading,
  saved:
    store.saveStatus === 'saved' &&
    store.syncConfig.connected,
}));

const canUseEditor = computed(() => store.syncConfig.connected);
const canLoginWithNotion = computed(
  () => isLegalAcceptanceLoaded.value && hasAcceptedLegalTerms.value && !isSigningIn.value,
);

const tabs = [
  { id: 'editor', label: 'Editor', icon: ['far', 'pen-to-square'] },
  { id: 'projects', label: 'Projects', icon: ['fas', 'folder-tree'] },
  { id: 'media', label: 'Media', icon: ['fas', 'photo-film'] },
  { id: 'sync', label: 'Sync', icon: ['fas', 'cloud-arrow-up'] },
] as const;

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
  (store.syncConfig.connected ? 'Connected' : 'Signed out'),
);

const workspaceLabel = computed(() =>
  store.syncConfig.workspaceName
    ? `Workspace: ${store.syncConfig.workspaceName}`
    : 'No workspace selected',
);

const contextLabel = computed(() => {
  const project = store.currentProject?.name ?? 'No project';
  const page = store.currentPage?.title ?? 'No page';
  return `${project} / ${page}`;
});

const parentPageLabel = computed(() =>
  store.syncConfig.selectedParentPageTitle ||
  (store.syncConfig.selectedParentPageId ? 'Selected Notion page' : 'Default Inkwell root page'),
);

const hasInlineMessage = computed(() => Boolean(uiMessage.value || store.errorMessage));

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

onMounted(() => {
  store.startRuntimeListener();
  store.registerCaptureInsertHandler(insertCaptureAtCursor);
  window.addEventListener('pagehide', handlePanelExit);
  window.addEventListener('resize', hideEditorContextMenu);
  document.addEventListener('visibilitychange', handleVisibilityChange);
  document.addEventListener('pointerdown', handleEditorContextMenuPointerDown);
  document.addEventListener('keydown', handleEditorContextMenuKeydown);
  void loadLegalAcceptance();
  void initializePanel();
});

onBeforeUnmount(() => {
  window.clearTimeout(saveTimer.value);
  window.clearInterval(sessionPollTimer);
  window.removeEventListener('pagehide', handlePanelExit);
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
    projectStateDraft.value = plainTextFromDocument(project?.stateContent);
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
    if (connected && activeTab.value === 'sync') {
      activeTab.value = 'editor';
    }
  },
);

watch(
  activeTab,
  (tab) => {
    hideEditorContextMenu();

    if (tab === 'sync' && store.syncConfig.connected) {
      void store.loadNotionParentPages(parentPageSearchDraft.value);
    }
  },
);

async function initializePanel() {
  await store.initialize();
}

async function loadLegalAcceptance() {
  hasAcceptedLegalTerms.value = await hasAcceptedCurrentLegalTerms();
  isLegalAcceptanceLoaded.value = true;
}

async function insertCaptureAtCursor(payload: CaptureSelectionPayload) {
  if (!editor.value || !store.currentPage) {
    return false;
  }

  shouldSkipNextUpdateSave = true;
  editor.value.chain().focus().insertContent(createCapturedContent(payload)).run();
  queueMicrotask(() => {
    shouldSkipNextUpdateSave = false;
  });
  await saveEditorContentOptimistically();
  return true;
}

async function selectPage(pageId: string) {
  if (!pageId || pageId === store.currentPage?.id) {
    return;
  }

  await saveEditorContentInBackground();
  void notionClient.flushPendingSyncOps({ force: true }).catch(() => undefined);
  await store.selectPage(pageId);
}

async function selectProject(projectId: string) {
  if (!projectId || projectId === store.currentProjectId) {
    return;
  }

  await saveEditorContentInBackground();
  void notionClient.flushPendingSyncOps({ force: true }).catch(() => undefined);
  await store.selectProject(projectId);
}

async function createProject() {
  await flushEditorContent();
  const name = newProjectNameDraft.value.trim() || 'Untitled Project';
  await store.createProject(name);
  newProjectNameDraft.value = '';
  activeTab.value = 'editor';
}

async function renameProject() {
  if (!store.currentProject || projectNameDraft.value === store.currentProject.name) {
    return;
  }

  await flushEditorContent();
  await store.renameCurrentProject(projectNameDraft.value);
}

async function saveProjectMetadata() {
  const project = store.currentProject;

  if (!project) {
    return;
  }

  const stateText = projectStateDraft.value;

  if (
    projectCategoryDraft.value === (project.category ?? '') &&
    stateText === plainTextFromDocument(project.stateContent)
  ) {
    return;
  }

  await flushEditorContent();
  await store.updateCurrentProjectMetadata({
    category: projectCategoryDraft.value,
    stateText,
  });
}

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

async function resync() {
  await flushEditorContent();
  await store.reloadFromNotion();
}

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

async function logout() {
  window.clearInterval(sessionPollTimer);
  isSigningIn.value = false;
  await store.logout();
  activeTab.value = 'sync';
}

function openLinkTools() {
  linkUrlDraft.value = String(editor.value?.getAttributes('link').href ?? '');
}

function setEditorToolbarMode(mode: typeof editorToolbarModes[number]['id']) {
  editorToolbarMode.value = mode;
  activeEditorMenu.value =
    mode === 'insert' ? 'link' : mode === 'controls' ? 'history' : 'type';
}

function showEditorMenu(menu: NonNullable<typeof activeEditorMenu.value>) {
  activeEditorMenu.value = menu;

  if (menu === 'link') {
    openLinkTools();
  }
}

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

async function createParentPage() {
  const title = parentPageTitleDraft.value.trim() || 'Inkwell';
  await store.createNotionParentPage(title);
  parentPageTitleDraft.value = '';
}

async function selectParentPage(pageId: string) {
  await store.selectNotionParentPage(pageId);
}

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

function setBlockType(event: Event) {
  applyBlockType((event.target as HTMLSelectElement).value);
}

function setContextBlockType(event: Event) {
  restoreEditorContextSelection();
  applyBlockType((event.target as HTMLSelectElement).value);
}

function runEditorFormattingCommand(command: () => boolean | undefined) {
  const didRun = command() ?? false;

  if (!didRun) {
    return;
  }

  window.clearTimeout(saveTimer.value);
  void saveEditorContentOptimistically();
}

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
  editorContextMenuPanel.value = 'main';
}

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

function handleEditorContextMenuKeydown(event: KeyboardEvent) {
  if (event.key === 'Escape' && editorContextMenu.value.visible) {
    event.preventDefault();
    hideEditorContextMenu();
  }
}

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

function runEditorListCommand(command: 'bullet' | 'ordered' | 'task') {
  const commands = {
    bullet: () => editor.value?.chain().focus().toggleBulletList().run(),
    ordered: () => editor.value?.chain().focus().toggleOrderedList().run(),
    task: () => editor.value?.chain().focus().toggleTaskList().run(),
  };

  runEditorFormattingCommand(commands[command]);
}

function runEditorBlockCommand(command: 'blockquote' | 'codeBlock') {
  const commands = {
    blockquote: () => editor.value?.chain().focus().toggleBlockquote().run(),
    codeBlock: () => editor.value?.chain().focus().toggleCodeBlock().run(),
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

function insertImage() {
  const src = imageUrlDraft.value.trim();
  if (!src) {
    return;
  }

  editor.value?.chain().focus().setImage({ src }).run();
  imageUrlDraft.value = '';
  activeTab.value = 'editor';
  void saveEditorContentOptimistically();
}

function insertVideo() {
  const src = videoUrlDraft.value.trim();
  if (!src) {
    return;
  }

  const inserted = editor.value?.chain().focus().setYoutubeVideo({ src }).run();

  if (!inserted) {
    uiMessage.value = 'Paste a YouTube video URL.';
    return;
  }

  uiMessage.value = '';
  videoUrlDraft.value = '';
  activeTab.value = 'editor';
  void saveEditorContentOptimistically();
}

function insertAudio() {
  const src = audioUrlDraft.value.trim();

  if (!src) {
    return;
  }

  if (!isHttpAudioUrl(src)) {
    uiMessage.value = 'Paste a public http(s) URL to an MP3 or audio file.';
    return;
  }

  editor.value?.chain().focus().setAudio({ src }).run();
  audioUrlDraft.value = '';
  uiMessage.value = '';
  activeTab.value = 'editor';
  void saveEditorContentOptimistically();
}

function toggleAudioRecording() {
  if (recordingPhase.value === 'recording') {
    audioRecorder?.stop();
    return;
  }
  if (recordingPhase.value === 'idle') {
    void startAudioRecording();
  }
}

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

async function flushEditorContent() {
  window.clearTimeout(saveTimer.value);

  await saveEditorContentOptimistically();
}

async function saveEditorContentInBackground() {
  window.clearTimeout(saveTimer.value);

  if (!editor.value || !store.currentPage) {
    return;
  }

  const page = { ...store.currentPage };
  const editorContent = editor.value.getJSON() as DocumentContent;

  if (hasPendingTransientMedia(editorContent)) {
    return;
  }

  const content = normalizeInkwellBlockIds(sanitizeMediaForSync(editorContent));
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

function handlePanelExit() {
  void saveEditorContentInBackground()
    .catch(() => undefined)
    .finally(() => {
      void notionClient.flushPendingSyncOps({ force: true }).catch(() => undefined);
    });
}

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

      if (hasPendingTransientMedia(editorContent)) {
        return;
      }

      const currentPage = store.currentPage;

      if (!currentPage) {
        return;
      }

      const content = normalizeInkwellBlockIds(sanitizeMediaForSync(editorContent));
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

async function uploadMediaFile(file: File, label: string): Promise<string> {
  queueMicrotask(() => {
    shouldSkipNextUpdateSave = false;
  });

  let fileUploadId = '';

  try {
    fileUploadId = await notionClient.uploadMedia(file, file.type, file.name);
  } catch (error) {
    uiMessage.value =
      error instanceof Error ? error.message : `Unable to upload this ${label} to Notion.`;
  }

  return fileUploadId;
}

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
            uploadState: fileUploadId ? 'done' : 'error',
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

async function handleUploadableImageDrop(info: { kind: 'file'; file: File }): Promise<void> {
  const { file } = info;

  if (!isUploadableImageFile(file)) {
    uiMessage.value = `Images must be ${Math.floor(IMAGE_UPLOAD_MAX_BYTES / 1024 / 1024)} MB or smaller.`;
    return;
  }

  const localSrc = URL.createObjectURL(file);
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  shouldSkipNextUpdateSave = true;
  editor.value?.chain().focus().setImage({ src: localSrc, uploadState: 'uploading' } as any).run();
  const fileUploadId = await uploadMediaFile(file, 'image');
  updateMediaNodeUploadState(editor.value, 'image', localSrc, fileUploadId);

  if (!fileUploadId) {
    return;
  }

  void saveEditorContentOptimistically();
}

async function handleUploadableAudioDrop(info: { kind: 'file'; file: File }): Promise<void> {
  await handleUploadableAudioFile(info.file);
}

async function handleUploadableAudioFile(file: File): Promise<void> {
  if (!isUploadableAudioFile(file)) {
    uiMessage.value = `Audio files must be ${Math.floor(AUDIO_UPLOAD_MAX_BYTES / 1024 / 1024)} MB or smaller.`;
    return;
  }

  const localSrc = URL.createObjectURL(file);
  shouldSkipNextUpdateSave = true;
  const editorInstance = editor.value;
  if (editorInstance) {
    const insertPos = editorInstance.state.selection.from;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    editorInstance.chain().focus(insertPos || 'end').setAudio({
      src: localSrc,
      uploadState: 'uploading',
      mimeType: file.type,
    } as any).run();
  }
  const fileUploadId = await uploadMediaFile(file, 'audio');
  updateMediaNodeUploadState(editor.value, 'audio', localSrc, fileUploadId);

  if (!fileUploadId) {
    return;
  }

  void saveEditorContentOptimistically();
}

function stopAudioStream() {
  audioStream.value?.getTracks().forEach((track) => track.stop());
  audioStream.value = null;
}

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

function insertCapturedTextAtDrop(
  view: EditorView,
  event: DragEvent,
  payload: CaptureSelectionPayload,
) {
  moveEditorSelectionToDrop(view, event);
  shouldSkipNextUpdateSave = true;
  editor.value?.chain().focus().insertContent(createCapturedContent(payload)).run();
  queueMicrotask(() => {
    shouldSkipNextUpdateSave = false;
  });

  if (editor.value) {
    void saveEditorContentOptimistically();
  }
}

function isLikelyHeadingDrop(event: DragEvent) {
  return event.dataTransfer?.types.includes(INKWELL_HEADING_DRAG_MIME) ?? false;
}

function isLikelyTextCaptureDrop(event: DragEvent) {
  const types = event.dataTransfer?.types ?? [];
  return types.includes(INKWELL_DRAG_MIME) && !types.includes(INKWELL_HEADING_DRAG_MIME);
}

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
  editor.value
    ?.chain()
    .focus()
    .insertContent(createLinkedHeadingContent(payload))
    .run();
  queueMicrotask(() => {
    shouldSkipNextUpdateSave = false;
  });

  if (editor.value) {
    void saveEditorContentOptimistically();
  }
}

function kebabCase(value: string) {
  return value.replace(/[A-Z]/g, (letter) => `-${letter.toLowerCase()}`);
}

function plainTextFromDocument(document: DocumentContent | undefined) {
  return (document?.content ?? [])
    .map((node) => textFromNode(node))
    .join('\n')
    .trim();
}

function textFromNode(node: DocumentContent): string {
  if (node.text) {
    return node.text;
  }

  if (node.type === 'hardBreak') {
    return '\n';
  }

  return (node.content ?? []).map((child) => textFromNode(child)).join('');
}
</script>

<template>
  <main class="shell">
    <header class="topbar">
      <div class="topbar-status">
        <div
          :class="syncBadgeClass"
          :title="syncBadgeTitle"
          role="status"
          tabindex="0"
          :aria-label="`${saveLabel}: ${syncBadgeTitle}`"
        >
          <span class="sync-dot" aria-hidden="true" />
          <span class="sync-label">{{ saveLabel }}</span>
        </div>
        <div class="topbar-meta">
          <strong>{{ contextLabel }}</strong>
          <small>{{ accountLabel }} / {{ workspaceLabel }}</small>
        </div>
      </div>

      <div class="topbar-switchers">
        <select
          v-if="store.syncConfig.connected"
          v-model="currentProjectModel"
          aria-label="Quick project"
          :disabled="store.isLoading || store.projects.length === 0"
        >
          <option
            v-for="project in store.projects"
            :key="project.id"
            :value="project.id"
          >
            {{ project.name }}
          </option>
        </select>

        <select
          v-if="store.syncConfig.connected"
          v-model="currentPageModel"
          aria-label="Quick page"
          :disabled="store.isLoading || store.pages.length === 0"
        >
          <option
            v-for="page in store.pages"
            :key="page.id"
            :value="page.id"
          >
            {{ page.title }}
          </option>
        </select>
      </div>

      <div v-if="store.syncConfig.connected" class="topbar-actions">
        <button
          type="button"
          class="icon-label-button secondary-button"
          :disabled="store.isLoading"
          title="New project"
          aria-label="New project"
          @click="activeTab = 'projects'"
        >
          <font-awesome-icon :icon="['fas', 'folder-plus']" fixed-width />
          <span>New project</span>
        </button>

        <button
          type="button"
          class="icon-label-button"
          :disabled="store.isLoading || !store.currentProjectId"
          title="New page"
          aria-label="New page"
          @click="createPage"
        >
          <font-awesome-icon :icon="['fas', 'file-circle-plus']" fixed-width />
          <span>New page</span>
        </button>
        <button
          type="button"
          class="icon-label-button secondary-button"
          :disabled="store.isLoading"
          title="Resync with Notion"
          aria-label="Resync with Notion"
          @click="resync"
        >
          <font-awesome-icon :icon="['fas', 'rotate']" fixed-width />
          <span>Sync</span>
        </button>
        <button
          type="button"
          class="icon-label-button secondary-button"
          title="Logout"
          aria-label="Logout"
          @click="logout"
        >
          <font-awesome-icon :icon="['fas', 'right-from-bracket']" fixed-width />
          <span>Logout</span>
        </button>
      </div>
    </header>

    <nav class="tabs" aria-label="Side panel sections">
      <button
        v-for="tab in tabs"
        :key="tab.id"
        type="button"
        class="icon-label-button tab-button"
        :class="{ active: activeTab === tab.id }"
        :aria-current="activeTab === tab.id ? 'page' : undefined"
        :title="tab.label"
        :aria-label="tab.label"
        @click="activeTab = tab.id"
      >
        <font-awesome-icon :icon="tab.icon" fixed-width />
        <span>{{ tab.label }}</span>
      </button>
    </nav>

    <section
      v-if="!store.syncConfig.connected"
      class="auth-gate"
      aria-label="Notion login"
    >
      <h2>Log in with Notion</h2>
      <p>
        Inkwell connects to Notion, syncs selected workspace content, and stores
        account, session, and sync metadata needed to provide the service.
      </p>
      <label class="legal-consent">
        <input
          v-model="hasAcceptedLegalTerms"
          type="checkbox"
          :disabled="!isLegalAcceptanceLoaded"
        >
        <span>
          I have read and agree to the
          <a
            :href="LEGAL_TERMS_URL"
            target="_blank"
            rel="noopener noreferrer"
            @click.prevent="openLegalUrl(LEGAL_TERMS_URL)"
          >Terms</a>
          and
          <a
            :href="LEGAL_PRIVACY_URL"
            target="_blank"
            rel="noopener noreferrer"
            @click.prevent="openLegalUrl(LEGAL_PRIVACY_URL)"
          >Privacy Policy</a>.
        </span>
      </label>
      <button
        type="button"
        class="icon-label-button"
        :disabled="!canLoginWithNotion"
        :title="isSigningIn ? 'Connecting' : 'Continue with Notion'"
        :aria-label="isSigningIn ? 'Connecting' : 'Continue with Notion'"
        @click="loginWithNotion"
      >
        <font-awesome-icon :icon="['fas', 'cloud-arrow-up']" fixed-width />
        <span>{{ isSigningIn ? 'Connecting...' : 'Continue with Notion' }}</span>
      </button>
    </section>

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
            <input
              v-model="pageTitleDraft"
              aria-label="Page title"
              :disabled="store.isLoading || !store.currentPage"
              @blur="renamePage"
              @keydown.enter="blurTitleInput"
            >
            <p>{{ store.currentProject?.name || 'Project' }} / {{ saveLabel }}</p>
          </div>
          <button
            type="button"
            class="icon-label-button secondary-button"
            :disabled="store.isLoading || !store.currentPage"
            title="Manage projects and pages"
            aria-label="Manage projects and pages"
            @click="activeTab = 'projects'"
          >
            <font-awesome-icon :icon="['fas', 'folder-tree']" fixed-width />
            <span>Manage</span>
          </button>
        </div>

        <div
          class="editor-tools"
          aria-label="Editor toolbar"
          @mouseleave="closeEditorMenu"
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
              :title="mode.label"
              :aria-label="mode.label"
              @click="setEditorToolbarMode(mode.id)"
              @mouseenter="setEditorToolbarMode(mode.id)"
            >
              <font-awesome-icon :icon="mode.icon" fixed-width />
              <span>{{ mode.label }}</span>
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
              @mouseenter="showEditorMenu(item.id)"
            >
              <font-awesome-icon :icon="item.icon" fixed-width />
              <span>{{ item.label }}</span>
            </button>
          </div>

          <div v-if="activeEditorMenu" class="tool-popover">
            <div v-if="activeEditorMenu === 'type'" class="tool-panel">
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

    <section
      v-if="canUseEditor && activeTab === 'projects'"
      class="tab-panel"
      aria-label="Projects and pages"
    >
      <div class="panel-section">
        <div class="section-heading">
          <h2>Projects</h2>
          <button
            type="button"
            class="icon-label-button secondary-button"
            title="Editor"
            aria-label="Editor"
            @click="activeTab = 'editor'"
          >
            <font-awesome-icon :icon="['far', 'pen-to-square']" fixed-width />
            <span>Editor</span>
          </button>
        </div>

        <form class="inline-form" @submit.prevent="createProject">
          <input
            v-model="newProjectNameDraft"
            aria-label="New project name"
            placeholder="New project name"
            :disabled="store.isLoading"
          >
          <button
            type="submit"
            class="icon-label-button"
            :disabled="store.isLoading"
            title="Create project"
            aria-label="Create project"
          >
            <font-awesome-icon :icon="['fas', 'folder-plus']" fixed-width />
            <span>Create</span>
          </button>
        </form>

        <div class="manage-row">
          <select
            v-model="currentProjectModel"
            aria-label="Project"
            :disabled="store.isLoading || store.projects.length === 0"
          >
            <option
              v-for="project in store.projects"
              :key="project.id"
              :value="project.id"
            >
              {{ project.name }}
            </option>
          </select>
          <button
            type="button"
            class="icon-label-button secondary-button danger-button"
            :disabled="store.isLoading || !store.currentProject"
            title="Archive project"
            aria-label="Archive project"
            @click="archiveProject"
          >
            <font-awesome-icon :icon="['fas', 'trash-can']" fixed-width />
            <span>Archive</span>
          </button>
        </div>

        <label class="field-label">
          Project name
          <input
            v-model="projectNameDraft"
            aria-label="Project name"
            :disabled="store.isLoading || !store.currentProject"
            @blur="renameProject"
            @keydown.enter="blurTitleInput"
          >
        </label>

        <label class="field-label">
          Category
          <input
            v-model="projectCategoryDraft"
            aria-label="Project category"
            :disabled="store.isLoading || !store.currentProject"
            @blur="saveProjectMetadata"
            @keydown.enter="blurTitleInput"
          >
        </label>

        <label class="field-label">
          Project state
          <textarea
            v-model="projectStateDraft"
            aria-label="Project state"
            rows="5"
            :disabled="store.isLoading || !store.currentProject"
            @blur="saveProjectMetadata"
          />
        </label>

        <div class="item-list">
          <button
            v-for="project in store.projects"
            :key="project.id"
            type="button"
            class="item-row"
            :class="{ active: project.id === store.currentProjectId }"
            @click="selectProject(project.id)"
          >
            <span>{{ project.name }}</span>
            <small>{{ project.syncState || 'saved' }}</small>
          </button>
        </div>
      </div>

      <div class="panel-section">
        <div class="section-heading">
          <h2>Pages</h2>
          <button
            type="button"
            class="icon-label-button"
            :disabled="store.isLoading || !store.currentProjectId"
            title="New page"
            aria-label="New page"
            @click="createPage"
          >
            <font-awesome-icon :icon="['fas', 'file-circle-plus']" fixed-width />
            <span>New page</span>
          </button>
        </div>

        <div class="manage-row">
          <select
            v-model="currentPageModel"
            aria-label="Page"
            :disabled="store.isLoading || store.pages.length === 0"
          >
            <option
              v-for="page in store.pages"
              :key="page.id"
              :value="page.id"
            >
              {{ page.title }}
            </option>
          </select>
          <button
            type="button"
            class="icon-label-button secondary-button danger-button"
            :disabled="store.isLoading || !store.currentPage"
            title="Archive page"
            aria-label="Archive page"
            @click="archivePage"
          >
            <font-awesome-icon :icon="['fas', 'trash-can']" fixed-width />
            <span>Archive</span>
          </button>
        </div>

        <label class="field-label">
          Page title
          <input
            v-model="pageTitleDraft"
            aria-label="Page title"
            :disabled="store.isLoading || !store.currentPage"
            @blur="renamePage"
            @keydown.enter="blurTitleInput"
          >
        </label>

        <div class="item-list">
          <button
            v-for="page in store.pages"
            :key="page.id"
            type="button"
            class="item-row"
            :class="{ active: page.id === store.currentPage?.id }"
            @click="selectPage(page.id)"
          >
            <span>{{ page.title }}</span>
            <small>{{ page.syncState || 'saved' }}</small>
          </button>
        </div>
      </div>
    </section>

    <section
      v-if="canUseEditor && activeTab === 'media'"
      class="tab-panel"
      aria-label="Media"
    >
      <div class="panel-section">
        <div class="section-heading">
          <h2>Media</h2>
          <button
            type="button"
            class="icon-label-button secondary-button"
            title="Editor"
            aria-label="Editor"
            @click="activeTab = 'editor'"
          >
            <font-awesome-icon :icon="['far', 'pen-to-square']" fixed-width />
            <span>Editor</span>
          </button>
        </div>

        <form class="stack-form" @submit.prevent="insertImage">
          <label class="field-label">
            Image URL
            <input
              v-model="imageUrlDraft"
              type="url"
              aria-label="Image URL"
              placeholder="https://..."
              :disabled="!editor"
            >
          </label>
          <button
            type="submit"
            class="icon-label-button"
            :disabled="!editor"
            title="Insert image"
            aria-label="Insert image"
          >
            <font-awesome-icon :icon="['fas', 'image']" fixed-width />
            <span>Insert image</span>
          </button>
        </form>

        <form class="stack-form" @submit.prevent="insertVideo">
          <label class="field-label">
            Video or YouTube URL
            <input
              v-model="videoUrlDraft"
              type="url"
              aria-label="Video or YouTube URL"
              placeholder="https://..."
              :disabled="!editor"
            >
          </label>
          <button
            type="submit"
            class="icon-label-button"
            :disabled="!editor"
            title="Insert video"
            aria-label="Insert video"
          >
            <font-awesome-icon :icon="['fas', 'video']" fixed-width />
            <span>Insert video</span>
          </button>
        </form>

        <form class="stack-form" @submit.prevent="insertAudio">
          <label class="field-label">
            Audio URL
            <input
              v-model="audioUrlDraft"
              type="url"
              aria-label="Audio URL"
              placeholder="https://..."
              :disabled="!editor"
            >
          </label>
          <button
            type="submit"
            class="icon-label-button"
            :disabled="!editor"
            title="Insert audio"
            aria-label="Insert audio"
          >
            <font-awesome-icon :icon="['fas', 'microphone']" fixed-width />
            <span>Insert audio</span>
          </button>
        </form>

        <small>Drop images, audio, or YouTube links into the editor.</small>
      </div>
    </section>

    <section
      v-if="activeTab === 'sync'"
      class="tab-panel"
      aria-label="Sync"
    >
      <div class="panel-section">
        <div class="section-heading">
          <h2>Sync</h2>
          <button
            v-if="store.syncConfig.connected"
            type="button"
            class="icon-label-button secondary-button"
            title="Resync"
            aria-label="Resync"
            @click="resync"
          >
            <font-awesome-icon :icon="['fas', 'rotate']" fixed-width />
            <span>Resync</span>
          </button>
        </div>

        <dl class="status-list">
          <div>
            <dt>Account</dt>
            <dd>{{ accountLabel }}</dd>
          </div>
          <div>
            <dt>Workspace</dt>
            <dd>{{ store.syncConfig.workspaceName || 'Not connected' }}</dd>
          </div>
          <div>
            <dt>Parent page</dt>
            <dd>{{ parentPageLabel }}</dd>
          </div>
          <div>
            <dt>Status</dt>
            <dd>{{ saveLabel }}</dd>
          </div>
        </dl>

        <div
          v-if="!store.syncConfig.connected"
          class="legal-disclosure"
        >
          <p>
            Inkwell connects to Notion, syncs selected workspace content, and
            stores account, session, and sync metadata needed to provide the service.
          </p>
          <label class="legal-consent">
            <input
              v-model="hasAcceptedLegalTerms"
              type="checkbox"
              :disabled="!isLegalAcceptanceLoaded"
            >
            <span>
              I have read and agree to the
              <a
                :href="LEGAL_TERMS_URL"
                target="_blank"
                rel="noopener noreferrer"
                @click.prevent="openLegalUrl(LEGAL_TERMS_URL)"
              >Terms</a>
              and
              <a
                :href="LEGAL_PRIVACY_URL"
                target="_blank"
                rel="noopener noreferrer"
                @click.prevent="openLegalUrl(LEGAL_PRIVACY_URL)"
              >Privacy Policy</a>.
            </span>
          </label>
        </div>

        <button
          v-if="!store.syncConfig.connected"
          type="button"
          class="icon-label-button"
          :disabled="!canLoginWithNotion"
          :title="isSigningIn ? 'Connecting' : 'Continue with Notion'"
          :aria-label="isSigningIn ? 'Connecting' : 'Continue with Notion'"
          @click="loginWithNotion"
        >
          <font-awesome-icon :icon="['fas', 'cloud-arrow-up']" fixed-width />
          <span>{{ isSigningIn ? 'Connecting...' : 'Continue with Notion' }}</span>
        </button>
        <button
          v-else
          type="button"
          class="icon-label-button secondary-button"
          title="Logout"
          aria-label="Logout"
          @click="logout"
        >
          <font-awesome-icon :icon="['fas', 'right-from-bracket']" fixed-width />
          <span>Logout</span>
        </button>
      </div>

      <div class="panel-section">
        <h2>Legal</h2>
        <p class="legal-links">
          <a
            :href="LEGAL_TERMS_URL"
            target="_blank"
            rel="noopener noreferrer"
            @click.prevent="openLegalUrl(LEGAL_TERMS_URL)"
          >Terms</a>
          <a
            :href="LEGAL_PRIVACY_URL"
            target="_blank"
            rel="noopener noreferrer"
            @click.prevent="openLegalUrl(LEGAL_PRIVACY_URL)"
          >Privacy Policy</a>
        </p>
      </div>

      <div class="panel-section">
        <h2>Server</h2>
        <form class="inline-form" @submit.prevent="saveServerUrl">
          <input
            v-model="serverUrlDraft"
            type="url"
            aria-label="Sync server URL"
            placeholder="http://localhost:8787"
          >
          <button
            type="submit"
            class="icon-label-button"
            title="Save server URL"
            aria-label="Save server URL"
          >
            <font-awesome-icon :icon="['fas', 'floppy-disk']" fixed-width />
            <span>Save</span>
          </button>
        </form>
      </div>

      <div class="panel-section">
        <h2>Notion Parent Page</h2>
        <form class="inline-form" @submit.prevent="searchParentPages">
          <input
            v-model="parentPageSearchDraft"
            aria-label="Search Notion pages"
            placeholder="Search pages"
            :disabled="!store.syncConfig.connected"
          >
          <button
            type="submit"
            class="icon-label-button"
            :disabled="!store.syncConfig.connected"
            title="Search Notion pages"
            aria-label="Search Notion pages"
          >
            <font-awesome-icon :icon="['fas', 'magnifying-glass']" fixed-width />
            <span>Search</span>
          </button>
        </form>

        <form class="inline-form" @submit.prevent="createParentPage">
          <input
            v-model="parentPageTitleDraft"
            aria-label="New Notion parent page"
            placeholder="New parent page title"
            :disabled="!store.syncConfig.connected"
          >
          <button
            type="submit"
            class="icon-label-button"
            :disabled="!store.syncConfig.connected"
            title="Create Notion parent page"
            aria-label="Create Notion parent page"
          >
            <font-awesome-icon :icon="['fas', 'folder-plus']" fixed-width />
            <span>Create</span>
          </button>
        </form>

        <div class="item-list">
          <button
            v-for="page in store.notionParentPages"
            :key="page.id"
            type="button"
            class="item-row"
            :class="{ active: page.id === store.syncConfig.selectedParentPageId }"
            :disabled="!store.syncConfig.connected"
            @click="selectParentPage(page.id)"
          >
            <span>{{ page.title }}</span>
            <small>{{ page.parentPageId ? 'Child page' : 'Page' }}</small>
          </button>
        </div>
      </div>
    </section>

    <div
      v-if="archiveTarget"
      class="modal-backdrop"
      role="dialog"
      aria-modal="true"
      aria-labelledby="archive-title"
    >
      <section class="modal">
        <h2 id="archive-title">Archive {{ archiveTarget.kind }}</h2>
        <p>{{ archiveTarget.title }}</p>
        <div class="modal-actions">
          <button
            type="button"
            class="icon-label-button secondary-button"
            title="Cancel"
            aria-label="Cancel"
            @click="cancelArchive"
          >
            <font-awesome-icon :icon="['fas', 'xmark']" fixed-width />
            <span>Cancel</span>
          </button>
          <button
            type="button"
            class="icon-label-button danger-primary"
            title="Archive"
            aria-label="Archive"
            @click="confirmArchive"
          >
            <font-awesome-icon :icon="['fas', 'trash-can']" fixed-width />
            <span>Archive</span>
          </button>
        </div>
      </section>
    </div>
  </main>
</template>

<style scoped>
.shell {
  display: grid;
  grid-template-rows: auto auto auto 1fr;
  min-height: 100vh;
  padding: 14px;
}

.topbar {
  display: grid;
  grid-template-columns: minmax(0, 1fr);
  gap: 10px;
  align-items: center;
  padding-bottom: 12px;
  border-bottom: 1px solid var(--inkwell-border);
}

.topbar-status {
  display: grid;
  grid-template-columns: auto minmax(0, 1fr);
  gap: 10px;
  align-items: center;
  min-width: 0;
}

.topbar-meta {
  display: grid;
  min-width: 0;
  gap: 1px;
}

.topbar-meta strong,
.topbar-meta small {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.topbar-meta small {
  color: var(--inkwell-muted);
  font-size: 0.78rem;
}

.sync-badge {
  display: inline-flex;
  align-items: center;
  justify-self: start;
  gap: 0;
  overflow: hidden;
  min-height: 28px;
  min-width: 28px;
  max-width: 100%;
  padding: 0 9px;
  border: 1px solid var(--inkwell-border);
  border-radius: 999px;
  background: var(--inkwell-surface-muted);
  color: var(--inkwell-text);
  font-size: 0.82rem;
  font-weight: 750;
}

.sync-badge:focus-visible {
  outline: 2px solid color-mix(in srgb, var(--inkwell-accent) 34%, transparent);
  outline-offset: 2px;
}

.sync-dot {
  flex: 0 0 auto;
  width: 8px;
  height: 8px;
  border-radius: 999px;
  background: var(--inkwell-muted);
}

.sync-label {
  display: inline-block;
  max-width: 0;
  margin-left: 0;
  opacity: 0;
  overflow: hidden;
  white-space: nowrap;
  transform: translateX(-4px);
  transition:
    max-width 160ms ease,
    opacity 140ms ease,
    transform 160ms ease,
    margin-left 160ms ease;
}

.sync-badge:hover .sync-label,
.sync-badge:focus-visible .sync-label {
  max-width: 12ch;
  margin-left: 6px;
  opacity: 1;
  transform: translateX(0);
}

.sync-badge.error {
  border-color: #dc2626;
  background: #fef2f2;
  color: #991b1b;
}

.sync-badge.error .sync-dot {
  background: #dc2626;
}

.sync-badge.stale {
  border-color: #f59e0b;
  background: #fffbeb;
  color: #92400e;
}

.sync-badge.stale .sync-dot {
  background: #f59e0b;
}

.sync-change-banner {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
  padding: 7px 12px;
  background: #fffbeb;
  border-bottom: 1px solid #f59e0b;
  font-size: 12px;
  color: #92400e;
  flex-shrink: 0;
}

.sync-change-banner-actions {
  display: flex;
  gap: 6px;
  flex-shrink: 0;
}

.sync-change-banner-btn {
  padding: 3px 10px;
  border-radius: 5px;
  border: 1px solid #d97706;
  background: transparent;
  color: #92400e;
  font-size: 12px;
  cursor: pointer;
  white-space: nowrap;
}

.sync-change-banner-btn:hover {
  background: #fef3c7;
}

.sync-change-banner-btn.primary {
  background: #f59e0b;
  color: #fff;
  border-color: #d97706;
}

.sync-change-banner-btn.primary:hover {
  background: #d97706;
}

.sync-badge.saving {
  border-color: #2563eb;
  background: #eff6ff;
  color: #1d4ed8;
}

.sync-badge.saving .sync-dot {
  background: #2563eb;
}

.sync-badge.saved {
  border-color: #16a34a;
  background: #f0fdf4;
  color: #166534;
}

.sync-badge.saved .sync-dot {
  background: #16a34a;
}

.topbar-switchers {
  display: grid;
  grid-template-columns: minmax(0, 1fr) minmax(0, 1fr);
  gap: 6px;
}

.topbar-switchers select {
  min-width: 0;
}

.topbar-actions {
  display: grid;
  grid-template-columns: repeat(4, minmax(0, 1fr));
  gap: 6px;
}

.topbar-actions button {
  justify-self: stretch;
  min-height: 30px;
  padding: 0 8px;
  font-weight: 750;
}

.topbar-actions .icon-label-button {
  min-width: 0;
  max-width: 100%;
}

.topbar-actions .icon-label-button:hover > span:not(.text-icon),
.topbar-actions .icon-label-button:focus-visible > span:not(.text-icon) {
  max-width: 10ch;
}

.tabs {
  display: grid;
  grid-template-columns: repeat(4, minmax(0, 1fr));
  gap: 4px;
  margin-top: 10px;
  padding: 3px;
  border: 1px solid var(--inkwell-border);
  border-radius: var(--inkwell-radius);
  background: var(--inkwell-surface-muted);
}

.tabs button {
  min-width: 0;
  min-height: 30px;
  border-color: transparent;
  background: transparent;
  color: var(--inkwell-muted);
  font-size: 0.82rem;
  font-weight: 800;
}

.tabs .icon-label-button {
  justify-self: stretch;
}

.tabs button.active {
  border-color: var(--inkwell-border);
  background: var(--inkwell-surface);
  color: var(--inkwell-text);
}

.secondary-button {
  border-color: var(--inkwell-border);
  background: var(--inkwell-surface-muted);
  color: var(--inkwell-text);
}

.icon-label-button {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  gap: 0;
  min-width: 32px;
  max-width: 100%;
  overflow: hidden;
  white-space: nowrap;
}

.icon-label-button > svg,
.icon-label-button > .text-icon {
  flex: 0 0 auto;
  width: 18px;
}

.icon-label-button > span:not(.text-icon) {
  display: inline-block;
  max-width: 0;
  opacity: 0;
  overflow: hidden;
  transform: translateX(-4px);
  transition:
    max-width 160ms ease,
    opacity 140ms ease,
    transform 160ms ease,
    margin-left 160ms ease;
}

.icon-label-button:hover > span:not(.text-icon),
.icon-label-button:focus-visible > span:not(.text-icon) {
  max-width: min(18ch, calc(100vw - 84px));
  margin-left: 6px;
  opacity: 1;
  transform: translateX(0);
}

.icon-label-button:disabled:hover > span:not(.text-icon) {
  max-width: 0;
  margin-left: 0;
  opacity: 0;
  transform: translateX(-4px);
}

.text-icon {
  display: inline-flex;
  justify-content: center;
  font-size: 0.76rem;
  font-weight: 850;
  letter-spacing: 0;
}

.page-title input,
.editor-header p {
  margin: 0;
}

.editor-header p {
  color: var(--inkwell-muted);
}

.error {
  margin: 10px 0 0;
  color: var(--inkwell-warning);
}

.auth-gate {
  display: grid;
  gap: 10px;
  align-content: start;
  margin-top: 12px;
  padding: 14px;
  border: 1px solid var(--inkwell-border);
  border-radius: var(--inkwell-radius);
  background: var(--inkwell-surface);
  box-shadow: var(--inkwell-shadow);
}

.auth-gate h2,
.auth-gate p {
  margin: 0;
}

.auth-gate h2 {
  font-size: 1rem;
}

.auth-gate p {
  color: var(--inkwell-muted);
}

.legal-disclosure {
  display: grid;
  gap: 10px;
}

.legal-disclosure p {
  margin: 0;
  color: var(--inkwell-muted);
}

.legal-consent {
  display: grid;
  grid-template-columns: auto minmax(0, 1fr);
  gap: 8px;
  align-items: start;
  color: var(--inkwell-muted);
  font-size: 0.8rem;
  line-height: 1.4;
}

.legal-consent input {
  width: 16px;
  height: 16px;
  margin: 1px 0 0;
  accent-color: var(--inkwell-accent);
}

.legal-consent a,
.legal-links a {
  color: var(--inkwell-accent);
  font-weight: 750;
  text-decoration: none;
}

.legal-consent a:hover,
.legal-links a:hover {
  text-decoration: underline;
}

.legal-links {
  display: flex;
  flex-wrap: wrap;
  gap: 10px;
  margin: 0;
}

.editor-shell {
  display: grid;
  grid-template-rows: auto minmax(0, 1fr);
  min-height: 0;
  margin-top: 12px;
  border: 1px solid var(--inkwell-border);
  border-radius: var(--inkwell-radius);
  background: var(--inkwell-surface);
  box-shadow: var(--inkwell-shadow);
}

.record-panel {
  display: flex;
  align-items: center;
  padding: 4px 2px;
}

.tab-panel {
  display: grid;
  align-content: start;
  gap: 12px;
  min-height: 0;
  margin-top: 12px;
  overflow: auto;
}

.editor-header {
  display: grid;
  gap: 10px;
  padding: 10px;
  border-bottom: 1px solid var(--inkwell-border);
}

.editor-title-row,
.section-heading,
.manage-row,
.inline-form,
.recording-row,
.modal-actions {
  display: grid;
  gap: 8px;
  align-items: center;
}

.editor-title-row {
  grid-template-columns: minmax(0, 1fr) auto;
  align-items: start;
}

.editor-title-row .page-title {
  min-width: 0;
}

.section-heading {
  grid-template-columns: minmax(0, 1fr) auto;
}

.manage-row {
  grid-template-columns: minmax(0, 1fr) auto;
}

.modal-actions {
  grid-template-columns: repeat(2, minmax(96px, 1fr));
}

.recording-row {
  grid-template-columns: auto minmax(0, 1fr);
}

.inline-form {
  grid-template-columns: minmax(0, 1fr) auto;
}

.inline-form input,
.manage-row select {
  min-width: 0;
}

.inline-form button,
.manage-row button,
.section-heading button,
.recording-row button {
  min-height: 32px;
  padding: 0 10px;
  font-weight: 750;
}

.panel-section {
  display: grid;
  gap: 10px;
  padding: 12px 0;
  border-bottom: 1px solid var(--inkwell-border);
}

.panel-section:first-child {
  padding-top: 0;
}

.panel-section:last-child {
  border-bottom: 0;
}

.panel-section h2,
.section-heading h2 {
  margin: 0;
  font-size: 0.95rem;
}

.field-label,
.stack-form {
  display: grid;
  gap: 6px;
}

.field-label {
  color: var(--inkwell-muted);
  font-size: 0.78rem;
  font-weight: 750;
}

.field-label input {
  color: var(--inkwell-text);
  font-size: 1rem;
  font-weight: 500;
}

.field-label textarea {
  min-width: 0;
  resize: vertical;
  color: var(--inkwell-text);
  font: inherit;
}

.stack-form {
  padding-bottom: 10px;
  border-bottom: 1px solid var(--inkwell-border);
}

.stack-form:last-of-type {
  border-bottom: 0;
}

.item-list {
  display: grid;
  gap: 6px;
}

.item-row {
  display: grid;
  grid-template-columns: minmax(0, 1fr) auto;
  gap: 8px;
  align-items: center;
  width: 100%;
  min-height: 38px;
  padding: 7px 9px;
  border-color: var(--inkwell-border);
  background: var(--inkwell-surface);
  color: var(--inkwell-text);
  text-align: left;
}

.item-row span,
.item-row small {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.item-row small {
  color: var(--inkwell-muted);
  font-size: 0.76rem;
}

.item-row.active {
  border-color: var(--inkwell-accent);
  background: var(--inkwell-accent-soft);
}

.status-list {
  display: grid;
  gap: 8px;
  margin: 0;
}

.status-list div {
  display: grid;
  grid-template-columns: 86px minmax(0, 1fr);
  gap: 8px;
}

.status-list dt {
  color: var(--inkwell-muted);
  font-weight: 750;
}

.status-list dd {
  min-width: 0;
  margin: 0;
  overflow-wrap: anywhere;
}

.recording-row {
  align-items: start;
}

.recording-row small {
  color: var(--inkwell-muted);
}

.danger-button {
  color: #991b1b;
}

.danger-primary {
  border-color: #dc2626;
  background: #dc2626;
  color: white;
}

.modal-backdrop {
  position: fixed;
  inset: 0;
  display: grid;
  place-items: center;
  padding: 18px;
  background: rgb(17 17 19 / 36%);
}

.modal {
  display: grid;
  width: min(100%, 320px);
  gap: 10px;
  padding: 14px;
  border: 1px solid var(--inkwell-border);
  border-radius: var(--inkwell-radius);
  background: var(--inkwell-surface);
  box-shadow: var(--inkwell-shadow);
}

.modal h2,
.modal p {
  margin: 0;
}

.modal p {
  overflow-wrap: anywhere;
}

.page-title {
  display: grid;
  gap: 3px;
}

.page-title input {
  width: 100%;
  min-width: 0;
  border: 0;
  background: transparent;
  color: var(--inkwell-text);
}

.page-title input {
  font-size: 1rem;
  font-weight: 700;
}

.page-title input:focus {
  outline: 2px solid color-mix(in srgb, var(--inkwell-accent) 34%, transparent);
  outline-offset: 2px;
}

.editor-tools {
  position: relative;
  display: grid;
  gap: 8px;
}

.editor-tool-tabs {
  display: grid;
  grid-template-columns: repeat(3, minmax(92px, 1fr));
  gap: 3px;
  width: 100%;
  padding: 3px;
  border: 1px solid var(--inkwell-border);
  border-radius: var(--inkwell-radius);
  background: var(--inkwell-surface-muted);
}

.editor-tool-tabs button {
  min-width: 0;
  min-height: 32px;
  padding: 0 8px;
  border-color: transparent;
  background: transparent;
  color: var(--inkwell-muted);
  font-size: 0.8rem;
  font-weight: 800;
}

.editor-tool-tabs .icon-label-button {
  justify-self: stretch;
}

.editor-tool-tabs .icon-label-button:hover > span:not(.text-icon),
.editor-tool-tabs .icon-label-button:focus-visible > span:not(.text-icon) {
  max-width: 11ch;
}

.editor-tool-tabs button.active {
  border-color: var(--inkwell-border);
  background: var(--inkwell-surface);
  color: var(--inkwell-text);
}

.editor-quickbar {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(92px, max-content));
  gap: 6px;
  align-items: center;
}

.tool-icon-button {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  gap: 0;
  min-width: 42px;
  max-width: 100%;
  min-height: 32px;
  padding: 0 8px;
  border-color: var(--inkwell-border);
  background: var(--inkwell-surface-muted);
  color: var(--inkwell-text);
  font-weight: 800;
}

.tool-icon-button.active {
  border-color: var(--inkwell-accent);
  background: var(--inkwell-accent-soft);
  color: var(--inkwell-accent-strong);
}

.tool-popover {
  display: grid;
  max-width: 100%;
  padding: 10px;
  border: 1px solid var(--inkwell-border);
  border-radius: var(--inkwell-radius);
  background: var(--inkwell-surface);
  box-shadow: var(--inkwell-shadow);
}

.tool-panel {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(124px, 1fr));
  gap: 8px;
  align-items: end;
}

.tool-panel .field-label {
  min-width: 0;
}

.tool-panel input,
.toolbar-select {
  width: 100%;
  min-width: 0;
}

.tool-panel button {
  min-height: 32px;
  padding: 0 10px;
  border-color: var(--inkwell-border);
  background: var(--inkwell-surface-muted);
  color: var(--inkwell-text);
  font-weight: 750;
}

.button-grid {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(112px, 1fr));
  width: 100%;
}

.button-grid button.active,
.tool-panel button.active {
  border-color: var(--inkwell-accent);
  background: var(--inkwell-accent);
  color: white;
}

.link-form input {
  min-width: 0;
}

.editor-context-menu {
  position: fixed;
  z-index: 50;
  width: max-content;
  max-width: min(352px, calc(100vw - 16px));
  padding: 6px;
  border: 1px solid rgb(55 53 47 / 12%);
  border-radius: 7px;
  background: var(--inkwell-surface);
  box-shadow:
    0 8px 24px rgb(15 23 42 / 12%),
    0 1px 4px rgb(15 23 42 / 8%);
  color: var(--inkwell-text);
}

.context-menu-stack {
  display: grid;
  gap: 6px;
}

.context-menu-row {
  display: flex;
  align-items: center;
  gap: 4px;
}

.context-menu-divider {
  height: 1px;
  margin: 1px 0;
  background: var(--inkwell-border);
}

.context-menu-button {
  display: inline-grid;
  place-items: center;
  min-width: 28px;
  width: 28px;
  height: 28px;
  min-height: 28px;
  padding: 0;
  border: 0;
  border-radius: 5px;
  background: transparent;
  color: var(--inkwell-text);
  font-size: 0.82rem;
  font-weight: 750;
}

.context-menu-button:hover,
.context-menu-button:focus-visible,
.context-menu-button.active {
  background: var(--inkwell-surface-muted);
  color: var(--inkwell-text);
}

.context-menu-button:disabled {
  background: transparent;
  color: var(--inkwell-muted);
  opacity: 0.45;
}

.context-menu-button.text-action {
  width: auto;
  min-width: 48px;
  padding: 0 8px;
}

.context-color-icon {
  display: inline-grid;
  place-items: center;
  width: 18px;
  height: 18px;
  border-bottom: 2px solid var(--inkwell-accent);
  font-weight: 850;
  line-height: 1;
}

.context-menu-select,
.context-menu-input {
  height: 28px;
  min-height: 28px;
  padding: 0 7px;
  border-color: transparent;
  border-radius: 5px;
  background: transparent;
  color: var(--inkwell-text);
  font-size: 0.82rem;
}

.context-menu-select {
  width: 88px;
}

.context-menu-select.wide {
  width: 132px;
}

.context-menu-input {
  width: min(290px, calc(100vw - 42px));
  border-color: var(--inkwell-border);
  background: var(--inkwell-surface);
}

.context-menu-select:hover,
.context-menu-select:focus {
  background: var(--inkwell-surface-muted);
  outline: none;
}

.context-menu-section-label {
  padding: 2px 4px 0;
  color: var(--inkwell-muted);
  font-size: 0.72rem;
  font-weight: 800;
  text-transform: uppercase;
}

.context-color-grid {
  display: grid;
  grid-template-columns: repeat(2, minmax(0, 1fr));
  gap: 2px;
  min-width: 230px;
}

.context-swatch {
  display: grid;
  grid-template-columns: 18px minmax(0, 1fr);
  gap: 7px;
  align-items: center;
  min-height: 28px;
  padding: 0 7px;
  border: 0;
  border-radius: 5px;
  background: transparent;
  color: var(--inkwell-text);
  font-size: 0.82rem;
  font-weight: 650;
  text-align: left;
}

.context-swatch:hover,
.context-swatch:focus-visible,
.context-swatch.active {
  background: var(--inkwell-surface-muted);
}

.context-swatch-chip {
  display: block;
  width: 14px;
  height: 14px;
  border: 1px solid var(--inkwell-border-strong);
  border-radius: 4px;
}

.editor {
  min-height: 0;
  overflow: auto;
}

.editor :deep(.tiptap) {
  min-height: calc(100vh - 190px);
  padding: 16px;
}

.editor :deep(.tiptap:focus) {
  outline: none;
}

.editor :deep(.tiptap > *:first-child) {
  margin-top: 0;
}

.editor :deep(.tiptap p),
.editor :deep(.tiptap blockquote),
.editor :deep(.tiptap ul),
.editor :deep(.tiptap ol),
.editor :deep(.tiptap pre) {
  margin: 0 0 0.85rem;
}

.editor :deep(.tiptap h1),
.editor :deep(.tiptap h2),
.editor :deep(.tiptap h3),
.editor :deep(.tiptap h4),
.editor :deep(.tiptap h5),
.editor :deep(.tiptap h6) {
  margin: 0 0 0.75rem;
  line-height: 1.22;
}

.editor :deep(.tiptap h1) {
  font-size: 1.8rem;
}

.editor :deep(.tiptap h2) {
  font-size: 1.55rem;
}

.editor :deep(.tiptap h3) {
  font-size: 1.32rem;
}

.editor :deep(.tiptap h4) {
  font-size: 1.14rem;
}

.editor :deep(.tiptap h5) {
  font-size: 1rem;
}

.editor :deep(.tiptap h6) {
  color: var(--inkwell-muted);
  font-size: 0.9rem;
  text-transform: uppercase;
}

.editor :deep(.tiptap ul),
.editor :deep(.tiptap ol) {
  padding-left: 1.35rem;
}

.editor :deep(.tiptap ul[data-type="taskList"]) {
  padding-left: 0;
  list-style: none;
}

.editor :deep(.tiptap li[data-type="taskItem"]) {
  display: grid;
  grid-template-columns: 22px minmax(0, 1fr);
  gap: 4px;
  align-items: start;
}

.editor :deep(.tiptap li[data-type="taskItem"] > label) {
  display: grid;
  place-items: center;
  min-height: 1.45em;
}

.editor :deep(.tiptap li[data-type="taskItem"] input) {
  margin: 0;
}

.editor :deep(.tiptap code) {
  border-radius: 4px;
  background: var(--inkwell-surface-muted);
  padding: 0.1em 0.28em;
  font-family: "SFMono-Regular", Consolas, "Liberation Mono", monospace;
  font-size: 0.9em;
}

.editor :deep(.tiptap pre) {
  overflow: auto;
  border-radius: 6px;
  background: #111113;
  color: #f4f4f5;
  padding: 12px;
}

.editor :deep(.tiptap pre code) {
  background: transparent;
  color: inherit;
  padding: 0;
}

.editor :deep(.tiptap hr) {
  margin: 1.1rem 0;
  border: 0;
  border-top: 1px solid var(--inkwell-border-strong);
}

.editor :deep(.tiptap blockquote) {
  padding-left: 12px;
  border-left: 3px solid var(--inkwell-accent);
  color: var(--inkwell-text);
}

.editor :deep(.tiptap a) {
  color: var(--inkwell-accent-strong);
  overflow-wrap: anywhere;
}

.editor :deep(.tiptap img) {
  max-width: 100%;
  height: auto;
  display: block;
  border-radius: 4px;
}

.editor :deep(.tiptap .inkwell-image-wrapper) {
  margin: 0 0 0.85rem;
  max-width: 100%;
  position: relative;
  width: fit-content;
}

.editor :deep(.tiptap .inkwell-image-wrapper.is-selected) {
  outline: 2px solid var(--inkwell-accent);
  outline-offset: 3px;
}

.editor :deep(.tiptap .inkwell-image-wrapper.is-selected[data-inkwell-block-id]::before) {
  background: var(--inkwell-accent);
  border-radius: 4px;
  color: var(--inkwell-surface);
  content: attr(data-inkwell-block-id);
  font-size: 0.68rem;
  left: 0;
  line-height: 1.25;
  max-width: min(100%, 28ch);
  overflow: hidden;
  padding: 2px 5px;
  position: absolute;
  text-overflow: ellipsis;
  top: -1.45rem;
  white-space: nowrap;
}

.editor :deep(.tiptap .inkwell-image-wrapper .inkwell-image-resize-handle) {
  background: var(--inkwell-accent);
  border: 2px solid var(--inkwell-surface);
  border-radius: 999px;
  bottom: -7px;
  box-shadow: 0 1px 4px rgba(15, 23, 42, 0.22);
  cursor: nwse-resize;
  display: none;
  height: 12px;
  position: absolute;
  right: -7px;
  width: 12px;
}

.editor :deep(.tiptap .inkwell-image-wrapper.is-selected .inkwell-image-resize-handle) {
  display: block;
}

.editor :deep(.tiptap .inkwell-image-wrapper.is-error),
.editor :deep(.tiptap .inkwell-image-wrapper.is-uploading) {
  border: 1px solid var(--inkwell-border);
  border-radius: 4px;
  background: var(--inkwell-surface-muted);
  color: var(--inkwell-muted);
  padding: 10px;
  font-size: 0.86rem;
}

.editor :deep(.tiptap .inkwell-image-wrapper a) {
  word-break: break-all;
}

.editor :deep(.tiptap .inkwell-audio-wrapper) {
  max-width: 640px;
  margin: 0 0 0.85rem;
}

.editor :deep(.tiptap .inkwell-audio-wrapper audio) {
  display: block;
  width: 100%;
}

.editor :deep(.tiptap .inkwell-audio-wrapper.is-error),
.editor :deep(.tiptap .inkwell-audio-wrapper.is-uploading) {
  border: 1px solid var(--inkwell-border);
  border-radius: 4px;
  background: var(--inkwell-surface-muted);
  color: var(--inkwell-muted);
  padding: 10px;
  font-size: 0.86rem;
}

.editor :deep(.tiptap .inkwell-audio-wrapper a) {
  word-break: break-all;
}

.editor :deep(.tiptap div[data-youtube-video]) {
  width: 100%;
  max-width: 640px;
  aspect-ratio: 16 / 9;
  margin: 0 0 0.85rem;
  overflow: hidden;
  border-radius: 4px;
  background: #111113;
}

.editor :deep(.tiptap div[data-youtube-video] iframe) {
  display: block;
  width: 100% !important;
  height: 100% !important;
  border: 0;
}

</style>
