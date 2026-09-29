/** @file Derives sync feedback and workspace labels displayed in the top bar. */
import { computed } from 'vue';
import type { useInkwellStore } from '@/src/stores/inkwell';

/** Groups the topbar's saved-state badge and workspace identity labels. */
export function useTopBarStatus(store: ReturnType<typeof useInkwellStore>) {
  const saveLabel = computed(() => {
    if (store.pullMessage) return store.pullMessage;
    if (store.isLoading) return 'Loading';
    if (store.saveStatus === 'saving') return 'Saving';
    if (store.saveStatus === 'creating') return 'Creating';
    if (store.saveStatus === 'error') return 'Save failed';
    if (store.pendingSyncCount > 0) {
      return `${store.pendingSyncCount} ${store.pendingSyncCount === 1 ? 'change' : 'changes'} queued`;
    }
    if (!store.isOnline) return 'Offline · saved locally';
    if (store.saveStatus === 'stale') return 'Stale';
    return 'Saved locally';
  });

  const syncBadgeTitle = computed(() => {
    if (store.errorMessage) return store.errorMessage;
    if (!store.isOnline) {
      return 'You are offline. Changes are saved on this device and will sync automatically when you reconnect.';
    }
    if (!store.syncConfig.connected) {
      return 'Changes are saved on this device. Connect Notion when you are ready to sync.';
    }
    if (store.pendingSyncCount > 0) {
      return `${store.pendingSyncCount} queued ${store.pendingSyncCount === 1 ? 'change is' : 'changes are'} waiting to sync with Notion.`;
    }

    const sseNote =
      store.sseStatus === 'connected'
        ? 'Live updates active'
        : store.sseStatus === 'connecting'
          ? 'Connecting…'
          : 'Live updates disconnected';

    if (!store.syncConfig.selectedParentPageId) {
      return `Inkwell will create a root Notion page with project folders on first sync. · ${sseNote}`;
    }

    const base = store.syncConfig.selectedParentPageTitle
      ? `Synced inside ${store.syncConfig.selectedParentPageTitle}`
      : saveLabel.value;
    return `${base} · ${sseNote}`;
  });

  const syncBadgeClass = computed(() => ({
    'sync-badge': true,
    error: store.saveStatus === 'error',
    stale:
      store.saveStatus === 'stale' ||
      !store.syncConfig.connected ||
      !store.isOnline ||
      store.pendingSyncCount > 0,
    saving: store.saveStatus === 'saving' || store.saveStatus === 'creating' || store.isLoading,
    saved:
      store.saveStatus === 'saved' &&
      store.syncConfig.connected &&
      store.isOnline &&
      store.pendingSyncCount === 0,
  }));

  const canUseEditor = computed(() => !store.isLoading && store.projects.length > 0);
  const accountLabel = computed(
    () =>
      store.syncConfig.userEmail ||
      store.syncConfig.userName ||
      (store.syncConfig.connected ? 'Connected' : 'Local only'),
  );
  const workspaceLabel = computed(() =>
    store.syncConfig.workspaceName
      ? `Workspace: ${store.syncConfig.workspaceName}`
      : 'No workspace selected',
  );
  const contextLabel = computed(() => store.currentProject?.name ?? 'No project');

  return {
    accountLabel,
    canUseEditor,
    contextLabel,
    saveLabel,
    syncBadgeClass,
    syncBadgeTitle,
    workspaceLabel,
  };
}
