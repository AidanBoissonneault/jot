/** @file Typed contract between the sidepanel coordinator and its top bar. */
import type { CSSProperties, ComputedRef, Ref } from 'vue';
import type { useInkwellStore } from '@/src/stores/inkwell';

type InkwellStore = ReturnType<typeof useInkwellStore>;
export type CategoryColor =
  | '#2563eb'
  | '#7c3aed'
  | '#c026d3'
  | '#dc2626'
  | '#d97706'
  | '#16835f'
  | '#0f766e'
  | '#4b5563';

/** State and commands the top bar needs from the sidepanel coordinator. */
export interface TopBarContext {
  store: InkwellStore;
  syncBadgeClass: ComputedRef<Record<string, boolean>>;
  syncBadgeHoverTitle: ComputedRef<string>;
  saveLabel: ComputedRef<string>;
  isProjectNameEditing: Ref<boolean>;
  projectNameInputRef: Ref<HTMLInputElement | null>;
  projectNameDraft: Ref<string>;
  markProjectNameDraftEdited: () => void;
  finishProjectNameEdit: () => Promise<void>;
  cancelProjectNameEdit: () => void;
  beginProjectNameEdit: () => Promise<void>;
  contextLabel: ComputedRef<string>;
  currentCategoryStyle: ComputedRef<CSSProperties>;
  activeTitleMenu: Ref<'project' | 'page' | 'category' | null>;
  toggleTitleMenu: (menu: 'project' | 'page' | 'category') => void;
  projectCategoryDraft: Ref<string>;
  markCategoryDraftEdited: () => void;
  commitCategory: () => Promise<void>;
  knownCategories: ComputedRef<Array<{ name: string; color: string }>>;
  selectCategory: (category: string) => Promise<void>;
  categoryColorOptions: readonly CategoryColor[];
  currentCategoryColor: ComputedRef<string>;
  chooseCategoryColor: (color: CategoryColor) => Promise<void>;
  colorForCategory: (category: string) => string;
  accountLabel: ComputedRef<string>;
  workspaceLabel: ComputedRef<string>;
  canUseEditor: ComputedRef<boolean>;
  isResyncing: Ref<boolean>;
  activeTab: Ref<'editor' | 'settings'>;
  createProject: () => Promise<void>;
  createPage: () => Promise<void>;
  resync: () => Promise<void>;
  logout: () => Promise<void>;
  selectProject: (projectId: string) => Promise<void>;
  archiveProject: () => Promise<void>;
}
