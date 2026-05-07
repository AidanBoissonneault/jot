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

    if (!isPageChange && editorContent === storedContent) {
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

  const name = window.prompt('Project name', 'Untitled Project');

  if (name === null) {
    return;
  }

  await store.createProject(name);
}

async function renameProject() {
  if (!store.currentProject || projectNameDraft.value === store.currentProject.name) {
    return;
  }

  await flushEditorContent();
  await store.renameCurrentProject(projectNameDraft.value);
}

async function archiveProject() {
  if (!store.currentProject) {
    return;
  }

  const shouldArchive = window.confirm(`Archive project "${store.currentProject.name}"?`);

  if (!shouldArchive) {
    return;
  }

  await flushEditorContent();
  await store.archiveCurrentProject();
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

  const shouldArchive = window.confirm(`Archive "${store.currentPage.title}"?`);

  if (!shouldArchive) {
    return;
  }

  await flushEditorContent();
  await store.archiveCurrentPage();
}

async function resync() {
  if (store.currentPage) {
    await store.refreshSelectedPage(store.currentPage.id);
  } else {
    await initializePanel();
  }
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

  const existingHref = editor.value.getAttributes('link').href;
  const href = window.prompt('Paste link URL', existingHref ?? '');

  if (href === null) {
    return;
  }

  const trimmedHref = href.trim();

  if (!trimmedHref) {
    editor.value.chain().focus().extendMarkRange('link').unsetLink().run();
    return;
  }

  editor.value
    .chain()
    .focus()
    .extendMarkRange('link')
    .setLink({ href: trimmedHref })
    .run();
}

function insertImage() {
  const src = window.prompt('Image URL')?.trim();
  if (src) editor.value?.chain().focus().setImage({ src }).run();
}

function insertVideo() {
  const src = window.prompt('Video or YouTube URL')?.trim();
  if (src) editor.value?.chain().focus().setYoutubeVideo({ src }).run();
}

