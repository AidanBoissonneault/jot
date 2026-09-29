/** @file Tiptap formatting state and editor commands shared by toolbars. */
import { computed, type Ref, type ShallowRef } from 'vue';
import type { Editor } from '@tiptap/core';

type FormatCommand = () => boolean | undefined;
type MarkCommand =
  | 'bold'
  | 'italic'
  | 'underline'
  | 'strike'
  | 'code'
  | 'superscript'
  | 'subscript';

/**
 * Keeps editor formatting state and Tiptap commands together. Persistence and
 * right-click selection restoration are injected by the editor coordinator.
 */
export function useEditorFormatting(
  editor: ShallowRef<Editor | undefined>,
  editorStateVersion: Ref<number>,
  runFormattingCommand: (command: FormatCommand) => void,
  restoreContextSelection: () => void,
) {
  const activeBlockType = computed(() => {
    editorStateVersion.value;
    if (!editor.value) return 'paragraph';

    for (const level of [1, 2, 3, 4, 5, 6]) {
      if (editor.value.isActive('heading', { level })) return `heading-${level}`;
    }
    if (editor.value.isActive('blockquote')) return 'blockquote';
    if (editor.value.isActive('codeBlock')) return 'codeBlock';
    return 'paragraph';
  });

  const activeFontSize = computed(() => {
    editorStateVersion.value;
    return String(editor.value?.getAttributes('textStyle').fontSize ?? '');
  });
  const activeTextColor = computed(() => {
    editorStateVersion.value;
    return String(editor.value?.getAttributes('textStyle').color ?? '');
  });
  const activeHighlightColor = computed(() => {
    editorStateVersion.value;
    return String(editor.value?.getAttributes('textStyle').backgroundColor ?? '');
  });

  function applyBlockType(value: string) {
    if (value === 'paragraph') {
      runFormattingCommand(() => editor.value?.chain().focus().setParagraph().run());
      return;
    }
    if (value.startsWith('heading-')) {
      runFormattingCommand(() =>
        editor.value
          ?.chain()
          .focus()
          .toggleHeading({ level: Number(value.replace('heading-', '')) as 1 | 2 | 3 | 4 | 5 | 6 })
          .run(),
      );
      return;
    }
    if (value === 'blockquote') {
      runFormattingCommand(() => editor.value?.chain().focus().toggleBlockquote().run());
      return;
    }
    if (value === 'codeBlock') {
      runFormattingCommand(() => editor.value?.chain().focus().toggleCodeBlock().run());
    }
  }

  function setBlockType(event: Event) {
    applyBlockType((event.target as HTMLSelectElement).value);
  }

  function setContextBlockType(event: Event) {
    restoreContextSelection();
    setBlockType(event);
  }

  function applyFontSize(value: string) {
    if (value) {
      runFormattingCommand(() => editor.value?.chain().focus().setFontSize(value).run());
    } else {
      runFormattingCommand(() => editor.value?.chain().focus().unsetFontSize().run());
    }
  }

  function setFontSize(event: Event) {
    applyFontSize((event.target as HTMLSelectElement).value);
  }

  function setContextFontSize(event: Event) {
    restoreContextSelection();
    setFontSize(event);
  }

  function applyTextColor(value: string) {
    if (value) {
      runFormattingCommand(() => editor.value?.chain().focus().setTextColor(value).run());
    } else {
      runFormattingCommand(() => editor.value?.chain().focus().unsetTextColor().run());
    }
  }

  function setTextColor(event: Event) {
    applyTextColor((event.target as HTMLSelectElement).value);
  }

  function applyContextTextColor(value: string) {
    restoreContextSelection();
    applyTextColor(value);
  }

  function applyHighlightColor(value: string) {
    if (value) {
      runFormattingCommand(() => editor.value?.chain().focus().setHighlightColor(value).run());
    } else {
      runFormattingCommand(() => editor.value?.chain().focus().unsetHighlightColor().run());
    }
  }

  function setHighlightColor(event: Event) {
    applyHighlightColor((event.target as HTMLSelectElement).value);
  }

  function applyContextHighlightColor(value: string) {
    restoreContextSelection();
    applyHighlightColor(value);
  }

  function runEditorMarkCommand(command: MarkCommand) {
    const commands: Record<MarkCommand, FormatCommand> = {
      bold: () => editor.value?.chain().focus().toggleBold().run(),
      italic: () => editor.value?.chain().focus().toggleItalic().run(),
      underline: () => editor.value?.chain().focus().toggleUnderline().run(),
      strike: () => editor.value?.chain().focus().toggleStrike().run(),
      code: () => editor.value?.chain().focus().toggleCode().run(),
      superscript: () => editor.value?.chain().focus().toggleSuperscript().run(),
      subscript: () => editor.value?.chain().focus().toggleSubscript().run(),
    };
    runFormattingCommand(commands[command]);
  }

  function runContextMarkCommand(command: 'bold' | 'italic' | 'underline' | 'strike' | 'code') {
    restoreContextSelection();
    runEditorMarkCommand(command);
  }

  function runEditorListCommand(command: 'bullet' | 'ordered' | 'task') {
    const commands: Record<typeof command, FormatCommand> = {
      bullet: () => editor.value?.chain().focus().toggleBulletList().run(),
      ordered: () => editor.value?.chain().focus().toggleOrderedList().run(),
      task: () => editor.value?.chain().focus().toggleTaskList().run(),
    };
    runFormattingCommand(commands[command]);
  }

  function runEditorBlockCommand(command: 'blockquote' | 'codeBlock') {
    const commands: Record<typeof command, FormatCommand> = {
      blockquote: () => editor.value?.chain().focus().toggleBlockquote().run(),
      codeBlock: () => editor.value?.chain().focus().toggleCodeBlock().run(),
    };
    runFormattingCommand(commands[command]);
  }

  return {
    activeBlockType,
    activeFontSize,
    activeTextColor,
    activeHighlightColor,
    applyBlockType,
    setBlockType,
    setContextBlockType,
    applyFontSize,
    setFontSize,
    setContextFontSize,
    applyTextColor,
    setTextColor,
    applyContextTextColor,
    applyHighlightColor,
    setHighlightColor,
    applyContextHighlightColor,
    runEditorMarkCommand,
    runContextMarkCommand,
    runEditorListCommand,
    runEditorBlockCommand,
  };
}
