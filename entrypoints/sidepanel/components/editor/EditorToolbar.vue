<script setup lang="ts">
/** Renders editor mode tabs, formatting controls, insertion tools, and history actions. */
import type { EditorToolbarContext } from './editorToolbarContext';
import EditorToolbarPopover from './toolbar/EditorToolbarPopover.vue';

const props = defineProps<{ context: EditorToolbarContext }>();
const {
  editor,
  editorToolbarModes,
  editorToolbarMode,
  setEditorToolbarMode,
  activeToolbarItems,
  activeEditorMenu,
  toggleEditorMenu,
} = props.context;
const context = props.context;
</script>

<template>
  <div class="editor-tools" aria-label="Editor toolbar">
    <div class="editor-tool-tabs" role="tablist" aria-label="Editor tool groups">
      <button
        v-for="mode in editorToolbarModes"
        :key="mode.id"
        type="button"
        role="tab"
        class="icon-label-button"
        :aria-selected="editorToolbarMode === mode.id"
        :class="{ active: editorToolbarMode === mode.id }"
        :title="mode.label"
        :aria-label="mode.label"
        @click="setEditorToolbarMode(mode.id)"
      >
        <font-awesome-icon :icon="mode.icon" fixed-width />
        <span>{{ mode.label }}</span>
      </button>
    </div>

    <div class="editor-quickbar" aria-label="Editor actions">
      <button
        v-for="item in activeToolbarItems"
        :key="item.id"
        type="button"
        class="tool-icon-button"
        :class="{ active: activeEditorMenu === item.id }"
        :disabled="!editor"
        :title="item.title"
        :aria-label="item.title"
        @click="toggleEditorMenu(item.id)"
      >
        <font-awesome-icon :icon="item.icon" fixed-width />
        <span>{{ item.label }}</span>
      </button>
    </div>

    <EditorToolbarPopover :context="context" />
  </div>
</template>
