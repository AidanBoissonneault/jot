import type { Ref } from 'vue';
import type { useInkwellStore } from '@/src/stores/inkwell';

type InkwellStore = ReturnType<typeof useInkwellStore>;

/** Page title, sync warning, and page-switch actions for the editor heading. */
export interface EditorPageTitleContext {
  store: InkwellStore;
  activeTitleMenu: Ref<'project' | 'page' | 'category' | null>;
  pageTitleDraft: Ref<string>;
  renamePage: () => Promise<void>;
  blurTitleInput: (event: Event) => void;
  toggleTitleMenu: (menu: 'project' | 'page' | 'category') => void;
  selectPage: (pageId: string) => Promise<void>;
  createPage: () => Promise<void>;
  archivePage: () => Promise<void>;
}
