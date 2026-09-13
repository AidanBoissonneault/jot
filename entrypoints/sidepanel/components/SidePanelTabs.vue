<!--
  Created: September 12, 2026
  Author: Aidan
  Description: Renders the primary navigation used to switch between side-panel sections.
-->
<script setup lang="ts">
export type SidePanelTab = 'editor' | 'projects' | 'media' | 'settings';

const activeTab = defineModel<SidePanelTab>({ required: true });

const tabs = [
  { id: 'editor', label: 'Editor', icon: ['far', 'pen-to-square'] },
  { id: 'projects', label: 'Projects', icon: ['fas', 'folder-tree'] },
  { id: 'settings', label: 'Settings', icon: ['fas', 'gear'] },
] as const;
</script>

<template>
  <nav class="tabs" aria-label="Side panel sections">
    <button
      v-for="tab in tabs"
      :key="tab.id"
      type="button"
      class="icon-label-button tab-button"
      :class="{ active: activeTab === tab.id }"
      :aria-current="activeTab === tab.id ? 'page' : undefined"
      :title="tab.label"
      :aria-label="tab.label"
      @click="activeTab = tab.id"
    >
      <font-awesome-icon :icon="tab.icon" fixed-width />
      <span>{{ tab.label }}</span>
    </button>
  </nav>
</template>
