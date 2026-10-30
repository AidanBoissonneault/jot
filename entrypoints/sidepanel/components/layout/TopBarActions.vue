<script setup lang="ts">
/** @file Provides workspace actions, settings, and Notion connection entry points. */
import { computed } from 'vue';
import type { TopBarContext } from './topBarContext';

const props = defineProps<{ context: TopBarContext }>();
const {
  store,
  showStoreCta,
  storeListingUrl,
  canUseEditor,
  canOpenNotionConnectModal,
  isSigningIn,
  isResyncing,
  resyncProgress,
  activeTab,
  createProject,
  createPage,
  resync,
  openNotionConnectModal,
} = props.context;

const progressPercent = computed(() => {
  const progress = resyncProgress.value;
  if (!progress || !progress.total || progress.total <= 0 || progress.completed === undefined) return null;
  return Math.min(100, Math.max(0, (progress.completed / progress.total) * 100));
});

const progressLabel = computed(() => {
  const progress = resyncProgress.value;
  if (!progress) return '';
  if (progress.phase === 'saving_edits') return 'Saving your latest edits';
  if (progress.phase === 'checking_notion') return 'Checking Notion for changes';
  if (progress.phase === 'syncing_pages') return 'Syncing local pages';
  if (progress.phase === 'uploading') return 'Sending saved changes to Notion';
  if (progress.phase === 'waiting_for_server') return 'Waiting for Notion uploads';
  if (progress.phase === 'updating_view') return 'Updating your workspace';
  if (progress.stage === 'reading_projects') return 'Reading project structures from Notion';
  if (progress.stage === 'importing_pages') return 'Loading project pages from Notion';
  return 'Loading your Notion workspace';
});

const progressDetail = computed(() => {
  const progress = resyncProgress.value;
  if (!progress) return '';
  if (progress.completed !== undefined && progress.total !== undefined && progress.total > 0) {
    const unit = progress.phase === 'loading_workspace'
      ? 'projects'
      : progress.phase === 'syncing_pages'
        ? 'pages'
        : 'uploads';
    return `${progress.completed} of ${progress.total} ${unit}`;
  }
  if (progress.pending !== undefined) {
    if (progress.phase === 'uploading') {
      return progress.pending === 1 ? '1 local change remaining' : `${progress.pending} local changes remaining`;
    }
    return progress.pending === 1 ? '1 upload remaining' : `${progress.pending} uploads remaining`;
  }
  return '';
});
</script>

<template>
  <div v-if="canUseEditor || !store.syncConfig.connected" class="topbar-actions">
    <div v-if="canUseEditor" class="topbar-action-group">
      <button
        type="button"
        class="icon-label-button secondary-button"
        :disabled="store.isLoading"
        title="New project"
        aria-label="New project"
        @click="createProject()"
      >
        <font-awesome-icon :icon="['fas', 'folder-plus']" fixed-width />
        <span>New project</span>
      </button>

      <button
        type="button"
        class="icon-label-button"
        :disabled="store.isLoading || !store.currentProjectId"
        title="New page"
        aria-label="New page"
        @click="createPage"
      >
        <font-awesome-icon :icon="['fas', 'file-circle-plus']" fixed-width />
        <span>New page</span>
      </button>
      <button
        type="button"
        class="icon-label-button secondary-button"
        :disabled="store.isLoading || isResyncing || !store.syncConfig.connected || !store.isOnline"
        :title="isResyncing ? 'Syncing with Notion' : 'Resync with Notion'"
        :aria-label="isResyncing ? 'Syncing with Notion' : 'Resync with Notion'"
        :aria-busy="isResyncing"
        @click="resync"
      >
        <font-awesome-icon :icon="['fas', 'rotate']" :class="{ 'sync-rotating-icon': isResyncing }" fixed-width />
        <span>Sync</span>
      </button>
      <button
        type="button"
        class="icon-label-button secondary-button"
        :class="{ active: activeTab === 'settings' }"
        title="Settings"
        aria-label="Settings"
        @click="activeTab = activeTab === 'settings' ? 'editor' : 'settings'"
      >
        <font-awesome-icon :icon="['fas', 'gear']" fixed-width />
        <span>Settings</span>
      </button>
    </div>
    <Transition name="resync-progress">
      <div
        v-if="isResyncing && resyncProgress"
        class="topbar-sync-progress"
        role="status"
        aria-live="polite"
      >
        <div class="topbar-sync-progress__caption">
          <span>{{ progressLabel }}</span>
          <span v-if="progressDetail">{{ progressDetail }}</span>
        </div>
        <div
          class="topbar-sync-progress__track"
          role="progressbar"
          aria-label="Resync progress"
          :aria-valuemin="progressPercent === null ? undefined : 0"
          :aria-valuemax="progressPercent === null ? undefined : 100"
          :aria-valuenow="progressPercent === null ? undefined : Math.round(progressPercent)"
          :aria-valuetext="progressPercent === null ? progressLabel : `${Math.round(progressPercent)} percent`"
        >
          <span
            class="topbar-sync-progress__fill"
            :class="{ indeterminate: progressPercent === null }"
            :style="progressPercent === null ? undefined : { width: `${progressPercent}%` }"
          />
        </div>
      </div>
    </Transition>
    <a
      v-if="showStoreCta && storeListingUrl"
      class="notion-login-button"
      :href="storeListingUrl"
      target="_blank"
      rel="noopener noreferrer"
      title="Download Jottathing"
      aria-label="Download Jottathing"
    >
      <span>Add to Notion</span>
    </a>
    <button
      v-else-if="showStoreCta"
      type="button"
      class="notion-login-button"
      disabled
      title="The extension download is coming soon."
      aria-label="Coming soon"
    >
      <span>Coming soon</span>
    </button>
    <button
      v-else-if="!store.syncConfig.connected"
      type="button"
      class="notion-login-button"
      :disabled="!canOpenNotionConnectModal"
      :title="isSigningIn ? 'Connecting to Notion' : store.syncConfig.logoutCleanupPending ? 'Retry logout cleanup before reconnecting' : 'Add a Notion workspace'"
      :aria-label="isSigningIn ? 'Connecting to Notion' : 'Add Notion workspace'"
      @click="openNotionConnectModal"
    >
      <span class="notion-brand-mark" aria-hidden="true">
        <svg viewBox="0 0 24 24" focusable="false">
          <path d="M4 2.75h16v18.5H4z" />
          <path d="M7 17V7h2l6 7.1V7h2v10h-2l-6-7.1V17z" class="notion-brand-mark-letter" />
        </svg>
      </span>
      <span>{{ isSigningIn ? 'Connecting…' : 'Add Notion workspace' }}</span>
    </button>
  </div>
</template>
