/** @file Creates the Tiptap editor with Jottathing extensions and event hooks. */
import { useEditor } from '@tiptap/vue-3';
import StarterKit from '@tiptap/starter-kit';
import { getCurrentInstance, onBeforeUnmount, ref } from 'vue';
import type { Editor } from '@tiptap/core';
import type { Ref } from 'vue';
import type { EditorView } from '@tiptap/pm/view';
import { NodeSelection } from '@tiptap/pm/state';
import { CodeNotebook } from '@/src/extensions/codeNotebook';
import { JottathingBlockIds } from '@/src/extensions/jottathingBlockIds';
import { JottathingBlockDragHandle } from '@/src/extensions/jottathingBlockDragHandle';
import { notionClient } from '@/src/services/notionClient';
import {
  decodeJottathingSource,
  JOTTATHING_SOURCE_ATTR,
  JottathingLink,
  safeExternalUrl,
} from '@/src/extensions/jottathingLink';
import { MediaKit } from '@/src/extensions/media';
import { JottathingSyncConflict } from '@/src/extensions/syncConflictBlock';
import { PortableTextEditingKit } from '@/src/extensions/textFormatting';
import type { DocumentContent } from '@/src/types/capture';
import type { OpenSourceRequestMessage } from '@/src/types/messages';
import type { SyncContentConflict } from '@/src/types/sync';

/** Stable callbacks connected after their editor-dependent composables initialize. */
export interface JottathingEditorHandlers {
  handleDrop: (view: EditorView, event: DragEvent) => boolean;
  handlePaste: (view: EditorView, event: ClipboardEvent) => boolean;
  showContextMenu: (view: EditorView, event: MouseEvent) => void;
}

/** Reactive state required by the editor lifecycle and block-boundary saves. */
interface JottathingEditorOptions {
  editorStateVersion: Ref<number>;
  handlers: JottathingEditorHandlers;
  isApplyingStoredContent: Ref<boolean>;
  saveEditorContent: () => Promise<void>;
  resolveSyncConflict: (
    conflict: SyncContentConflict,
    content: DocumentContent,
  ) => Promise<DocumentContent | null | void>;
}

const EDITOR_AUTOSAVE_DELAY_MS = 500;

