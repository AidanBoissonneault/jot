/** @file Shared direct formatting controls and toolbar popover bindings. */
import type { Editor } from '@tiptap/core';
import type { ComputedRef, Ref, ShallowRef } from 'vue';
import type { useJottathingStore } from '@/src/stores/jottathing';
import type { EditorToolbarMenu } from '../../composables/useEditorToolbar';

export type EditorMenu = EditorToolbarMenu;
export type RecordingPhase = 'idle' | 'requesting_permission' | 'recording' | 'processing';
type JottathingStore = ReturnType<typeof useJottathingStore>;

export interface EditorToolbarContext {
  editor: ShallowRef<Editor | undefined>;
  store: JottathingStore;
  audioStream: Ref<MediaStream | null>;
  activeEditorMenu: Ref<EditorMenu>;
  toggleEditorMenu: (menu: Exclude<EditorMenu, null>) => void;
  closeEditorMenu: () => void;
  activeEditorMarks: ComputedRef<
    Readonly<Record<'bold' | 'italic' | 'underline' | 'strike' | 'code', boolean>>
  >;
  activeBlockType: ComputedRef<string>;
  blockTypes: ReadonlyArray<{ label: string; value: string }>;
  setBlockType: (event: Event) => void;
  activeFontSize: ComputedRef<string>;
  fontSizes: ReadonlyArray<{ label: string; value: string }>;
  setFontSize: (event: Event) => void;
  setFontSizeValue: (value: string) => void;
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
  imageFileAccept: string;
  handleImageFileInput: (event: Event) => void;
  videoUrlDraft: Ref<string>;
  insertVideo: () => void;
  audioUrlDraft: Ref<string>;
  insertAudio: () => void;
  recordingPhase: Ref<RecordingPhase>;
  toggleAudioRecording: () => void;
  clearFormatting: () => void;
}
