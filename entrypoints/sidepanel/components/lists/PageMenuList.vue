<script setup lang="ts">
/** @file Displays selectable pages and compact page actions in the title switcher. */
import type { ProjectPage } from '@/src/types/capture';

defineProps<{
  pages: ProjectPage[];
  selectedPageId: string | undefined;
  workspaceKind: 'local' | 'notion';
  authenticated: boolean;
}>();

const emit = defineEmits<{
  select: [pageId: string];
  archive: [pageId: string];
  create: [];
}>();
</script>

<template>
  <div class="workspace-tree-pages page-menu-list">
    <div
      v-for="page in pages"
      :key="page.id"
      class="workspace-tree-row workspace-tree-page-row"
    >
      <button
        type="button"
        class="workspace-tree-select workspace-tree-page"
        :class="{ active: page.id === selectedPageId }"
        :aria-label="page.title"
        @click="emit('select', page.id)"
      >
        <font-awesome-icon :icon="['fas', 'file-lines']" fixed-width class="workspace-tree-icon" />
        <span class="workspace-tree-name">{{ page.title }}</span>
        <span
          v-if="authenticated"
          class="page-list-sync-dot"
          :class="[workspaceKind, page.syncState, { authenticated }]"
          :title="page.syncMessage || (workspaceKind === 'notion' ? 'Page synced with Notion' : 'Local only')"
          aria-hidden="true"
        />
      </button>
      <div class="workspace-tree-actions">
        <button
          type="button"
          class="workspace-tree-action workspace-tree-delete-action"
          :title="`Delete ${page.title}`"
          :aria-label="`Delete ${page.title}`"
          @click.stop="emit('archive', page.id)"
        >
          <font-awesome-icon :icon="['fas', 'trash-can']" fixed-width />
        </button>
      </div>
    </div>
    <button type="button" class="workspace-tree-create-page" @click="emit('create')">
      <font-awesome-icon :icon="['fas', 'file-circle-plus']" fixed-width />
      New page
    </button>
  </div>
</template>
