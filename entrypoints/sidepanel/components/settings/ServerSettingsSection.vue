<script setup lang="ts">
/** Presents the ServerSettingsSection settings section; the parent owns the shared settings state. */
import type { SettingsPageContext } from './settingsPageContext';

const props = defineProps<{ context: SettingsPageContext }>();
const { serverUrlDraft, saveServerUrl } = props.context;
</script>

<template>
  <div class="panel-section">
    <h2>Server</h2>
    <form class="inline-form" @submit.prevent="saveServerUrl">
      <input
        v-model="serverUrlDraft"
        type="url"
        aria-label="Sync server URL"
        placeholder="http://localhost:8787"
      />
      <button
        type="submit"
        class="icon-label-button"
        title="Save server URL"
        aria-label="Save server URL"
      >
        <font-awesome-icon :icon="['fas', 'floppy-disk']" fixed-width />
        <span>Save</span>
      </button>
    </form>
  </div>
</template>
