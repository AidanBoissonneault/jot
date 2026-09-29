<script setup lang="ts">
/** @file Link insertion and removal form. */
import type { EditorToolbarContext } from '../editorToolbarContext';

const props = defineProps<{ context: EditorToolbarContext }>();
const { editor, linkUrlDraft, setLink, openLinkTools } = props.context;
</script>

<template>
  <form class="tool-panel link-form" aria-label="Link editor" @submit.prevent="setLink">
    <input
      v-model="linkUrlDraft"
      type="url"
      aria-label="Link URL"
      placeholder="Paste link URL"
      :disabled="!editor"
      @focus="openLinkTools"
    />
    <button
      type="submit"
      class="icon-label-button"
      :disabled="!editor"
      title="Apply link"
      aria-label="Apply link"
    >
      <font-awesome-icon :icon="['fas', 'check']" fixed-width />
      <span>Apply</span>
    </button>
    <button
      type="button"
      class="icon-label-button secondary-button"
      :disabled="!editor"
      title="Remove link"
      aria-label="Remove link"
      @click="
        linkUrlDraft = '';
        setLink();
      "
    >
      <font-awesome-icon :icon="['fas', 'xmark']" fixed-width />
      <span>Remove</span>
    </button>
  </form>
</template>
