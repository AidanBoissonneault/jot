/** @file Project category labels and persisted category color choices. */
import { computed, ref, type Ref } from 'vue';
import { useInkwellStore } from '@/src/stores/inkwell';

const CATEGORY_COLORS_KEY = 'inkwellCategoryColors';

export const categoryColorOptions = [
  '#2563eb',
  '#7c3aed',
  '#c026d3',
  '#dc2626',
  '#d97706',
  '#16835f',
  '#0f766e',
  '#4b5563',
] as const;

/** Owns category labels, deterministic colors, and persisted user color choices. */
export function useProjectCategories(
  activeTitleMenu: Ref<'project' | 'page' | 'category' | null>,
  saveProjectMetadata: () => Promise<void>,
) {
  const store = useInkwellStore();
  const projectCategoryDraft = ref('');
  const isProjectCategoryDraftDirty = ref(false);
  const projectCategoryDraftRevision = ref(0);
  const categoryColors = ref<Record<string, string>>({});

  function markCategoryDraftEdited() {
    isProjectCategoryDraftDirty.value = true;
    projectCategoryDraftRevision.value += 1;
  }

  function normalizeCategoryName(value: string) {
    return value.trim().toLocaleLowerCase();
  }

  function colorForCategory(value: string) {
    const key = normalizeCategoryName(value);
    if (!key) return '#6b6f76';
    const savedColor = categoryColors.value[key];
    if (savedColor) return savedColor;

    let hash = 0;
    for (const character of key) {
      hash = ((hash << 5) - hash + character.charCodeAt(0)) | 0;
    }

    return categoryColorOptions[Math.abs(hash) % categoryColorOptions.length];
  }

  const knownCategories = computed(() => {
    const categories = new Map<string, string>();
    for (const project of store.projects) {
      const name = project.category?.trim();
      if (name) categories.set(normalizeCategoryName(name), name);
    }

    return [...categories.values()].map((name) => ({
      name,
      color: colorForCategory(name),
    }));
  });

  const currentCategoryColor = computed(() => colorForCategory(projectCategoryDraft.value));
  const currentCategoryStyle = computed(() => ({
    backgroundColor: currentCategoryColor.value,
    borderColor: currentCategoryColor.value,
  }));

  async function loadCategoryColors() {
    const stored = await browser.storage.local.get(CATEGORY_COLORS_KEY);
    const value = stored[CATEGORY_COLORS_KEY];
    if (value && typeof value === 'object' && !Array.isArray(value)) {
      categoryColors.value = Object.fromEntries(
        Object.entries(value as Record<string, unknown>).filter(
          (entry): entry is [string, string] =>
            typeof entry[1] === 'string' &&
            categoryColorOptions.includes(entry[1] as (typeof categoryColorOptions)[number]),
        ),
      );
    }
  }

  async function chooseCategoryColor(color: (typeof categoryColorOptions)[number]) {
    const key = normalizeCategoryName(projectCategoryDraft.value);
    if (!key) return;
    categoryColors.value = { ...categoryColors.value, [key]: color };
    await browser.storage.local.set({ [CATEGORY_COLORS_KEY]: categoryColors.value });
  }

  async function selectCategory(category: string) {
    projectCategoryDraft.value = category;
    markCategoryDraftEdited();
    activeTitleMenu.value = null;
    await saveProjectMetadata();
  }

  async function commitCategory() {
    projectCategoryDraft.value = projectCategoryDraft.value.trim();
    if (projectCategoryDraft.value !== (store.currentProject?.category ?? '')) {
      markCategoryDraftEdited();
    }
    activeTitleMenu.value = null;
    await saveProjectMetadata();
  }

  return {
    projectCategoryDraft,
    isProjectCategoryDraftDirty,
    projectCategoryDraftRevision,
    markCategoryDraftEdited,
    categoryColorOptions,
    knownCategories,
    currentCategoryColor,
    currentCategoryStyle,
    colorForCategory,
    loadCategoryColors,
    chooseCategoryColor,
    selectCategory,
    commitCategory,
  };
}
