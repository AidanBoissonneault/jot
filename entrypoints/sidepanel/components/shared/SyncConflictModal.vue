<script setup lang="ts">
import { computed, ref, watch } from 'vue';
import type { DocumentContent } from '@/src/types/capture';
import type { SyncContentConflict } from '@/src/types/sync';
import { normalizeInkwellBlockIds } from '@/src/extensions/inkwellBlockIds';
import { isProjectStateMetadataNode } from '@/src/extensions/sourceRegistry';

type Choice = 'local' | 'notion' | 'both' | '';
type DiffPart = { kind: 'added' | 'context' | 'removed'; text: string };
type ConflictRow = {
  id: string;
  base?: DocumentContent;
  local?: DocumentContent;
  notion?: DocumentContent;
  duplicate?: boolean;
  internal?: boolean;
  bothEdited?: boolean;
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
  ((row.local && row.notion && row.changed) || row.duplicate) && !row.choice,
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
    const internal = conflict.targetType === 'project' && isProjectStateMetadataNode(local);
    const choice: Choice = internal
      ? notionChanged && !localChanged ? 'notion' : 'local'
      : bothEdited || (changed && !base)
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
      changed,
      choice,
    };
  });

  notionBlocks.forEach((notion, index) => {
    if (consumedNotion.has(index)) return;
    const notionId = stableBlockId(notion);
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
      if (!internal) {
        identicalLocal.duplicate = true;
        identicalLocal.choice = '';
      }
      return;
    }

    result.push({
      id: notionId ?? `notion-${index}`,
      notion,
      internal,
      changed: false,
      choice: '',
    });
  });
  return result;
}

function stableBlockId(block: DocumentContent): string | undefined {
  const value = block.attrs?.inkwellBlockId;
  return typeof value === 'string' && value ? value : undefined;
}

function signature(block: DocumentContent): string {
  return JSON.stringify(withoutIdentity(block));
}

function withoutIdentity(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(withoutIdentity);
  if (!value || typeof value !== 'object') return value;
  const record = value as Record<string, unknown>;
  const isFileUpload = Boolean(record.notionFileUploadId);
  return Object.fromEntries(Object.entries(record)
    .filter(([key]) => key !== 'inkwellBlockId' && key !== 'notionBlockId' && key !== 'inkwellConflictResolution' && key !== 'uploadState' && !(isFileUpload && key === 'src'))
    .sort(([first], [second]) => first.localeCompare(second))
    .map(([key, nested]) => [key, key === 'src' ? stableMediaUrl(nested) : withoutIdentity(nested)]));
}

function stableMediaUrl(value: unknown): unknown {
  if (typeof value !== 'string') return withoutIdentity(value);
  try {
    const url = new URL(value);
    if (url.searchParams.has('X-Amz-Signature') || url.hostname.startsWith('prod-files-secure.s3.')) {
      return `${url.origin}${url.pathname}`;
    }
  } catch {
    // Preserve non-URL media sources for comparison.
  }
  return value;
}

function displayBlock(block?: DocumentContent): string {
  if (!block) return 'Block deleted';
  if (props.conflict.targetType === 'project' && isProjectStateMetadataNode(block)) {
    return 'Project source metadata (managed automatically)';
  }
  const type = block.type ?? 'Block';
  if (type === 'image' || type === 'audio' || type === 'youtube') {
    const src = String(block.attrs?.src ?? block.attrs?.url ?? '');
    if (type !== 'youtube' && src) {
      try {
        const url = new URL(String(stableMediaUrl(src)));
        const path = decodeURIComponent(url.pathname.split('/').slice(-2).join('/'));
        return `${type}: ${path || 'Notion media'}`;
      } catch {
        return `${type}: Notion media`;
      }
    }
    return `${type}: ${src || 'media'}`;
  }
  const text = textFrom(block).trim();
  return text || (type === 'horizontalRule' ? 'Divider' : type);
}

function textFrom(block: DocumentContent): string {
  return (block.text ?? '') + (block.content ?? []).map(textFrom).join('');
}

