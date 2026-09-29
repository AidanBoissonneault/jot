/** @file URL media insertion and upload-state handling for the editor. */
import { ref, type Ref, type ShallowRef } from 'vue';
import type { Editor } from '@tiptap/core';
import { notionClient } from '@/src/services/notionClient';
import type { useInkwellStore } from '@/src/stores/inkwell';
import {
  AUDIO_UPLOAD_MAX_BYTES,
  IMAGE_UPLOAD_MAX_BYTES,
  isUploadableAudioFile,
  isUploadableImageFile,
} from '@/src/extensions/mediaDrop';
import type { EditorMenu } from '../components/editor/editorToolbarContext';

/** Owns editor media URLs, local file insertion, uploads, and node status updates. */
export function useEditorMedia(
  editor: ShallowRef<Editor | undefined>,
  store: ReturnType<typeof useInkwellStore>,
  activeEditorMenu: Ref<EditorMenu>,
  uiMessage: Ref<string>,
  skipNextEditorUpdate: () => void,
  clearEditorUpdateSkip: () => void,
  saveEditorContent: () => Promise<void>,
) {
  const imageUrlDraft = ref('');
  const videoUrlDraft = ref('');
  const audioUrlDraft = ref('');

  function insertImage() {
    const src = imageUrlDraft.value.trim();
    if (!src) return;
    editor.value?.chain().focus().setImage({ src }).run();
    imageUrlDraft.value = '';
    activeEditorMenu.value = null;
    void saveEditorContent();
  }

  function insertVideo() {
    const src = videoUrlDraft.value.trim();
    if (!src) return;
    const inserted = editor.value?.chain().focus().setYoutubeVideo({ src }).run();
    if (!inserted) {
      uiMessage.value = 'Paste a YouTube video URL.';
      return;
    }
    uiMessage.value = '';
    videoUrlDraft.value = '';
    activeEditorMenu.value = null;
    void saveEditorContent();
  }

  function insertAudio() {
    const src = audioUrlDraft.value.trim();
    if (!src) return;
    if (!isHttpAudioUrl(src)) {
      uiMessage.value = 'Paste a public http(s) URL to an MP3 or audio file.';
      return;
    }
    editor.value?.chain().focus().setAudio({ src }).run();
    audioUrlDraft.value = '';
    uiMessage.value = '';
    activeEditorMenu.value = null;
    void saveEditorContent();
  }

  async function uploadMediaFile(file: File, label: string): Promise<string> {
    queueMicrotask(clearEditorUpdateSkip);
    if (!store.syncConfig.connected || !store.isOnline) return '';
    try {
      return await notionClient.uploadMedia(file, file.type, file.name);
    } catch (error) {
      uiMessage.value =
        error instanceof Error ? error.message : `Unable to upload this ${label} to Notion.`;
      return '';
    }
  }

  function updateMediaNodeUploadState(
    editorInstance: Editor | undefined,
    nodeTypeName: string,
    localSrc: string,
    fileUploadId: string,
  ) {
    skipNextEditorUpdate();
    editorInstance?.state.doc.descendants((node, pos) => {
      if (node.type.name === nodeTypeName && node.attrs.src === localSrc) {
        editorInstance
          .chain()
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
  }

  async function handleUploadableImageDrop(info: { kind: 'file'; file: File }): Promise<void> {
    const { file } = info;
    if (!isUploadableImageFile(file)) {
      uiMessage.value = `Images must be ${Math.floor(IMAGE_UPLOAD_MAX_BYTES / 1024 / 1024)} MB or smaller.`;
      return;
    }
    const localSrc = await fileToDataUrl(file);
    skipNextEditorUpdate();
    // The upload-state attributes are defined by the Inkwell image extension.
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    editor.value
      ?.chain()
      .focus()
      .setImage({
        src: localSrc,
        uploadState: store.syncConfig.connected && store.isOnline ? 'uploading' : 'local',
        filename: file.name,
      } as any)
      .run();
    await saveEditorContent();
    const fileUploadId = await uploadMediaFile(file, 'image');
    updateMediaNodeUploadState(editor.value, 'image', localSrc, fileUploadId);
    if (fileUploadId) void saveEditorContent();
  }

  async function handleUploadableAudioDrop(info: { kind: 'file'; file: File }): Promise<void> {
    await handleUploadableAudioFile(info.file);
  }

  async function handleUploadableAudioFile(file: File): Promise<void> {
    if (!isUploadableAudioFile(file)) {
      uiMessage.value = `Audio files must be ${Math.floor(AUDIO_UPLOAD_MAX_BYTES / 1024 / 1024)} MB or smaller.`;
      return;
    }
    const localSrc = await fileToDataUrl(file);
    skipNextEditorUpdate();
    const editorInstance = editor.value;
    if (editorInstance) {
      const insertPos = editorInstance.state.selection.from;
      // The upload-state attributes are defined by the Inkwell audio extension.
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      editorInstance
        .chain()
        .focus(insertPos || 'end')
        .setAudio({
          src: localSrc,
          uploadState: store.syncConfig.connected && store.isOnline ? 'uploading' : 'local',
          mimeType: file.type,
          filename: file.name,
        } as any)
        .run();
    }
    await saveEditorContent();
    const fileUploadId = await uploadMediaFile(file, 'audio');
    updateMediaNodeUploadState(editor.value, 'audio', localSrc, fileUploadId);
    if (fileUploadId) void saveEditorContent();
  }

  return {
    imageUrlDraft,
    videoUrlDraft,
    audioUrlDraft,
    insertImage,
    insertVideo,
    insertAudio,
    handleUploadableImageDrop,
    handleUploadableAudioDrop,
    handleUploadableAudioFile,
  };
}

function isHttpAudioUrl(value: string) {
  return /^https?:\/\/.+\.(mp3|mpeg|m4a|aac|wav|ogg|oga|opus|webm)(\?[^#]*)?(#.*)?$/i.test(value);
}

async function fileToDataUrl(file: File): Promise<string> {
  const bytes = new Uint8Array(await file.arrayBuffer());
  let binary = '';
  const chunkSize = 8192;
  for (let index = 0; index < bytes.length; index += chunkSize) {
    binary += String.fromCharCode(...bytes.subarray(index, index + chunkSize));
  }
  return `data:${file.type || 'application/octet-stream'};base64,${btoa(binary)}`;
}
