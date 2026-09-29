<script setup lang="ts">
/** @file Link edit, apply, remove, and return controls. */
import type { EditorContextMenuContext } from '../editorContextMenuContext';

const props = defineProps<{ context: EditorContextMenuContext }>();
const { editorContextMenuPanel, contextMenuLinkDraft, applyContextLink, removeContextLink } =
  props.context;
</script>

<template>
  <form class="context-menu-stack" aria-label="Link editor" @submit.prevent="applyContextLink">
    <div class="context-menu-row">
      <input
        v-model="contextMenuLinkDraft"
        class="context-menu-input"
        type="url"
        aria-label="Link URL"
        placeholder="Paste link URL"
      />
    </div>
    <div class="context-menu-row">
      <button
        type="button"
        class="context-menu-button text-action"
        @click="editorContextMenuPanel = 'main'"
      >
        Back
      </button>
      <button type="submit" class="context-menu-button text-action">Apply</button>
      <button type="button" class="context-menu-button text-action" @click="removeContextLink">
        Remove
      </button>
    </div>
  </form>
</template>
