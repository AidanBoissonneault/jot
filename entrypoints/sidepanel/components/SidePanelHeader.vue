<!--
  Created: September 12, 2026
  Author: Aidan
  Description: Displays sync status, workspace switching, and the side panel's global actions.
-->
<script setup lang="ts">
import { nextTick, ref } from 'vue';
import { useInkwellStore } from '@/src/stores/inkwell';

defineProps<{
  accountLabel: string;
  canUseEditor: boolean;
  saveLabel: string;
  settingsOpen: boolean;
  syncBadgeClass: Record<string, boolean>;
  syncBadgeTitle: string;
  workspaceLabel: string;
}>();

const projectCategory = defineModel<string>('projectCategory', { required: true });

const emit = defineEmits<{
  archiveProject: [];
  createPage: [];
  createQuickProject: [];
  logout: [];
  openSettings: [];
  resync: [];
  saveProjectMetadata: [];
  selectProject: [projectId: string];
}>();

const store = useInkwellStore();
const projectSwitcher = ref<HTMLDetailsElement | null>(null);
const projectCategoryInput = ref<HTMLInputElement | null>(null);

async function openCategoryEditor() {
  if (store.isLoading || !store.currentProject) {
    return;
  }

  if (projectSwitcher.value) {
    projectSwitcher.value.open = true;
  }

  await nextTick();
  projectCategoryInput.value?.focus();
}

function closeSwitcher(event: Event) {
  (event.currentTarget as HTMLElement).closest('details')?.removeAttribute('open');
}
</script>

<template>
  <header class="topbar">
    <div class="topbar-status">
      <div
        :class="syncBadgeClass"
        :title="syncBadgeTitle"
        role="status"
        tabindex="0"
        :aria-label="`${saveLabel}: ${syncBadgeTitle}`"
      >
        <span class="sync-dot" aria-hidden="true" />
        <span class="sync-label">{{ saveLabel }}</span>
      </div>
      <div v-if="canUseEditor" class="context-switcher">
        <details
          ref="projectSwitcher"
          class="context-switcher-dropdown"
          name="workspace-switcher"
        >
          <summary title="Switch project">
            <strong>{{ store.currentProject?.name || 'No project' }}</strong>
            <span class="project-category-spacer" aria-hidden="true">
              {{ projectCategory.trim() || 'Add category' }}
            </span>
            <span class="switcher-chevron" aria-hidden="true" />
          </summary>
          <div class="switcher-popover item-list">
          <button
            v-for="project in store.projects"
            :key="project.id"
            type="button"
            class="item-row"
            :class="{ active: project.id === store.currentProjectId }"
            @click="emit('selectProject', project.id); closeSwitcher($event)"
          >
            <span>{{ project.name }}</span>
            <small v-if="project.category" class="project-list-category">{{ project.category }}</small>
          </button>
          <form class="switcher-category-form" @submit.prevent="emit('saveProjectMetadata')">
            <label for="header-project-category">Project category</label>
            <div class="inline-form">
              <input
                id="header-project-category"
                ref="projectCategoryInput"
                v-model="projectCategory"
                placeholder="Add category"
                :disabled="store.isLoading || !store.currentProject"
                @blur="emit('saveProjectMetadata')"
              >
              <button
                type="submit"
                class="icon-label-button secondary-button"
                :disabled="store.isLoading || !store.currentProject"
                title="Save category"
                aria-label="Save category"
              >
                <font-awesome-icon :icon="['fas', 'check']" fixed-width />
                <span>Save</span>
              </button>
            </div>
          </form>
          <hr class="switcher-divider">
          <div class="switcher-menu-actions">
            <button
              type="button"
              class="switcher-action"
              :disabled="store.isLoading"
              @click="emit('createQuickProject'); closeSwitcher($event)"
            >
              <font-awesome-icon :icon="['fas', 'folder-plus']" fixed-width />
              <span>New project</span>
            </button>
            <button
              type="button"
              class="switcher-action danger-button"
              :disabled="store.isLoading || !store.currentProject"
              @click="emit('archiveProject'); closeSwitcher($event)"
            >
              <font-awesome-icon :icon="['fas', 'trash-can']" fixed-width />
              <span>Delete project</span>
            </button>
          </div>
          </div>
        </details>
        <button
          type="button"
          class="project-category-badge"
          :class="{ empty: !projectCategory.trim() }"
          :disabled="store.isLoading || !store.currentProject"
          :aria-label="projectCategory.trim() ? `Edit category ${projectCategory.trim()}` : 'Add category'"
          @click="openCategoryEditor"
        >
          {{ projectCategory.trim() || 'Add category' }}
        </button>
      </div>
      <div v-else class="topbar-meta">
        <strong>Inkwell</strong>
        <small>{{ accountLabel }} / {{ workspaceLabel }}</small>
      </div>
    </div>

    <div class="topbar-actions">
      <div class="topbar-main-actions">
        <button
          type="button"
          class="icon-label-button secondary-button"
          :disabled="store.isLoading"
          title="New project"
          aria-label="New project"
          @click="emit('createQuickProject')"
        >
          <font-awesome-icon :icon="['fas', 'folder-plus']" fixed-width />
          <span>New project</span>
        </button>
        <button
          type="button"
          class="icon-label-button secondary-button"
          :disabled="store.isLoading || !store.currentProjectId"
          title="New page"
          aria-label="New page"
          @click="emit('createPage')"
        >
          <font-awesome-icon :icon="['fas', 'file-circle-plus']" fixed-width />
          <span>New page</span>
        </button>
        <button
          type="button"
          class="icon-label-button secondary-button"
          :disabled="store.isLoading || !store.syncConfig.connected || !store.isOnline"
          title="Resync with Notion"
          aria-label="Resync with Notion"
          @click="emit('resync')"
        >
          <font-awesome-icon :icon="['fas', 'rotate']" fixed-width />
          <span>Sync</span>
        </button>
        <button
          type="button"
          class="icon-label-button secondary-button"
          :class="{ active: settingsOpen }"
          :title="settingsOpen ? 'Close settings' : 'Settings'"
          :aria-label="settingsOpen ? 'Close settings' : 'Settings'"
          :aria-pressed="settingsOpen"
          @click="emit('openSettings')"
        >
          <font-awesome-icon :icon="['fas', 'gear']" fixed-width />
          <span>Settings</span>
        </button>
      </div>
      <button
        v-if="store.syncConfig.connected"
        type="button"
        class="icon-label-button secondary-button"
        title="Logout"
        aria-label="Logout"
        @click="emit('logout')"
      >
        <font-awesome-icon :icon="['fas', 'right-from-bracket']" fixed-width />
        <span>Logout</span>
      </button>
    </div>
  </header>
</template>
