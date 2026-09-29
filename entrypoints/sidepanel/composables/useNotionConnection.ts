/** @file Notion legal consent, sign-in polling, and connection controls. */
import { computed, ref, type Ref } from 'vue';
import { hasAcceptedCurrentLegalTerms, storeCurrentLegalAcceptance } from '@/src/services/legal';
import type { useInkwellStore } from '@/src/stores/inkwell';

type InkwellStore = ReturnType<typeof useInkwellStore>;

/** Owns Notion consent state and sign-in/session lifecycle for the sidepanel. */
export function useNotionConnection(
  store: InkwellStore,
  activeTab: Ref<'editor' | 'settings'>,
  uiMessage: Ref<string>,
) {
  const hasAcceptedLegalTerms = ref(false);
  const isLegalAcceptanceLoaded = ref(false);
  const isSigningIn = ref(false);
  let sessionPollTimer: number | undefined;

  const canLoginWithNotion = computed(
    () => isLegalAcceptanceLoaded.value && hasAcceptedLegalTerms.value && !isSigningIn.value,
  );

  async function loadLegalAcceptance() {
    hasAcceptedLegalTerms.value = await hasAcceptedCurrentLegalTerms();
    isLegalAcceptanceLoaded.value = true;
  }

  function startSessionPolling() {
    window.clearInterval(sessionPollTimer);
    let attempts = 0;
    sessionPollTimer = window.setInterval(() => {
      attempts += 1;
      void store.refreshSyncSession().then(() => {
        if (store.syncConfig.connected || attempts >= 30) {
          window.clearInterval(sessionPollTimer);
          isSigningIn.value = false;
        }
      });
    }, 2000);
  }

  function stopSessionPolling() {
    window.clearInterval(sessionPollTimer);
    sessionPollTimer = undefined;
  }

  async function loginWithNotion() {
    if (!hasAcceptedLegalTerms.value) {
      uiMessage.value = 'Review and accept the Terms and Privacy Policy before connecting Notion.';
      return;
    }
    await storeCurrentLegalAcceptance();
    isSigningIn.value = true;
    await browser.tabs.create({ active: true, url: store.getSyncLoginUrl() });
    startSessionPolling();
  }

  function openLegalUrl(url: string) {
    void browser.tabs.create({ active: true, url });
  }

  async function logout() {
    stopSessionPolling();
    isSigningIn.value = false;
    await store.logout();
    activeTab.value = 'settings';
  }

  return {
    hasAcceptedLegalTerms,
    isLegalAcceptanceLoaded,
    isSigningIn,
    canLoginWithNotion,
    loadLegalAcceptance,
    startSessionPolling,
    stopSessionPolling,
    loginWithNotion,
    openLegalUrl,
    logout,
  };
}
