<script setup lang="ts">
import { computed, onUnmounted, ref, watch } from 'vue';

type RecordingPhase = 'idle' | 'requesting_permission' | 'recording' | 'processing';

const props = defineProps<{
  disabled: boolean;
  phase: RecordingPhase;
  stream: MediaStream | null;
  variant?: 'floating' | 'panel';
}>();

const emit = defineEmits<{
  (e: 'start'): void;
  (e: 'stop'): void;
}>();

const elapsedSeconds = ref(0);
const waveformBars = ref<number[]>(Array(20).fill(3));

let intervalHandle: ReturnType<typeof setInterval> | undefined;
let rafHandle: number | undefined;
let analyserNode: AnalyserNode | undefined;
let audioCtx: AudioContext | undefined;

const formattedElapsed = computed(() => {
  const m = Math.floor(elapsedSeconds.value / 60);
  const s = String(elapsedSeconds.value % 60).padStart(2, '0');
  return `${m}:${s}`;
});

function sampleBars(data: Uint8Array, count: number): number[] {
  const bins = data.length;
  const result: number[] = [];
  for (let i = 0; i < count; i++) {
    const idx = Math.floor((i / count) * bins * 0.6);
    const normalized = data[idx] / 255;
    result.push(Math.max(3, Math.round(normalized * 28)));
  }
  return result;
}

function startWaveformLoop() {
  if (!analyserNode) return;
  const data = new Uint8Array(analyserNode.frequencyBinCount);
  function tick() {
    analyserNode!.getByteFrequencyData(data);
    waveformBars.value = sampleBars(data, 20);
    rafHandle = requestAnimationFrame(tick);
  }
  rafHandle = requestAnimationFrame(tick);
}

function teardownAudio() {
  if (rafHandle !== undefined) {
    cancelAnimationFrame(rafHandle);
    rafHandle = undefined;
  }
  analyserNode = undefined;
  audioCtx?.close();
  audioCtx = undefined;
  waveformBars.value = Array(20).fill(3);
}

watch(
  () => props.stream,
  (stream) => {
    teardownAudio();
    if (!stream) return;
    audioCtx = new AudioContext();
    const source = audioCtx.createMediaStreamSource(stream);
    analyserNode = audioCtx.createAnalyser();
    analyserNode.fftSize = 64;
    source.connect(analyserNode);
    startWaveformLoop();
  },
);

watch(
  () => props.phase,
  (phase, prev) => {
    if (phase === 'recording' && prev !== 'recording') {
      elapsedSeconds.value = 0;
      intervalHandle = setInterval(() => {
        elapsedSeconds.value++;
      }, 1000);
    } else if (phase !== 'recording') {
      clearInterval(intervalHandle);
      intervalHandle = undefined;
      if (phase === 'idle') elapsedSeconds.value = 0;
    }
  },
);

onUnmounted(() => {
  clearInterval(intervalHandle);
  teardownAudio();
});
</script>

<template>
  <div class="audio-recorder" :class="[`phase-${phase}`, variant === 'panel' ? 'is-panel' : 'is-floating']">
    <Transition name="hud">
      <div
        v-if="phase === 'recording'"
        class="recorder-hud"
        aria-label="Recording in progress"
      >
        <span class="rec-dot" aria-hidden="true" />
        <div class="waveform" aria-hidden="true">
          <span
            v-for="(h, i) in waveformBars"
            :key="i"
            class="waveform-bar"
            :style="{ height: h + 'px' }"
          />
        </div>
        <span class="elapsed" aria-live="polite">{{ formattedElapsed }}</span>
      </div>
    </Transition>

    <Transition name="hint">
      <span v-if="phase === 'requesting_permission'" class="recorder-hint">
        Check Chrome toolbar for mic prompt…
      </span>
      <span v-else-if="phase === 'processing'" class="recorder-hint">
        Processing…
      </span>
    </Transition>

    <button
      type="button"
      class="mic-button"
      :class="{
        recording: phase === 'recording',
        preparing: phase === 'requesting_permission' || phase === 'processing',
      }"
      :disabled="disabled || phase === 'processing' || phase === 'requesting_permission'"
      :title="phase === 'recording' ? 'Stop recording' : 'Record audio note'"
      :aria-label="phase === 'recording' ? 'Stop recording' : 'Record audio note'"
      @click="phase === 'recording' ? emit('stop') : emit('start')"
    >
      <font-awesome-icon
        :icon="phase === 'recording' ? ['fas', 'stop'] : ['fas', 'microphone']"
        fixed-width
      />
    </button>
  </div>
