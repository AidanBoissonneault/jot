<script setup lang="ts">
/** @file Provides new project, new page, sync, settings, and logout actions. */
import type { TopBarContext } from './topBarContext';

const props = defineProps<{ context: TopBarContext }>();
const { store, canUseEditor, isResyncing, activeTab, createProject, createPage, resync, logout } = props.context;
</script>

<template>
  <div v-if="canUseEditor" class="topbar-actions">
    <div class="topbar-action-group">
      <button
        type="button"
        class="icon-label-button secondary-button"
        :disabled="store.isLoading"
        title="New project"
        aria-label="New project"
        @click="createProject"
      >
        <font-awesome-icon :icon="['fas', 'folder-plus']" fixed-width />
        <span>New project</span>
      </button>

      <button
        type="button"
        class="icon-label-button"
        :disabled="store.isLoading || !store.currentProjectId"
        title="New page"
        aria-label="New page"
        @click="createPage"
      >
        <font-awesome-icon :icon="['fas', 'file-circle-plus']" fixed-width />
        <span>New page</span>
      </button>
      <button
        type="button"
        class="icon-label-button secondary-button"
        :disabled="store.isLoading || isResyncing || !store.syncConfig.connected || !store.isOnline"
        :title="isResyncing ? 'Syncing with Notion' : 'Resync with Notion'"
        :aria-label="isResyncing ? 'Syncing with Notion' : 'Resync with Notion'"
        :aria-busy="isResyncing"
        @click="resync"
      >
        <font-awesome-icon :icon="['fas', 'rotate']" :class="{ 'sync-rotating-icon': isResyncing }" fixed-width />
        <span>Sync</span>
      </button>
      <button
        type="button"
        class="icon-label-button secondary-button"
        :class="{ active: activeTab === 'settings' }"
        title="Settings"
        aria-label="Settings"
        @click="activeTab = activeTab === 'settings' ? 'editor' : 'settings'"
      >
        <font-awesome-icon :icon="['fas', 'gear']" fixed-width />
        <span>Settings</span>
      </button>
    </div>
    <button
      v-if="store.syncConfig.connected"
      type="button"
      class="icon-label-button secondary-button logout-button"
      title="Logout"
      aria-label="Logout"
      @click="logout"
    >
      <font-awesome-icon :icon="['fas', 'right-from-bracket']" fixed-width />
      <span>Logout</span>
    </button>
  </div>
</template>
