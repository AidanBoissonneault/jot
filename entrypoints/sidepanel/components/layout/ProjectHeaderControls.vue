<script setup lang="ts">
/** Owns project rename, project switching, and category editing controls. */
import type { TopBarContext } from './topBarContext';
import ProjectMenuList from '../lists/ProjectMenuList.vue';
import CategoryList from '../lists/CategoryList.vue';
import CategoryColorPicker from '../lists/CategoryColorPicker.vue';

const props = defineProps<{ context: TopBarContext }>();
const {
  store,
  isProjectNameEditing,
  projectNameInputRef,
  projectNameDraft,
  finishProjectNameEdit,
  beginProjectNameEdit,
  contextLabel,
  currentCategoryStyle,
  activeTitleMenu,
  toggleTitleMenu,
  projectCategoryDraft,
  commitCategory,
  knownCategories,
  selectCategory,
  categoryColorOptions,
  currentCategoryColor,
  chooseCategoryColor,
  colorForCategory,
  createProject,
  selectProject,
  archiveProject,
} = props.context;
</script>

<template>
  <div class="project-header-control">
    <input
      v-if="isProjectNameEditing"
      ref="projectNameInputRef"
      v-model="projectNameDraft"
      class="project-name-input"
      aria-label="Project name"
      :disabled="store.isLoading || !store.currentProject"
      @blur="finishProjectNameEdit"
      @keydown.enter.prevent="finishProjectNameEdit"
      @keydown.escape="
        isProjectNameEditing = false;
        projectNameDraft = store.currentProject?.name || '';
      "
    />
    <button
      v-else
      type="button"
      class="project-name-display"
      :disabled="store.isLoading || !store.currentProject"
      title="Double-click to rename project"
      @dblclick="beginProjectNameEdit"
    >
      {{ contextLabel }}
    </button>

    <button
      type="button"
      class="category-pill"
      :style="currentCategoryStyle"
      :disabled="store.isLoading || !store.currentProject"
      title="Edit project category"
      aria-label="Edit project category"
      :aria-expanded="activeTitleMenu === 'category'"
      @click="toggleTitleMenu('category')"
    >
      {{ projectCategoryDraft || 'Category' }}
    </button>

    <button
      type="button"
      class="title-menu-trigger project-menu-trigger"
      :class="{ active: activeTitleMenu === 'project' }"
      :disabled="store.isLoading || store.projects.length === 0"
      title="Switch project"
      aria-label="Switch project"
      :aria-expanded="activeTitleMenu === 'project'"
      @click="toggleTitleMenu('project')"
    >
      <font-awesome-icon :icon="['fas', 'chevron-down']" fixed-width />
    </button>

    <div v-if="activeTitleMenu === 'project'" class="title-dropdown project-dropdown">
      <ProjectMenuList
        :projects="store.projects"
        :selected-project-id="store.currentProjectId"
        :color-for-category="colorForCategory"
        @select="selectProject"
      />
      <div class="title-dropdown-actions">
        <button type="button" @click="createProject">
          <font-awesome-icon :icon="['fas', 'folder-plus']" fixed-width />
          New project
        </button>
        <button
          type="button"
          class="danger-button"
          :disabled="!store.currentProject"
          @click="archiveProject"
        >
          <font-awesome-icon :icon="['fas', 'trash-can']" fixed-width />
          Delete project
        </button>
      </div>
    </div>

    <div v-if="activeTitleMenu === 'category'" class="category-dropdown">
      <form class="category-form" @submit.prevent="commitCategory">
        <input
          v-model="projectCategoryDraft"
          aria-label="Project category"
          placeholder="Category name"
          autocomplete="off"
        />
        <button type="submit">Save</button>
      </form>
      <CategoryList :categories="knownCategories" @select="selectCategory" />
      <CategoryColorPicker
        :colors="categoryColorOptions"
        :selected-color="currentCategoryColor"
        :enabled="Boolean(projectCategoryDraft.trim())"
        @select="chooseCategoryColor"
      />
    </div>
  </div>
</template>
