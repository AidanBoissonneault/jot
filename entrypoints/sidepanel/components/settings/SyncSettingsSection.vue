<script setup lang="ts">
/** Presents the SyncSettingsSection settings section; the parent owns the shared settings state. */
import { computed } from 'vue';
import type { SettingsPageContext } from './settingsPageContext';
import SyncStatusList from '../lists/SyncStatusList.vue';

const props = defineProps<{ context: SettingsPageContext }>();
const {
  store,
  saveLabel,
  accountLabel,
  parentPageLabel,
  isResyncing,
  resync,
  isDeletingConnection,
  deleteConnection,
} = props.context;

const statusItems = computed(() => [
  { label: 'Account', value: accountLabel.value },
  { label: 'Parent page', value: parentPageLabel.value },
  { label: 'Status', value: saveLabel.value },
  { label: 'Connection', value: store.isOnline ? 'Online' : 'Offline' },
  {
    label: 'Local queue',
    value: `${store.pendingSyncCount} ${store.pendingSyncCount === 1 ? 'change' : 'changes'}`,
  },
]);
const queueAccountMismatch = computed(() =>
  store.syncConfig.connected &&
  ((store.syncConfig.syncQueueOwnerUserId !== undefined &&
    store.syncConfig.syncQueueOwnerUserId !== store.syncConfig.userId) ||
    (Boolean(store.syncConfig.syncQueueOwnerWorkspaceId) &&
      store.syncConfig.syncQueueOwnerWorkspaceId !== store.syncConfig.workspaceId)),
);
const queueOwnerUnknown = computed(() => queueAccountMismatch.value && store.syncConfig.syncQueueOwnerUserId === null);

async function assignUnknownQueueToCurrentAccount() {
  const confirmed = window.confirm(
    'These older local changes could not be matched to a Notion account. Sync them to the currently connected account?',
  );
  if (!confirmed) return;
  await store.assignUnmatchedPendingQueueToCurrentAccount().catch(() => undefined);
}
</script>

<template>
  <div class="panel-section">
    <div class="section-heading">
      <h2>Sync</h2>
      <button
        v-if="store.syncConfig.connected"
        type="button"
        class="icon-label-button secondary-button"
        :disabled="isResyncing"
        :title="isResyncing ? 'Syncing with Notion' : 'Resync'"
        :aria-label="isResyncing ? 'Syncing with Notion' : 'Resync'"
        :aria-busy="isResyncing"
        @click="resync"
      >
        <font-awesome-icon :icon="['fas', 'rotate']" :class="{ 'sync-rotating-icon': isResyncing }" fixed-width />
        <span>Resync</span>
      </button>
    </div>

    <SyncStatusList :items="statusItems" />

    <div v-if="queueAccountMismatch" class="sync-conflict-warning" role="status">
      <template v-if="queueOwnerUnknown">
        <span>Older local data could not be matched to a Notion account. Your documents remain on this device.</span>
        <button type="button" class="secondary-button" @click="assignUnknownQueueToCurrentAccount">
          Use this account for local data
        </button>
      </template>
      <span v-else>Queued changes are locked to their original Notion account and workspace. Reconnect that connection to sync them. Your documents remain on this device.</span>
    </div>

    <button
      v-if="store.syncConfig.logoutCleanupPending"
      type="button"
      class="icon-label-button secondary-button"
      :disabled="store.isRetryingLogoutCleanup"
      :title="store.isRetryingLogoutCleanup ? 'Finishing logout' : 'Retry logout cleanup'"
      :aria-busy="store.isRetryingLogoutCleanup"
      @click="store.retryLogoutCleanup"
    >
      <font-awesome-icon :icon="['fas', 'rotate']" :class="{ 'sync-rotating-icon': store.isRetryingLogoutCleanup }" fixed-width />
      <span>{{ store.isRetryingLogoutCleanup ? 'Finishing logout…' : 'Retry logout cleanup' }}</span>
    </button>
    <button
      v-if="store.projects.length > 0 || store.pendingSyncCount > 0 || store.syncConfig.authenticated || store.syncConfig.connected"
      type="button"
      class="icon-label-button danger-button"
      :disabled="isDeletingConnection || queueAccountMismatch"
      :aria-busy="isDeletingConnection"
      :title="queueAccountMismatch ? 'Reconnect the account that owns this local data first' : isDeletingConnection ? 'Deleting connection' : 'Delete connection and Jottathing data'"
      @click="deleteConnection"
    >
      <font-awesome-icon :icon="['fas', 'trash-can']" fixed-width />
      <span>{{ isDeletingConnection ? 'Deleting connection…' : 'Delete connection' }}</span>
    </button>
  </div>
</template>
