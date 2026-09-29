<script setup lang="ts">
/** @file Text and highlight color swatches. */
import type { EditorContextMenuContext } from '../editorContextMenuContext';

const props = defineProps<{ context: EditorContextMenuContext }>();
const {
  activeTextColor,
  textColors,
  applyContextTextColor,
  activeHighlightColor,
  highlightColors,
  applyContextHighlightColor,
  editorContextMenuPanel,
} = props.context;
</script>

<template>
  <div class="context-menu-stack color-panel">
    <div class="context-menu-section-label">Text</div>
    <div class="context-color-grid">
      <button
        v-for="color in textColors"
        :key="`text-${color.value}`"
        type="button"
        class="context-swatch"
        :class="{ active: activeTextColor === color.value }"
        :title="color.label"
        :aria-label="`Text color ${color.label}`"
        @mousedown.prevent
        @click="applyContextTextColor(color.value)"
      >
        <span class="context-swatch-chip" :style="{ background: color.value || 'transparent' }" />
        <span>{{ color.label }}</span>
      </button>
    </div>
    <div class="context-menu-section-label">Highlight</div>
    <div class="context-color-grid">
      <button
        v-for="color in highlightColors"
        :key="`highlight-${color.value}`"
        type="button"
        class="context-swatch"
        :class="{ active: activeHighlightColor === color.value }"
        :title="color.label"
        :aria-label="`Highlight ${color.label}`"
        @mousedown.prevent
        @click="applyContextHighlightColor(color.value)"
      >
        <span class="context-swatch-chip" :style="{ background: color.value || 'transparent' }" />
        <span>{{ color.label }}</span>
      </button>
    </div>
    <div class="context-menu-row">
      <button
        type="button"
        class="context-menu-button text-action"
        @click="editorContextMenuPanel = 'main'"
      >
        Back
      </button>
    </div>
  </div>
</template>
