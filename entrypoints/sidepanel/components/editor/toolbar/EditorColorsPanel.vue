<script setup lang="ts">
/** @file Text and highlight color controls. */
import type { EditorToolbarContext } from '../editorToolbarContext';

const props = defineProps<{ context: EditorToolbarContext }>();
const {
  editor,
  activeTextColor,
  textColors,
  setTextColor,
  activeHighlightColor,
  highlightColors,
  setHighlightColor,
} = props.context;
</script>

<template>
  <div class="tool-panel">
    <label class="field-label">
      Text color
      <select
        class="toolbar-select"
        aria-label="Text color"
        :disabled="!editor"
        :value="activeTextColor"
        @change="setTextColor"
      >
        <option v-for="color in textColors" :key="color.value" :value="color.value">
          {{ color.label }}
        </option>
      </select>
    </label>

    <label class="field-label">
      Highlight
      <select
        class="toolbar-select"
        aria-label="Highlight"
        :disabled="!editor"
        :value="activeHighlightColor"
        @change="setHighlightColor"
      >
        <option v-for="color in highlightColors" :key="color.value" :value="color.value">
          {{ color.label }}
        </option>
      </select>
    </label>
  </div>
</template>
