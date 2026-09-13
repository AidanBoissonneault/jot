<!--
  Created: September 12, 2026
  Author: Aidan
  Description: Provides project and page creation, renaming, categorization, and archive controls.
-->
<script setup lang="ts">
import { useInkwellStore } from '@/src/stores/inkwell';

const newProjectName = defineModel<string>('newProjectName', { required: true });
const pageTitle = defineModel<string>('pageTitle', { required: true });
const projectCategory = defineModel<string>('projectCategory', { required: true });
const projectName = defineModel<string>('projectName', { required: true });

const emit = defineEmits<{
  archivePage: [];
  archiveProject: [];
  createPage: [];
  createProject: [];
  openEditor: [];
  renamePage: [];
  renameProject: [];
  saveProjectMetadata: [];
}>();

const store = useInkwellStore();

function blurInput(event: Event) {
  (event.target as HTMLInputElement).blur();
}
</script>

<template>
  <section class="tab-panel" aria-label="Projects and pages">
    <div class="panel-section">
      <div class="section-heading">
        <h2>Projects</h2>
        <button type="button" class="icon-label-button secondary-button" title="Editor" aria-label="Editor" @click="emit('openEditor')">
          <font-awesome-icon :icon="['far', 'pen-to-square']" fixed-width />
          <span>Editor</span>
        </button>
      </div>

      <form class="inline-form" @submit.prevent="emit('createProject')">
        <input v-model="newProjectName" aria-label="New project name" placeholder="New project name" :disabled="store.isLoading">
        <button type="submit" class="icon-label-button" :disabled="store.isLoading" title="Create project" aria-label="Create project">
          <font-awesome-icon :icon="['fas', 'folder-plus']" fixed-width />
          <span>Create</span>
        </button>
      </form>

      <div class="entity-title-row">
        <div class="entity-title-control static-title">
          <input v-model="projectName" class="entity-title-input" aria-label="Project name" :disabled="store.isLoading || !store.currentProject" @blur="emit('renameProject')" @keydown.enter="blurInput">
        </div>
        <button type="button" class="icon-label-button secondary-button danger-button" :disabled="store.isLoading || !store.currentProject" title="Archive project" aria-label="Archive project" @click="emit('archiveProject')">
          <font-awesome-icon :icon="['fas', 'trash-can']" fixed-width />
          <span>Archive</span>
        </button>
      </div>

      <label class="field-label">
        Category
        <input v-model="projectCategory" aria-label="Project category" :disabled="store.isLoading || !store.currentProject" @blur="emit('saveProjectMetadata')" @keydown.enter="blurInput">
      </label>
    </div>

    <div class="panel-section">
      <div class="section-heading">
        <h2>Pages</h2>
        <button type="button" class="icon-label-button" :disabled="store.isLoading || !store.currentProjectId" title="New page" aria-label="New page" @click="emit('createPage')">
          <font-awesome-icon :icon="['fas', 'file-circle-plus']" fixed-width />
          <span>New page</span>
        </button>
      </div>

      <div class="entity-title-row">
        <div class="entity-title-control static-title">
          <input v-model="pageTitle" class="entity-title-input" aria-label="Page title" :disabled="store.isLoading || !store.currentPage" @blur="emit('renamePage')" @keydown.enter="blurInput">
        </div>
        <button type="button" class="icon-label-button secondary-button danger-button" :disabled="store.isLoading || !store.currentPage" title="Archive page" aria-label="Archive page" @click="emit('archivePage')">
          <font-awesome-icon :icon="['fas', 'trash-can']" fixed-width />
          <span>Archive</span>
        </button>
      </div>
    </div>
  </section>
</template>
