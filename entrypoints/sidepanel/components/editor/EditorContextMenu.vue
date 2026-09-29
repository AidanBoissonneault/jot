<script setup lang="ts">
/** Composes a positioned editor context menu from focused action panels. */
import type { EditorContextMenuContext } from './editorContextMenuContext';
import EditorContextMainPanel from './contextMenu/EditorContextMainPanel.vue';
import EditorContextLinkPanel from './contextMenu/EditorContextLinkPanel.vue';
import EditorContextColorPanel from './contextMenu/EditorContextColorPanel.vue';

const props = defineProps<{ context: EditorContextMenuContext }>();
const context = props.context;
const { editorContextMenu, editorContextMenuRef, editorContextMenuPanel } = context;
</script>

<template>
  <div
    v-if="editorContextMenu.visible"
    ref="editorContextMenuRef"
    class="editor-context-menu"
    :style="{
      left: `${editorContextMenu.left}px`,
      top: `${editorContextMenu.top}px`,
    }"
    role="menu"
    aria-label="Text editor context menu"
    @contextmenu.prevent
    @pointerdown.stop
  >
    <EditorContextMainPanel v-if="editorContextMenuPanel === 'main'" :context="context" />

    <EditorContextLinkPanel v-if="editorContextMenuPanel === 'link'" :context="context" />

    <EditorContextColorPanel v-if="editorContextMenuPanel === 'color'" :context="context" />
  </div>
</template>
