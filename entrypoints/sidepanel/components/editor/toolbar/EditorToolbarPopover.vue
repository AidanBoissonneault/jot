<script setup lang="ts">
/** @file Renders the link or media form beside its toolbar action. */
import type { EditorToolbarContext } from '../editorToolbarContext';
import EditorLinkPanel from './EditorLinkPanel.vue';
import EditorMediaPanel from './EditorMediaPanel.vue';

const props = defineProps<{ context: EditorToolbarContext }>();
const { activeEditorMenu } = props.context;
const context = props.context;
</script>

<template>
  <div
    class="tool-popover"
    role="dialog"
    :aria-label="activeEditorMenu === 'link' ? 'Link options' : 'Media options'"
  >
    <EditorLinkPanel v-if="activeEditorMenu === 'link'" :context="context" />
    <EditorMediaPanel v-else-if="activeEditorMenu === 'media'" :context="context" />
  </div>
</template>
