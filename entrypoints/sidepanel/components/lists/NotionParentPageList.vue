<script setup lang="ts">
/** @file Displays selectable Notion parent pages in sync settings. */
import type { NotionParentPage } from '@/src/types/capture';

defineProps<{
  pages: NotionParentPage[];
  selectedPageId: string | undefined;
  disabled?: boolean;
}>();

const emit = defineEmits<{ select: [pageId: string] }>();
</script>

<template>
  <div class="item-list">
    <button
      v-for="page in pages"
      :key="page.id"
      type="button"
      class="item-row"
      :class="{ active: page.id === selectedPageId }"
      :disabled="disabled"
      @click="emit('select', page.id)"
    >
      <span>{{ page.title }}</span>
      <small>{{ page.parentPageId ? 'Child page' : 'Page' }}</small>
    </button>
  </div>
</template>
