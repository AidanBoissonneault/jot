<!--
  Created: September 12, 2026
  Author: Aidan
  Description: Displays sync status, workspace switching, and the side panel's global actions.
-->
<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, onMounted, ref } from 'vue';
import { useInkwellStore } from '@/src/stores/inkwell';
import type { ProjectCategoryColor } from '@/src/types/capture';

defineProps<{
  accountLabel: string;
  canUseEditor: boolean;
  settingsOpen: boolean;
  workspaceLabel: string;
}>();

const projectCategory = defineModel<string>('projectCategory', { required: true });
const projectName = defineModel<string>('projectName', { required: true });

const emit = defineEmits<{
  archiveProject: [];
  createPage: [];
  createQuickProject: [];
  logout: [];
  openSettings: [];
  resync: [];
  renameProject: [];
  saveProjectMetadata: [];
  selectProject: [projectId: string];
}>();

const store = useInkwellStore();
const projectSwitcher = ref<HTMLDetailsElement | null>(null);
const projectCategoryInput = ref<HTMLInputElement | null>(null);
const projectNameInput = ref<HTMLInputElement | null>(null);
const categoryMenu = ref<HTMLElement | null>(null);
const categoryMenuOpen = ref(false);
const editingProjectField = ref<'name' | null>(null);

const categoryColors: Array<{ name: string; value: ProjectCategoryColor }> = [
  { name: 'Default', value: 'default' },
  { name: 'Gray', value: 'gray' },
  { name: 'Brown', value: 'brown' },
  { name: 'Orange', value: 'orange' },
  { name: 'Yellow', value: 'yellow' },
  { name: 'Green', value: 'green' },
  { name: 'Blue', value: 'blue' },
  { name: 'Purple', value: 'purple' },
  { name: 'Pink', value: 'pink' },
  { name: 'Red', value: 'red' },
];

const colorStyles: Record<ProjectCategoryColor, { backgroundColor: string; color: string }> = {
  default: { backgroundColor: '#ececef', color: '#52525b' },
  gray: { backgroundColor: '#e4e4e7', color: '#52525b' },
  brown: { backgroundColor: '#f1e3d3', color: '#7c4a20' },
  orange: { backgroundColor: '#ffedd5', color: '#9a3412' },
  yellow: { backgroundColor: '#fef9c3', color: '#854d0e' },
  green: { backgroundColor: '#dcfce7', color: '#166534' },
  blue: { backgroundColor: '#dbeafe', color: '#1e40af' },
  purple: { backgroundColor: '#f3e8ff', color: '#6b21a8' },
  pink: { backgroundColor: '#fce7f3', color: '#9d174d' },
  red: { backgroundColor: '#fee2e2', color: '#991b1b' },
};

const currentCategoryPreference = computed(() => categoryPreference(projectCategory.value));
const pinnedCategories = computed(() =>
  store.categoryPreferences.filter((preference) => preference.pinned),
);

function categoryPreference(name: string | undefined) {
  const key = name?.trim().toLocaleLowerCase();
  return store.categoryPreferences.find(
    (preference) => preference.name.toLocaleLowerCase() === key,
  );
}

function categoryStyle(name: string | undefined) {
  if (!name?.trim()) return {};
  return colorStyles[categoryPreference(name)?.color ?? 'default'];
}

async function openNameEditor() {
  if (store.isLoading || !store.currentProject) {
    return;
  }

  if (projectSwitcher.value) projectSwitcher.value.open = false;
  categoryMenuOpen.value = false;
  editingProjectField.value = 'name';
  await nextTick();
  projectNameInput.value?.focus();
  projectNameInput.value?.select();
}

async function toggleCategoryMenu() {
  if (store.isLoading || !store.currentProject) {
    return;
  }

  if (projectSwitcher.value) projectSwitcher.value.open = false;
  editingProjectField.value = null;
  categoryMenuOpen.value = !categoryMenuOpen.value;
  if (!categoryMenuOpen.value) return;
  await nextTick();
  projectCategoryInput.value?.focus();
}

function saveNameEditor() {
  if (editingProjectField.value !== 'name') return;
  editingProjectField.value = null;
  if (projectSwitcher.value) projectSwitcher.value.open = false;
  emit('renameProject');
}

function saveCategoryEditor() {
  categoryMenuOpen.value = false;
  if (projectSwitcher.value) projectSwitcher.value.open = false;
  emit('saveProjectMetadata');
}

function cancelNameEditor() {
  projectName.value = store.currentProject?.name ?? '';
  editingProjectField.value = null;
}

function cancelCategoryEditor() {
  projectCategory.value = store.currentProject?.category ?? '';
  categoryMenuOpen.value = false;
}

function choosePinnedCategory(name: string) {
  projectCategory.value = name;
  saveCategoryEditor();
}

function setCategoryColor(color: ProjectCategoryColor) {
  const name = projectCategory.value.trim();
  if (name) void store.updateCategoryPreference(name, { color });
}

function togglePinnedCategory() {
  const name = projectCategory.value.trim();
  if (name) void store.updateCategoryPreference(name, {
    pinned: !currentCategoryPreference.value?.pinned,
  });
}

