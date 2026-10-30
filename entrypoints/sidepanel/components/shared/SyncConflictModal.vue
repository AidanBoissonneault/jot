<script setup lang="ts">
import { computed, ref, watch } from 'vue';
import type { DocumentContent } from '@/src/types/capture';
import type { SyncContentConflict } from '@/src/types/sync';
import { isProjectStateMetadataNode } from '@/src/extensions/sourceRegistry';
import {
  buildSyncConflictMerge,
  createSyncConflictRows,
  syncConflictBlockText,
  syncConflictDiffParts as diffParts,
  type SyncConflictChoice,
  type SyncConflictRow,
} from '@/src/lib/syncConflictReview';

type ConflictRow = SyncConflictRow & { choice: SyncConflictChoice };

const props = defineProps<{ conflict: SyncContentConflict; busy?: boolean; error?: string }>();
const emit = defineEmits<{
  cancel: [];
  resolve: [content: DocumentContent];
}>();

const rows = ref<ConflictRow[]>([]);
const remoteUnavailableAcknowledged = ref(false);
const reviewRows = computed(() => rows.value.filter((row) => row.needsChoice || row.duplicate));

watch(() => props.conflict, (conflict) => {
  rows.value = createRows(conflict);
  remoteUnavailableAcknowledged.value = false;
}, { immediate: true });

const hasUnresolvedHunks = computed(() => rows.value.some((row) =>
  ((row.local && row.notion && row.bothEdited) || row.duplicate ||
    (row.localDeleted && row.notion && row.notionChanged) ||
    (row.notionDeleted && row.local && row.localChanged)) && !row.choice,
));

function createRows(conflict: SyncContentConflict): ConflictRow[] {
  return createSyncConflictRows(conflict).map((row) => ({
    ...row,
    choice: row.choice ?? 'local',
  }));
}

function displayBlock(block?: DocumentContent): string {
  if (block && props.conflict.targetType === 'project' && isProjectStateMetadataNode(block)) {
    return 'Project source metadata (managed automatically)';
  }
  return syncConflictBlockText(block);
}

function changeParts(base?: DocumentContent, version?: DocumentContent) {
  if (!version && base) return [{ kind: 'removed' as const, text: displayBlock(base) }];
  if (version && !base) return [{ kind: 'added' as const, text: displayBlock(version) }];
  return diffParts(base, version);
}

function resolve() {
  const choices = Object.fromEntries(rows.value.map((row) => [row.id, row.choice]));
  emit('resolve', buildSyncConflictMerge(props.conflict, rows.value, choices));
}
</script>

