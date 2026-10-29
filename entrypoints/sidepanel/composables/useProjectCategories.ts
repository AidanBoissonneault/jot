/** @file Project category labels and persisted category color choices. */
import { computed, ref, watch, type Ref } from 'vue';
import { useJottathingStore } from '@/src/stores/jottathing';

const CATEGORY_COLORS_KEY = 'jottathingCategoryColors';

export const categoryColorOptions = [
  '#405a78',
  '#5a4d78',
  '#824e5d',
  '#806039',
  '#3f6549',
  '#3c6668',
  '#525b65',
  '#315c76',
] as const;

/** Owns category labels, deterministic colors, and persisted user color choices. */
export function useProjectCategories(
  activeTitleMenu: Ref<'project' | 'page' | 'category' | null>,
  saveProjectMetadata: () => Promise<void>,
) {
  const store = useJottathingStore();
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
    if (!key) return categoryColorOptions[0];
    const savedColor = categoryColors.value[key];
    if (savedColor) return savedColor;

    let hash = 0;
    for (const character of key) {
      hash = ((hash << 5) - hash + character.charCodeAt(0)) | 0;
    }

    return categoryColorOptions[Math.abs(hash) % categoryColorOptions.length];
  }

  const draftCategoryColor = ref(colorForCategory(projectCategoryDraft.value));
  watch(activeTitleMenu, (menu) => {
    if (menu === 'category') {
      draftCategoryColor.value = colorForCategory(projectCategoryDraft.value);
    }
  });
  watch(projectCategoryDraft, (category) => {
    if (activeTitleMenu.value !== 'category') {
      draftCategoryColor.value = colorForCategory(category);
    }
  });
  const currentCategoryColor = computed(() => draftCategoryColor.value);

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

  const currentCategoryStyle = computed(() => ({
    backgroundColor: currentCategoryColor.value,
    borderColor: currentCategoryColor.value,
  }));

  async function loadCategoryColors() {
    const stored = await browser.storage.local.get(CATEGORY_COLORS_KEY);
    const value = stored[CATEGORY_COLORS_KEY];
    if (value && typeof value === 'object' && !Array.isArray(value)) {
      categoryColors.value = Object.fromEntries(
        Object.entries(value as Record<string, unknown>).flatMap(([key, color]) => {
          if (typeof color !== 'string') return [];
          return categoryColorOptions.includes(color as (typeof categoryColorOptions)[number])
            ? [[key, color] as [string, string]]
            : [];
        }),
      );
      if (activeTitleMenu.value !== 'category') {
        draftCategoryColor.value = colorForCategory(projectCategoryDraft.value);
      }
    }
  }

  async function chooseCategoryColor(color: (typeof categoryColorOptions)[number]) {
    draftCategoryColor.value = color;
    const key = normalizeCategoryName(projectCategoryDraft.value);
    if (!key) return;
    categoryColors.value = { ...categoryColors.value, [key]: color };
    await browser.storage.local.set({ [CATEGORY_COLORS_KEY]: categoryColors.value });
  }

  async function selectCategory(category: string) {
    draftCategoryColor.value = colorForCategory(category);
    projectCategoryDraft.value = category;
    markCategoryDraftEdited();
    activeTitleMenu.value = null;
    await saveProjectMetadata();
  }

  async function commitCategory() {
    projectCategoryDraft.value = projectCategoryDraft.value.trim();
    const key = normalizeCategoryName(projectCategoryDraft.value);
    if (key) {
      categoryColors.value = { ...categoryColors.value, [key]: draftCategoryColor.value };
      await browser.storage.local.set({ [CATEGORY_COLORS_KEY]: categoryColors.value });
    }
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
