import { mergeAttributes, Node } from '@tiptap/core';
import { VueNodeViewRenderer } from '@tiptap/vue-3';
import type { DocumentContent } from '../types/capture.js';
import type { SyncContentConflict } from '../types/sync.js';
import SyncConflictNodeView from '@/entrypoints/sidepanel/components/editor/SyncConflictNodeView.vue';

export type SyncConflictBlockOptions = {
  onResolve: (
    conflict: SyncContentConflict,
    content: DocumentContent,
  ) => Promise<DocumentContent | null | void>;
};

export const JottathingSyncConflict = Node.create<SyncConflictBlockOptions>({
  name: 'jottathingSyncConflict',
  group: 'block',
  atom: true,
  selectable: false,
  addOptions() {
    return { onResolve: async () => undefined };
  },
  addAttributes() {
    return {
      conflict: { default: null, rendered: false },
      choices: { default: {}, rendered: false },
    };
  },
  parseHTML() {
    return [{ tag: 'div[data-jottathing-sync-conflict]' }];
  },
  renderHTML({ HTMLAttributes }) {
    return ['div', mergeAttributes(HTMLAttributes, { 'data-jottathing-sync-conflict': '' }), 'Merge conflict'];
  },
  addNodeView() {
    return VueNodeViewRenderer(SyncConflictNodeView);
  },
});
