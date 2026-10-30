<script setup lang="ts">
import { computed, ref, watch } from 'vue';
import type { DocumentContent } from '@/src/types/capture';
import type { SyncContentConflict } from '@/src/types/sync';
import { normalizeJottathingBlockIds } from '@/src/extensions/jottathingBlockIds';
import { isProjectStateMetadataNode } from '@/src/extensions/sourceRegistry';
import {
  syncConflictBlockId as stableBlockId,
  syncConflictBlockSignature as signature,
  syncConflictBlockText,
  syncConflictDiffParts as diffParts,
} from '@/src/lib/syncConflictReview';

type Choice = 'local' | 'notion' | 'both' | '';
type ConflictRow = {
  id: string;
  base?: DocumentContent;
  local?: DocumentContent;
  notion?: DocumentContent;
  duplicate?: boolean;
  internal?: boolean;
  bothEdited?: boolean;
  localDeleted?: boolean;
  notionDeleted?: boolean;
  localChanged?: boolean;
  notionChanged?: boolean;
  changed: boolean;
  choice: Choice;
};

const props = defineProps<{ conflict: SyncContentConflict; busy?: boolean; error?: string }>();
const emit = defineEmits<{
  cancel: [];
  resolve: [content: DocumentContent];
}>();

const rows = ref<ConflictRow[]>([]);
const remoteUnavailableAcknowledged = ref(false);

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
  const localBlocks = conflict.localContent.content ?? [];
  const notionBlocks = conflict.remoteContent?.content ?? [];
  const localChangedIds = conflict.localChangedBlockIds
    ? new Set(conflict.localChangedBlockIds)
    : undefined;
  const remoteChangedIds = conflict.remoteChangedBlockIds
    ? new Set(conflict.remoteChangedBlockIds)
    : undefined;
  const baseById = new Map((conflict.baseContent?.content ?? [])
    .map((block) => [stableBlockId(block), block] as const)
    .filter((entry): entry is readonly [string, DocumentContent] => Boolean(entry[0])));
  const notionIndexById = new Map<string, number>();
  notionBlocks.forEach((block, index) => {
    const id = stableBlockId(block);
    if (id && !notionIndexById.has(id)) notionIndexById.set(id, index);
  });
  const consumedNotion = new Set<number>();
  const result: ConflictRow[] = localBlocks.map((local, index) => {
    const localId = stableBlockId(local);
    const notionIndex = localId ? notionIndexById.get(localId) : undefined;
    const notion = notionIndex === undefined ? undefined : notionBlocks[notionIndex];
    if (notionIndex !== undefined) consumedNotion.add(notionIndex);
    const base = localId ? baseById.get(localId) : undefined;
    const localChanged = localId && localChangedIds
      ? localChangedIds.has(localId)
      : Boolean(base && signature(local) !== signature(base));
    const notionChanged = localId && remoteChangedIds
      ? remoteChangedIds.has(localId)
      : Boolean(base && notion && signature(notion) !== signature(base));
    const changed = Boolean(notion && signature(local) !== signature(notion));
    const bothEdited = Boolean(base && localChanged && notionChanged && changed);
    const notionDeleted = Boolean(conflict.remoteContent && base && !notion);
    const deletionConflict = Boolean(base && localChanged && notionDeleted);
    const internal = conflict.targetType === 'project' && isProjectStateMetadataNode(local);
    const choice: Choice = internal
      ? notionChanged && !localChanged ? 'notion' : 'local'
      : bothEdited || deletionConflict
        ? ''
        : notionChanged && !localChanged
          ? 'notion'
          : 'local';

    return {
      id: localId ?? `local-${index}`,
      base,
      local,
      notion,
      internal,
      bothEdited,
      notionDeleted,
      localChanged,
      notionChanged,
      changed,
      choice,
    };
  });

  notionBlocks.forEach((notion, index) => {
    if (consumedNotion.has(index)) return;
    const notionId = stableBlockId(notion);
    const base = notionId ? baseById.get(notionId) : undefined;
    const notionChanged = notionId && remoteChangedIds
      ? remoteChangedIds.has(notionId)
      : Boolean(base && signature(notion) !== signature(base));
    const localDeleted = Boolean(base && conflict.remoteContent);
    const internal = conflict.targetType === 'project' && isProjectStateMetadataNode(notion);
    const identicalLocal = result.find((row) =>
      row.local && !row.notion && row.internal === internal &&
      signature(row.local) === signature(notion) &&
      (internal || (
        !baseById.has(stableBlockId(row.local) ?? '') &&
        !baseById.has(notionId ?? '')
      )),
    );
    if (identicalLocal) {
      identicalLocal.notion = notion;
      identicalLocal.notionChanged = notionChanged;
      if (!internal) {
        identicalLocal.duplicate = true;
        identicalLocal.choice = '';
      }
      return;
    }

    result.push({
      id: notionId ?? `notion-${index}`,
      notion,
      base,
      localDeleted,
      notionChanged,
      internal,
      changed: Boolean(base && notionChanged),
      choice: localDeleted && notionChanged ? '' : 'notion',
    });
  });
  return result;
}

function displayBlock(block?: DocumentContent): string {
  if (block && props.conflict.targetType === 'project' && isProjectStateMetadataNode(block)) {
    return 'Project source metadata (managed automatically)';
  }
  return syncConflictBlockText(block);
}

