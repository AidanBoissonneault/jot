/** @file Typed contract for editor context-menu state and operations. */
import type { Editor } from '@tiptap/core';
import type { ShallowRef, ComputedRef, Ref } from 'vue';
import type { SourceOpenPayload } from '@/src/types/messages';

export interface EditorContextMenuContext {
  editor: ShallowRef<Editor | undefined>;
  editorContextMenu: Ref<{ visible: boolean; left: number; top: number }>;
  editorContextMenuRef: Ref<HTMLElement | null>;
  editorContextMenuHasSelection: Ref<boolean>;
  editorContextMenuSource: Ref<SourceOpenPayload | null>;
  editorContextMenuSourceHost: ComputedRef<string>;
  editorContextMenuPanel: Ref<'main' | 'link' | 'color'>;
  contextMenuLinkDraft: Ref<string>;
  activeBlockType: ComputedRef<string>;
  activeFontSize: ComputedRef<string>;
  activeTextColor: ComputedRef<string>;
  activeHighlightColor: ComputedRef<string>;
  blockTypes: ReadonlyArray<{ label: string; value: string }>;
  fontSizes: ReadonlyArray<{ label: string; value: string }>;
  textColors: ReadonlyArray<{ label: string; value: string }>;
  highlightColors: ReadonlyArray<{ label: string; value: string }>;
  cutEditorSelectionToClipboard: () => Promise<void>;
  copyEditorSelectionFromContextMenu: () => Promise<void>;
  pasteClipboardTextIntoEditor: () => Promise<void>;
  setContextBlockType: (event: Event) => void;
  setContextFontSize: (event: Event) => void;
  runContextMarkCommand: (command: 'bold' | 'italic' | 'underline' | 'strike' | 'code') => void;
  openContextLinkPanel: () => void;
  openEditorContextSource: () => Promise<void>;
  applyContextLink: () => void;
  removeContextLink: () => void;
  applyContextTextColor: (value: string) => void;
  applyContextHighlightColor: (value: string) => void;
}
