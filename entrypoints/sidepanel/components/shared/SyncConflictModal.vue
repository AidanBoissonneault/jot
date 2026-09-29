<script setup lang="ts">
import { computed, ref, watch } from 'vue';
import type { DocumentContent } from '@/src/types/capture';
import type { SyncContentConflict } from '@/src/types/sync';
import { normalizeInkwellBlockIds } from '@/src/extensions/inkwellBlockIds';

type Choice = 'local' | 'notion' | 'both' | 'delete' | 'keep';
type ConflictRow = {
  id: string;
  local?: DocumentContent;
  notion?: DocumentContent;
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
  rows.value = createRows(conflict.localContent, conflict.remoteContent);
  remoteUnavailableAcknowledged.value = false;
}, { immediate: true });

const hasUnresolvedHunks = computed(() => rows.value.some((row) =>
  row.local && row.notion && row.changed && !row.choice,
));

function createRows(localContent: DocumentContent, remoteContent: DocumentContent | null): ConflictRow[] {
  const localBlocks = localContent.content ?? [];
  const notionBlocks = remoteContent?.content ?? [];
  const notionById = new Map(notionBlocks.map((block, index) => [blockId(block, index, 'notion'), block]));
  const localIds = new Set<string>();
  const result: ConflictRow[] = [];

  localBlocks.forEach((local, index) => {
    const id = blockId(local, index, 'local');
    localIds.add(id);
    const notion = notionById.get(id);
    const changed = Boolean(notion && signature(local) !== signature(notion));
    result.push({ id, local, notion, changed, choice: changed ? 'local' : 'keep' });
  });

  notionBlocks.forEach((notion, index) => {
    const id = blockId(notion, index, 'notion');
    if (localIds.has(id)) return;
    result.push({ id, notion, changed: false, choice: 'keep' });
  });
  return result;
}

function blockId(block: DocumentContent, index: number, side: string): string {
  const value = block.attrs?.inkwellBlockId;
  return typeof value === 'string' && value ? value : `${side}-${index}`;
}

function signature(block: DocumentContent): string {
  return JSON.stringify(withoutIdentity(block));
}

function withoutIdentity(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(withoutIdentity);
  if (!value || typeof value !== 'object') return value;
  return Object.fromEntries(Object.entries(value as Record<string, unknown>)
    .filter(([key]) => key !== 'inkwellBlockId' && key !== 'notionBlockId' && key !== 'inkwellConflictResolution')
    .sort(([first], [second]) => first.localeCompare(second))
    .map(([key, nested]) => [key, withoutIdentity(nested)]));
}

function displayBlock(block?: DocumentContent): string {
  if (!block) return 'Block deleted';
  const type = block.type ?? 'Block';
  if (type === 'image' || type === 'audio' || type === 'youtube') {
    return `${type}: ${String(block.attrs?.src ?? block.attrs?.url ?? 'media')}`;
  }
  const text = textFrom(block).trim();
  return text || (type === 'horizontalRule' ? 'Divider' : type);
}

function textFrom(block: DocumentContent): string {
  return (block.text ?? '') + (block.content ?? []).map(textFrom).join('');
}

function resolve() {
  const chosen: DocumentContent[] = [];
  for (const row of rows.value) {
    if (row.local && row.notion && row.changed) {
      if (row.choice === 'local') chosen.push(markBlock(row.local));
      else if (row.choice === 'notion') chosen.push(row.notion);
      else if (row.choice === 'both') chosen.push(markBlock(row.local), row.notion);
      continue;
    }
    if (row.local) chosen.push(row.local);
    else if (row.notion && row.choice === 'keep') chosen.push(row.notion);
  }

  const merged = normalizeInkwellBlockIds({
    type: props.conflict.localContent.type ?? 'doc',
    attrs: { inkwellConflictResolution: true },
    content: chosen,
  });
  emit('resolve', merged);
}

function markBlock(block: DocumentContent): DocumentContent {
  return {
    ...block,
    attrs: { ...block.attrs, inkwellConflictResolution: true },
  };
}
</script>

<template>
  <div class="modal-backdrop sync-conflict-backdrop" role="dialog" aria-modal="true" aria-labelledby="sync-conflict-title">
    <section class="modal sync-conflict-modal" :class="{ 'has-error': error }">
      <h2 id="sync-conflict-title">Merge sync changes</h2>
      <p v-if="error" class="sync-conflict-error" role="alert">{{ error }}</p>
      <p>{{ conflict.targetTitle }} has blocks that changed in both Inkwell and Notion. Choose which version to keep for each block.</p>

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
            <div v-if="row.local" class="sync-conflict-side">
              <strong>Inkwell</strong>
              <pre>{{ displayBlock(row.local) }}</pre>
            </div>
            <div v-if="row.notion" class="sync-conflict-side">
              <strong>Notion</strong>
              <pre>{{ displayBlock(row.notion) }}</pre>
            </div>
          </div>
          <fieldset v-if="row.local && row.notion && row.changed" class="sync-conflict-choices">
            <legend>Choose this block’s version</legend>
            <label><input v-model="row.choice" type="radio" value="local" /> Keep Inkwell</label>
            <label><input v-model="row.choice" type="radio" value="notion" /> Keep Notion</label>
            <label><input v-model="row.choice" type="radio" value="both" /> Keep both</label>
          </fieldset>
          <label v-else-if="row.notion && !row.local" class="sync-conflict-keep-remote">
            <input v-model="row.choice" type="checkbox" true-value="keep" false-value="delete" /> Keep this Notion block
          </label>
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
          <span>{{ busy ? 'Syncing merge...' : 'Apply merge' }}</span>
        </button>
      </div>
    </section>
  </div>
</template>
