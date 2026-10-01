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
        aria-describedby="server-security-note"
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
    <p id="server-security-note" class="server-security-note">
      Only use a server you control or trust. It receives Inkwell authentication data and any content you sync to it. HTTPS is required outside localhost development.
    </p>
  </div>
</template>
