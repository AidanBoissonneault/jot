<script setup lang="ts">
/** Presents the NotionParentPageSection settings section; the parent owns the shared settings state. */
import type { SettingsPageContext } from './settingsPageContext';
import NotionParentPageList from '../lists/NotionParentPageList.vue';

const props = defineProps<{ context: SettingsPageContext }>();
const {
  store,
  parentPageSearchDraft,
  searchParentPages,
  parentPageTitleDraft,
  createParentPage,
  selectParentPage,
} = props.context;
</script>

<template>
  <div class="panel-section">
    <h2>Notion Parent Page</h2>
    <form class="inline-form" @submit.prevent="searchParentPages">
      <input
        v-model="parentPageSearchDraft"
        aria-label="Search Notion pages"
        placeholder="Search pages"
        :disabled="!store.syncConfig.connected"
      />
      <button
        type="submit"
        class="icon-label-button"
        :disabled="!store.syncConfig.connected || store.isLoadingNotionParentPages"
        :title="store.isLoadingNotionParentPages ? 'Loading Notion pages' : 'Search Notion pages'"
        :aria-label="store.isLoadingNotionParentPages ? 'Loading Notion pages' : 'Search Notion pages'"
        :aria-busy="store.isLoadingNotionParentPages"
      >
        <font-awesome-icon
          :icon="['fas', 'magnifying-glass']"
          :class="{ 'sync-rotating-icon': store.isLoadingNotionParentPages }"
          fixed-width
        />
        <span>{{ store.isLoadingNotionParentPages ? 'Searching…' : 'Search' }}</span>
      </button>
    </form>

    <form class="inline-form" @submit.prevent="createParentPage">
      <input
        v-model="parentPageTitleDraft"
        aria-label="New Notion parent page"
        placeholder="New parent page title"
        :disabled="!store.syncConfig.connected"
      />
      <button
        type="submit"
        class="icon-label-button"
        :disabled="!store.syncConfig.connected"
        title="Create Notion parent page"
        aria-label="Create Notion parent page"
      >
        <font-awesome-icon :icon="['fas', 'folder-plus']" fixed-width />
        <span>Create</span>
      </button>
    </form>

    <NotionParentPageList
      :pages="store.notionParentPages"
      :selected-page-id="store.syncConfig.selectedParentPageId"
      :loading="store.isLoadingNotionParentPages"
      :disabled="!store.syncConfig.connected"
      @select="selectParentPage"
    />
  </div>
</template>