</template>

<style scoped>
.audio-recorder {
  display: flex;
  align-items: center;
  gap: 6px;
}

.audio-recorder.is-floating {
  position: absolute;
  bottom: 16px;
  right: 12px;
  z-index: 10;
}

.audio-recorder.is-panel {
  position: static;
  flex-wrap: wrap;
}

.audio-recorder.is-panel .recorder-hud {
  flex: 1;
  box-shadow: none;
  background: transparent;
  border-color: transparent;
  padding: 0;
}

.audio-recorder.is-panel .recorder-hint {
  background: transparent;
  border-color: transparent;
  box-shadow: none;
  padding: 0;
  font-size: 12px;
}

.audio-recorder.is-panel .mic-button {
  box-shadow: none;
}

/* HUD pill */
.recorder-hud {
  display: flex;
  align-items: center;
  gap: 6px;
  padding: 5px 10px;
  background: var(--inkwell-surface);
  border: 1px solid var(--inkwell-border);
  border-radius: 20px;
  box-shadow: var(--inkwell-shadow);
  font-size: 12px;
  font-variant-numeric: tabular-nums;
  color: var(--inkwell-text);
}

.rec-dot {
  display: block;
  width: 8px;
  height: 8px;
  border-radius: 50%;
  background: #e53e3e;
  flex-shrink: 0;
  animation: pulse-dot 1.2s ease-in-out infinite;
}

@keyframes pulse-dot {
  0%, 100% { opacity: 1; }
  50% { opacity: 0.3; }
}

.waveform {
  display: flex;
  align-items: center;
  gap: 2px;
  height: 28px;
}

.waveform-bar {
  display: block;
  width: 2px;
  background: var(--inkwell-accent);
  border-radius: 1px;
  transition: height 80ms ease;
  min-height: 3px;
}

.elapsed {
  font-size: 12px;
  color: var(--inkwell-muted);
  min-width: 3ch;
}

/* Hint text */
.recorder-hint {
  font-size: 11px;
  color: var(--inkwell-muted);
  white-space: nowrap;
  background: var(--inkwell-surface);
  border: 1px solid var(--inkwell-border);
  border-radius: 20px;
  padding: 4px 10px;
  box-shadow: var(--inkwell-shadow);
}

/* Mic button */
.mic-button {
  width: 36px;
  height: 36px;
  border-radius: 50%;
  border: 1px solid var(--inkwell-border);
  background: var(--inkwell-surface);
  color: var(--inkwell-muted);
  display: flex;
  align-items: center;
  justify-content: center;
  cursor: pointer;
  box-shadow: 0 2px 8px rgb(17 17 19 / 10%);
  transition: box-shadow 120ms ease, transform 120ms ease, background 120ms ease, color 120ms ease, border-color 120ms ease;
  flex-shrink: 0;
  padding: 0;
}

.mic-button:hover:not(:disabled) {
  box-shadow: 0 4px 14px rgb(17 17 19 / 14%);
  transform: translateY(-1px);
  color: var(--inkwell-accent);
  border-color: var(--inkwell-accent);
}

.mic-button.recording {
  background: #e53e3e;
  border-color: #e53e3e;
  color: white;
}

.mic-button.recording:hover:not(:disabled) {
  background: #c53030;
  border-color: #c53030;
  color: white;
}

.mic-button.preparing {
  opacity: 0.6;
  cursor: default;
}

.mic-button:disabled {
  opacity: 0.5;
  cursor: not-allowed;
  transform: none;
}

/* Transitions */
.hud-enter-active,
.hud-leave-active {
  transition: opacity 150ms ease, transform 150ms ease;
}
.hud-enter-from,
.hud-leave-to {
  opacity: 0;
  transform: translateX(6px);
}

.hint-enter-active,
.hint-leave-active {
  transition: opacity 120ms ease;
}
.hint-enter-from,
.hint-leave-to {
  opacity: 0;
}
</style>
