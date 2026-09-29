<script setup lang="ts">
/** @file Selects the focused panel for the active editor toolbar menu. */
import type { EditorToolbarContext } from '../editorToolbarContext';
import EditorTypePanel from './EditorTypePanel.vue';
import EditorMarksPanel from './EditorMarksPanel.vue';
import EditorColorsPanel from './EditorColorsPanel.vue';
import EditorLinkPanel from './EditorLinkPanel.vue';
import EditorListsPanel from './EditorListsPanel.vue';
import EditorBlocksPanel from './EditorBlocksPanel.vue';
import EditorMediaPanel from './EditorMediaPanel.vue';
import EditorRecordPanel from './EditorRecordPanel.vue';
import EditorHistoryPanel from './EditorHistoryPanel.vue';

const props = defineProps<{ context: EditorToolbarContext }>();
const { activeEditorMenu } = props.context;
const context = props.context;
</script>

<template>
  <div v-if="activeEditorMenu" class="tool-popover">
    <EditorTypePanel v-if="activeEditorMenu === 'type'" :context="context" />

    <EditorMarksPanel v-if="activeEditorMenu === 'marks'" :context="context" />

    <EditorColorsPanel v-if="activeEditorMenu === 'color'" :context="context" />

    <EditorLinkPanel v-if="activeEditorMenu === 'link'" :context="context" />

    <EditorListsPanel v-if="activeEditorMenu === 'lists'" :context="context" />

    <EditorBlocksPanel v-if="activeEditorMenu === 'blocks'" :context="context" />

    <EditorMediaPanel v-if="activeEditorMenu === 'media'" :context="context" />

    <EditorRecordPanel v-if="activeEditorMenu === 'record'" :context="context" />

    <EditorHistoryPanel v-if="activeEditorMenu === 'history'" :context="context" />
  </div>
</template>
