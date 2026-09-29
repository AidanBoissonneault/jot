<script setup lang="ts">
/** @file Displays selectable pages in the editor title switcher. */
import type { ProjectPage } from '@/src/types/capture';

defineProps<{
  pages: ProjectPage[];
  selectedPageId: string | undefined;
}>();

const emit = defineEmits<{ select: [pageId: string] }>();
</script>

<template>
  <button
    v-for="page in pages"
    :key="page.id"
    type="button"
    class="title-dropdown-item"
    :class="{ active: page.id === selectedPageId }"
    @click="emit('select', page.id)"
  >
    {{ page.title }}
  </button>
</template>
