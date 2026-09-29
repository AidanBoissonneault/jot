<script setup lang="ts">
/** @file Quote, code block, and divider controls. */
import type { EditorToolbarContext } from '../editorToolbarContext';

const props = defineProps<{ context: EditorToolbarContext }>();
const { editor, runEditorBlockCommand } = props.context;
</script>

<template>
  <div class="tool-panel button-grid">
    <button
      type="button"
      class="icon-label-button"
      :class="{ active: editor?.isActive('blockquote') }"
      :disabled="!editor"
      title="Quote"
      aria-label="Quote"
      @click="runEditorBlockCommand('blockquote')"
    >
      <font-awesome-icon :icon="['fas', 'quote-left']" fixed-width />
      <span>Quote</span>
    </button>
    <button
      type="button"
      class="icon-label-button"
      :class="{ active: editor?.isActive('codeBlock') }"
      :disabled="!editor"
      title="Code block"
      aria-label="Code block"
      @click="runEditorBlockCommand('codeBlock')"
    >
      <font-awesome-icon :icon="['fas', 'code']" fixed-width />
      <span>Code block</span>
    </button>
    <button
      type="button"
      class="icon-label-button"
      :disabled="!editor"
      title="Divider"
      aria-label="Divider"
      @click="editor?.chain().focus().setHorizontalRule().run()"
    >
      <font-awesome-icon :icon="['fas', 'grip-lines']" fixed-width />
      <span>Divider</span>
    </button>
  </div>
</template>
