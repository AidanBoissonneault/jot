<script setup lang="ts">
/** @file Undo, redo, and clear formatting controls. */
import type { EditorToolbarContext } from '../editorToolbarContext';

const props = defineProps<{ context: EditorToolbarContext }>();
const { editor, clearFormatting } = props.context;
</script>

<template>
  <div class="tool-panel button-grid">
    <button
      type="button"
      class="icon-label-button"
      :disabled="!editor"
      title="Undo"
      aria-label="Undo"
      @click="editor?.chain().focus().undo().run()"
    >
      <font-awesome-icon :icon="['fas', 'rotate-left']" fixed-width />
      <span>Undo</span>
    </button>
    <button
      type="button"
      class="icon-label-button"
      :disabled="!editor"
      title="Redo"
      aria-label="Redo"
      @click="editor?.chain().focus().redo().run()"
    >
      <font-awesome-icon :icon="['fas', 'rotate-right']" fixed-width />
      <span>Redo</span>
    </button>
    <button
      type="button"
      class="icon-label-button"
      :disabled="!editor"
      title="Clear formatting"
      aria-label="Clear formatting"
      @click="clearFormatting"
    >
      <font-awesome-icon :icon="['fas', 'eraser']" fixed-width />
      <span>Clear</span>
    </button>
  </div>
</template>
