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
  activeEditorMarks,
  runEditorMarkCommand,
} = props.context;
const context = props.context;
const inlineFormattingControls = [
  { command: 'bold', label: 'Bold', icon: ['fas', 'bold'] },
  { command: 'italic', label: 'Italic', icon: ['fas', 'italic'] },
  { command: 'underline', label: 'Underline', icon: ['fas', 'underline'] },
  { command: 'strike', label: 'Strikethrough', icon: ['fas', 'strikethrough'] },
  { command: 'code', label: 'Inline code', icon: ['fas', 'code'] },
] as const;
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

    <div class="editor-quickbar editor-formatting-bar" role="toolbar" aria-label="Text formatting">
      <button
        v-for="control in inlineFormattingControls"
        :key="control.command"
        type="button"
        class="tool-icon-button"
        :class="{ active: activeEditorMarks[control.command] }"
        :disabled="!editor"
        :title="control.label"
        :aria-label="control.label"
        :aria-pressed="activeEditorMarks[control.command]"
        @mousedown.prevent
        @click="runEditorMarkCommand(control.command)"
      >
        <font-awesome-icon :icon="control.icon" fixed-width />
      </button>
    </div>

    <EditorToolbarPopover :context="context" />
  </div>
</template>
