<script setup lang="ts">
/** @file Hosts the Tiptap editor canvas and forwards pointer interaction events. */
import { EditorContent, type Editor } from '@tiptap/vue-3';

defineProps<{ editor: Editor | undefined }>();

const emit = defineEmits<{
  closeTools: [];
  hideContextMenu: [];
}>();
</script>

<template>
  <EditorContent
    v-if="editor"
    class="editor"
    :editor="editor"
    @click="emit('closeTools')"
    @scroll="emit('hideContextMenu')"
  />
</template>
