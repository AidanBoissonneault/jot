<script setup lang="ts">
/** Shows remote-change status and controls for the current page and page list. */
import type { EditorPageTitleContext } from './editorPageTitleContext';
import PageMenuList from '../lists/PageMenuList.vue';

const props = defineProps<{ context: EditorPageTitleContext }>();
const {
  store,
  activeTitleMenu,
  pageTitleDraft,
  renamePage,
  blurTitleInput,
  toggleTitleMenu,
  selectPage,
  createPage,
  archivePage,
} = props.context;
</script>

<template>
  <div
    v-if="store.currentPage && store.stalePageIds.includes(store.currentPage.id)"
    class="sync-change-banner"
    role="alert"
  >
    <span>This page was updated in Notion.</span>
    <div class="sync-change-banner-actions">
      <button
        type="button"
        class="sync-change-banner-btn primary"
        @click="store.confirmReloadPage(store.currentPage.id)"
      >
        Sync
      </button>
      <button
        type="button"
        class="sync-change-banner-btn"
        @click="store.dismissStalePage(store.currentPage.id)"
      >
        Dismiss
      </button>
    </div>
  </div>
  <div
    v-else-if="store.currentPage && store.aheadPageIds.includes(store.currentPage.id)"
    class="sync-change-banner"
    role="alert"
  >
    <span>This page was edited on another device.</span>
    <div class="sync-change-banner-actions">
      <button
        type="button"
        class="sync-change-banner-btn primary"
        @click="store.confirmReloadPage(store.currentPage.id)"
      >
        Sync
      </button>
      <button
        type="button"
        class="sync-change-banner-btn"
        @click="store.dismissStalePage(store.currentPage.id)"
      >
        Keep local
      </button>
    </div>
  </div>
  <div class="editor-title-row">
    <div class="title-selector page-title-selector">
      <div class="title-input-row">
        <input
          v-model="pageTitleDraft"
          aria-label="Page title"
          :disabled="store.isLoading || !store.currentPage"
          @blur="renamePage"
          @keydown.enter="blurTitleInput"
        />
        <button
          type="button"
          class="title-menu-trigger"
          :class="{ active: activeTitleMenu === 'page' }"
          :disabled="store.isLoading || store.pages.length === 0"
          title="Switch page"
          aria-label="Switch page"
          :aria-expanded="activeTitleMenu === 'page'"
          @click="toggleTitleMenu('page')"
        >
          <font-awesome-icon :icon="['fas', 'chevron-down']" fixed-width />
        </button>
      </div>
      <div v-if="activeTitleMenu === 'page'" class="title-dropdown page-dropdown">
        <PageMenuList
          :pages="store.pages"
          :selected-page-id="store.currentPage?.id"
          @select="selectPage"
        />
        <div class="title-dropdown-actions">
          <button type="button" :disabled="!store.currentProjectId" @click="createPage">
            <font-awesome-icon :icon="['fas', 'file-circle-plus']" fixed-width />
            New page
          </button>
          <button
            type="button"
            class="danger-button"
            :disabled="!store.currentPage"
            @click="archivePage"
          >
            <font-awesome-icon :icon="['fas', 'trash-can']" fixed-width />
            Delete page
          </button>
        </div>
      </div>
    </div>
  </div>
</template>
