/** @file Owns the editor's small set of anchored toolbar popovers. */
import { ref } from 'vue';
import type { Ref } from 'vue';
import type { Editor } from '@tiptap/core';

export type EditorToolbarMenu = 'link' | 'media' | null;

/** Owns toolbar popover state. Formatting actions are direct controls in the toolbar. */
export function useEditorToolbar(
  editor: Ref<Editor | undefined>,
  linkUrlDraft: Ref<string>,
) {
  const activeEditorMenu = ref<EditorToolbarMenu>(null);

  function openLinkTools() {
    linkUrlDraft.value = String(editor.value?.getAttributes('link').href ?? '');
  }

  function toggleEditorMenu(menu: Exclude<EditorToolbarMenu, null>) {
    const closing = activeEditorMenu.value === menu;
    activeEditorMenu.value = closing ? null : menu;
    if (menu === 'link' && !closing) openLinkTools();
  }

  function closeEditorMenu() {
    activeEditorMenu.value = null;
  }

  return { activeEditorMenu, closeEditorMenu, openLinkTools, toggleEditorMenu };
}
