<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref, watch } from 'vue';
import { EditorContent, useEditor } from '@tiptap/vue-3';
import { TextSelection } from '@tiptap/pm/state';
import type { EditorView } from '@tiptap/pm/view';
import StarterKit from '@tiptap/starter-kit';
import {
  decodeJotSource,
  JOT_SOURCE_ATTR,
  JotLink,
} from '@/src/extensions/jotLink';
import { PortableTextEditingKit } from '@/src/extensions/textFormatting';
import { MediaKit } from '@/src/extensions/media';
import {
  hasPendingTransientMedia,
  sanitizeMediaForSync,
} from '@/src/extensions/mediaContent';
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
  createCapturedContent,
  createLinkedHeadingContent,
  notionClient,
} from '@/src/services/notionClient';
import { useJotStore } from '@/src/stores/jot';
import type { DocumentContent } from '@/src/types/capture';
import type {
  CaptureSelectionPayload,
  ConsumeHeadingDragMessage,
  OpenSourceRequestMessage,
} from '@/src/types/messages';

const JOT_DRAG_MIME = 'application/x-jot-capture';
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

const store = useJotStore();
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
const activeTab = ref<'editor' | 'projects' | 'media' | 'sync'>('editor');
const editorToolbarMode = ref<'style' | 'insert' | 'controls'>('style');
const activeEditorMenu = ref<
  | 'type'
  | 'marks'
  | 'color'
  | 'link'
  | 'lists'
  | 'blocks'
  | 'history'
  | null
>(null);
const archiveTarget = ref<{
  kind: 'project' | 'page';
  id: string;
  title: string;
} | null>(null);
const isSigningIn = ref(false);
const editorStateVersion = ref(0);
const isRecordingAudio = ref(false);
const isPreparingAudioRecording = ref(false);
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
let audioStream: MediaStream | undefined;
let audioChunks: Blob[] = [];

