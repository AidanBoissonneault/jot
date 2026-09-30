<script setup lang="ts">
import { computed, ref } from 'vue';
import { NodeViewWrapper, nodeViewProps } from '@tiptap/vue-3';
import type { SyncContentConflict } from '@/src/types/sync';
import {
  buildSyncConflictMerge,
  createSyncConflictRows,
  hasUnresolvedSyncConflictRows,
  syncConflictBlockText,
  syncConflictDiffParts,
  type SyncConflictChoice,
} from '@/src/lib/syncConflictReview';
import type { DocumentContent } from '@/src/types/capture';

const props = defineProps(nodeViewProps);
const conflict = computed(() => props.node.attrs.conflict as SyncContentConflict);
const rows = computed(() => createSyncConflictRows(conflict.value));
const choices = computed(() => props.node.attrs.choices as Record<string, SyncConflictChoice> ?? {});
const hasUnresolved = computed(() => hasUnresolvedSyncConflictRows(rows.value, choices.value));
const remoteAcknowledged = ref(false);
const isApplying = ref(false);
const error = ref('');

function choose(rowId: string, choice: SyncConflictChoice) {
  props.updateAttributes({ choices: { ...choices.value, [rowId]: choice } });
}

function isChosen(rowId: string, choice: SyncConflictChoice) {
  return choices.value[rowId] === choice;
}

async function applyChoices() {
  if (hasUnresolved.value || (conflict.value.remoteContent === null && !remoteAcknowledged.value)) return;
  const options = props.extension.options as {
    onResolve?: (conflict: SyncContentConflict, content: DocumentContent) => Promise<void>;
  };
  if (!options.onResolve) return;

  isApplying.value = true;
  error.value = '';
  try {
    await options.onResolve(
      conflict.value,
      buildSyncConflictMerge(conflict.value, rows.value, choices.value),
    );
  } catch (cause) {
    error.value = cause instanceof Error ? cause.message : 'Unable to apply this merge.';
  } finally {
    isApplying.value = false;
  }
}
</script>

<template>
  <NodeViewWrapper class="inkwell-sync-conflict" contenteditable="false">
    <div class="inkwell-sync-conflict__title">
      <strong>Merge conflict</strong>
      <span>{{ conflict.targetTitle }}</span>
    </div>
    <p v-if="conflict.remoteContent === null" class="inkwell-sync-conflict__warning">
      Notion has blocks Inkwell cannot represent. Applying this review replaces those blocks with the local version.
      <label><input v-model="remoteAcknowledged" type="checkbox" /> I reviewed the local version.</label>
    </p>

    <div v-for="row in rows.filter((entry) => entry.needsChoice || entry.duplicate)" :key="row.id" class="inkwell-sync-conflict__row">
      <div v-if="row.localDeleted" class="inkwell-sync-conflict__candidate">
        <header>
          <strong>Inkwell</strong><span>Removed locally</span>
        </header>
        <pre><span class="removed">− {{ syncConflictBlockText() }}</span></pre>
        <div class="inkwell-sync-conflict__actions">
          <button type="button" :class="{ chosen: isChosen(row.id, 'local') }" @click="choose(row.id, 'local')" aria-label="Keep the local deletion">
            <font-awesome-icon :icon="['fas', 'check']" fixed-width /> Keep deletion
          </button>
          <button type="button" :class="{ chosen: isChosen(row.id, 'notion') }" @click="choose(row.id, 'notion')" aria-label="Discard the local deletion">
            <font-awesome-icon :icon="['fas', 'xmark']" fixed-width /> Discard
          </button>
        </div>
      </div>
      <div v-if="row.local" class="inkwell-sync-conflict__candidate">
        <header>
          <strong>Inkwell</strong><span>Local edit</span>
        </header>
        <pre><span class="removed">− {{ syncConflictBlockText(row.local) }}</span></pre>
        <div class="inkwell-sync-conflict__actions">
          <button type="button" :class="{ chosen: isChosen(row.id, 'local') }" @click="choose(row.id, 'local')" aria-label="Keep the Inkwell version">
            <font-awesome-icon :icon="['fas', 'check']" fixed-width /> Keep
          </button>
          <button type="button" :class="{ chosen: isChosen(row.id, 'notion') }" @click="choose(row.id, 'notion')" aria-label="Discard the Inkwell version">
            <font-awesome-icon :icon="['fas', 'xmark']" fixed-width /> Discard
          </button>
        </div>
      </div>
      <div v-if="row.notion" class="inkwell-sync-conflict__candidate">
        <header>
          <strong>Notion</strong><span>Remote edit</span>
        </header>
        <pre><span class="added">+ {{ syncConflictBlockText(row.notion) }}</span></pre>
        <div class="inkwell-sync-conflict__actions">
          <button type="button" :class="{ chosen: isChosen(row.id, 'notion') }" @click="choose(row.id, 'notion')" aria-label="Keep the Notion version">
            <font-awesome-icon :icon="['fas', 'check']" fixed-width /> Keep
          </button>
          <button type="button" :class="{ chosen: isChosen(row.id, 'local') }" @click="choose(row.id, 'local')" aria-label="Discard the Notion version">
            <font-awesome-icon :icon="['fas', 'xmark']" fixed-width /> Discard
          </button>
        </div>
        <pre v-if="row.changed && row.local" class="inkwell-sync-conflict__inline-diff"><span v-for="(part, index) in syncConflictDiffParts(row.local, row.notion)" :key="index" :class="part.kind">{{ part.text }}</span></pre>
      </div>
      <div v-if="row.notionDeleted" class="inkwell-sync-conflict__candidate">
        <header>
          <strong>Notion</strong><span>Removed remotely</span>
        </header>
        <pre><span class="removed">− {{ syncConflictBlockText() }}</span></pre>
        <div class="inkwell-sync-conflict__actions">
          <button type="button" :class="{ chosen: isChosen(row.id, 'notion') }" @click="choose(row.id, 'notion')" aria-label="Keep the Notion deletion">
            <font-awesome-icon :icon="['fas', 'check']" fixed-width /> Keep deletion
          </button>
          <button type="button" :class="{ chosen: isChosen(row.id, 'local') }" @click="choose(row.id, 'local')" aria-label="Discard the Notion deletion">
            <font-awesome-icon :icon="['fas', 'xmark']" fixed-width /> Discard
          </button>
        </div>
      </div>
      <p v-if="row.duplicate" class="inkwell-sync-conflict__duplicate">These added blocks match. Choose which copy to keep.</p>
    </div>

    <p v-if="error" class="inkwell-sync-conflict__error" role="alert">{{ error }}</p>
    <footer>
      <span v-if="hasUnresolved">Choose a version for each changed block.</span>
      <span v-else>Choices are ready to apply.</span>
      <button type="button" :disabled="isApplying || hasUnresolved || (conflict.remoteContent === null && !remoteAcknowledged)" @click="applyChoices">
        <font-awesome-icon :icon="['fas', 'check']" fixed-width />
        {{ isApplying ? 'Applying…' : 'Apply merge' }}
      </button>
    </footer>
  </NodeViewWrapper>
</template>
