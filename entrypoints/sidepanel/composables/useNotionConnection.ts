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
  prepareForDeletion?: () => Promise<void>,
  resetAfterDeletion?: () => void,
) {
  const hasAcceptedLegalTerms = ref(false);
  const isLegalAcceptanceLoaded = ref(false);
  const isSigningIn = ref(false);
  const isDeletingConnection = ref(false);
  let sessionPollTimer: number | undefined;

  const canLoginWithNotion = computed(
    () => isLegalAcceptanceLoaded.value && hasAcceptedLegalTerms.value &&
      !isSigningIn.value && !store.syncConfig.logoutCleanupPending,
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
      void store.refreshSyncSession(true).then(() => {
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
    if (store.syncConfig.logoutCleanupPending) {
      uiMessage.value = 'Finish logout cleanup before reconnecting to Notion.';
      return;
    }
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
    if (await store.logout()) activeTab.value = 'settings';
  }

  async function deleteConnection() {
    if (isDeletingConnection.value) return;
    if (!store.syncConfig.authenticated || !store.syncConfig.userId) {
      uiMessage.value = 'Sign in to the Notion account that owns this Inkwell data before deleting cloud data. Your local documents are unchanged.';
      return;
    }
    if (
      store.syncConfig.syncQueueOwnerUserId === null ||
      (store.syncConfig.syncQueueOwnerUserId &&
        store.syncConfig.syncQueueOwnerUserId !== store.syncConfig.userId)
    ) {
      uiMessage.value = 'Reconnect the Notion account that owns this local data before deleting the connection. Your local documents are unchanged.';
      return;
    }
    const confirmed = window.confirm(
      'Delete the Inkwell connection and all Inkwell data? This removes local documents and queued changes in this browser, plus Inkwell account and sync data from the server. Pages already stored in Notion will remain. This cannot be undone.',
    );
    if (!confirmed) return;

    stopSessionPolling();
    isSigningIn.value = false;
    isDeletingConnection.value = true;
    try {
      await prepareForDeletion?.();
      const result = await store.deleteConnection();
      resetAfterDeletion?.();
      activeTab.value = 'settings';
      uiMessage.value = result.notionTokenRevoked
        ? 'Inkwell data and connection deleted. Your Notion pages remain.'
        : 'Inkwell data was deleted, but Notion did not confirm token revocation. Remove the Inkwell connection in Notion settings if it remains listed.';
    } catch {
      uiMessage.value = store.errorMessage || 'Unable to delete the Inkwell connection.';
    } finally {
      isDeletingConnection.value = false;
    }
  }

  return {
    hasAcceptedLegalTerms,
    isLegalAcceptanceLoaded,
    isSigningIn,
    isDeletingConnection,
    canLoginWithNotion,
    loadLegalAcceptance,
    startSessionPolling,
    stopSessionPolling,
    loginWithNotion,
    openLegalUrl,
    logout,
    deleteConnection,
  };
}
