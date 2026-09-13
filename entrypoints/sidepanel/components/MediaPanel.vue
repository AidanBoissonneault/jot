<!--
  Created: September 12, 2026
  Author: Aidan
  Description: Collects a remote media URL and media type before inserting it into the editor.
-->
<script setup lang="ts">
export type MediaKind = 'image' | 'video' | 'audio';

withDefaults(defineProps<{
  compact?: boolean;
  editorAvailable: boolean;
}>(), {
  compact: false,
});

const mediaKind = defineModel<MediaKind>('mediaKind', { required: true });
const mediaUrl = defineModel<string>('mediaUrl', { required: true });

const emit = defineEmits<{
  insert: [];
  openEditor: [];
}>();
</script>

<template>
  <section :class="compact ? 'media-popover-panel' : 'tab-panel'" aria-label="Media">
    <div class="panel-section">
      <div v-if="!compact" class="section-heading">
        <h2>Media</h2>
        <button type="button" class="icon-label-button secondary-button" title="Editor" aria-label="Editor" @click="emit('openEditor')">
          <font-awesome-icon :icon="['far', 'pen-to-square']" fixed-width />
          <span>Editor</span>
        </button>
      </div>

      <form class="media-insert" @submit.prevent="emit('insert')">
        <label class="field-label">
          Media URL
          <input v-model="mediaUrl" type="url" aria-label="Media URL" placeholder="https://..." :disabled="!editorAvailable">
        </label>
        <div class="media-insert-actions">
          <label class="field-label">
            Type
            <select v-model="mediaKind" aria-label="Media type" :disabled="!editorAvailable">
              <option value="image">Image</option>
              <option value="video">YouTube</option>
              <option value="audio">Audio</option>
            </select>
          </label>
          <button type="submit" class="icon-label-button" :disabled="!editorAvailable || !mediaUrl.trim()" title="Insert media" aria-label="Insert media">
            <font-awesome-icon :icon="['fas', 'plus']" fixed-width />
            <span>Insert</span>
          </button>
        </div>
      </form>

      <p class="panel-hint">You can also drop images, audio files, or YouTube links directly into the editor.</p>
    </div>
  </section>
</template>
