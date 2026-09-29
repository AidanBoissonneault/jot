/** @file Owns persisted project category/state drafts and their save operation. */
import { ref, watch, type Ref } from 'vue';
import { visibleProjectStateContent } from '@/src/extensions/sourceRegistry';
import { plainTextFromDocument } from '@/src/lib/documentText';
import type { useInkwellStore } from '@/src/stores/inkwell';

/** Coordinates project-level settings with local page persistence. */
export function useProjectSettings(
  store: ReturnType<typeof useInkwellStore>,
  projectCategoryDraft: Ref<string>,
  flushEditorContent: () => Promise<void>,
) {
  const projectStateDraft = ref('');

  watch(
    () => store.currentProject,
    (project) => {
      projectCategoryDraft.value = project?.category ?? '';
      projectStateDraft.value = plainTextFromDocument(
        visibleProjectStateContent(project?.stateContent),
      );
    },
    { immediate: true },
  );

  /** Saves the category and plain-text project state after flushing page edits. */
  async function saveProjectMetadata(): Promise<void> {
    const project = store.currentProject;

    if (!project) {
      return;
    }

    const stateText = projectStateDraft.value;
    if (
      projectCategoryDraft.value === (project.category ?? '') &&
      stateText === plainTextFromDocument(visibleProjectStateContent(project.stateContent))
    ) {
      return;
    }

    await flushEditorContent();
    await store.updateCurrentProjectMetadata({
      category: projectCategoryDraft.value,
      stateText,
    });
  }

  return { projectStateDraft, saveProjectMetadata };
}
