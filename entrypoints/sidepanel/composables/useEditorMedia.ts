/** @file URL media insertion and upload-state handling for the editor. */
import { ref, type Ref, type ShallowRef } from 'vue';
import type { Editor } from '@tiptap/core';
import { notionClient } from '@/src/services/notionClient';
import type { useJottathingStore } from '@/src/stores/jottathing';
import { createJottathingBlockId } from '@/src/extensions/jottathingBlockIds';
import {
  AUDIO_UPLOAD_MAX_BYTES,
  IMAGE_FILE_ACCEPT,
  IMAGE_UPLOAD_MAX_BYTES,
  isUploadableAudioFile,
  isUploadableImageFile,
} from '@/src/extensions/mediaDrop';
import type { EditorMenu } from '../components/editor/editorToolbarContext';

/** Owns editor media URLs, local file insertion, uploads, and node status updates. */
export function useEditorMedia(
  editor: ShallowRef<Editor | undefined>,
  store: ReturnType<typeof useJottathingStore>,
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
    blockId: string,
    fileUploadId: string,
  ) {
    skipNextEditorUpdate();
    editorInstance?.state.doc.descendants((node, pos) => {
      if (node.type.name === nodeTypeName && node.attrs.jottathingBlockId === blockId) {
        const { uploadStartedAt: _uploadStartedAt, ...attrs } = node.attrs;
        editorInstance
          .chain()
          .command(({ tr }) => {
            tr.setNodeMarkup(pos, undefined, {
              ...attrs,
              ...(fileUploadId ? { notionFileUploadId: fileUploadId } : {}),
              uploadState: fileUploadId ? 'done' : 'local',
            });
            return true;
          })
          .run();
      }
    });
  }

  async function handleUploadableImageFile(file: File): Promise<void> {
    if (!isUploadableImageFile(file)) {
      uiMessage.value = imageValidationMessage(file);
      return;
    }
    if (!editor.value) return;

    let localSrc: string;
    try {
      localSrc = await fileToDataUrl(file);
    } catch {
      uiMessage.value = 'Unable to read this image file.';
      return;
    }
    const blockId = createJottathingBlockId();
    const shouldUploadNow = store.syncConfig.connected && store.isOnline;
    skipNextEditorUpdate();
    uiMessage.value = '';
    // The upload-state attributes are defined by the Jottathing image extension.
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    editor.value
      ?.chain()
      .focus()
      .setImage({
        src: localSrc,
        uploadState: shouldUploadNow ? 'uploading' : 'local',
        ...(shouldUploadNow ? { uploadStartedAt: Date.now() } : {}),
        mimeType: file.type,
        filename: file.name || filenameForImageType(file.type),
        jottathingBlockId: blockId,
      } as any)
      .run();
    await saveEditorContent();
    const fileUploadId = await uploadMediaFile(file, 'image');
    updateMediaNodeUploadState(editor.value, 'image', blockId, fileUploadId);
    await saveEditorContent();
  }

  async function handleUploadableImageDrop(info: { kind: 'file'; file: File }): Promise<void> {
    await handleUploadableImageFile(info.file);
  }

  async function handleImageFileInput(event: Event): Promise<void> {
    const input = event.currentTarget as HTMLInputElement | null;
    if (!input || typeof input !== 'object' || !('files' in input) || !('value' in input)) return;
    const file = input.files?.[0];
    // Let the same image be selected again after an upload or validation failure.
    input.value = '';
    if (file) await handleUploadableImageFile(file);
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
      const blockId = createJottathingBlockId();
      const shouldUploadNow = store.syncConfig.connected && store.isOnline;
      // The upload-state attributes are defined by the Jottathing audio extension.
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      editorInstance
        .chain()
        .focus(insertPos || 'end')
        .setAudio({
          src: localSrc,
          uploadState: shouldUploadNow ? 'uploading' : 'local',
          ...(shouldUploadNow ? { uploadStartedAt: Date.now() } : {}),
          mimeType: file.type,
          filename: file.name || 'audio-upload',
          jottathingBlockId: blockId,
        } as any)
        .run();
      await saveEditorContent();
      const fileUploadId = await uploadMediaFile(file, 'audio');
      updateMediaNodeUploadState(editorInstance, 'audio', blockId, fileUploadId);
      await saveEditorContent();
      return;
    }
  }

  return {
    imageUrlDraft,
    videoUrlDraft,
    audioUrlDraft,
    insertImage,
    insertVideo,
    insertAudio,
    handleUploadableImageFile,
    handleUploadableImageDrop,
    handleImageFileInput,
    handleUploadableAudioDrop,
    handleUploadableAudioFile,
    imageFileAccept: IMAGE_FILE_ACCEPT,
  };
}

function imageValidationMessage(file: File): string {
  if (file.size > IMAGE_UPLOAD_MAX_BYTES) {
    return `Images must be 20 MB or smaller.`;
  }
  if (file.size === 0) return 'The selected image file is empty.';
  return 'Use a JPEG, PNG, GIF, WebP, or AVIF image.';
}

function filenameForImageType(mimeType: string): string {
  const extensions: Record<string, string> = {
    'image/jpeg': 'jpg',
    'image/png': 'png',
    'image/gif': 'gif',
    'image/webp': 'webp',
    'image/avif': 'avif',
  };
  return `pasted-image.${extensions[mimeType.toLowerCase()] ?? 'img'}`;
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
