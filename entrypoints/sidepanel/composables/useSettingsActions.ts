/** @file Owns sync server and Notion parent-page settings actions and drafts. */
import { computed, ref, watch, type Ref } from 'vue';
import type { useInkwellStore } from '@/src/stores/inkwell';

/** Groups the editable fields and actions shown in settings sections. */
export function useSettingsActions(
  store: ReturnType<typeof useInkwellStore>,
  uiMessage: Ref<string>,
) {
  const serverUrlDraft = ref('');
  const parentPageSearchDraft = ref('');
  const parentPageTitleDraft = ref('');

  watch(
    () => store.syncConfig.serverUrl,
    (serverUrl) => {
      serverUrlDraft.value = serverUrl;
    },
    { immediate: true },
  );

  const parentPageLabel = computed(
    () =>
      store.syncConfig.selectedParentPageTitle ||
      (store.syncConfig.selectedParentPageId
        ? 'Selected Notion page'
        : 'Default Inkwell root page'),
  );

  /** Validates and saves a custom synchronization server URL. */
  async function saveServerUrl(): Promise<void> {
    const serverUrl = serverUrlDraft.value.trim();

    if (!serverUrl) {
      uiMessage.value = 'Enter a sync server URL.';
      return;
    }

    try {
      await store.updateServerUrl(serverUrl);
      uiMessage.value = '';
    } catch (error) {
      uiMessage.value = error instanceof Error ? error.message : 'Unable to save the sync server URL.';
    }
  }

  /** Searches Notion workspace pages for a parent selection. */
  async function searchParentPages(): Promise<void> {
    await store.loadNotionParentPages(parentPageSearchDraft.value);
  }

  /** Creates and selects an Inkwell parent page in the connected workspace. */
  async function createParentPage(): Promise<void> {
    const title = parentPageTitleDraft.value.trim() || 'Inkwell';
    await store.createNotionParentPage(title);
    parentPageTitleDraft.value = '';
  }

  /** Selects an existing Notion page as the synchronization parent. */
  async function selectParentPage(pageId: string): Promise<void> {
    await store.selectNotionParentPage(pageId);
  }

  return {
    createParentPage,
    parentPageLabel,
    parentPageSearchDraft,
    parentPageTitleDraft,
    saveServerUrl,
    searchParentPages,
    selectParentPage,
    serverUrlDraft,
  };
}
