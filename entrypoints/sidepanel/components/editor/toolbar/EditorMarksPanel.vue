<script setup lang="ts">
/** @file Inline formatting mark controls. */
import type { EditorToolbarContext } from '../editorToolbarContext';

const props = defineProps<{ context: EditorToolbarContext }>();
const { editor, runEditorMarkCommand } = props.context;
</script>

<template>
  <div class="tool-panel button-grid">
    <button
      type="button"
      class="icon-label-button"
      :class="{ active: editor?.isActive('bold') }"
      :disabled="!editor"
      title="Bold"
      aria-label="Bold"
      @click="runEditorMarkCommand('bold')"
    >
      <font-awesome-icon :icon="['fas', 'bold']" fixed-width />
      <span>Bold</span>
    </button>
    <button
      type="button"
      class="icon-label-button"
      :class="{ active: editor?.isActive('italic') }"
      :disabled="!editor"
      title="Italic"
      aria-label="Italic"
      @click="runEditorMarkCommand('italic')"
    >
      <font-awesome-icon :icon="['fas', 'italic']" fixed-width />
      <span>Italic</span>
    </button>
    <button
      type="button"
      class="icon-label-button"
      :class="{ active: editor?.isActive('underline') }"
      :disabled="!editor"
      title="Underline"
      aria-label="Underline"
      @click="runEditorMarkCommand('underline')"
    >
      <font-awesome-icon :icon="['fas', 'underline']" fixed-width />
      <span>Underline</span>
    </button>
    <button
      type="button"
      class="icon-label-button"
      :class="{ active: editor?.isActive('strike') }"
      :disabled="!editor"
      title="Strikethrough"
      aria-label="Strikethrough"
      @click="runEditorMarkCommand('strike')"
    >
      <font-awesome-icon :icon="['fas', 'strikethrough']" fixed-width />
      <span>Strike</span>
    </button>
    <button
      type="button"
      class="icon-label-button"
      :class="{ active: editor?.isActive('code') }"
      :disabled="!editor"
      title="Inline code"
      aria-label="Inline code"
      @click="runEditorMarkCommand('code')"
    >
      <font-awesome-icon :icon="['fas', 'code']" fixed-width />
      <span>Code</span>
    </button>
    <button
      type="button"
      class="icon-label-button"
      :class="{ active: editor?.isActive('superscript') }"
      :disabled="!editor"
      title="Superscript"
      aria-label="Superscript"
      @click="runEditorMarkCommand('superscript')"
    >
      <span aria-hidden="true" class="text-icon">x2</span>
      <span>Super</span>
    </button>
    <button
      type="button"
      class="icon-label-button"
      :class="{ active: editor?.isActive('subscript') }"
      :disabled="!editor"
      title="Subscript"
      aria-label="Subscript"
      @click="runEditorMarkCommand('subscript')"
    >
      <span aria-hidden="true" class="text-icon">x_2</span>
      <span>Sub</span>
    </button>
  </div>
</template>
