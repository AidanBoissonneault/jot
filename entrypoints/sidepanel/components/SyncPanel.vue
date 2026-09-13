<!--
  Created: September 12, 2026
  Author: Aidan
  Description: Manages the Notion connection settings, legal consent, server configuration, and parent-page selection.
-->
<script setup lang="ts">
import { useInkwellStore } from '@/src/stores/inkwell';

defineProps<{
  accountLabel: string;
  canLogin: boolean;
  isLegalAcceptanceLoaded: boolean;
  isSigningIn: boolean;
  parentPageLabel: string;
  privacyUrl: string;
  saveLabel: string;
  termsUrl: string;
}>();

const hasAcceptedLegalTerms = defineModel<boolean>('hasAcceptedLegalTerms', { required: true });
const parentPageSearch = defineModel<string>('parentPageSearch', { required: true });
const parentPageTitle = defineModel<string>('parentPageTitle', { required: true });
const serverUrl = defineModel<string>('serverUrl', { required: true });

const emit = defineEmits<{
  createParentPage: [];
  login: [];
  logout: [];
  openOnboarding: [];
  openLegalUrl: [url: string];
  resync: [];
  saveServerUrl: [];
  searchParentPages: [];
  selectParentPage: [pageId: string];
}>();

const store = useInkwellStore();
</script>

