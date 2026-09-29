/** @file Owns persisted project category/state drafts and their save operation. */
import { ref, watch, type Ref } from 'vue';
import { visibleProjectStateContent } from '@/src/extensions/sourceRegistry';
import { plainTextFromDocument } from '@/src/lib/documentText';
import type { useInkwellStore } from '@/src/stores/inkwell';

/** Coordinates project-level settings with local page persistence. */
export function useProjectSettings(
  store: ReturnType<typeof useInkwellStore>,
  projectCategoryDraft: Ref<string>,
  isProjectCategoryDraftDirty: Ref<boolean>,
  projectCategoryDraftRevision: Ref<number>,
  flushEditorContent: () => Promise<void>,
) {
  const projectStateDraft = ref('');
  let categoryProjectId = '';

  watch(
    () => store.currentProject,
    (project) => {
      const nextProjectId = project?.id ?? '';
      const nextCategory = project?.category ?? '';

      if (nextProjectId !== categoryProjectId) {
        projectCategoryDraft.value = nextCategory;
        isProjectCategoryDraftDirty.value = false;
        projectCategoryDraftRevision.value = 0;
      } else if (!isProjectCategoryDraftDirty.value) {
        projectCategoryDraft.value = nextCategory;
      }

      categoryProjectId = nextProjectId;
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
    const category = projectCategoryDraft.value;
    const categoryRevision = projectCategoryDraftRevision.value;
    if (
      category === (project.category ?? '') &&
      stateText === plainTextFromDocument(visibleProjectStateContent(project.stateContent)) &&
      !isProjectCategoryDraftDirty.value
    ) {
      return;
    }

    await flushEditorContent();
    await store.updateCurrentProjectMetadata({
      category,
      stateText,
    });

    if (
      store.currentProject?.id === project.id &&
      store.currentProject.category === category &&
      projectCategoryDraft.value === category &&
      projectCategoryDraftRevision.value === categoryRevision
    ) {
      isProjectCategoryDraftDirty.value = false;
    }
  }

  return { projectStateDraft, saveProjectMetadata };
}
