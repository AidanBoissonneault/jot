<script setup lang="ts">
/** @file Displays project choices for the top bar project switcher. */
import type { Project } from '@/src/types/capture';

defineProps<{
  projects: Project[];
  selectedProjectId: string | null;
  colorForCategory: (category: string) => string;
}>();

const emit = defineEmits<{ select: [projectId: string] }>();
</script>

<template>
  <button
    v-for="project in projects"
    :key="project.id"
    type="button"
    class="title-dropdown-item"
    :class="{ active: project.id === selectedProjectId }"
    @click="emit('select', project.id)"
  >
    <span>{{ project.name }}</span>
    <span
      v-if="project.category"
      class="project-list-category"
      :style="{ backgroundColor: colorForCategory(project.category) }"
    >
      {{ project.category }}
    </span>
  </button>
</template>