<template>
  <div class="settings-section-group" aria-label="Sync settings">
    <div v-if="!store.syncConfig.connected" class="panel-section logged-out-sync">
      <div class="local-workspace-heading">
        <span class="local-workspace-icon" aria-hidden="true">
          <font-awesome-icon :icon="['fas', 'floppy-disk']" fixed-width />
        </span>
        <div>
          <span class="section-kicker">Local workspace</span>
          <h2>Your notes are ready whenever you are.</h2>
        </div>
      </div>

      <p class="logged-out-sync-copy">
        Inkwell is saving projects and pages on this device. Connect Notion to
        back them up to your workspace and keep changes in sync across devices.
      </p>

      <ul class="sync-benefits">
        <li>
          <font-awesome-icon :icon="['fas', 'check']" fixed-width />
          <span>Your local work is uploaded when you connect</span>
        </li>
        <li>
          <font-awesome-icon :icon="['fas', 'check']" fixed-width />
          <span>Offline edits continue syncing when you reconnect</span>
        </li>
        <li>
          <font-awesome-icon :icon="['fas', 'check']" fixed-width />
          <span>You can disconnect at any time</span>
        </li>
      </ul>

      <div class="legal-disclosure connect-consent">
        <label class="legal-consent">
          <input v-model="hasAcceptedLegalTerms" type="checkbox" :disabled="!isLegalAcceptanceLoaded">
          <span>
            I agree to the
            <a :href="termsUrl" target="_blank" rel="noopener noreferrer" @click.prevent="emit('openLegalUrl', termsUrl)">Terms</a>
            and
            <a :href="privacyUrl" target="_blank" rel="noopener noreferrer" @click.prevent="emit('openLegalUrl', privacyUrl)">Privacy Policy</a>.
          </span>
        </label>
      </div>

      <button
        type="button"
        class="icon-label-button connect-notion-button"
        :disabled="!canLogin"
        :title="isSigningIn ? 'Connecting' : 'Connect Notion'"
        :aria-label="isSigningIn ? 'Connecting' : 'Connect Notion'"
        @click="emit('login')"
      >
        <font-awesome-icon :icon="['fas', 'cloud-arrow-up']" fixed-width />
        <span>{{ isSigningIn ? 'Waiting for Notion...' : 'Connect Notion' }}</span>
      </button>

      <button type="button" class="text-button tour-button" @click="emit('openOnboarding')">
        View the quick tour
      </button>
    </div>

    <div v-else class="panel-section">
      <div class="section-heading">
        <h2>Sync</h2>
        <button type="button" class="icon-label-button secondary-button" title="Resync" aria-label="Resync" @click="emit('resync')">
          <font-awesome-icon :icon="['fas', 'rotate']" fixed-width />
          <span>Resync</span>
        </button>
      </div>

      <dl class="status-list">
        <div><dt>Account</dt><dd>{{ accountLabel }}</dd></div>
        <div><dt>Workspace</dt><dd>{{ store.syncConfig.workspaceName || 'Not connected' }}</dd></div>
        <div><dt>Destination</dt><dd>{{ parentPageLabel }}</dd></div>
        <div><dt>Status</dt><dd>{{ saveLabel }}</dd></div>
      </dl>

      <button type="button" class="icon-label-button secondary-button" title="Logout" aria-label="Logout" @click="emit('logout')">
        <font-awesome-icon :icon="['fas', 'right-from-bracket']" fixed-width />
        <span>Logout</span>
      </button>
    </div>

    <div v-if="store.syncConfig.connected" class="panel-section">
      <h2>Legal</h2>
      <p class="legal-links">
        <a :href="termsUrl" target="_blank" rel="noopener noreferrer" @click.prevent="emit('openLegalUrl', termsUrl)">Terms</a>
        <a :href="privacyUrl" target="_blank" rel="noopener noreferrer" @click.prevent="emit('openLegalUrl', privacyUrl)">Privacy Policy</a>
      </p>
    </div>

    <details class="panel-section advanced-settings">
      <summary>
        <span>Advanced settings</span>
        <span class="switcher-chevron" aria-hidden="true" />
      </summary>
      <div class="advanced-settings-content">
        <div>
          <h2>Custom sync server</h2>
          <p class="panel-hint">Only change this when connecting to a self-hosted Inkwell server.</p>
        </div>
        <form class="inline-form" @submit.prevent="emit('saveServerUrl')">
          <input v-model="serverUrl" type="url" aria-label="Sync server URL" placeholder="http://localhost:8787">
          <button type="submit" class="icon-label-button" title="Save server URL" aria-label="Save server URL">
            <font-awesome-icon :icon="['fas', 'floppy-disk']" fixed-width />
            <span>Save</span>
          </button>
        </form>
        <a class="disabled-link" href="#" aria-disabled="true" tabindex="-1" @click.prevent>Self-hosting guide <small>WIP</small></a>
      </div>
    </details>

    <div v-if="store.syncConfig.connected" class="panel-section">
      <h2>Notion Parent Page</h2>
      <form class="inline-form" @submit.prevent="emit('searchParentPages')">
        <input v-model="parentPageSearch" aria-label="Search Notion pages" placeholder="Search pages" :disabled="!store.syncConfig.connected">
        <button type="submit" class="icon-label-button" :disabled="!store.syncConfig.connected" title="Search Notion pages" aria-label="Search Notion pages">
          <font-awesome-icon :icon="['fas', 'magnifying-glass']" fixed-width />
          <span>Search</span>
        </button>
      </form>

      <form class="inline-form" @submit.prevent="emit('createParentPage')">
        <input v-model="parentPageTitle" aria-label="New Notion parent page" placeholder="New parent page title" :disabled="!store.syncConfig.connected">
        <button type="submit" class="icon-label-button" :disabled="!store.syncConfig.connected" title="Create Notion parent page" aria-label="Create Notion parent page">
          <font-awesome-icon :icon="['fas', 'folder-plus']" fixed-width />
          <span>Create</span>
        </button>
      </form>

      <div class="item-list">
        <button
          v-for="page in store.notionParentPages"
          :key="page.id"
          type="button"
          class="item-row"
          :class="{ active: page.id === store.syncConfig.selectedParentPageId }"
          :disabled="!store.syncConfig.connected"
          @click="emit('selectParentPage', page.id)"
        >
          <span>{{ page.title }}</span>
          <small>{{ page.parentPageId ? 'Child page' : 'Page' }}</small>
        </button>
      </div>
    </div>
  </div>
</template>