function insertAudio() {
  const src = window.prompt('MP3 or audio URL')?.trim();

  if (!src) {
    return;
  }

  if (!isHttpAudioUrl(src)) {
    window.alert('Paste a public http(s) URL to an MP3 or audio file.');
    return;
  }

  editor.value?.chain().focus().setAudio({ src }).run();
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
    window.alert('Audio recording is not available in this browser.');
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
    store.errorMessage =
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
    window.alert(`Images must be ${Math.floor(IMAGE_UPLOAD_MAX_BYTES / 1024 / 1024)} MB or smaller.`);
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
    store.errorMessage =
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
    window.alert(`Audio files must be ${Math.floor(AUDIO_UPLOAD_MAX_BYTES / 1024 / 1024)} MB or smaller.`);
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
    store.errorMessage =
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
</script>

<template>
  <main class="shell">
    <header class="topbar">
      <div
        :class="syncBadgeClass"
        :title="syncBadgeTitle"
      >
        <span aria-hidden="true" />
        {{ saveLabel }}
      </div>

      <div v-if="store.syncConfig.connected" class="topbar-actions">
        <button
          type="button"
          class="secondary-button"
          :disabled="store.isLoading"
          title="Resync with Notion"
          @click="resync"
        >
          ↻
        </button>
        <button
          type="button"
          class="secondary-button"
          @click="logout"
        >
          Logout
        </button>
      </div>
    </header>

    <section
      v-if="!store.syncConfig.connected"
      class="auth-gate"
      aria-label="Notion login"
    >
      <h2>Log in with Notion</h2>
      <button
        type="button"
        :disabled="isSigningIn"
        @click="loginWithNotion"
      >
        {{ isSigningIn ? 'Connecting...' : 'Continue with Notion' }}
      </button>
    </section>

    <p v-if="store.errorMessage" class="error">{{ store.errorMessage }}</p>

    <section v-if="canUseEditor" class="editor-shell" aria-label="Project page">
      <header class="editor-header">
        <div class="project-controls">
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
            class="icon-button"
            :disabled="store.isLoading"
            title="New project"
            @click="createProject"
          >
            +
          </button>

          <button
            type="button"
            class="archive-button"
            :disabled="store.isLoading || !store.currentProject"
            title="Archive project"
            @click="archiveProject"
          >
            Archive
          </button>
        </div>

        <div class="project-title">
          <input
            v-model="projectNameDraft"
            aria-label="Project name"
            :disabled="store.isLoading || !store.currentProject"
            @blur="renameProject"
            @keydown.enter="blurTitleInput"
          >
        </div>

        <div class="page-controls">
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
            class="icon-button"
            :disabled="store.isLoading || !store.currentProjectId"
            title="New page"
            @click="createPage"
          >
            +
          </button>

          <button
            type="button"
            class="archive-button"
            :disabled="store.isLoading || !store.currentPage"
            title="Archive page"
            @click="archivePage"
          >
            Archive
          </button>
        </div>

        <div class="page-title">
          <input
            v-model="pageTitleDraft"
            aria-label="Page title"
            :disabled="store.isLoading || !store.currentPage"
            @blur="renamePage"
            @keydown.enter="blurTitleInput"
          >
          <p>{{ saveLabel }}</p>
        </div>

        <div class="toolbar" aria-label="Editor toolbar">
          <div class="toolbar-group block-group" aria-label="Block style">
            <select
              class="toolbar-select block-select"
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

            <select
              class="toolbar-select compact-select"
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
          </div>

          <div class="toolbar-group" aria-label="Inline formatting">
            <button
              type="button"
              :class="{ active: editor?.isActive('bold') }"
              :disabled="!editor"
              title="Bold"
              @click="editor?.chain().focus().toggleBold().run()"
            >
              B
            </button>
            <button
              type="button"
              :class="{ active: editor?.isActive('italic') }"
              :disabled="!editor"
              title="Italic"
              @click="editor?.chain().focus().toggleItalic().run()"
            >
              I
            </button>
            <button
              type="button"
              :class="{ active: editor?.isActive('underline') }"
              :disabled="!editor"
              title="Underline"
              @click="editor?.chain().focus().toggleUnderline().run()"
            >
              U
            </button>
            <button
              type="button"
              :class="{ active: editor?.isActive('strike') }"
              :disabled="!editor"
              title="Strikethrough"
              @click="editor?.chain().focus().toggleStrike().run()"
            >
              S
            </button>
            <button
              type="button"
              :class="{ active: editor?.isActive('code') }"
              :disabled="!editor"
              title="Inline code"
              @click="editor?.chain().focus().toggleCode().run()"
            >
              &lt;/&gt;
            </button>
            <button
              type="button"
              :class="{ active: editor?.isActive('superscript') }"
              :disabled="!editor"
              title="Superscript"
              @click="editor?.chain().focus().toggleSuperscript().run()"
            >
              x2
            </button>
            <button
              type="button"
              :class="{ active: editor?.isActive('subscript') }"
              :disabled="!editor"
              title="Subscript"
              @click="editor?.chain().focus().toggleSubscript().run()"
            >
              x2
            </button>
          </div>

          <div class="toolbar-group color-group" aria-label="Color">
            <select
              class="toolbar-select compact-select"
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

            <select
              class="toolbar-select compact-select"
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
          </div>

          <div class="toolbar-group" aria-label="Lists and inserts">
            <button
              type="button"
              :class="{ active: editor?.isActive('link') }"
              :disabled="!editor"
              title="Link"
              @click="setLink"
            >
              Link
            </button>
            <button
              type="button"
              :class="{ active: editor?.isActive('bulletList') }"
              :disabled="!editor"
              title="Bullet list"
              @click="editor?.chain().focus().toggleBulletList().run()"
            >
              -
            </button>
            <button
              type="button"
              :class="{ active: editor?.isActive('orderedList') }"
              :disabled="!editor"
              title="Ordered list"
              @click="editor?.chain().focus().toggleOrderedList().run()"
            >
              1.
            </button>
            <button
              type="button"
              :class="{ active: editor?.isActive('taskList') }"
              :disabled="!editor"
              title="Task list"
              @click="editor?.chain().focus().toggleTaskList().run()"
            >
              []
            </button>
            <button
              type="button"
              :class="{ active: editor?.isActive('blockquote') }"
              :disabled="!editor"
              title="Quote"
              @click="editor?.chain().focus().toggleBlockquote().run()"
            >
              "
            </button>
            <button
              type="button"
              :class="{ active: editor?.isActive('codeBlock') }"
              :disabled="!editor"
              title="Code block"
              @click="editor?.chain().focus().toggleCodeBlock().run()"
            >
              Code
            </button>
            <button
              type="button"
              :disabled="!editor"
              title="Divider"
              @click="editor?.chain().focus().setHorizontalRule().run()"
            >
              HR
            </button>
          </div>

          <div class="toolbar-group" aria-label="Media inserts">
            <button
              type="button"
              :disabled="!editor"
              title="Image"
              @click="insertImage"
            >
              Img
            </button>
            <button
              type="button"
              :disabled="!editor"
              title="Video / YouTube"
              @click="insertVideo"
            >
              Vid
            </button>
            <button
              type="button"
              :disabled="!editor"
              title="MP3 or audio URL"
              @click="insertAudio"
            >
              Aud
            </button>
            <button
              type="button"
              :class="{ active: isRecordingAudio }"
              :disabled="!editor || isPreparingAudioRecording"
              :title="isRecordingAudio ? 'Stop recording audio' : 'Record audio'"
              @click="toggleAudioRecording"
            >
              {{ isRecordingAudio ? 'Stop' : 'Rec' }}
            </button>
          </div>

          <div class="toolbar-group utility-group" aria-label="History and cleanup">
            <button
              type="button"
              :disabled="!editor"
              title="Clear formatting"
              @click="clearFormatting"
            >
              Tx
            </button>
            <button
              type="button"
              :disabled="!editor"
              title="Undo"
              @click="editor?.chain().focus().undo().run()"
            >
              Undo
            </button>
            <button
              type="button"
              :disabled="!editor"
              title="Redo"
              @click="editor?.chain().focus().redo().run()"
            >
              Redo
            </button>
          </div>
        </div>
      </header>

      <editor-content v-if="editor" class="editor" :editor="editor" />
    </section>
  </main>
</template>

<style scoped>
.shell {
  display: grid;
  grid-template-rows: auto auto 1fr;
  min-height: 100vh;
  padding: 14px;
}

.topbar {
  display: grid;
  grid-template-columns: minmax(0, 1fr) auto;
  gap: 10px;
  align-items: center;
  padding-bottom: 12px;
  border-bottom: 1px solid var(--jot-border);
}

.sync-badge {
  display: inline-flex;
  align-items: center;
  justify-self: start;
  gap: 6px;
  min-height: 28px;
  padding: 0 10px;
  border: 1px solid var(--jot-border);
  border-radius: 999px;
  background: var(--jot-surface-muted);
  color: var(--jot-text);
  font-size: 0.82rem;
  font-weight: 750;
}

.sync-badge span {
  width: 8px;
  height: 8px;
  border-radius: 999px;
  background: var(--jot-muted);
}

.sync-badge.error {
  border-color: #dc2626;
  background: #fef2f2;
  color: #991b1b;
}

.sync-badge.error span {
  background: #dc2626;
}

.sync-badge.stale {
  border-color: #f59e0b;
  background: #fffbeb;
  color: #92400e;
}

.sync-badge.stale span {
  background: #f59e0b;
}

.sync-badge.saving {
  border-color: #2563eb;
  background: #eff6ff;
  color: #1d4ed8;
}

.sync-badge.saving span {
  background: #2563eb;
}

.sync-badge.saved {
  border-color: #16a34a;
  background: #f0fdf4;
  color: #166534;
}

.sync-badge.saved span {
  background: #16a34a;
}

.topbar-actions {
  display: flex;
  gap: 6px;
}

.secondary-button {
  border-color: var(--jot-border);
  background: var(--jot-surface-muted);
  color: var(--jot-text);
}

.page-title input,
.project-title input,
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

.auth-actions {
  display: grid;
  gap: 8px;
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

.editor-header {
  display: grid;
  gap: 10px;
  padding: 10px;
  border-bottom: 1px solid var(--jot-border);
}

.page-controls {
  display: grid;
  grid-template-columns: minmax(0, 1fr) auto auto;
  gap: 6px;
}

.project-controls {
  display: grid;
  grid-template-columns: minmax(0, 1fr) auto auto;
  gap: 6px;
}

.page-title,
.project-title {
  display: grid;
  gap: 3px;
}

.page-title input,
.project-title input {
  width: 100%;
  min-width: 0;
  border: 0;
  background: transparent;
  color: var(--jot-text);
}

.project-title input {
  font-size: 0.9rem;
  font-weight: 750;
}

.page-title input {
  font-size: 1rem;
  font-weight: 700;
}

.page-title input:focus,
.project-title input:focus {
  outline: 2px solid color-mix(in srgb, var(--jot-accent) 34%, transparent);
  outline-offset: 2px;
}

.toolbar {
  display: flex;
  flex-wrap: wrap;
  gap: 6px;
  align-items: stretch;
}

.toolbar-group {
  display: inline-flex;
  flex: 0 1 auto;
  flex-wrap: wrap;
  gap: 3px;
  align-items: center;
  min-width: 0;
  padding-right: 6px;
  border-right: 1px solid var(--jot-border);
}

.toolbar-group:last-child {
  padding-right: 0;
  border-right: 0;
}

.block-group {
  flex: 1 1 214px;
}

.color-group,
.utility-group {
  flex: 0 1 auto;
}

.toolbar button,
.page-controls button,
.project-controls button,
.toolbar-select {
  min-width: 30px;
  min-height: 30px;
  padding: 0 8px;
  border-color: var(--jot-border);
  background: var(--jot-surface-muted);
  color: var(--jot-text);
  font-weight: 700;
}

.toolbar-select {
  width: auto;
  max-width: 100%;
}

.block-select {
  flex: 1 1 126px;
  min-width: 126px;
}

.compact-select {
  flex: 0 1 88px;
  min-width: 78px;
}

.page-controls .archive-button {
  min-width: 72px;
}

.toolbar button.active {
  border-color: var(--jot-accent);
  background: var(--jot-accent);
  color: white;
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