const editor = useEditor({
  extensions: [
    StarterKit.configure({
      heading: {
        levels: [1, 2, 3, 4, 5, 6],
      },
      link: false,
    }),
    JotLink,
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
    handleClick: (_view, _pos, event) => {
      const anchor =
        event.target instanceof Element ? event.target.closest('a') : null;

      if (!anchor?.href) {
        return false;
      }

      event.preventDefault();

      const sourcePayload = decodeJotSource(
        anchor.getAttribute(`data-${kebabCase(JOT_SOURCE_ATTR)}`),
      );

      if (sourcePayload) {
        void browser.runtime.sendMessage({
          type: 'jot.openSourceRequest',
          payload: sourcePayload,
        } satisfies OpenSourceRequestMessage);
        return true;
      }

      void browser.tabs.create({ active: true, url: anchor.href });
      return true;
    },
    handleDrop: (view, event) => {
      const payload = readHeadingDropPayload(event);

      if (payload) {
        event.preventDefault();
        insertLinkedHeadingAtDrop(view, event, payload);
        return true;
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

  return 'Saved';
});

const syncBadgeTitle = computed(() => {
  if (store.errorMessage) {
    return store.errorMessage;
  }

  if (!store.syncConfig.connected) {
    return 'Log in with Notion to sync across devices.';
  }

  if (!store.syncConfig.selectedParentPageId) {
    return 'Jot will create a root Notion page with project folders on first sync.';
  }

  return store.syncConfig.selectedParentPageTitle
    ? `Synced inside ${store.syncConfig.selectedParentPageTitle}`
    : saveLabel.value;
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
  (store.syncConfig.selectedParentPageId ? 'Selected Notion page' : 'Default Jot root page'),
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
  void initializePanel();
});

onBeforeUnmount(() => {
  window.clearTimeout(saveTimer.value);
  window.clearInterval(sessionPollTimer);
  if (editor.value && store.currentPage) {
    void saveEditorContentOptimistically();
  }
  stopAudioStream();
  editor.value?.destroy();
});

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
    if (tab === 'sync' && store.syncConfig.connected) {
      void store.loadNotionParentPages(parentPageSearchDraft.value);
    }
  },
);

async function initializePanel() {
  await store.initialize();
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

  saveEditorContentInBackground();
  await store.selectPage(pageId);
}

async function selectProject(projectId: string) {
  if (!projectId || projectId === store.currentProjectId) {
    return;
  }

  saveEditorContentInBackground();
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
  isSigningIn.value = true;
  await browser.tabs.create({ active: true, url: store.getSyncLoginUrl() });
  startSessionPolling();
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
  activeEditorMenu.value = activeEditorMenu.value === menu ? null : menu;

  if (activeEditorMenu.value === 'link') {
    openLinkTools();
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
  const title = parentPageTitleDraft.value.trim() || 'Jot';
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
  const value = (event.target as HTMLSelectElement).value;
  const chain = editor.value?.chain().focus();

  if (!chain) {
    return;
  }

  if (value === 'paragraph') {
    chain.setParagraph().run();
    return;
  }

  if (value.startsWith('heading-')) {
    chain
      .toggleHeading({ level: Number(value.replace('heading-', '')) as 1 | 2 | 3 | 4 | 5 | 6 })
      .run();
    return;
  }

  if (value === 'blockquote') {
    chain.toggleBlockquote().run();
    return;
  }

  if (value === 'codeBlock') {
    chain.toggleCodeBlock().run();
  }
}

function setFontSize(event: Event) {
  const value = (event.target as HTMLSelectElement).value;

  if (value) {
    editor.value?.chain().focus().setFontSize(value).run();
  } else {
    editor.value?.chain().focus().unsetFontSize().run();
  }
}

function setTextColor(event: Event) {
  const value = (event.target as HTMLSelectElement).value;

  if (value) {
    editor.value?.chain().focus().setTextColor(value).run();
  } else {
    editor.value?.chain().focus().unsetTextColor().run();
  }
}

function setHighlightColor(event: Event) {
  const value = (event.target as HTMLSelectElement).value;

  if (value) {
    editor.value?.chain().focus().setHighlightColor(value).run();
  } else {
    editor.value?.chain().focus().unsetHighlightColor().run();
  }
}

function setLink() {
  if (!editor.value) {
    return;
  }

  const trimmedHref = linkUrlDraft.value.trim();

  if (!trimmedHref) {
    editor.value.chain().focus().extendMarkRange('link').unsetLink().run();
    linkUrlDraft.value = '';
    return;
  }

  editor.value
    .chain()
    .focus()
    .extendMarkRange('link')
    .setLink({ href: trimmedHref })
    .run();
  linkUrlDraft.value = '';
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

  editor.value?.chain().focus().setYoutubeVideo({ src }).run();
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

async function toggleAudioRecording() {
  if (isRecordingAudio.value) {
    audioRecorder?.stop();
    return;
  }

  await startAudioRecording();
}

async function startAudioRecording() {
  if (!editor.value || isPreparingAudioRecording.value) {
    return;
  }

  if (!navigator.mediaDevices?.getUserMedia) {
    uiMessage.value = 'Audio recording is not available in this browser.';
    return;
  }

  isPreparingAudioRecording.value = true;

  try {
    audioStream = await navigator.mediaDevices.getUserMedia({ audio: true });
    audioChunks = [];
    const mimeType = preferredAudioRecordingMimeType();
    audioRecorder = new MediaRecorder(
      audioStream,
      mimeType ? { mimeType } : undefined,
    );

    audioRecorder.addEventListener('dataavailable', (event) => {
      if (event.data.size > 0) {
        audioChunks.push(event.data);
      }
    });

    audioRecorder.addEventListener('stop', () => {
      const recorderMimeType = audioRecorder?.mimeType || mimeType || 'audio/webm';
      const audioBlob = new Blob(audioChunks, { type: recorderMimeType });
      const extension = audioExtensionFromMimeType(recorderMimeType);
      const file = new File(
        [audioBlob],
        `jot-recording-${new Date().toISOString().replace(/[:.]/g, '-')}.${extension}`,
        { type: recorderMimeType },
      );

      isRecordingAudio.value = false;
      audioRecorder = undefined;
      audioChunks = [];
      stopAudioStream();
      void handleUploadableAudioFile(file);
    });

    audioRecorder.start();
    isRecordingAudio.value = true;
  } catch (error) {
    uiMessage.value =
      error instanceof Error ? error.message : 'Unable to start audio recording.';
    stopAudioStream();
  } finally {
    isPreparingAudioRecording.value = false;
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

function clearFormatting() {
  editor.value?.chain().focus().unsetAllMarks().clearNodes().run();
}

async function flushEditorContent() {
  window.clearTimeout(saveTimer.value);

  await saveEditorContentOptimistically();
}

function saveEditorContentInBackground() {
  window.clearTimeout(saveTimer.value);

  if (!editor.value || !store.currentPage) {
    return;
  }

  const page = { ...store.currentPage };
  const editorContent = editor.value.getJSON() as DocumentContent;

  if (hasPendingTransientMedia(editorContent)) {
    return;
  }

  const content = sanitizeMediaForSync(editorContent);
  const title = pageTitleDraft.value;

  lastAppliedContent = JSON.stringify(content);
  void store.savePageContentSnapshot(page, content, {
    preserveLocalContent: true,
    title,
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

      const content = sanitizeMediaForSync(editorContent);
      lastAppliedContent = JSON.stringify(content);
      await store.saveCurrentPageContent(content, {
        preserveLocalContent: true,
        title: pageTitleDraft.value,
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
  queueMicrotask(() => {
    shouldSkipNextUpdateSave = false;
  });

  let fileUploadId = '';

  try {
    fileUploadId = await notionClient.uploadMedia(file, file.type, file.name);
  } catch (error) {
    uiMessage.value =
      error instanceof Error ? error.message : 'Unable to upload this image to Notion.';
  }

  shouldSkipNextUpdateSave = true;
  editor.value?.state.doc.descendants((node, pos) => {
    if (node.type.name === 'image' && node.attrs.src === localSrc) {
      editor.value
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
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  editor.value?.chain().focus().setAudio({
    src: localSrc,
    uploadState: 'uploading',
    mimeType: file.type,
  } as any).run();
  queueMicrotask(() => {
    shouldSkipNextUpdateSave = false;
  });

  let fileUploadId = '';

  try {
    fileUploadId = await notionClient.uploadMedia(file, file.type, file.name);
  } catch (error) {
    uiMessage.value =
      error instanceof Error ? error.message : 'Unable to upload this audio to Notion.';
  }

  shouldSkipNextUpdateSave = true;
  editor.value?.state.doc.descendants((node, pos) => {
    if (node.type.name === 'audio' && node.attrs.src === localSrc) {
      editor.value
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

  if (!fileUploadId) {
    return;
  }

  void saveEditorContentOptimistically();
}

function stopAudioStream() {
  audioStream?.getTracks().forEach((track) => track.stop());
  audioStream = undefined;
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

function readHeadingDropPayload(event: DragEvent) {
  const rawPayload = event.dataTransfer?.getData(JOT_DRAG_MIME);

  if (!rawPayload) {
    return null;
  }

  try {
    const payload = JSON.parse(rawPayload) as CaptureSelectionPayload;
    return payload.highlightMeta.isHeading ? payload : null;
  } catch {
    return null;
  }
}

function isLikelyHeadingDrop(event: DragEvent) {
  const html = event.dataTransfer?.getData('text/html') ?? '';

  return /<h[1-6](\s|>)/i.test(html);
}

async function consumeHeadingDropPayload(event: DragEvent) {
  const text = event.dataTransfer?.getData('text/plain')?.replace(/\s+/g, ' ').trim();

  return browser.runtime
    .sendMessage({
      type: 'jot.consumeHeadingDrag',
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
      <button
        type="button"
        class="icon-label-button"
        :disabled="isSigningIn"
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
                @click="editor?.chain().focus().toggleBold().run()"
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
                @click="editor?.chain().focus().toggleItalic().run()"
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
                @click="editor?.chain().focus().toggleUnderline().run()"
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
                @click="editor?.chain().focus().toggleStrike().run()"
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
                @click="editor?.chain().focus().toggleCode().run()"
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
                @click="editor?.chain().focus().toggleSuperscript().run()"
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
                @click="editor?.chain().focus().toggleSubscript().run()"
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
                @click="editor?.chain().focus().toggleBulletList().run()"
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
                @click="editor?.chain().focus().toggleOrderedList().run()"
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
                @click="editor?.chain().focus().toggleTaskList().run()"
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
                @click="editor?.chain().focus().toggleBlockquote().run()"
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
                @click="editor?.chain().focus().toggleCodeBlock().run()"
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

      <editor-content v-if="editor" class="editor" :editor="editor" />
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

        <div class="recording-row">
          <button
            type="button"
            class="icon-label-button"
            :class="{ active: isRecordingAudio }"
            :disabled="!editor || isPreparingAudioRecording"
            :title="isRecordingAudio ? 'Stop recording audio' : 'Record audio'"
            :aria-label="isRecordingAudio ? 'Stop recording audio' : 'Record audio'"
            @click="toggleAudioRecording"
          >
            <font-awesome-icon :icon="isRecordingAudio ? ['fas', 'xmark'] : ['fas', 'microphone']" fixed-width />
            <span>{{ isRecordingAudio ? 'Stop recording' : 'Record audio' }}</span>
          </button>
          <small>{{ isPreparingAudioRecording ? 'Preparing microphone...' : 'Drop images, audio, or YouTube links into the editor.' }}</small>
        </div>
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

        <button
          v-if="!store.syncConfig.connected"
          type="button"
          class="icon-label-button"
          :disabled="isSigningIn"
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
  border-bottom: 1px solid var(--jot-border);
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
  color: var(--jot-muted);
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
  border: 1px solid var(--jot-border);
  border-radius: 999px;
  background: var(--jot-surface-muted);
  color: var(--jot-text);
  font-size: 0.82rem;
  font-weight: 750;
}

.sync-badge:focus-visible {
  outline: 2px solid color-mix(in srgb, var(--jot-accent) 34%, transparent);
  outline-offset: 2px;
}

.sync-dot {
  flex: 0 0 auto;
  width: 8px;
  height: 8px;
  border-radius: 999px;
  background: var(--jot-muted);
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
  border: 1px solid var(--jot-border);
  border-radius: var(--jot-radius);
  background: var(--jot-surface-muted);
}

.tabs button {
  min-width: 0;
  min-height: 30px;
  border-color: transparent;
  background: transparent;
  color: var(--jot-muted);
  font-size: 0.82rem;
  font-weight: 800;
}

.tabs .icon-label-button {
  justify-self: stretch;
}

.tabs button.active {
  border-color: var(--jot-border);
  background: var(--jot-surface);
  color: var(--jot-text);
}

.secondary-button {
  border-color: var(--jot-border);
  background: var(--jot-surface-muted);
  color: var(--jot-text);
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
  color: var(--jot-muted);
}

.error {
  margin: 10px 0 0;
  color: var(--jot-warning);
}

.auth-gate {
  display: grid;
  gap: 10px;
  align-content: start;
  margin-top: 12px;
  padding: 14px;
  border: 1px solid var(--jot-border);
  border-radius: var(--jot-radius);
  background: var(--jot-surface);
  box-shadow: var(--jot-shadow);
}

.auth-gate h2,
.auth-gate p {
  margin: 0;
}

.auth-gate h2 {
  font-size: 1rem;
}

.auth-gate p {
  color: var(--jot-muted);
}

.editor-shell {
  display: grid;
  grid-template-rows: auto minmax(0, 1fr);
  min-height: 0;
  margin-top: 12px;
  border: 1px solid var(--jot-border);
  border-radius: var(--jot-radius);
  background: var(--jot-surface);
  box-shadow: var(--jot-shadow);
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
  border-bottom: 1px solid var(--jot-border);
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
  border-bottom: 1px solid var(--jot-border);
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
  color: var(--jot-muted);
  font-size: 0.78rem;
  font-weight: 750;
}

.field-label input {
  color: var(--jot-text);
  font-size: 1rem;
  font-weight: 500;
}

.field-label textarea {
  min-width: 0;
  resize: vertical;
  color: var(--jot-text);
  font: inherit;
}

.stack-form {
  padding-bottom: 10px;
  border-bottom: 1px solid var(--jot-border);
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
  border-color: var(--jot-border);
  background: var(--jot-surface);
  color: var(--jot-text);
  text-align: left;
}

.item-row span,
.item-row small {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.item-row small {
  color: var(--jot-muted);
  font-size: 0.76rem;
}

.item-row.active {
  border-color: var(--jot-accent);
  background: var(--jot-accent-soft);
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
  color: var(--jot-muted);
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
  color: var(--jot-muted);
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
  border: 1px solid var(--jot-border);
  border-radius: var(--jot-radius);
  background: var(--jot-surface);
  box-shadow: var(--jot-shadow);
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
  color: var(--jot-text);
}

.page-title input {
  font-size: 1rem;
  font-weight: 700;
}

.page-title input:focus {
  outline: 2px solid color-mix(in srgb, var(--jot-accent) 34%, transparent);
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
  border: 1px solid var(--jot-border);
  border-radius: var(--jot-radius);
  background: var(--jot-surface-muted);
}

.editor-tool-tabs button {
  min-width: 0;
  min-height: 32px;
  padding: 0 8px;
  border-color: transparent;
  background: transparent;
  color: var(--jot-muted);
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
  border-color: var(--jot-border);
  background: var(--jot-surface);
  color: var(--jot-text);
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
  border-color: var(--jot-border);
  background: var(--jot-surface-muted);
  color: var(--jot-text);
  font-weight: 800;
}

.tool-icon-button.active {
  border-color: var(--jot-accent);
  background: var(--jot-accent-soft);
  color: var(--jot-accent-strong);
}

.tool-popover {
  display: grid;
  max-width: 100%;
  padding: 10px;
  border: 1px solid var(--jot-border);
  border-radius: var(--jot-radius);
  background: var(--jot-surface);
  box-shadow: var(--jot-shadow);
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
  border-color: var(--jot-border);
  background: var(--jot-surface-muted);
  color: var(--jot-text);
  font-weight: 750;
}

.button-grid {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(112px, 1fr));
  width: 100%;
}

.button-grid button.active,
.tool-panel button.active {
  border-color: var(--jot-accent);
  background: var(--jot-accent);
  color: white;
}

.link-form input {
  min-width: 0;
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
  color: var(--jot-muted);
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
  background: var(--jot-surface-muted);
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
  border-top: 1px solid var(--jot-border-strong);
}

.editor :deep(.tiptap blockquote) {
  padding-left: 12px;
  border-left: 3px solid var(--jot-accent);
  color: var(--jot-text);
}

.editor :deep(.tiptap a) {
  color: var(--jot-accent-strong);
  overflow-wrap: anywhere;
}

.editor :deep(.tiptap img) {
  max-width: 100%;
  height: auto;
  display: block;
  border-radius: 4px;
}

.editor :deep(.tiptap .jot-image-wrapper) {
  margin: 0 0 0.85rem;
}

.editor :deep(.tiptap .jot-image-wrapper.is-error),
.editor :deep(.tiptap .jot-image-wrapper.is-uploading) {
  border: 1px solid var(--jot-border);
  border-radius: 4px;
  background: var(--jot-surface-muted);
  color: var(--jot-muted);
  padding: 10px;
  font-size: 0.86rem;
}

.editor :deep(.tiptap .jot-image-wrapper a) {
  word-break: break-all;
}

.editor :deep(.tiptap .jot-audio-wrapper) {
  max-width: 640px;
  margin: 0 0 0.85rem;
}

.editor :deep(.tiptap .jot-audio-wrapper audio) {
  display: block;
  width: 100%;
}

.editor :deep(.tiptap .jot-audio-wrapper.is-error),
.editor :deep(.tiptap .jot-audio-wrapper.is-uploading) {
  border: 1px solid var(--jot-border);
  border-radius: 4px;
  background: var(--jot-surface-muted);
  color: var(--jot-muted);
  padding: 10px;
  font-size: 0.86rem;
}

.editor :deep(.tiptap .jot-audio-wrapper a) {
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

.editor :deep(.tiptap .jot-youtube-wrapper) {
  width: 100%;
  max-width: 640px;
  aspect-ratio: 16 / 9;
  margin: 0 0 0.85rem;
  overflow: hidden;
  border-radius: 4px;
  background: #111113;
}

.editor :deep(.tiptap .jot-youtube-link) {
  position: relative;
  display: grid;
  width: 100%;
  height: 100%;
  place-items: center;
  color: white;
  text-decoration: none;
}

.editor :deep(.tiptap .jot-youtube-link img) {
  width: 100%;
  height: 100%;
  object-fit: cover;
  opacity: 0.78;
}

.editor :deep(.tiptap .jot-youtube-play) {
  position: absolute;
  display: inline-flex;
  align-items: center;
  min-height: 34px;
  padding: 0 14px;
  border-radius: 4px;
  background: #dc2626;
  color: white;
  font-size: 0.88rem;
  font-weight: 800;
}
</style>
