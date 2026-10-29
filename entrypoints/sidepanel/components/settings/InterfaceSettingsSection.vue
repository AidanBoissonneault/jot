<script setup lang="ts">
/** Presents the InterfaceSettingsSection settings section; the parent owns the shared settings state. */
import type { SettingsPageContext } from './settingsPageContext';

const props = defineProps<{ context: SettingsPageContext }>();
const themeOptions = [
  { value: 'system', label: 'System' },
  { value: 'light', label: 'Light' },
  { value: 'dark', label: 'Dark' },
] as const;
const {
  interfaceScaleLabel,
  interfaceScale,
  MIN_INTERFACE_SCALE,
  MAX_INTERFACE_SCALE,
  INTERFACE_SCALE_STEP,
  previewInterfaceScale,
  persistInterfaceScale,
  themePreference,
  setThemePreference,
} = props.context;
</script>

<template>
  <div class="panel-section">
    <div class="settings-heading">
      <div>
        <h2>Interface</h2>
        <p>Make Jottathing comfortable to read and use.</p>
      </div>
      <span class="setting-value" aria-live="polite">
        {{ interfaceScaleLabel }} Â· {{ interfaceScale }}%
      </span>
    </div>

    <div class="setting-card">
      <div class="setting-copy">
        <label for="interface-scale">Interface size</label>
        <p id="interface-scale-help">
          Changes are applied immediately and saved on this browser.
        </p>
      </div>

      <input
        id="interface-scale"
        class="scale-slider"
        type="range"
        :min="MIN_INTERFACE_SCALE"
        :max="MAX_INTERFACE_SCALE"
        :step="INTERFACE_SCALE_STEP"
        :value="interfaceScale"
        aria-describedby="interface-scale-help interface-scale-bounds"
        :aria-valuetext="`${interfaceScaleLabel}, ${interfaceScale}%`"
        @input="previewInterfaceScale"
        @change="persistInterfaceScale"
      />
      <div id="interface-scale-bounds" class="scale-bounds" aria-hidden="true">
        <span>Smaller</span>
        <span>Larger</span>
      </div>
    </div>

    <div class="setting-card theme-setting-card">
      <div class="setting-copy">
        <span class="setting-label">Theme</span>
        <p>Follow your browser appearance or choose a theme.</p>
      </div>
      <div class="theme-options" role="group" aria-label="Theme">
        <button
          v-for="option in themeOptions"
          :key="option.value"
          type="button"
          class="theme-option"
          :class="{ active: themePreference === option.value }"
          :aria-pressed="themePreference === option.value"
          @click="setThemePreference(option.value)"
        >
          {{ option.label }}
        </button>
      </div>
    </div>
  </div>
</template>
