/** @file Typed contract between the sidepanel coordinator and its top bar. */
import type { CSSProperties, ComputedRef, Ref } from 'vue';
import type { useJottathingStore } from '@/src/stores/jottathing';
import type { SyncContentConflict, SyncProgressUpdate } from '@/src/types/sync';

type JottathingStore = ReturnType<typeof useJottathingStore>;
export type CategoryColor =
  | '#315c76'
  | '#5a4d78'
  | '#824e5d'
  | '#806039'
  | '#3f6549'
  | '#3c6668'
  | '#525b65'
  | '#405a78';

/** State and commands the top bar needs from the sidepanel coordinator. */
export interface TopBarContext {
  store: JottathingStore;
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
  flushEditorContent: () => Promise<void>;
  canUseEditor: ComputedRef<boolean>;
  canOpenNotionConnectModal: ComputedRef<boolean>;
  isSigningIn: Ref<boolean>;
  isResyncing: Ref<boolean>;
  resyncProgress: Ref<SyncProgressUpdate | null>;
  syncConflicts: Ref<SyncContentConflict[]>;
  openProjectSyncConflict: (conflict: SyncContentConflict) => void;
  activeTab: Ref<'editor' | 'settings'>;
  createProject: (workspaceId?: string) => Promise<void>;
  createPage: () => Promise<void>;
  createWorkspace: (name: string) => Promise<void>;
  selectWorkspace: (workspaceId: string) => Promise<void>;
  resync: () => Promise<void>;
  openNotionConnectModal: () => void;
  requestLogout: () => void;
  selectProject: (projectId: string) => Promise<void>;
  selectPage: (pageId: string) => Promise<void>;
  archiveProject: () => Promise<void>;
}
