import { mergeAttributes, Node } from '@tiptap/core';
import { VueNodeViewRenderer } from '@tiptap/vue-3';
import type { DocumentContent } from '../types/capture.js';
import type { SyncContentConflict } from '../types/sync.js';
import SyncConflictNodeView from '@/entrypoints/sidepanel/components/editor/SyncConflictNodeView.vue';

export type SyncConflictBlockOptions = {
  onResolve: (
    conflict: SyncContentConflict,
    content: DocumentContent,
  ) => Promise<DocumentContent | void>;
};

export const InkwellSyncConflict = Node.create<SyncConflictBlockOptions>({
  name: 'inkwellSyncConflict',
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
    return [{ tag: 'div[data-inkwell-sync-conflict]' }];
  },
  renderHTML({ HTMLAttributes }) {
    return ['div', mergeAttributes(HTMLAttributes, { 'data-inkwell-sync-conflict': '' }), 'Merge conflict'];
  },
  addNodeView() {
    return VueNodeViewRenderer(SyncConflictNodeView);
  },
});
