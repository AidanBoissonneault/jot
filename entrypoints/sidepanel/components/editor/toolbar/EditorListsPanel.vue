<script setup lang="ts">
/** @file Bullet, ordered, and task list controls. */
import type { EditorToolbarContext } from '../editorToolbarContext';

const props = defineProps<{ context: EditorToolbarContext }>();
const { editor, runEditorListCommand } = props.context;
</script>

<template>
  <div class="tool-panel button-grid">
    <button
      type="button"
      class="icon-label-button"
      :class="{ active: editor?.isActive('bulletList') }"
      :disabled="!editor"
      title="Bullet list"
      aria-label="Bullet list"
      @click="runEditorListCommand('bullet')"
    >
      <font-awesome-icon :icon="['fas', 'list-ul']" fixed-width />
      <span>Bullet</span>
    </button>
    <button
      type="button"
      class="icon-label-button"
      :class="{ active: editor?.isActive('orderedList') }"
      :disabled="!editor"
      title="Ordered list"
      aria-label="Ordered list"
      @click="runEditorListCommand('ordered')"
    >
      <font-awesome-icon :icon="['fas', 'list-ol']" fixed-width />
      <span>Number</span>
    </button>
    <button
      type="button"
      class="icon-label-button"
      :class="{ active: editor?.isActive('taskList') }"
      :disabled="!editor"
      title="Task list"
      aria-label="Task list"
      @click="runEditorListCommand('task')"
    >
      <font-awesome-icon :icon="['fas', 'list-check']" fixed-width />
      <span>Task</span>
    </button>
  </div>
</template>
