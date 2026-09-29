<script setup lang="ts">
/** Presents the InterfaceSettingsSection settings section; the parent owns the shared settings state. */
import type { SettingsPageContext } from './settingsPageContext';
import InterfaceScalePresets from '../lists/InterfaceScalePresets.vue';

const props = defineProps<{ context: SettingsPageContext }>();
const {
  interfaceScaleLabel,
  interfaceScale,
  MIN_INTERFACE_SCALE,
  MAX_INTERFACE_SCALE,
  INTERFACE_SCALE_STEP,
  previewInterfaceScale,
  persistInterfaceScale,
  setInterfaceScale,
} = props.context;
</script>

<template>
  <div class="panel-section">
    <div class="settings-heading">
      <div>
        <h2>Interface</h2>
        <p>Make Inkwell comfortable to read and use.</p>
      </div>
      <span class="setting-value" aria-live="polite">
        {{ interfaceScaleLabel }} Â· {{ interfaceScale }}%
      </span>
    </div>

    <div class="setting-card">
      <div class="setting-copy">
        <label for="interface-scale">Interface size</label>
        <p id="interface-scale-help">
          Enlarges text throughout the sidebar. Changes appear immediately and are saved on this
          browser.
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

      <InterfaceScalePresets :selected-scale="interfaceScale" @select="setInterfaceScale" />

      <div class="scale-preview" aria-hidden="true">
        <small>Preview</small>
        <strong>Inkwell should feel easy to read.</strong>
        <span>Adjust the slider until this text is comfortable.</span>
      </div>
    </div>
  </div>
</template>
