import { afterEach, describe, expect, it, vi } from 'vitest';
import { ref } from 'vue';
import { useNotionConnection } from '@/entrypoints/sidepanel/composables/useNotionConnection';
import type { useInkwellStore } from '@/src/stores/inkwell';

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('Notion connection controls', () => {
  it('requires the owning account and confirmation before deleting local and cloud data', async () => {
    const store = {
      syncConfig: {
        authenticated: true,
        userId: 'notion:current-user',
        syncQueueOwnerUserId: 'notion:original-user',
      },
      errorMessage: '',
      deleteConnection: vi.fn(async () => ({ notionTokenRevoked: true })),
    } as unknown as ReturnType<typeof useInkwellStore>;
    const confirm = vi.fn(() => false);
    vi.stubGlobal('window', { clearInterval: vi.fn(), confirm });

    const connection = useNotionConnection(store, ref('editor'), ref(''));
    await connection.deleteConnection();

    expect(confirm).not.toHaveBeenCalled();
    expect(store.deleteConnection).not.toHaveBeenCalled();
  });

  it('prepares local writes and resets editor state after a confirmed deletion', async () => {
    const order: string[] = [];
    const store = {
      syncConfig: {
        authenticated: true,
        userId: 'notion:current-user',
        syncQueueOwnerUserId: 'notion:current-user',
      },
      errorMessage: '',
      deleteConnection: vi.fn(async () => {
        order.push('server-and-local-delete');
        return { notionTokenRevoked: true };
      }),
    } as unknown as ReturnType<typeof useInkwellStore>;
    vi.stubGlobal('window', { clearInterval: vi.fn(), confirm: () => true });

    const connection = useNotionConnection(
      store,
      ref('editor'),
      ref(''),
      async () => { order.push('flush-editor-and-pause-writes'); },
      () => { order.push('reset-editor'); },
    );
    await connection.deleteConnection();

    expect(order).toEqual([
      'flush-editor-and-pause-writes',
      'server-and-local-delete',
      'reset-editor',
    ]);
    expect(connection.isDeletingConnection.value).toBe(false);
  });
});
