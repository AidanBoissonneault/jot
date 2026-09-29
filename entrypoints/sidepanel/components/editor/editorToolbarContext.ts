/** @file Shared editor toolbar modes, menu names, and coordinator bindings. */
import type { IconProp } from '@fortawesome/fontawesome-svg-core';
import type { Editor } from '@tiptap/core';
import type { ComputedRef, Ref, ShallowRef } from 'vue';
import type { useInkwellStore } from '@/src/stores/inkwell';

export type EditorToolbarMode = 'style' | 'insert' | 'controls';
export type EditorMenu =
  'type' | 'marks' | 'color' | 'link' | 'lists' | 'blocks' | 'media' | 'history' | 'record' | null;
export type RecordingPhase = 'idle' | 'requesting_permission' | 'recording' | 'processing';
type InkwellStore = ReturnType<typeof useInkwellStore>;

export interface EditorToolbarContext {
  editor: ShallowRef<Editor | undefined>;
  store: InkwellStore;
  audioStream: Ref<MediaStream | null>;
  editorToolbarModes: ComputedRef<
    ReadonlyArray<{ id: EditorToolbarMode; label: string; icon: IconProp }>
  >;
  editorToolbarMode: Ref<EditorToolbarMode>;
  setEditorToolbarMode: (mode: EditorToolbarMode) => void;
  activeToolbarItems: ComputedRef<
    ReadonlyArray<{ id: NonNullable<EditorMenu>; label: string; icon: IconProp; title: string }>
  >;
  activeEditorMenu: Ref<EditorMenu>;
  toggleEditorMenu: (menu: NonNullable<EditorMenu>) => void;
  closeEditorMenu: () => void;
  activeBlockType: ComputedRef<string>;
  blockTypes: ReadonlyArray<{ label: string; value: string }>;
  setBlockType: (event: Event) => void;
  activeFontSize: ComputedRef<string>;
  fontSizes: ReadonlyArray<{ label: string; value: string }>;
  setFontSize: (event: Event) => void;
  runEditorMarkCommand: (
    command: 'bold' | 'italic' | 'underline' | 'strike' | 'code' | 'superscript' | 'subscript',
  ) => void;
  activeTextColor: ComputedRef<string>;
  textColors: ReadonlyArray<{ label: string; value: string }>;
  setTextColor: (event: Event) => void;
  activeHighlightColor: ComputedRef<string>;
  highlightColors: ReadonlyArray<{ label: string; value: string }>;
  setHighlightColor: (event: Event) => void;
  linkUrlDraft: Ref<string>;
  setLink: () => void;
  openLinkTools: () => void;
  runEditorListCommand: (command: 'bullet' | 'ordered' | 'task') => void;
  runEditorBlockCommand: (command: 'blockquote' | 'codeBlock') => void;
  imageUrlDraft: Ref<string>;
  insertImage: () => void;
  videoUrlDraft: Ref<string>;
  insertVideo: () => void;
  audioUrlDraft: Ref<string>;
  insertAudio: () => void;
  recordingPhase: Ref<RecordingPhase>;
  toggleAudioRecording: () => void;
  clearFormatting: () => void;
}
