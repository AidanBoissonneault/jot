import { computed, ref } from 'vue';
import { defineStore } from 'pinia';
import { notionClient } from '@/src/services/notionClient';
import type { Capture, CaptureType, Project } from '@/src/types/capture';

export const captureLabels: Record<CaptureType, string> = {
  quote: 'Notes',
  task: 'Tasks',
  idea: 'Ideas',
  link: 'Links',
};

export const useJotStore = defineStore('jot', () => {
  const projects = ref<Project[]>([]);
  const captures = ref<Capture[]>([]);
  const currentProjectId = ref<string>('');
  const isLoading = ref(false);
  const errorMessage = ref<string>('');

  const currentProject = computed(() =>
    projects.value.find((project) => project.id === currentProjectId.value),
  );

  const recentCaptures = computed(() =>
    [...captures.value].sort(
      (first, second) =>
        new Date(second.createdAt).getTime() - new Date(first.createdAt).getTime(),
    ),
  );

  const capturesByType = computed<Record<CaptureType, Capture[]>>(() => ({
    quote: recentCaptures.value.filter((capture) => capture.type === 'quote'),
    task: recentCaptures.value.filter((capture) => capture.type === 'task'),
    idea: recentCaptures.value.filter((capture) => capture.type === 'idea'),
    link: recentCaptures.value.filter((capture) => capture.type === 'link'),
  }));

  async function initialize() {
    isLoading.value = true;
    errorMessage.value = '';

    try {
      projects.value = await notionClient.listProjects();
      currentProjectId.value = projects.value[0]?.id ?? '';
      await loadCaptures();
    } catch (error) {
      errorMessage.value =
        error instanceof Error ? error.message : 'Unable to load Jot data.';
    } finally {
      isLoading.value = false;
    }
  }

  async function selectProject(projectId: string) {
    currentProjectId.value = projectId;
    await loadCaptures();
  }

  async function loadCaptures() {
    if (!currentProjectId.value) {
      captures.value = [];
      return;
    }

    captures.value = await notionClient.listCaptures(currentProjectId.value);
  }

  async function createQuickNote(content: string) {
    const trimmedContent = content.trim();

    if (!trimmedContent || !currentProjectId.value) {
      return;
    }

    const capture = await notionClient.createCapture({
      projectId: currentProjectId.value,
      type: 'quote',
      content: trimmedContent,
      sourceUrl: 'jot://quick-note',
      pageTitle: 'Quick Note',
    });

    captures.value = [capture, ...captures.value];
  }

  return {
    captures,
    capturesByType,
    currentProject,
    currentProjectId,
    errorMessage,
    initialize,
    isLoading,
    projects,
    recentCaptures,
    selectProject,
    createQuickNote,
  };
});
