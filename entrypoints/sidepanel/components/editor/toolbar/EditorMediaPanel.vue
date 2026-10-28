<script setup lang="ts">
/** @file Image, video, and audio insertion controls. */
import type { EditorToolbarContext } from '../editorToolbarContext';

const props = defineProps<{ context: EditorToolbarContext }>();
const {
  editor,
  imageUrlDraft,
  insertImage,
  imageFileAccept,
  handleImageFileInput,
  videoUrlDraft,
  insertVideo,
  audioUrlDraft,
  insertAudio,
} = props.context;
</script>

<template>
  <div class="media-tool-panel">
    <label class="media-file-picker">
      <font-awesome-icon :icon="['fas', 'image']" fixed-width />
      <span>Choose image file</span>
      <input
        type="file"
        :accept="imageFileAccept"
        aria-label="Choose image file"
        :disabled="!editor"
        @change="handleImageFileInput"
      />
    </label>
    <form @submit.prevent="insertImage">
      <input
        v-model="imageUrlDraft"
        type="url"
        aria-label="Image URL"
        placeholder="Image URL"
        :disabled="!editor"
      />
      <button type="submit" :disabled="!editor" title="Insert image" aria-label="Insert image">
        <font-awesome-icon :icon="['fas', 'image']" fixed-width />
      </button>
    </form>
    <form @submit.prevent="insertVideo">
      <input
        v-model="videoUrlDraft"
        type="url"
        aria-label="Video or YouTube URL"
        placeholder="Video or YouTube URL"
        :disabled="!editor"
      />
      <button type="submit" :disabled="!editor" title="Insert video" aria-label="Insert video">
        <font-awesome-icon :icon="['fas', 'video']" fixed-width />
      </button>
    </form>
    <form @submit.prevent="insertAudio">
      <input
        v-model="audioUrlDraft"
        type="url"
        aria-label="Audio URL"
        placeholder="Audio URL"
        :disabled="!editor"
      />
      <button type="submit" :disabled="!editor" title="Insert audio" aria-label="Insert audio">
        <font-awesome-icon :icon="['fas', 'microphone']" fixed-width />
      </button>
    </form>
    <small>Or drop images, audio, or YouTube links into the editor.</small>
  </div>
</template>
