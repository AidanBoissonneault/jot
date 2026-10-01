<script setup lang="ts">
/** Shows synchronization status and account/workspace identity. */
import { computed, nextTick, onBeforeUnmount, onMounted, ref, watch } from 'vue';
import type { TopBarContext } from './topBarContext';
import ProjectHeaderControls from './ProjectHeaderControls.vue';

const props = defineProps<{ context: TopBarContext }>();
const context = props.context;
const { syncBadgeClass, syncBadgeHoverTitle, saveLabel, accountLabel, workspaceLabel } = context;
const statusRoot = ref<HTMLElement | null>(null);
const conflictMenu = ref<HTMLElement | null>(null);
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
const statusTitle = computed(() => pageConflicts.value.length
  ? `${syncBadgeHoverTitle.value} · Right-click for conflict shortcuts.`
  : syncBadgeHoverTitle.value);

async function openConflictMenu(event: MouseEvent | KeyboardEvent) {
  if (!pageConflicts.value.length) return;
  event.preventDefault();
  isConflictMenuOpen.value = true;
  await nextTick();
  conflictMenu.value?.querySelector<HTMLButtonElement>('button')?.focus();
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
    statusRoot.value?.querySelector<HTMLElement>('.sync-badge')?.focus();
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
    <div
      :class="syncBadgeClass"
      :title="statusTitle"
      role="status"
      tabindex="0"
      :aria-haspopup="pageConflicts.length ? 'menu' : undefined"
      :aria-expanded="pageConflicts.length ? isConflictMenuOpen : undefined"
      :aria-controls="pageConflicts.length ? 'sync-conflict-menu' : undefined"
      :aria-label="statusTitle"
      @contextmenu="openConflictMenu"
      @keydown.enter.space="openConflictMenu"
    >
      <span class="sync-dot" aria-hidden="true" />
      <span class="sync-label">{{ saveLabel }}</span>
    </div>
    <div
      v-if="isConflictMenuOpen"
      id="sync-conflict-menu"
      ref="conflictMenu"
      class="sync-conflict-menu"
      role="menu"
      aria-label="Pages with merge conflicts"
      @contextmenu.stop.prevent
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
          <button
            type="button"
            role="menuitem"
            @click="openConflictProject(conflict)"
          >
            Open project
          </button>
          <button
            type="button"
            role="menuitem"
            @click="openConflictPage(conflict)"
          >
            Open page
          </button>
        </div>
      </div>
    </div>
    <div class="topbar-meta">
      <ProjectHeaderControls :context="context" />
      <small>{{ accountLabel }} / {{ workspaceLabel }}</small>
    </div>
  </div>
</template>
