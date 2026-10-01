import type { ComputedRef, Ref } from 'vue';
import type { useInkwellStore } from '@/src/stores/inkwell';

type InkwellStore = ReturnType<typeof useInkwellStore>;

/** State and operations supplied by the sidepanel to the settings view. */
export interface SettingsPageContext {
  store: InkwellStore;
  projectStateDraft: Ref<string>;
  isResyncing: Ref<boolean>;
  saveProjectMetadata: () => Promise<void>;
  resync: () => Promise<void>;
  saveLabel: ComputedRef<string>;
  accountLabel: ComputedRef<string>;
  parentPageLabel: ComputedRef<string>;
  hasAcceptedLegalTerms: Ref<boolean>;
  isLegalAcceptanceLoaded: Ref<boolean>;
  LEGAL_TERMS_URL: string;
  LEGAL_PRIVACY_URL: string;
  openLegalUrl: (url: string) => void;
  canLoginWithNotion: ComputedRef<boolean>;
  isSigningIn: Ref<boolean>;
  isDeletingConnection: Ref<boolean>;
  loginWithNotion: () => Promise<void>;
  logout: () => Promise<void>;
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
  setInterfaceScale: (scale: number) => void;
}
