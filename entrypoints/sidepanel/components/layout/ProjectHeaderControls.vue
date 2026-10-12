<script setup lang="ts">
/** Owns project rename, project switching, and category editing controls. */
import { nextTick, onBeforeUnmount, onMounted, ref, watch } from 'vue';
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
  markProjectNameDraftEdited,
  finishProjectNameEdit,
  cancelProjectNameEdit,
  beginProjectNameEdit,
  contextLabel,
  currentCategoryStyle,
  activeTitleMenu,
  toggleTitleMenu,
  projectCategoryDraft,
  markCategoryDraftEdited,
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

const controlsRef = ref<HTMLElement | null>(null);
const categoryButtonRef = ref<HTMLButtonElement | null>(null);
const categoryDropdownRef = ref<HTMLElement | null>(null);
const categoryDropdownStyle = ref<Record<string, string>>({
  left: '0px',
  top: '0px',
  visibility: 'hidden',
});

function positionCategoryDropdown() {
  const button = categoryButtonRef.value;
  const controls = controlsRef.value;
  const dropdown = categoryDropdownRef.value;
  if (!button || !controls || !dropdown) return;

  const buttonRect = button.getBoundingClientRect();
  const controlsRect = controls.getBoundingClientRect();
  const width = dropdown.offsetWidth;
  const height = dropdown.offsetHeight;
  const padding = 8;
  const desiredLeft = controlsRect.right - 28 - width;
  const left = Math.max(padding, Math.min(desiredLeft, window.innerWidth - width - padding));
  const desiredTop = buttonRect.bottom + 5;
  const top = Math.max(padding, Math.min(desiredTop, window.innerHeight - height - padding));

  categoryDropdownStyle.value = {
    left: `${left}px`,
    top: `${top}px`,
    visibility: 'visible',
  };
}

function updateCategoryDropdownPosition() {
  if (activeTitleMenu.value === 'category') positionCategoryDropdown();
}

watch(activeTitleMenu, (menu) => {
  if (menu !== 'category') {
    categoryDropdownStyle.value.visibility = 'hidden';
    return;
  }

  categoryDropdownStyle.value.visibility = 'hidden';
  void nextTick(positionCategoryDropdown);
});

function handleOutsidePointerDown(event: PointerEvent) {
  const target = event.target as Node;
  if (controlsRef.value?.contains(target) || categoryDropdownRef.value?.contains(target)) return;

  if (activeTitleMenu.value === 'category') {
    void commitCategory();
  } else if (activeTitleMenu.value === 'project') {
    toggleTitleMenu('project');
  }
}

onMounted(() => {
  document.addEventListener('pointerdown', handleOutsidePointerDown);
  document.addEventListener('scroll', updateCategoryDropdownPosition, true);
  window.addEventListener('resize', updateCategoryDropdownPosition);
});
onBeforeUnmount(() => {
  document.removeEventListener('pointerdown', handleOutsidePointerDown);
  document.removeEventListener('scroll', updateCategoryDropdownPosition, true);
  window.removeEventListener('resize', updateCategoryDropdownPosition);
});
</script>

<template>
  <div ref="controlsRef" class="project-header-control">
    <input
      v-if="isProjectNameEditing"
      ref="projectNameInputRef"
      v-model="projectNameDraft"
      class="project-name-input inline-title-input"
      aria-label="Project name"
      :disabled="store.isLoading || !store.currentProject"
      @input="markProjectNameDraftEdited"
      @blur="finishProjectNameEdit"
      @keydown.enter.prevent="finishProjectNameEdit"
      @keydown.escape.prevent.stop="cancelProjectNameEdit"
    />
    <button
      v-else
      type="button"
      class="project-name-display"
      :disabled="store.isLoading || !store.currentProject"
      title="Click to rename project"
      @click="beginProjectNameEdit"
    >
      {{ store.currentProject ? (projectNameDraft || contextLabel) : contextLabel }}
    </button>

    <button
      ref="categoryButtonRef"
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

    <Transition name="popover">
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
    </Transition>

    <Teleport to="body">
      <Transition name="popover">
        <div
          v-if="activeTitleMenu === 'category'"
          ref="categoryDropdownRef"
          class="category-dropdown"
          :style="categoryDropdownStyle"
        >
          <form class="category-form" @submit.prevent="commitCategory">
            <input
              v-model="projectCategoryDraft"
              aria-label="Project category"
              placeholder="Category name"
              autocomplete="off"
              @input="markCategoryDraftEdited"
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
      </Transition>
    </Teleport>
  </div>
</template>
