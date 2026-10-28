import type { Ref } from 'vue';
import type { useJottathingStore } from '@/src/stores/jottathing';

type JottathingStore = ReturnType<typeof useJottathingStore>;

/** Page title, sync warning, and page-switch actions for the editor heading. */
export interface EditorPageTitleContext {
  store: JottathingStore;
  activeTitleMenu: Ref<'project' | 'page' | 'category' | null>;
  pageTitleDraft: Ref<string>;
  isPageTitleEditing: Ref<boolean>;
  pageTitleInputRef: Ref<HTMLInputElement | null>;
  markPageTitleDraftEdited: () => void;
  beginPageTitleEdit: () => Promise<void>;
  finishPageTitleEdit: () => Promise<void>;
  cancelPageTitleEdit: () => void;
  toggleTitleMenu: (menu: 'project' | 'page' | 'category') => void;
  selectPage: (pageId: string) => Promise<void>;
  createPage: () => Promise<void>;
  archivePage: (pageId?: string) => Promise<void>;
}