function handleDocumentPointerDown(event: PointerEvent) {
  const target = event.target as Node;
  if (categoryMenuOpen.value && !categoryMenu.value?.contains(target)) {
    saveCategoryEditor();
  }
}

function handleDocumentKeydown(event: KeyboardEvent) {
  if (event.key === 'Escape' && categoryMenuOpen.value) cancelCategoryEditor();
}

onMounted(() => {
  document.addEventListener('pointerdown', handleDocumentPointerDown);
  document.addEventListener('keydown', handleDocumentKeydown);
});

onBeforeUnmount(() => {
  document.removeEventListener('pointerdown', handleDocumentPointerDown);
  document.removeEventListener('keydown', handleDocumentKeydown);
});

function closeSwitcher(event: Event) {
  (event.currentTarget as HTMLElement).closest('details')?.removeAttribute('open');
}
</script>

<template>
  <header class="topbar">
    <div class="topbar-status">
      <div v-if="canUseEditor" class="context-switcher">
        <details
          ref="projectSwitcher"
          class="context-switcher-dropdown"
          name="workspace-switcher"
        >
          <summary title="Switch project">
            <strong class="project-name-inline">
              <input
                v-if="editingProjectField === 'name'"
                ref="projectNameInput"
                v-model="projectName"
                class="header-inline-editor project-name-editor"
                aria-label="Project name"
                :disabled="store.isLoading || !store.currentProject"
                @click.prevent.stop
                @blur="saveNameEditor"
                @keydown.enter.prevent="saveNameEditor"
                @keydown.escape.prevent="cancelNameEditor"
              >
              <span
                v-else
                class="header-text-button"
                title="Rename project"
                @dblclick.prevent.stop="openNameEditor"
              >
                {{ store.currentProject?.name || 'No project' }}
              </span>
            </strong>
            <span
              class="project-category-inline"
              :class="{ empty: !projectCategory.trim() }"
              :style="categoryStyle(projectCategory)"
            >
              <span
                class="header-text-button"
                :title="projectCategory.trim() ? 'Edit project category' : 'Add project category'"
                @pointerdown.stop
                @click.prevent.stop="toggleCategoryMenu"
              >
                {{ projectCategory.trim() || 'Add category' }}
              </span>
            </span>
            <span
              v-if="!store.syncConfig.connected"
              class="local-mode-label"
              title="This workspace is saved on this device"
            >Local</span>
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
            <small
              v-if="project.category"
              class="project-list-category"
              :style="categoryStyle(project.category)"
            >{{ project.category }}</small>
          </button>
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
        <div
          v-if="categoryMenuOpen"
          ref="categoryMenu"
          class="switcher-popover category-editor-popover"
          @pointerdown.stop
          @click.stop
        >
          <form class="category-name-form" @submit.prevent="saveCategoryEditor">
            <input
              ref="projectCategoryInput"
              v-model="projectCategory"
              class="category-name-input"
              aria-label="Project category"
              placeholder="Add category"
            >
            <button type="submit" class="category-save-button">Save</button>
          </form>
          <div class="category-section-label">Color</div>
          <div class="category-color-grid" role="radiogroup" aria-label="Category color">
            <button
              v-for="color in categoryColors"
              :key="color.value"
              type="button"
              class="category-color-button"
              :class="{ active: currentCategoryPreference?.color === color.value || (!currentCategoryPreference && color.value === 'default') }"
              :title="color.name"
              :aria-label="color.name"
              :aria-checked="currentCategoryPreference?.color === color.value || (!currentCategoryPreference && color.value === 'default')"
              role="radio"
              @click="setCategoryColor(color.value)"
            >
              <span class="category-color-swatch" :style="colorStyles[color.value]" />
            </button>
          </div>
          <div class="category-section-heading">
            <div class="category-section-label">Pinned categories</div>
            <button
              type="button"
              class="category-pin-toggle"
              :class="{ active: currentCategoryPreference?.pinned }"
              :disabled="!projectCategory.trim()"
              :title="currentCategoryPreference?.pinned ? 'Unpin category' : 'Pin category'"
              :aria-label="currentCategoryPreference?.pinned ? 'Unpin category' : 'Pin category'"
              :aria-pressed="Boolean(currentCategoryPreference?.pinned)"
              @click="togglePinnedCategory"
            >
              <font-awesome-icon :icon="['fas', 'thumbtack']" fixed-width />
            </button>
          </div>
          <template v-if="pinnedCategories.length">
            <div class="pinned-category-list">
              <button
                v-for="category in pinnedCategories"
                :key="category.name"
                type="button"
                class="pinned-category-button"
                @click="choosePinnedCategory(category.name)"
              >
                <span class="category-color-swatch" :style="colorStyles[category.color]" />
                <span>{{ category.name }}</span>
              </button>
            </div>
          </template>
        </div>
      </div>
      <div v-else class="topbar-meta">
        <strong>Inkwell</strong>
        <small v-if="store.syncConfig.connected">{{ accountLabel }} / {{ workspaceLabel }}</small>
        <small v-else>Your local workspace</small>
      </div>
    </div>

    <div class="topbar-actions">
      <div class="topbar-main-actions">
        <button
          v-if="store.syncConfig.connected"
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
