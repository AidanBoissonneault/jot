/** @file Creates the Tiptap editor with Inkwell extensions and event hooks. */
import { useEditor } from '@tiptap/vue-3';
import StarterKit from '@tiptap/starter-kit';
import { ref } from 'vue';
import type { Ref } from 'vue';
import type { EditorView } from '@tiptap/pm/view';
import { CodeNotebook } from '@/src/extensions/codeNotebook';
import { InkwellBlockIds } from '@/src/extensions/inkwellBlockIds';
import {
  decodeInkwellSource,
  INKWELL_SOURCE_ATTR,
  InkwellLink,
} from '@/src/extensions/inkwellLink';
import { MediaKit } from '@/src/extensions/media';
import { InkwellSyncConflict } from '@/src/extensions/syncConflictBlock';
import { PortableTextEditingKit } from '@/src/extensions/textFormatting';
import type { DocumentContent } from '@/src/types/capture';
import type { OpenSourceRequestMessage } from '@/src/types/messages';
import type { SyncContentConflict } from '@/src/types/sync';

/** Stable callbacks connected after their editor-dependent composables initialize. */
export interface InkwellEditorHandlers {
  handleDrop: (view: EditorView, event: DragEvent) => boolean;
  showContextMenu: (view: EditorView, event: MouseEvent) => void;
}

/** Reactive state required by the editor lifecycle and debounced local saves. */
interface InkwellEditorOptions {
  editorStateVersion: Ref<number>;
  handlers: InkwellEditorHandlers;
  isApplyingStoredContent: Ref<boolean>;
  saveEditorContent: () => Promise<void>;
  saveTimer: Ref<number | undefined>;
  resolveSyncConflict: (conflict: SyncContentConflict, content: DocumentContent) => Promise<void>;
}

/** Builds the primary editor with supported content extensions and interaction hooks. */
export function useInkwellEditor({
  editorStateVersion,
  handlers,
  isApplyingStoredContent,
  saveEditorContent,
  saveTimer,
  resolveSyncConflict,
}: InkwellEditorOptions) {
  const shouldSkipNextUpdateSave = ref(false);
  const editor = useEditor({
    extensions: [
      StarterKit.configure({
        heading: { levels: [1, 2, 3, 4, 5, 6] },
        link: false,
        underline: false,
        codeBlock: false,
      }),
      CodeNotebook,
      InkwellLink,
      InkwellBlockIds,
      PortableTextEditingKit,
      MediaKit,
      InkwellSyncConflict.configure({ onResolve: resolveSyncConflict }),
    ],
    content: {
      type: 'doc',
      content: [{ type: 'paragraph' }],
    },
    editorProps: {
      attributes: { 'aria-label': 'Project page editor' },
      handleDOMEvents: {
        contextmenu: (view, event) => {
          if (!(event instanceof MouseEvent)) {
            return false;
          }

          handlers.showContextMenu(view, event);
          return true;
        },
      },
      handleClick: (_view, _position, event) => {
        const anchor = event.target instanceof Element ? event.target.closest('a') : null;

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
      handleDrop: (view, event) => handlers.handleDrop(view, event),
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

      window.clearTimeout(saveTimer.value);
      saveTimer.value = window.setTimeout(() => {
        void saveEditorContent();
      }, 450);
    },
    onSelectionUpdate: () => {
      editorStateVersion.value += 1;
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

function kebabCase(value: string): string {
  return value.replace(/[A-Z]/g, (letter) => `-${letter.toLowerCase()}`);
}
