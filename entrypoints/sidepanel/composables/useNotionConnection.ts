/** @file Notion legal consent, sign-in polling, and connection controls. */
import { computed, ref, type Ref } from 'vue';
import { hasAcceptedCurrentLegalTerms, storeCurrentLegalAcceptance } from '@/src/services/legal';
import type { useJottathingStore } from '@/src/stores/jottathing';
import type { SyncProgressUpdate } from '@/src/types/sync';

type JottathingStore = ReturnType<typeof useJottathingStore>;

/** Owns Notion consent state and sign-in/session lifecycle for the sidepanel. */
export function useNotionConnection(
  store: JottathingStore,
  activeTab: Ref<'editor' | 'settings'>,
  uiMessage: Ref<string>,
  prepareForConnectionChange?: () => Promise<void>,
  resetAfterDeletion?: () => void,
) {
  const hasAcceptedLegalTerms = ref(false);
  const isLegalAcceptanceLoaded = ref(false);
  const isSigningIn = ref(false);
  const isLoggingOut = ref(false);
  const logoutError = ref('');
  const logoutProgress = ref('');
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
    let completingLogin = false;
    sessionPollTimer = window.setInterval(() => {
      if (completingLogin) return;
      attempts += 1;
      void store.refreshSyncSession(true).then(async () => {
        if (!store.syncConfig.connected && attempts < 30) return;
        completingLogin = true;
        window.clearInterval(sessionPollTimer);
        sessionPollTimer = undefined;
        isSigningIn.value = false;
        if (!store.syncConfig.connected) {
          uiMessage.value = 'Notion login did not finish. Please try again.';
          return;
        }

        try {
          await store.activateNotionWorkspace();
          activeTab.value = 'editor';
        } catch (error) {
          uiMessage.value = error instanceof Error
            ? error.message
            : 'Jottathing connected to Notion, but could not open its workspace.';
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
    try {
      await prepareForConnectionChange?.();
      await storeCurrentLegalAcceptance();
      isSigningIn.value = true;
      await browser.tabs.create({ active: true, url: store.getSyncLoginUrl() });
      startSessionPolling();
    } catch (error) {
      isSigningIn.value = false;
      uiMessage.value = error instanceof Error
        ? error.message
        : 'Could not open Notion login. Please try again.';
    }
  }

  function openLegalUrl(url: string) {
    void browser.tabs.create({ active: true, url });
  }

  async function logout(): Promise<boolean> {
    if (isLoggingOut.value) return false;
    logoutError.value = '';
    logoutProgress.value = '';
    isLoggingOut.value = true;
    stopSessionPolling();
    isSigningIn.value = false;
    try {
      await prepareForConnectionChange?.();
      const didLogout = await store.logout((progress: SyncProgressUpdate) => {
        logoutProgress.value = progress.phase === 'saving_edits'
          ? 'Saving the latest edits…'
          : progress.phase === 'uploading'
            ? progress.pending
              ? `Sending ${progress.pending} queued change${progress.pending === 1 ? '' : 's'} to the sync worker…`
              : 'Sending queued changes to the sync worker…'
            : progress.pending
              ? `Waiting for ${progress.pending} queued change${progress.pending === 1 ? '' : 's'} to finish syncing to Notion…`
              : 'Waiting for the sync worker to finish syncing to Notion…';
      });
      if (didLogout) {
        activeTab.value = 'editor';
        if (store.errorMessage) uiMessage.value = store.errorMessage;
        return true;
      }
      logoutError.value = store.errorMessage || 'Could not sign out. Please try again.';
      return false;
    } catch (error) {
      logoutError.value = error instanceof Error
        ? error.message
        : 'Could not save your current note before signing out.';
      uiMessage.value = logoutError.value;
      return false;
    } finally {
      isLoggingOut.value = false;
      logoutProgress.value = '';
    }
  }

  async function deleteConnection() {
    if (isDeletingConnection.value) return;
    if (!store.syncConfig.authenticated || !store.syncConfig.userId) {
      uiMessage.value = 'Sign in to the Notion account that owns this Jottathing data before deleting cloud data. Your local documents are unchanged.';
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
      'Delete the Jottathing connection and all Jottathing data? This removes local documents and queued changes in this browser, plus Jottathing account and sync data from the server. Pages already stored in Notion will remain. This cannot be undone.',
    );
    if (!confirmed) return;

    stopSessionPolling();
    isSigningIn.value = false;
    isDeletingConnection.value = true;
    try {
      await prepareForConnectionChange?.();
      const result = await store.deleteConnection();
      resetAfterDeletion?.();
      activeTab.value = 'settings';
      uiMessage.value = result.notionTokenRevoked
        ? 'Jottathing data and connection deleted. Your Notion pages remain.'
        : 'Jottathing data was deleted, but Notion did not confirm token revocation. Remove the Jottathing connection in Notion settings if it remains listed.';
    } catch {
      uiMessage.value = store.errorMessage || 'Unable to delete the Jottathing connection.';
    } finally {
      isDeletingConnection.value = false;
    }
  }

  return {
    hasAcceptedLegalTerms,
    isLegalAcceptanceLoaded,
    isSigningIn,
    isLoggingOut,
    logoutError,
    logoutProgress,
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
