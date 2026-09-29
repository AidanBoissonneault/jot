<script setup lang="ts">
/** @file Block type and font size controls. */
import type { EditorToolbarContext } from '../editorToolbarContext';

const props = defineProps<{ context: EditorToolbarContext }>();
const {
  editor,
  activeBlockType,
  blockTypes,
  setBlockType,
  activeFontSize,
  fontSizes,
  setFontSize,
} = props.context;
</script>

<template>
  <div class="tool-panel">
    <label class="field-label">
      Block
      <select
        class="toolbar-select"
        aria-label="Block type"
        :disabled="!editor"
        :value="activeBlockType"
        @change="setBlockType"
      >
        <option v-for="blockType in blockTypes" :key="blockType.value" :value="blockType.value">
          {{ blockType.label }}
        </option>
      </select>
    </label>

    <label class="field-label">
      Size
      <select
        class="toolbar-select"
        aria-label="Font size"
        :disabled="!editor"
        :value="activeFontSize"
        @change="setFontSize"
      >
        <option v-for="fontSize in fontSizes" :key="fontSize.value" :value="fontSize.value">
          {{ fontSize.label }}
        </option>
      </select>
    </label>
  </div>
</template>
