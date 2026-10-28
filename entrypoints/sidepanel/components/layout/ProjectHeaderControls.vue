<script setup lang="ts">
/** Owns project rename, project switching, and category editing controls. */
import { nextTick, onBeforeUnmount, onMounted, ref, watch } from 'vue';
import type { TopBarContext } from './topBarContext';
import WorkspaceMenuList from '../lists/WorkspaceMenuList.vue';
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
  flushEditorContent,
  createProject,
  createPage,
  selectProject,
  selectPage: selectPageAction,
  createWorkspace: createWorkspaceAction,
  selectWorkspace: selectWorkspaceAction,
  requestLogout,
  syncConflicts,
  openProjectSyncConflict,
} = props.context;

const controlsRef = ref<HTMLElement | null>(null);
const categoryButtonRef = ref<HTMLButtonElement | null>(null);
const categoryDropdownRef = ref<HTMLElement | null>(null);
const categoryDropdownStyle = ref<Record<string, string>>({
  left: '0px',
  top: '0px',
  visibility: 'hidden',
});

async function createWorkspace() {
  const name = window.prompt('Workspace name', 'New workspace');
  if (name === null) return;
  await createWorkspaceAction(name);
  toggleTitleMenu('project');
}

async function moveProjectToWorkspace(projectId: string, workspaceId: string) {
  if (projectId === store.currentProjectId) await flushEditorContent();
  await store.moveProjectToWorkspace(projectId, workspaceId);
  toggleTitleMenu('project');
}

async function movePageToProject(
  pageId: string,
  projectId: string,
  targetPageId?: string,
  position: 'before' | 'after' = 'after',
) {
  if (store.currentPage?.id === pageId) await flushEditorContent();
  await store.movePageToProject(pageId, projectId, targetPageId, position);
}

async function selectProjectFromTree(workspaceId: string, projectId: string) {
  if (workspaceId !== store.currentWorkspaceId) await selectWorkspaceAction(workspaceId);
  if (projectId !== store.currentProjectId) await selectProject(projectId);
  if (activeTitleMenu.value === 'project') toggleTitleMenu('project');
}

async function selectPageFromTree(workspaceId: string, projectId: string, pageId: string) {
  if (workspaceId !== store.currentWorkspaceId) await selectWorkspaceAction(workspaceId);
  if (projectId !== store.currentProjectId) await selectProject(projectId);
  if (pageId !== store.currentPage?.id) await selectPageAction(pageId);
  if (activeTitleMenu.value === 'project') toggleTitleMenu('project');
}

async function openConflictProject(workspaceId: string, projectId: string) {
  if (workspaceId !== store.currentWorkspaceId) await selectWorkspaceAction(workspaceId);
  if (projectId !== store.currentProjectId) await selectProject(projectId);
}

async function openConflictPage(workspaceId: string, projectId: string, pageId: string) {
  await openConflictProject(workspaceId, projectId);
  if (pageId !== store.currentPage?.id) await selectPageAction(pageId);
}

function loadWorkspacePages(projectId: string) {
  void store.loadWorkspaceMenuPages(projectId);
}

async function createProjectInWorkspace(workspaceId: string) {
  await createProject(workspaceId);
}

async function renameWorkspace(workspaceId: string, name: string) {
  try {
    await store.renameLocalWorkspace(workspaceId, name);
  } catch {
    // The store exposes the save error in the shared status area.
  }
}

async function createPageInProject(workspaceId: string, projectId: string) {
  if (workspaceId !== store.currentWorkspaceId) await selectWorkspaceAction(workspaceId);
  if (projectId !== store.currentProjectId) await selectProject(projectId);
  await createPage();
}

async function deleteWorkspace(workspaceId: string) {
  const workspace = store.workspaces.find((entry) => entry.id === workspaceId);
  if (!workspace || workspace.kind !== 'local') return;
  if (!window.confirm(`Delete "${workspace.name}" and all of its projects and pages? This cannot be undone.`)) return;
  await flushEditorContent();
  await store.deleteLocalWorkspace(workspaceId);
}

