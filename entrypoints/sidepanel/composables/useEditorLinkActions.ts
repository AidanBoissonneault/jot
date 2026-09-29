/** @file Owns editor link drafts and persisted link/formatting commands. */
import { ref } from 'vue';
import type { Ref, ShallowRef } from 'vue';
import type { Editor } from '@tiptap/core';

/** Applies editor link changes and schedules their optimistic persistence. */
export function useEditorLinkActions(
  editor: ShallowRef<Editor | undefined>,
  saveTimer: Ref<number | undefined>,
  saveEditorContent: () => Promise<void>,
) {
  const linkUrlDraft = ref('');

  function runEditorFormattingCommand(command: () => boolean | undefined) {
    if (!command()) return;
    window.clearTimeout(saveTimer.value);
    void saveEditorContent();
  }

  function setLink() {
    applyLink(linkUrlDraft.value);
    linkUrlDraft.value = '';
  }

  function applyLink(href: string) {
    if (!editor.value) return;
    const trimmedHref = href.trim();

    if (!trimmedHref) {
      runEditorFormattingCommand(() =>
        editor.value?.chain().focus().extendMarkRange('link').unsetLink().run(),
      );
      return;
    }

    runEditorFormattingCommand(() =>
      editor.value?.chain().focus().extendMarkRange('link').setLink({ href: trimmedHref }).run(),
    );
  }

  function clearFormatting() {
    runEditorFormattingCommand(() =>
      editor.value?.chain().focus().unsetAllMarks().clearNodes().run(),
    );
  }

  return {
    applyLink,
    clearFormatting,
    linkUrlDraft,
    runEditorFormattingCommand,
    setLink,
  };
}
