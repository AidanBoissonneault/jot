/** @file Inserts captured text and linked headings into the active editor page. */
import type { ShallowRef } from 'vue';
import type { Editor } from '@tiptap/core';
import { TextSelection } from '@tiptap/pm/state';
import type { EditorView } from '@tiptap/pm/view';
import { capturedBlockId } from '@/src/extensions/sourceRegistry';
import { createCapturedContent, createLinkedHeadingContent } from '@/src/services/notionClient';
import { useInkwellStore } from '@/src/stores/inkwell';
import type { DocumentContent } from '@/src/types/capture';
import type { CaptureSelectionPayload } from '@/src/types/messages';
import { moveEditorSelectionToDrop } from '../components/editor/editorImageMove';

/** Coordinates local capture insertion with page saving and source mappings. */
export function useEditorCaptureInsertion(
  editor: ShallowRef<Editor | undefined>,
  store: ReturnType<typeof useInkwellStore>,
  saveEditorContent: () => Promise<void>,
  skipNextEditorUpdate: () => void,
) {
  /** Registers the source metadata for any captured block that was inserted. */
  async function registerCapturedSource(
    content: DocumentContent[],
    payload: CaptureSelectionPayload,
  ): Promise<void> {
    const blockId = capturedBlockId(content);
    if (blockId) {
      await store.registerCurrentProjectSource(blockId, payload);
    }
  }

  /** Inserts a capture request sent to the open sidepanel. */
  async function insertCaptureAtCursor(payload: CaptureSelectionPayload): Promise<boolean> {
    if (!editor.value || !store.currentPage) {
      return false;
    }

    const capturedContent = createCapturedContent(payload);
    skipNextEditorUpdate();
    editor.value.chain().focus().insertContent(capturedContent).run();
    await Promise.all([saveEditorContent(), registerCapturedSource(capturedContent, payload)]);
    return true;
  }

  /** Places captured selection text at the pointer drop position. */
  function insertCapturedTextAtDrop(
    view: EditorView,
    event: DragEvent,
    payload: CaptureSelectionPayload,
  ): void {
    moveEditorSelectionToDrop(view, event);
    const capturedContent = createCapturedContent(payload);
    skipNextEditorUpdate();
    editor.value?.chain().focus().insertContent(capturedContent).run();

    if (editor.value) {
      void Promise.all([saveEditorContent(), registerCapturedSource(capturedContent, payload)]);
    }
  }

  /** Inserts a linked heading capture at the pointer drop position. */
  function insertLinkedHeadingAtDrop(
    view: EditorView,
    event: DragEvent,
    payload: CaptureSelectionPayload,
    resolvedDropPosition?: number,
  ): void {
    const dropPosition =
      typeof resolvedDropPosition === 'number'
        ? resolvedDropPosition
        : view.posAtCoords({ left: event.clientX, top: event.clientY })?.pos;

    if (typeof dropPosition === 'number') {
      view.dispatch(
        view.state.tr.setSelection(TextSelection.near(view.state.doc.resolve(dropPosition))),
      );
    }

    skipNextEditorUpdate();
    const capturedContent = createLinkedHeadingContent(payload);
    editor.value?.chain().focus().insertContent(capturedContent).run();

    if (editor.value) {
      void Promise.all([saveEditorContent(), registerCapturedSource(capturedContent, payload)]);
    }
  }

  /** Inserts ordinary text when a browser drag has no capture source metadata. */
  function insertPlainTextAtDrop(view: EditorView, event: DragEvent, text: string): void {
    moveEditorSelectionToDrop(view, event);
    skipNextEditorUpdate();
    editor.value?.chain().focus().insertContent(text).run();
    if (editor.value) {
      void saveEditorContent();
    }
  }

  return {
    insertCaptureAtCursor,
    insertCapturedTextAtDrop,
    insertLinkedHeadingAtDrop,
    insertPlainTextAtDrop,
  };
}