async function deleteProject(projectId: string) {
  const project = store.workspaceMenuProjects.find((entry) => entry.id === projectId);
  if (!project) return;
  if (!window.confirm(`Delete "${project.name}"? It will be archived in its workspace.`)) return;
  if (project.id === store.currentProjectId) await flushEditorContent();
  await store.archiveProjectById(projectId);
}

async function deletePage(pageId: string) {
  const page = Object.values(store.workspaceMenuPagesByProject).flat().find((entry) => entry.id === pageId);
  if (!page) return;
  if (!window.confirm(`Delete "${page.title}"?`)) return;
  if (store.currentPage?.id === pageId) await flushEditorContent();
  await store.archivePageById(pageId);
}

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
  if (menu === 'project') void store.refreshWorkspaceMenuTree();
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
  <div
    ref="controlsRef"
    class="project-header-control"
    :class="{ 'has-sync-dot': Boolean(store.currentProject && store.syncConfig.authenticated) }"
  >
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
      :class="{ empty: !projectCategoryDraft.trim() }"
      :style="projectCategoryDraft.trim() ? currentCategoryStyle : undefined"
      :disabled="store.isLoading || !store.currentProject"
      :title="projectCategoryDraft.trim() ? 'Edit project category' : 'Add project category'"
      :aria-label="projectCategoryDraft.trim() ? 'Edit project category' : 'Add project category'"
      :aria-expanded="activeTitleMenu === 'category'"
      @click="toggleTitleMenu('category')"
    >
      {{ projectCategoryDraft.trim() || '+ Category' }}
    </button>

    <span
      v-if="store.currentProject && store.syncConfig.authenticated"
      class="project-title-sync-dot"
      role="img"
      :class="[
        store.currentWorkspace?.kind,
        store.currentProject.syncState,
        { authenticated: true },
      ]"
      :title="store.currentProject.syncMessage || (store.currentWorkspace?.kind === 'notion' ? 'Project synced with Notion' : 'Local only')"
      :aria-label="store.currentProject.syncMessage || (store.currentWorkspace?.kind === 'notion' ? 'Project synced with Notion' : 'Local only')"
    />

    <button
      type="button"
      class="title-menu-trigger project-menu-trigger"
      :class="{ active: activeTitleMenu === 'project' }"
      :disabled="store.isLoading || store.workspaces.length === 0"
      title="Switch workspace or project"
      aria-label="Switch workspace or project"
      :aria-expanded="activeTitleMenu === 'project'"
      @click="toggleTitleMenu('project')"
    >
      <font-awesome-icon :icon="['fas', 'chevron-down']" fixed-width />
    </button>

    <Transition name="popover">
      <div v-if="activeTitleMenu === 'project'" class="title-dropdown project-dropdown">
        <div class="workspace-dropdown-section">
          <WorkspaceMenuList
            :workspaces="store.workspaces"
            :projects="store.workspaceMenuProjects"
            :pages-by-project="store.workspaceMenuPagesByProject"
            :loading-project-ids="store.workspaceMenuPageLoads"
            :color-for-category="colorForCategory"
            :selected-workspace-id="store.currentWorkspaceId"
            :selected-project-id="store.currentProjectId"
            :selected-page-id="store.currentPage?.id"
            :authenticated="Boolean(store.syncConfig.authenticated)"
            :project-sync-conflicts="syncConflicts"
            @select-project="selectProjectFromTree"
            @select-page="selectPageFromTree"
            @load-pages="loadWorkspacePages"
            @create-workspace="createWorkspace"
            @rename-workspace="renameWorkspace"
            @create-project="createProjectInWorkspace"
            @create-page="createPageInProject"
            @delete-workspace="deleteWorkspace"
            @delete-project="deleteProject"
            @delete-page="deletePage"
            @logout="requestLogout"
            @review-project-conflict="openProjectSyncConflict"
            @open-conflict-project="openConflictProject"
            @open-conflict-page="openConflictPage"
            @move-project="moveProjectToWorkspace"
            @move-page="movePageToProject"
          />
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
