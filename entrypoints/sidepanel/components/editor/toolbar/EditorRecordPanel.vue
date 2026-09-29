<script setup lang="ts">
/** @file Audio note recording controls. */
import type { EditorToolbarContext } from '../editorToolbarContext';
import AudioRecorder from '@/src/components/AudioRecorder.vue';

const props = defineProps<{ context: EditorToolbarContext }>();
const { editor, store, recordingPhase, audioStream, toggleAudioRecording } = props.context;
</script>

<template>
  <div class="tool-panel record-panel">
    <AudioRecorder
      :disabled="!editor || !store.currentPage"
      :phase="recordingPhase"
      :stream="audioStream"
      variant="panel"
      @start="toggleAudioRecording"
      @stop="toggleAudioRecording"
    />
  </div>
</template>
