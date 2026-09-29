/** @file Owns toolbar mode, selected panel, panel items, and menu transitions. */
import { computed, ref } from 'vue';
import type { Ref } from 'vue';
import type { IconProp } from '@fortawesome/fontawesome-svg-core';
import type { Editor } from '@tiptap/core';

/** Delayed recording callbacks keep toolbar state available before recorder setup. */
export interface EditorToolbarHandlers {
  isRecording: () => boolean;
  stopAudioRecording: () => void;
}

/** Toolbar menu identifiers shared with its panel components. */
export type EditorToolbarMenu =
  'type' | 'marks' | 'color' | 'link' | 'lists' | 'blocks' | 'media' | 'history' | 'record';

/** Owns editor toolbar presentation state and its panel switching rules. */
export function useEditorToolbar(
  editor: Ref<Editor | undefined>,
  linkUrlDraft: Ref<string>,
  handlers: EditorToolbarHandlers,
) {
  const editorToolbarMode = ref<'style' | 'insert' | 'controls'>('style');
  const activeEditorMenu = ref<EditorToolbarMenu | null>(null);
  const editorToolbarModes = [
    { id: 'style', label: 'Style', icon: ['fas', 'wand-magic-sparkles'] },
    { id: 'insert', label: 'Insert', icon: ['fas', 'plus'] },
    { id: 'controls', label: 'Controls', icon: ['fas', 'sliders'] },
  ] as const;

  const activeToolbarItems = computed(() => {
    if (editorToolbarMode.value === 'insert') {
      return [
        { id: 'link', label: 'Link', icon: ['fas', 'link'], title: 'Link' },
        { id: 'lists', label: 'Lists', icon: ['fas', 'list-ul'], title: 'Lists' },
        { id: 'blocks', label: 'Blocks', icon: ['fas', 'quote-left'], title: 'Blocks and divider' },
        { id: 'media', label: 'Media', icon: ['fas', 'photo-film'], title: 'Add media' },
        { id: 'record', label: 'Record', icon: ['fas', 'microphone'], title: 'Record audio note' },
      ] as const;
    }

    if (editorToolbarMode.value === 'controls') {
      return [
        {
          id: 'history',
          label: 'History',
          icon: ['fas', 'rotate-left'],
          title: 'Undo, redo, clear formatting',
        },
      ] as const;
    }

    return [
      { id: 'type', label: 'Type', icon: ['fas', 'heading'], title: 'Block type and size' },
      { id: 'marks', label: 'Marks', icon: ['fas', 'bold'], title: 'Inline formatting' },
      { id: 'color', label: 'Color', icon: ['fas', 'palette'], title: 'Text and highlight color' },
    ] as const;
  });

  const editorToolbarModesForComponent = computed(() =>
    editorToolbarModes.map((mode) => ({
      ...mode,
      icon: [...mode.icon] as IconProp,
    })),
  );
  const activeToolbarItemsForComponent = computed(() =>
    activeToolbarItems.value.map((item) => ({
      ...item,
      icon: [...item.icon] as IconProp,
    })),
  );

  function openLinkTools() {
    linkUrlDraft.value = String(editor.value?.getAttributes('link').href ?? '');
  }

  function setEditorToolbarMode(mode: (typeof editorToolbarModes)[number]['id']) {
    if (mode === 'insert' && editorToolbarMode.value === 'insert') {
      activeEditorMenu.value = activeEditorMenu.value === 'media' ? null : 'media';
      return;
    }

    editorToolbarMode.value = mode;
    activeEditorMenu.value = mode === 'insert' ? 'media' : mode === 'controls' ? 'history' : 'type';
  }

  function toggleEditorMenu(menu: EditorToolbarMenu) {
    const closing = activeEditorMenu.value === menu;
    activeEditorMenu.value = closing ? null : menu;

    if (activeEditorMenu.value === 'link') openLinkTools();
    if (closing && menu === 'record' && handlers.isRecording()) handlers.stopAudioRecording();
  }

  function closeEditorMenu() {
    activeEditorMenu.value = null;
  }

  return {
    activeEditorMenu,
    activeToolbarItemsForComponent,
    closeEditorMenu,
    editorToolbarMode,
    editorToolbarModesForComponent,
    openLinkTools,
    setEditorToolbarMode,
    toggleEditorMenu,
  };
}
