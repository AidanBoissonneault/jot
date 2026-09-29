<script setup lang="ts">
/** Presents the ProjectDetailsSection settings section; the parent owns the shared settings state. */
import type { SettingsPageContext } from './settingsPageContext';

const props = defineProps<{ context: SettingsPageContext }>();
const { store, projectStateDraft, saveProjectMetadata } = props.context;
</script>

<template>
  <div class="panel-section">
    <div class="settings-heading">
      <div>
        <h2 id="settings-heading">Settings</h2>
        <p>Project details, sync, and interface preferences.</p>
      </div>
    </div>
    <h3>Current project</h3>
    <label class="field-label">
      Project state
      <textarea
        v-model="projectStateDraft"
        aria-label="Project state"
        rows="5"
        :disabled="store.isLoading || !store.currentProject"
        @blur="saveProjectMetadata"
      />
    </label>
  </div>
</template>
