import { describe, expect, it } from 'vitest';
import {
  projectStateSourceBlockIds,
  pruneOrphanedProjectStateSources,
  SOURCE_ENTRY_PREFIX,
} from '@/src/lib/projectStateSources';
import type { DocumentContent } from '@/src/types/capture';

const codeBlock = (text: string): DocumentContent => ({
  type: 'codeBlock',
  content: [{ type: 'text', text }],
});

describe('project state source cleanup', () => {
  it('removes orphaned current source entries and retains live ones', () => {
    const liveEntry = codeBlock(`${SOURCE_ENTRY_PREFIX}{"blockId":"live","source":{}}`);
    const deletedEntry = codeBlock(`${SOURCE_ENTRY_PREFIX}{"blockId":"deleted","source":{}}`);
    const state = { type: 'doc', content: [liveEntry, deletedEntry] };

    const pruned = pruneOrphanedProjectStateSources(state, new Set(['live']));

    expect(pruned.content).toEqual([liveEntry]);
    expect(projectStateSourceBlockIds(pruned.content![0]!)).toEqual(['live']);
  });

  it('leaves malformed, unrelated, and retired entries untouched', () => {
    const malformedEntry = codeBlock(`${SOURCE_ENTRY_PREFIX}{`);
    const retiredV2Entry = codeBlock('jottathing_source_v2:{"i":"old","s":{}}');
    const note = { type: 'paragraph' };
    const state = { type: 'doc', content: [malformedEntry, retiredV2Entry, note] };

    expect(pruneOrphanedProjectStateSources(state, new Set())).toBe(state);
    expect(projectStateSourceBlockIds(retiredV2Entry)).toEqual([]);
  });
});