/** Builds the primary editor with supported content extensions and interaction hooks. */
export function useJottathingEditor({
  editorStateVersion,
  handlers,
  isApplyingStoredContent,
  saveEditorContent,
  resolveSyncConflict,
}: JottathingEditorOptions) {
  const shouldSkipNextUpdateSave = ref(false);
  let focusedBlockKey: string | undefined;
  let editorSaveTimer: ReturnType<typeof setTimeout> | undefined;

  function flushEditorSave() {
    clearTimeout(editorSaveTimer);
    editorSaveTimer = undefined;
    void saveEditorContent()
      .then(() => notionClient.flushPendingSyncOps({ force: true }))
      .catch(() => undefined);
  }

  function scheduleEditorSave() {
    clearTimeout(editorSaveTimer);
    editorSaveTimer = setTimeout(flushEditorSave, EDITOR_AUTOSAVE_DELAY_MS);
  }

  if (getCurrentInstance()) {
    onBeforeUnmount(() => {
      if (editorSaveTimer === undefined) return;
      flushEditorSave();
    });
  }

  const editor = useEditor({
    extensions: [
      StarterKit.configure({
        heading: { levels: [1, 2, 3, 4, 5, 6] },
        code: { HTMLAttributes: { spellcheck: 'false' } },
        link: false,
        underline: false,
        codeBlock: false,
      }),
      CodeNotebook,
      JottathingLink,
      JottathingBlockIds,
      JottathingBlockDragHandle,
      PortableTextEditingKit,
      MediaKit,
      JottathingSyncConflict.configure({ onResolve: resolveSyncConflict }),
    ],
    content: {
      type: 'doc',
      content: [{ type: 'paragraph' }],
    },
    onCreate: ({ editor: createdEditor }) => {
      focusedBlockKey = focusedBlockKeyForSelection(createdEditor.state.selection);
    },
    editorProps: {
      attributes: { 'aria-label': 'Project page editor', spellcheck: 'true' },
      handleDOMEvents: {
        contextmenu: (view, event) => {
          if (!(event instanceof MouseEvent)) {
            return false;
          }

          handlers.showContextMenu(view, event);
          return true;
        },
      },
      handleKeyDown: (view, event) => {
        if (
          event.key !== 'Enter' ||
          event.isComposing ||
          event.ctrlKey ||
          event.metaKey ||
          event.altKey ||
          !isCursorAtDocumentEnd(view.state.selection)
        ) {
          return false;
        }

        requestAnimationFrame(() => {
          if (!view.dom.isConnected) return;
          const scrollContainer = view.dom.closest('.editor');
          if (!(scrollContainer instanceof HTMLElement)) return;
          scrollContainer.scrollTop = scrollContainer.scrollHeight;
        });

        return false;
      },
      handleClick: (_view, _position, event) => {
        const anchor = event.target instanceof Element ? event.target.closest('a') : null;

        if (!anchor?.href) {
          return false;
        }

        event.preventDefault();
        const sourcePayload = decodeJottathingSource(
          anchor.getAttribute(`data-${kebabCase(JOTTATHING_SOURCE_ATTR)}`),
        );

        if (sourcePayload) {
          void browser.runtime.sendMessage({
            type: 'jottathing.openSourceRequest',
            payload: sourcePayload,
          } satisfies OpenSourceRequestMessage);
          return true;
        }

        const safeUrl = safeExternalUrl(anchor.href);
        if (!safeUrl) return true;
        void browser.tabs.create({ active: true, url: safeUrl });
        return true;
      },
      handleDrop: (view, event) => handlers.handleDrop(view, event),
      handlePaste: (view, event) => handlers.handlePaste(view, event),
    },
    onUpdate: () => {
      editorStateVersion.value += 1;

      if (isApplyingStoredContent.value) {
        return;
      }

      if (shouldSkipNextUpdateSave.value) {
        shouldSkipNextUpdateSave.value = false;
        return;
      }

      scheduleEditorSave();
    },
    onSelectionUpdate: ({ editor: activeEditor }) => {
      editorStateVersion.value += 1;
      const nextBlockKey = focusedBlockKeyForSelection(activeEditor.state.selection);
      const leftFocusedBlock =
        focusedBlockKey !== undefined && nextBlockKey !== focusedBlockKey;
      focusedBlockKey = nextBlockKey;

      if (leftFocusedBlock && !isApplyingStoredContent.value) {
        flushEditorSave();
      }
    },
    onFocus: ({ editor: activeEditor }) => {
      focusedBlockKey = focusedBlockKeyForSelection(activeEditor.state.selection);
    },
    onBlur: () => {
      const hadFocusedBlock = focusedBlockKey !== undefined;
      focusedBlockKey = undefined;
      if (hadFocusedBlock && !isApplyingStoredContent.value) {
        flushEditorSave();
      }
    },
  });

  function skipNextEditorUpdate() {
    shouldSkipNextUpdateSave.value = true;
    queueMicrotask(() => {
      shouldSkipNextUpdateSave.value = false;
    });
  }

  function clearEditorUpdateSkip() {
    shouldSkipNextUpdateSave.value = false;
  }

  return { editor, skipNextEditorUpdate, clearEditorUpdateSkip };
}

/** Identifies the block containing the selection head, including node selections. */
function focusedBlockKeyForSelection(selection: Editor['state']['selection']): string {
  if (selection instanceof NodeSelection) {
    return `${selection.node.type.name}:${selection.from}`;
  }

  const head = selection.$head;
  if (head.depth === 0) return `${head.node().type.name}:0`;
  const block = head.node(head.depth);
  return `${block.type.name}:${head.before(head.depth)}`;
}

/** Checks the end of the active textblock and every containing block. */
function isCursorAtDocumentEnd(
  selection: Editor['state']['selection'],
): boolean {
  if (!selection.empty) return false;

  const $from = selection.$from;
  if (
    !$from.parent.isTextblock ||
    $from.parentOffset !== $from.parent.content.size ||
    $from.depth === 0
  ) {
    return false;
  }

  for (let depth = $from.depth; depth > 0; depth -= 1) {
    if ($from.after(depth) !== $from.end(depth - 1)) return false;
  }

  return true;
}

function kebabCase(value: string): string {
  return value.replace(/[A-Z]/g, (letter) => `-${letter.toLowerCase()}`);
}
