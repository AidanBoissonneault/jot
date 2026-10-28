/** @file Derives sync feedback and workspace labels displayed in the top bar. */
import { computed } from 'vue';
import type { useJottathingStore } from '@/src/stores/jottathing';

/** Groups the topbar's saved-state badge and workspace identity labels. */
export function useTopBarStatus(store: ReturnType<typeof useJottathingStore>) {
  const saveLabel = computed(() => {
    if (store.isLoading) return 'Loading workspace';
    if (store.isCheckingSync) return 'Checking sync';
    if (store.syncCheckError) return 'Sync unavailable';
    if (store.pullMessage) return store.pullMessage;
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

  const canUseEditor = computed(() => !store.isLoading && store.projects.length > 0);
  const accountLabel = computed(
    () =>
      store.syncConfig.userEmail ||
      store.syncConfig.userName ||
      (store.syncConfig.connected ? 'Connected' : 'Local only'),
  );
  const contextLabel = computed(() => store.currentProject?.name ?? 'No project');

  return {
    accountLabel,
    canUseEditor,
    contextLabel,
    saveLabel,
  };
}
