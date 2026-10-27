import { describe, expect, it } from 'vitest';
import { isUpdateCompatible } from '@/apps/worker/src/managedBlockIdentity';
import type { BlockMapping, NotionBlockPayload } from '@/apps/worker/src/types';

function mapping(type: string): BlockMapping {
  return {
    jottathingBlockId: 'local-heading',
    kind: 'heading',
    lastSyncedHash: 'previous',
    localNodeId: 'local-heading',
    localPageId: 'local-page',
    newState: { object: 'block', type },
    notionBlockId: 'remote-heading',
    oldState: null,
    order: 0,
  };
}

function desired(type: string) {
  const notionBlock: NotionBlockPayload = { object: 'block', type };
  return {
    jottathingBlockId: 'local-heading',
    kind: 'heading',
    lastSyncedHash: 'next',
    localNodeId: 'local-heading',
    localPageId: 'local-page',
    notionBlock,
    order: 0,
  };
}

describe('managed heading block identity', () => {
  it('does not update an existing heading block to a different heading type', () => {
    expect(isUpdateCompatible(mapping('heading_1'), desired('heading_2'))).toBe(false);
  });

  it('allows an in-place update when a heading keeps its exact type', () => {
    expect(isUpdateCompatible(mapping('heading_4'), desired('heading_4'))).toBe(true);
  });
});