<template>
  <div class="modal-backdrop sync-conflict-backdrop" role="dialog" aria-modal="true" aria-labelledby="sync-conflict-title">
    <section class="modal sync-conflict-modal" :class="{ 'has-error': error }">
      <h2 id="sync-conflict-title">{{ conflict.reason === 'duplicates' ? 'Resolve duplicate blocks' : 'Merge sync changes' }}</h2>
      <p v-if="error" class="sync-conflict-error" role="alert">{{ error }}</p>
      <p v-if="conflict.reason === 'duplicates'">{{ conflict.targetTitle }} has matching new blocks. Review the side-by-side changes and choose which copies to keep.</p>
      <p v-else>{{ conflict.targetTitle }} has changes that need review. New blocks that do not conflict will be preserved automatically.</p>

      <div v-if="!conflict.remoteContent" class="sync-conflict-warning" role="alert">
        Notion contains blocks this editor cannot represent. The available resolution replaces the Notion content with the local version.
        <label class="sync-conflict-acknowledge">
          <input v-model="remoteUnavailableAcknowledged" type="checkbox" />
          I reviewed the local content and want to replace the Notion content.
        </label>
      </div>

      <div v-else class="sync-conflict-rows">
        <article
          v-for="(row, index) in reviewRows"
          :key="row.id"
          class="sync-conflict-row"
          :class="{ 'has-three-way': row.bothEdited || row.duplicate }"
        >
          <div class="sync-conflict-row-heading">
            <strong>Block {{ index + 1 }}</strong>
            <span>{{ row.duplicate ? 'Matching additions' : 'Change needs review' }}</span>
          </div>
          <div class="sync-conflict-blocks">
            <div v-if="row.local && !row.internal" class="sync-conflict-side">
              <strong>Jottathing</strong>
              <pre>{{ displayBlock(row.local) }}</pre>
            </div>
            <div v-if="row.notion && !row.internal" class="sync-conflict-side">
              <strong>Notion</strong>
              <pre>{{ displayBlock(row.notion) }}</pre>
            </div>
            <p v-if="row.internal" class="sync-conflict-internal">Project source metadata will be preserved automatically.</p>
            <p v-if="row.localDeleted && row.notion && row.notionChanged" class="sync-conflict-deletion">Jottathing removed this block while Notion changed it.</p>
            <p v-if="row.notionDeleted && row.local && row.localChanged" class="sync-conflict-deletion">Notion removed this block while Jottathing changed it.</p>
          </div>
          <div v-if="(row.bothEdited || row.duplicate) && row.local && row.notion && !row.internal" class="sync-conflict-diff-wrap">
            <p>{{ row.duplicate ? 'Both blocks are new and have matching content.' : 'Compare each side with the last synced version.' }}</p>
            <div class="sync-conflict-three-way">
              <div>
                <strong>Last synced</strong>
                <pre class="sync-conflict-diff">{{ row.base ? displayBlock(row.base) : 'No shared version' }}</pre>
              </div>
              <div>
                <strong>Jottathing</strong>
                <pre class="sync-conflict-diff"><span v-for="(part, index) in changeParts(row.base, row.local)" :key="index" :class="part.kind">{{ part.text }}</span></pre>
              </div>
              <div>
                <strong>Notion</strong>
                <pre class="sync-conflict-diff"><span v-for="(part, index) in changeParts(row.base, row.notion)" :key="index" :class="part.kind">{{ part.text }}</span></pre>
              </div>
            </div>
            <div class="sync-conflict-diff-legend"><span class="removed">\u2212 Removed</span><span class="added">+ Added</span><span>Unmarked text is unchanged</span></div>
            <pre class="sync-conflict-diff"><span v-for="(part, index) in diffParts(row.local, row.notion)" :key="index" :class="part.kind">{{ part.text }}</span></pre>
          </div>
          <p v-else-if="row.duplicate" class="sync-conflict-duplicate">
            These new blocks have identical content. Keep one copy or keep both.
          </p>
          <fieldset v-if="row.localDeleted && row.notion && row.notionChanged && !row.internal" class="sync-conflict-choices">
            <legend>Choose how to resolve the deletion</legend>
            <label><input v-model="row.choice" type="radio" value="local" /> Keep Jottathing deletion</label>
            <label><input v-model="row.choice" type="radio" value="notion" /> Keep Notion block</label>
          </fieldset>
          <fieldset v-else-if="row.notionDeleted && row.local && row.localChanged && !row.internal" class="sync-conflict-choices">
            <legend>Choose how to resolve the deletion</legend>
            <label><input v-model="row.choice" type="radio" value="local" /> Keep Jottathing block</label>
            <label><input v-model="row.choice" type="radio" value="notion" /> Keep Notion deletion</label>
          </fieldset>
          <fieldset v-else-if="row.local && row.notion && row.bothEdited && !row.duplicate && !row.internal" class="sync-conflict-choices">
            <legend>Choose this block’s version</legend>
            <label><input v-model="row.choice" type="radio" value="local" /> Keep Jottathing</label>
            <label><input v-model="row.choice" type="radio" value="notion" /> Keep Notion</label>
          </fieldset>
          <fieldset v-else-if="row.duplicate" class="sync-conflict-choices">
            <legend>Resolve duplicate</legend>
            <label><input v-model="row.choice" type="radio" value="local" /> Keep Jottathing copy</label>
            <label><input v-model="row.choice" type="radio" value="notion" /> Keep Notion copy</label>
            <label><input v-model="row.choice" type="radio" value="both" /> Keep both</label>
          </fieldset>
          <p v-else-if="row.notion && !row.local && !row.localDeleted && !row.internal" class="sync-conflict-keep-remote">
            This new Notion block will be preserved separately.
          </p>
        </article>
      </div>

      <div class="modal-actions">
        <button type="button" class="icon-label-button secondary-button" :disabled="busy" @click="emit('cancel')">
          <font-awesome-icon :icon="['fas', 'xmark']" fixed-width />
          <span>Cancel</span>
        </button>
        <button
          type="button"
          class="icon-label-button"
          :disabled="busy || hasUnresolvedHunks || (!conflict.remoteContent && !remoteUnavailableAcknowledged)"
          @click="resolve"
        >
          <font-awesome-icon :icon="['fas', 'check']" fixed-width />
          <span>{{ busy ? 'Syncing...' : conflict.reason === 'duplicates' ? 'Apply choices' : 'Apply merge' }}</span>
        </button>
      </div>
    </section>
  </div>
</template>
