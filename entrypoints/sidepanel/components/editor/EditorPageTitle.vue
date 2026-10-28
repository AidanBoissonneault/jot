<script setup lang="ts">
/** Shows remote-change status and controls for the current page and page list. */
import { onBeforeUnmount, onMounted, ref } from 'vue';
import type { EditorPageTitleContext } from './editorPageTitleContext';
import PageMenuList from '../lists/PageMenuList.vue';

const props = defineProps<{ context: EditorPageTitleContext }>();
const {
  store,
  activeTitleMenu,
  pageTitleDraft,
  isPageTitleEditing,
  pageTitleInputRef,
  markPageTitleDraftEdited,
  beginPageTitleEdit,
  finishPageTitleEdit,
  cancelPageTitleEdit,
  toggleTitleMenu,
  selectPage,
  createPage,
  archivePage,
} = props.context;

const titleSelectorRef = ref<HTMLElement | null>(null);

function handleOutsidePointerDown(event: PointerEvent) {
  if (titleSelectorRef.value?.contains(event.target as Node)) return;
  if (activeTitleMenu.value === 'page') toggleTitleMenu('page');
}

function blurTitleInput(event: Event) {
  (event.target as HTMLInputElement).blur();
}

onMounted(() => document.addEventListener('pointerdown', handleOutsidePointerDown));
onBeforeUnmount(() => document.removeEventListener('pointerdown', handleOutsidePointerDown));
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
    <div ref="titleSelectorRef" class="title-selector page-title-selector">
      <div class="title-input-row">
        <input
          v-if="isPageTitleEditing"
          ref="pageTitleInputRef"
          v-model="pageTitleDraft"
          class="page-title-input inline-title-input"
          aria-label="Page title"
          :disabled="store.isLoading || !store.currentPage"
          @input="markPageTitleDraftEdited"
          @blur="finishPageTitleEdit"
          @keydown.enter.prevent="blurTitleInput"
          @keydown.escape.prevent.stop="cancelPageTitleEdit"
        />
        <button
          v-else
          type="button"
          class="page-title-display"
          :disabled="store.isLoading || !store.currentPage"
          title="Click to rename page"
          @click="beginPageTitleEdit"
        >
          {{ pageTitleDraft || store.currentPage?.title || 'Untitled Page' }}
        </button>
        <span
          v-if="store.currentPage && store.syncConfig.authenticated"
          class="page-header-sync-dot"
          role="img"
          :class="[
            store.currentWorkspace?.kind,
            store.currentPage.syncState,
            { authenticated: true },
          ]"
          :title="store.currentPage.syncMessage || (store.currentWorkspace?.kind === 'notion' ? 'Page synced with Notion' : 'Local only')"
          :aria-label="store.currentPage.syncMessage || (store.currentWorkspace?.kind === 'notion' ? 'Page synced with Notion' : 'Local only')"
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
      <Transition name="popover">
        <div v-if="activeTitleMenu === 'page'" class="title-dropdown page-dropdown">
          <PageMenuList
            :pages="store.pages"
            :selected-page-id="store.currentPage?.id"
            :workspace-kind="store.currentWorkspace?.kind ?? 'local'"
            :authenticated="Boolean(store.syncConfig.authenticated)"
            @select="selectPage"
            @archive="archivePage"
            @create="createPage"
          />
        </div>
      </Transition>
    </div>
  </div>
</template>
