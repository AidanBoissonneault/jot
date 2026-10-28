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
    onResolve?: (
      conflict: SyncContentConflict,
      content: DocumentContent,
    ) => Promise<DocumentContent | null | void>;
  };
  if (!options.onResolve) return;

  isApplying.value = true;
  error.value = '';
  try {
    const mergedContent = buildSyncConflictMerge(conflict.value, rows.value, choices.value);
    const resolvedContent = await options.onResolve(conflict.value, mergedContent);
    if (resolvedContent === undefined) {
      throw new Error('The merge was not applied. Try again.');
    }
    if (resolvedContent !== null) {
      props.editor.commands.setContent(resolvedContent, { emitUpdate: false });
    }
  } catch (cause) {
    error.value = cause instanceof Error ? cause.message : 'Unable to apply this merge.';
  } finally {
    isApplying.value = false;
  }
}
</script>

<template>
  <NodeViewWrapper class="jottathing-sync-conflict" contenteditable="false">
    <div class="jottathing-sync-conflict__title">
      <strong>{{ conflict.reason === 'duplicates' ? 'Duplicate blocks' : 'Merge conflict' }}</strong>
      <span>{{ conflict.targetTitle }}</span>
    </div>
    <p v-if="conflict.reason === 'duplicates'" class="jottathing-sync-conflict__warning">
      These identical new blocks were added on both sides. Choose whether to keep the Jottathing copy, the Notion copy, or both.
    </p>
    <p v-if="conflict.remoteContent === null" class="jottathing-sync-conflict__warning">
      Notion has blocks Jottathing cannot represent. Applying this review replaces those blocks with the local version.
      <label><input v-model="remoteAcknowledged" type="checkbox" /> I reviewed the local version.</label>
    </p>

    <div v-for="row in rows.filter((entry) => entry.needsChoice || entry.duplicate)" :key="row.id" class="jottathing-sync-conflict__row">
      <div v-if="row.localDeleted" class="jottathing-sync-conflict__candidate">
        <header>
          <strong>Jottathing</strong><span>Removed locally</span>
        </header>
        <pre><span class="removed">− {{ syncConflictBlockText() }}</span></pre>
        <div class="jottathing-sync-conflict__actions">
          <button type="button" :class="{ chosen: isChosen(row.id, 'local') }" @click="choose(row.id, 'local')" aria-label="Keep the local deletion">
            <font-awesome-icon :icon="['fas', 'check']" fixed-width /> Keep deletion
          </button>
          <button type="button" :class="{ chosen: isChosen(row.id, 'notion') }" @click="choose(row.id, 'notion')" aria-label="Discard the local deletion">
            <font-awesome-icon :icon="['fas', 'xmark']" fixed-width /> Discard
          </button>
        </div>
      </div>
      <div v-if="row.local" class="jottathing-sync-conflict__candidate">
        <header>
          <strong>Jottathing</strong><span>Local edit</span>
        </header>
        <pre><span class="removed">− {{ syncConflictBlockText(row.local) }}</span></pre>
        <div class="jottathing-sync-conflict__actions">
          <button type="button" :class="{ chosen: isChosen(row.id, 'local') }" @click="choose(row.id, 'local')" aria-label="Keep the Jottathing version">
            <font-awesome-icon :icon="['fas', 'check']" fixed-width /> Keep
          </button>
          <button type="button" :class="{ chosen: isChosen(row.id, 'notion') }" @click="choose(row.id, 'notion')" aria-label="Discard the Jottathing version">
            <font-awesome-icon :icon="['fas', 'xmark']" fixed-width /> Discard
          </button>
        </div>
      </div>
      <div v-if="row.notion" class="jottathing-sync-conflict__candidate">
        <header>
          <strong>Notion</strong><span>Remote edit</span>
        </header>
        <pre><span class="added">+ {{ syncConflictBlockText(row.notion) }}</span></pre>
        <div class="jottathing-sync-conflict__actions">
          <button type="button" :class="{ chosen: isChosen(row.id, 'notion') }" @click="choose(row.id, 'notion')" aria-label="Keep the Notion version">
            <font-awesome-icon :icon="['fas', 'check']" fixed-width /> Keep
          </button>
          <button type="button" :class="{ chosen: isChosen(row.id, 'local') }" @click="choose(row.id, 'local')" aria-label="Discard the Notion version">
            <font-awesome-icon :icon="['fas', 'xmark']" fixed-width /> Discard
          </button>
        </div>
        <pre v-if="row.changed && row.local" class="jottathing-sync-conflict__inline-diff"><span v-for="(part, index) in syncConflictDiffParts(row.local, row.notion)" :key="index" :class="part.kind">{{ part.text }}</span></pre>
      </div>
      <div v-if="row.notionDeleted" class="jottathing-sync-conflict__candidate">
        <header>
          <strong>Notion</strong><span>Removed remotely</span>
        </header>
        <pre><span class="removed">− {{ syncConflictBlockText() }}</span></pre>
        <div class="jottathing-sync-conflict__actions">
          <button type="button" :class="{ chosen: isChosen(row.id, 'notion') }" @click="choose(row.id, 'notion')" aria-label="Keep the Notion deletion">
            <font-awesome-icon :icon="['fas', 'check']" fixed-width /> Keep deletion
          </button>
          <button type="button" :class="{ chosen: isChosen(row.id, 'local') }" @click="choose(row.id, 'local')" aria-label="Discard the Notion deletion">
            <font-awesome-icon :icon="['fas', 'xmark']" fixed-width /> Discard
          </button>
        </div>
      </div>
      <div v-if="row.needsChoice && row.base && row.local && row.notion && !row.duplicate" class="jottathing-sync-conflict__three-way">
        <div>
          <strong>Last synced</strong>
          <pre>{{ syncConflictBlockText(row.base) }}</pre>
        </div>
        <div>
          <strong>Jottathing changes</strong>
          <pre><span v-for="(part, index) in syncConflictDiffParts(row.base, row.local)" :key="index" :class="part.kind">{{ part.text }}</span></pre>
        </div>
        <div>
          <strong>Notion changes</strong>
          <pre><span v-for="(part, index) in syncConflictDiffParts(row.base, row.notion)" :key="index" :class="part.kind">{{ part.text }}</span></pre>
        </div>
      </div>
      <p v-if="row.duplicate" class="jottathing-sync-conflict__duplicate">These added blocks match. Choose which copy to keep.</p>
    </div>

    <p v-if="error" class="jottathing-sync-conflict__error" role="alert">{{ error }}</p>
    <footer>
      <span v-if="hasUnresolved">Choose a version for each changed block.</span>
      <span v-else>Choices are ready to apply.</span>
      <button type="button" :disabled="isApplying || hasUnresolved || (conflict.remoteContent === null && !remoteAcknowledged)" @click="applyChoices">
        <font-awesome-icon :icon="['fas', 'check']" fixed-width />
        {{ isApplying ? 'Applying…' : conflict.reason === 'duplicates' ? 'Apply choices' : 'Apply merge' }}
      </button>
    </footer>
  </NodeViewWrapper>
</template>