function resolve() {
  const chosen: DocumentContent[] = [];
  const deleteNotionBlockIds: string[] = [];
  for (const row of rows.value) {
    if (row.duplicate && row.local && row.notion) {
      if (row.choice === 'local') {
        chosen.push(markBlock(row.local, remoteBlockId(row.notion)));
      } else if (row.choice === 'both') {
        chosen.push(markBlock(row.local));
      }
      if (row.choice === 'notion' || row.choice === 'both') {
        chosen.push(markBlock(row.notion, remoteBlockId(row.notion)));
      }
      continue;
    }
    if (row.localDeleted) {
      if (row.choice === 'notion' && row.notion) {
        chosen.push(markBlock(row.notion, remoteBlockId(row.notion)));
      } else if (row.choice === 'local' && row.notion) {
        const notionId = remoteBlockId(row.notion);
        if (notionId) deleteNotionBlockIds.push(notionId);
      }
      continue;
    }
    if (row.notionDeleted) {
      if (row.choice === 'local' && row.local) chosen.push(markBlock(row.local));
      continue;
    }
    if (row.local && row.notion && row.changed) {
      const choice = row.bothEdited
        ? row.choice
        : row.notionChanged && !row.localChanged
          ? 'notion'
          : 'local';
      if (choice === 'local') {
        chosen.push(markBlock(row.local, remoteBlockId(row.notion)));
      } else if (choice === 'notion') {
        chosen.push(markBlock(row.notion, remoteBlockId(row.notion)));
      }
      continue;
    }
    if (row.local) chosen.push(row.local);
    else if (row.notion) chosen.push(row.notion);
  }

  const merged = normalizeJottathingBlockIds({
    type: props.conflict.localContent.type ?? 'doc',
    attrs: {
      jottathingConflictResolution: true,
      jottathingPreserveRemoteBlocks: Boolean(props.conflict.remoteContent),
      ...(deleteNotionBlockIds.length ? { jottathingDeleteNotionBlockIds: deleteNotionBlockIds } : {}),
    },
    // Applying the merge confirms every block in the reviewed snapshot,
    // including Notion-only blocks that the modal preserves automatically.
    content: chosen.map((block) => ({
      ...block,
      attrs: {
        ...block.attrs,
        jottathingConflictResolution: true,
      },
    })),
  });
  emit('resolve', merged);
}

function remoteBlockId(block: DocumentContent): string | undefined {
  const id = block.attrs?.notionBlockId;
  return typeof id === 'string' && id ? id : undefined;
}

function markBlock(block: DocumentContent, notionBlockId?: string): DocumentContent {
  return {
    ...block,
    attrs: {
      ...block.attrs,
      ...(notionBlockId ? { notionBlockId } : {}),
      jottathingConflictResolution: true,
    },
  };
}
</script>

<template>
  <div class="modal-backdrop sync-conflict-backdrop" role="dialog" aria-modal="true" aria-labelledby="sync-conflict-title">
    <section class="modal sync-conflict-modal" :class="{ 'has-error': error }">
      <h2 id="sync-conflict-title">{{ conflict.reason === 'duplicates' ? 'Resolve duplicate blocks' : 'Merge sync changes' }}</h2>
      <p v-if="error" class="sync-conflict-error" role="alert">{{ error }}</p>
      <p v-if="conflict.reason === 'duplicates'">{{ conflict.targetTitle }} has identical new blocks on both sides. Choose whether to keep the Jottathing copy, the Notion copy, or both.</p>
      <p v-else>{{ conflict.targetTitle }} has content that needs review. New blocks are preserved; exact duplicates require a separate choice, and blocks changed on both sides show a diff.</p>

      <div v-if="!conflict.remoteContent" class="sync-conflict-warning" role="alert">
        Notion contains blocks this editor cannot represent. The available resolution replaces the Notion content with the local version.
        <label class="sync-conflict-acknowledge">
          <input v-model="remoteUnavailableAcknowledged" type="checkbox" />
          I reviewed the local content and want to replace the Notion content.
        </label>
      </div>

      <div v-else class="sync-conflict-rows">
        <article v-for="row in rows" :key="row.id" class="sync-conflict-row">
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
          <div v-if="row.bothEdited && row.local && row.notion && !row.internal" class="sync-conflict-diff-wrap">
            <p>Both sides changed since the last shared version. Compare each version with that baseline, then choose one.</p>
            <div v-if="row.base" class="sync-conflict-three-way">
              <div>
                <strong>Last synced</strong>
                <pre class="sync-conflict-diff">{{ displayBlock(row.base) }}</pre>
              </div>
              <div>
                <strong>Jottathing changes</strong>
                <pre class="sync-conflict-diff"><span v-for="(part, index) in diffParts(row.base, row.local)" :key="index" :class="part.kind">{{ part.text }}</span></pre>
              </div>
              <div>
                <strong>Notion changes</strong>
                <pre class="sync-conflict-diff"><span v-for="(part, index) in diffParts(row.base, row.notion)" :key="index" :class="part.kind">{{ part.text }}</span></pre>
              </div>
            </div>
            <div class="sync-conflict-diff-legend"><span class="removed">− Jottathing</span><span class="added">+ Notion</span></div>
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