function diffParts(local?: DocumentContent, notion?: DocumentContent): DiffPart[] {
  const before = displayBlock(local);
  const after = displayBlock(notion);
  if (before === after) return [{ kind: 'context', text: before }];

  const left = before.match(/\s+|[^\s]+/g) ?? [];
  const right = after.match(/\s+|[^\s]+/g) ?? [];
  if (left.length * right.length > 160_000) {
    return [
      { kind: 'removed', text: before },
      { kind: 'added', text: after },
    ];
  }

  const width = right.length + 1;
  const table = new Uint32Array((left.length + 1) * width);
  for (let row = left.length - 1; row >= 0; row -= 1) {
    for (let column = right.length - 1; column >= 0; column -= 1) {
      const cell = row * width + column;
      table[cell] = left[row] === right[column]
        ? table[(row + 1) * width + column + 1] + 1
        : Math.max(table[(row + 1) * width + column], table[row * width + column + 1]);
    }
  }

  const operations: DiffPart[] = [];
  let row = 0;
  let column = 0;
  while (row < left.length || column < right.length) {
    let kind: DiffPart['kind'];
    let text: string;
    if (row < left.length && column < right.length && left[row] === right[column]) {
      kind = 'context';
      text = left[row++];
      column += 1;
    } else if (
      row < left.length &&
      (column >= right.length || table[(row + 1) * width + column] >= table[row * width + column + 1])
    ) {
      kind = 'removed';
      text = left[row++];
    } else {
      kind = 'added';
      text = right[column++];
    }
    const previous = operations.at(-1);
    if (previous?.kind === kind) previous.text += text;
    else operations.push({ kind, text });
  }
  return operations;
}

function resolve() {
  const chosen: DocumentContent[] = [];
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
    if (row.local && row.notion && row.changed) {
      if (row.choice === 'local') {
        chosen.push(markBlock(row.local, remoteBlockId(row.notion)));
      } else if (row.choice === 'notion') {
        chosen.push(markBlock(row.notion, remoteBlockId(row.notion)));
      }
      continue;
    }
    if (row.local) chosen.push(row.local);
    else if (row.notion) chosen.push(row.notion);
  }

  const merged = normalizeInkwellBlockIds({
    type: props.conflict.localContent.type ?? 'doc',
    attrs: {
      inkwellConflictResolution: true,
      inkwellPreserveRemoteBlocks: Boolean(props.conflict.remoteContent),
    },
    // Applying the merge confirms every block in the reviewed snapshot,
    // including Notion-only blocks that the modal preserves automatically.
    content: chosen.map((block) => ({
      ...block,
      attrs: {
        ...block.attrs,
        inkwellConflictResolution: true,
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
      inkwellConflictResolution: true,
    },
  };
}
</script>

<template>
  <div class="modal-backdrop sync-conflict-backdrop" role="dialog" aria-modal="true" aria-labelledby="sync-conflict-title">
    <section class="modal sync-conflict-modal" :class="{ 'has-error': error }">
      <h2 id="sync-conflict-title">Merge sync changes</h2>
      <p v-if="error" class="sync-conflict-error" role="alert">{{ error }}</p>
      <p>{{ conflict.targetTitle }} has content that needs review. New blocks are preserved; exact duplicates require a choice, and blocks changed on both sides show a diff.</p>

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
              <strong>Inkwell</strong>
              <pre>{{ displayBlock(row.local) }}</pre>
            </div>
            <div v-if="row.notion && !row.internal" class="sync-conflict-side">
              <strong>Notion</strong>
              <pre>{{ displayBlock(row.notion) }}</pre>
            </div>
            <p v-if="row.internal" class="sync-conflict-internal">Project source metadata will be preserved automatically.</p>
          </div>
          <div v-if="row.bothEdited && row.local && row.notion && !row.internal" class="sync-conflict-diff-wrap">
            <p>Both sides changed since the last shared version. Review the diff, then choose one version.</p>
            <div class="sync-conflict-diff-legend"><span class="removed">− Inkwell</span><span class="added">+ Notion</span></div>
            <pre class="sync-conflict-diff"><span v-for="(part, index) in diffParts(row.local, row.notion)" :key="index" :class="part.kind">{{ part.text }}</span></pre>
          </div>
          <p v-else-if="row.duplicate" class="sync-conflict-duplicate">
            These new blocks have identical content. Keep one copy or keep both.
          </p>
          <fieldset v-if="row.local && row.notion && row.changed && !row.duplicate && !row.internal" class="sync-conflict-choices">
            <legend>Choose this block’s version</legend>
            <label><input v-model="row.choice" type="radio" value="local" /> Keep Inkwell</label>
            <label><input v-model="row.choice" type="radio" value="notion" /> Keep Notion</label>
          </fieldset>
          <fieldset v-else-if="row.duplicate" class="sync-conflict-choices">
            <legend>Resolve duplicate</legend>
            <label><input v-model="row.choice" type="radio" value="local" /> Keep Inkwell copy</label>
            <label><input v-model="row.choice" type="radio" value="notion" /> Keep Notion copy</label>
            <label><input v-model="row.choice" type="radio" value="both" /> Keep both</label>
          </fieldset>
          <p v-else-if="row.notion && !row.local && !row.internal" class="sync-conflict-keep-remote">
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
          <span>{{ busy ? 'Syncing merge...' : 'Apply merge' }}</span>
        </button>
      </div>
    </section>
  </div>
</template>
