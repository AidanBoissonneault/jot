<!--
  Created: September 12, 2026
  Author: Aidan
  Description: Presents interface preferences and hosts connection and sync settings.
-->
<script setup lang="ts">
defineProps<{
  interfaceScaleLabel: string;
  maximumScale: number;
  minimumScale: number;
  scaleStep: number;
}>();

const interfaceScale = defineModel<number>({ required: true });

const emit = defineEmits<{
  persist: [];
  preview: [event: Event];
  selectPreset: [scale: number];
}>();

const scalePresets = [90, 100, 120, 140] as const;
</script>

<template>
  <section class="tab-panel settings-panel" aria-labelledby="settings-heading">
    <div class="panel-section">
      <div class="settings-heading">
        <div>
          <h2 id="settings-heading">Settings</h2>
          <p>Make Inkwell comfortable to read and use.</p>
        </div>
        <span class="setting-value" aria-live="polite">{{ interfaceScaleLabel }} · {{ interfaceScale }}%</span>
      </div>

      <div class="setting-card">
        <div class="setting-copy">
          <label for="interface-scale">Interface size</label>
          <p id="interface-scale-help">Enlarges text throughout the sidebar. Changes appear immediately and are saved on this browser.</p>
        </div>

        <input
          id="interface-scale"
          class="scale-slider"
          type="range"
          :min="minimumScale"
          :max="maximumScale"
          :step="scaleStep"
          :value="interfaceScale"
          aria-describedby="interface-scale-help interface-scale-bounds"
          :aria-valuetext="`${interfaceScaleLabel}, ${interfaceScale}%`"
          @input="emit('preview', $event)"
          @change="emit('persist')"
        >
        <div id="interface-scale-bounds" class="scale-bounds" aria-hidden="true">
          <span>Smaller</span>
          <span>Larger</span>
        </div>

        <div class="scale-presets" aria-label="Interface size presets">
          <button
            v-for="preset in scalePresets"
            :key="preset"
            type="button"
            class="secondary-button"
            :class="{ active: interfaceScale === preset }"
            :aria-pressed="interfaceScale === preset"
            @click="emit('selectPreset', preset)"
          >
            {{ preset === 100 ? 'Default' : `${preset}%` }}
          </button>
        </div>

        <div class="scale-preview" aria-hidden="true">
          <small>Preview</small>
          <strong>Inkwell should feel easy to read.</strong>
          <span>Adjust the slider until this text is comfortable.</span>
        </div>
      </div>
    </div>

    <slot />
  </section>
</template>
