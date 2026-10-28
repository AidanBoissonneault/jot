<script setup lang="ts">
/** Shows workspace identity and compact shortcuts to pages with conflicts. */
import { computed, onBeforeUnmount, onMounted, ref, watch } from 'vue';
import type { TopBarContext } from './topBarContext';
import ProjectHeaderControls from './ProjectHeaderControls.vue';

const props = defineProps<{ context: TopBarContext }>();
const context = props.context;
const statusRoot = ref<HTMLElement | null>(null);
const isConflictMenuOpen = ref(false);

type PageConflictLink = {
  key: string;
  pageId: string;
  pageTitle: string;
  projectId: string;
  projectName: string;
};

const pageConflicts = computed(() => {
  const unique = new Map<string, PageConflictLink>();
  for (const project of context.store.projects) {
    if (project.status !== 'active') continue;
    for (const conflict of project.syncConflicts ?? []) {
      if (conflict.targetType !== 'page') continue;
      const key = `${project.id}:${conflict.targetId}`;
      unique.set(key, {
        key,
        pageId: conflict.targetId,
        pageTitle: conflict.targetTitle,
        projectId: project.id,
        projectName: project.name,
      });
    }
  }
  return [...unique.values()];
});

function toggleConflictMenu() {
  isConflictMenuOpen.value = !isConflictMenuOpen.value;
}

function closeConflictMenu() {
  isConflictMenuOpen.value = false;
}

watch(pageConflicts, (conflicts) => {
  if (!conflicts.length) closeConflictMenu();
});

function handleOutsidePointerDown(event: PointerEvent) {
  if (!statusRoot.value?.contains(event.target as Node)) closeConflictMenu();
}

function handleDocumentKeyDown(event: KeyboardEvent) {
  if (event.key === 'Escape' && isConflictMenuOpen.value) {
    closeConflictMenu();
    statusRoot.value?.querySelector<HTMLButtonElement>('.topbar-conflicts-button')?.focus();
  }
}

async function openConflictProject(conflict: PageConflictLink) {
  closeConflictMenu();
  context.activeTab.value = 'editor';
  await context.store.selectProject(conflict.projectId);
}

async function openConflictPage(conflict: PageConflictLink) {
  closeConflictMenu();
  context.activeTab.value = 'editor';
  await context.store.selectProject(conflict.projectId);
  await context.store.selectPage(conflict.pageId);
}

onMounted(() => {
  document.addEventListener('pointerdown', handleOutsidePointerDown);
  document.addEventListener('keydown', handleDocumentKeyDown);
});

onBeforeUnmount(() => {
  document.removeEventListener('pointerdown', handleOutsidePointerDown);
  document.removeEventListener('keydown', handleDocumentKeyDown);
});
</script>

<template>
  <div ref="statusRoot" class="topbar-status">
    <div class="topbar-meta">
      <ProjectHeaderControls :context="context" />
    </div>
    <button
      v-if="pageConflicts.length"
      type="button"
      class="topbar-conflicts-button"
      :aria-expanded="isConflictMenuOpen"
      aria-controls="sync-conflict-menu"
      @click="toggleConflictMenu"
    >
      Conflicts ({{ pageConflicts.length }})
    </button>
    <div
      v-if="isConflictMenuOpen"
      id="sync-conflict-menu"
      class="sync-conflict-menu"
      role="menu"
      aria-label="Pages with merge conflicts"
    >
      <div class="sync-conflict-menu-heading" role="presentation">
        Pages with merge conflicts
      </div>
      <div
        v-for="conflict in pageConflicts"
        :key="conflict.key"
        class="sync-conflict-menu-item"
        role="group"
        :aria-label="`${conflict.projectName}: ${conflict.pageTitle}`"
      >
        <div class="sync-conflict-menu-page">{{ conflict.pageTitle }}</div>
        <div class="sync-conflict-menu-project">{{ conflict.projectName }}</div>
        <div class="sync-conflict-menu-actions">
          <button type="button" role="menuitem" @click="openConflictProject(conflict)">
            Open project
          </button>
          <button type="button" role="menuitem" @click="openConflictPage(conflict)">
            Open page
          </button>
        </div>
      </div>
    </div>
  </div>
</template>
