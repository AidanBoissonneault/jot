/** @file Routes editor drops to capture, image move, media, video, and audio handlers. */
import type { ShallowRef } from 'vue';
import type { Editor } from '@tiptap/core';
import type { EditorView } from '@tiptap/pm/view';
import {
  peekUploadableAudioDrop,
  peekUploadableImageDrop,
  readAudioDropSrc,
  readImageDropSrc,
  readYoutubeDropSrc,
} from '@/src/extensions/mediaDrop';
import {
  isEditorInternalDrop,
  readInkwellImageMovePayload,
} from '@/src/extensions/inkwellImageMove';
import type { CaptureSelectionPayload } from '@/src/types/messages';
import {
  capturePayloadFromActiveTab,
  consumeHeadingDropPayload,
  consumeTextDragPayload,
  isLikelyHeadingDrop,
  isLikelyTextCaptureDrop,
  readInkwellDropPayload,
} from '../components/editor/captureDropPayload';
import {
  moveEditorSelectionToDrop,
  moveImageNodeAtDrop,
  readSelectedImageMovePayload,
} from '../components/editor/editorImageMove';
import type { useEditorCaptureInsertion } from './useEditorCaptureInsertion';

/** Media upload actions required to accept dropped files. */
interface EditorDropHandlingDependencies {
  captureInsertion: ReturnType<typeof useEditorCaptureInsertion>;
  editor: ShallowRef<Editor | undefined>;
  handleUploadableAudioDrop: (info: { kind: 'file'; file: File }) => Promise<void>;
  handleUploadableImageDrop: (info: { kind: 'file'; file: File }) => Promise<void>;
  saveEditorContent: () => Promise<void>;
}

/** Owns the event dispatch for everything dropped onto the Tiptap canvas. */
export function useEditorDropHandling({
  captureInsertion,
  editor,
  handleUploadableAudioDrop,
  handleUploadableImageDrop,
  saveEditorContent,
}: EditorDropHandlingDependencies) {
  /** Handles one drop event, returning whether Tiptap should handle it further. */
  function handleDrop(view: EditorView, event: DragEvent): boolean {
    const inkwellPayload = readInkwellDropPayload(event);

    if (inkwellPayload?.highlightMeta.isHeading) {
      event.preventDefault();
      captureInsertion.insertLinkedHeadingAtDrop(view, event, inkwellPayload);
      return true;
    }

    if (inkwellPayload) {
      event.preventDefault();
      captureInsertion.insertCapturedTextAtDrop(view, event, inkwellPayload);
      return true;
    }

    const imageMovePayload = readInkwellImageMovePayload(event.dataTransfer);
    if (imageMovePayload) {
      event.preventDefault();
      if (moveImageNodeAtDrop(view, event, imageMovePayload)) {
        void saveEditorContent();
      }
      return true;
    }

    const selectedImageMovePayload = readSelectedImageMovePayload(view, event);
    if (selectedImageMovePayload) {
      event.preventDefault();
      if (moveImageNodeAtDrop(view, event, selectedImageMovePayload)) {
        void saveEditorContent();
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
      void saveEditorContent();
      return true;
    }

    const audioSrc = readAudioDropSrc(event.dataTransfer);
    if (audioSrc) {
      event.preventDefault();
      moveEditorSelectionToDrop(view, event);
      editor.value?.chain().focus().setAudio({ src: audioSrc }).run();
      void saveEditorContent();
      return true;
    }

    const imageSrc = readImageDropSrc(event.dataTransfer);
    if (imageSrc) {
      event.preventDefault();
      moveEditorSelectionToDrop(view, event);
      editor.value?.chain().focus().setImage({ src: imageSrc }).run();
      void saveEditorContent();
      return true;
    }

    if (isLikelyTextCaptureDrop(event)) {
      // Capture synchronously because the browser clears dataTransfer after this handler returns.
      const fallbackText = event.dataTransfer?.getData('text/plain') ?? '';
      event.preventDefault();

      void consumeTextDragPayload(fallbackText).then((dragPayload) => {
        if (dragPayload) {
          captureInsertion.insertCapturedTextAtDrop(view, event, dragPayload);
          return;
        }

        if (fallbackText) {
          void capturePayloadFromActiveTab(fallbackText).then((fallbackPayload) => {
            if (fallbackPayload) {
              captureInsertion.insertCapturedTextAtDrop(view, event, fallbackPayload);
              return;
            }

            captureInsertion.insertPlainTextAtDrop(view, event, fallbackText);
          });
        }
      });

      return true;
    }

    if (!isLikelyHeadingDrop(event)) {
      return false;
    }

    const dropPosition = view.posAtCoords({ left: event.clientX, top: event.clientY });
    event.preventDefault();

    void consumeHeadingDropPayload(event).then((dragPayload: CaptureSelectionPayload | null) => {
      if (!dragPayload) {
        return;
      }

      captureInsertion.insertLinkedHeadingAtDrop(view, event, dragPayload, dropPosition?.pos);
    });

    return true;
  }

  return { handleDrop };
}
