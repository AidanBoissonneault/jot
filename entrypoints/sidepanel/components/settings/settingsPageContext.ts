import type { ComputedRef, Ref } from 'vue';
import type { ThemePreference } from '@/src/services/preferences';
import type { useJottathingStore } from '@/src/stores/jottathing';

type JottathingStore = ReturnType<typeof useJottathingStore>;

/** State and operations supplied by the sidepanel to the settings view. */
export interface SettingsPageContext {
  store: JottathingStore;
  projectStateDraft: Ref<string>;
  isResyncing: Ref<boolean>;
  saveProjectMetadata: () => Promise<void>;
  resync: () => Promise<void>;
  saveLabel: ComputedRef<string>;
  accountLabel: ComputedRef<string>;
  parentPageLabel: ComputedRef<string>;
  LEGAL_TERMS_URL: string;
  LEGAL_PRIVACY_URL: string;
  openLegalUrl: (url: string) => void;
  isDeletingConnection: Ref<boolean>;
  deleteConnection: () => Promise<void>;
  serverUrlDraft: Ref<string>;
  saveServerUrl: () => Promise<void>;
  parentPageSearchDraft: Ref<string>;
  searchParentPages: () => Promise<void>;
  parentPageTitleDraft: Ref<string>;
  createParentPage: () => Promise<void>;
  selectParentPage: (pageId: string) => Promise<void>;
  interfaceScaleLabel: ComputedRef<string>;
  interfaceScale: Ref<number>;
  MIN_INTERFACE_SCALE: number;
  MAX_INTERFACE_SCALE: number;
  INTERFACE_SCALE_STEP: number;
  previewInterfaceScale: (event: Event) => void;
  persistInterfaceScale: () => Promise<void>;
  themePreference: Ref<ThemePreference>;
  setThemePreference: (theme: ThemePreference) => Promise<void>;
}
