import { describe, expect, it, vi } from 'vitest';
import { createWorkerInstallationState } from '@/apps/worker/src/services/workerInstallationState';
import type { WorkerStore } from '@/apps/worker/src/types';

const store = {
  blockMappings: {},
  ignoredInkwellDatabaseIds: new Set<string>(),
  inkwellDatabase: undefined,
  inkwellRootPage: undefined,
  installationId: 42,
  logs: [],
  notePages: {},
  parentPages: {},
  projectBlocks: {},
  projectPages: {},
  threadBlocks: {},
  tokens: { access_token: 'captured-before-logout' },
} satisfies WorkerStore;

function createState(getActiveInstallationWithTokensById: ReturnType<typeof vi.fn>) {
  return createWorkerInstallationState({
    auth: { getActiveInstallationWithTokensById } as never,
    cookieName: 'inkwell_session',
    readInkwellSyncState: async () => ({} as WorkerStore),
    readStore: () => ({} as WorkerStore),
  });
}

describe('installation checks under the sync mutation lock', () => {
  it('rejects a request when logout revoked its installation while it waited', async () => {
    const getActiveInstallationWithTokensById = vi.fn(async () => undefined);
    const state = createState(getActiveInstallationWithTokensById);
    const operation = vi.fn(async () => 'should not run');

    await expect(state.withFreshInstallationStore(store, operation))
      .rejects.toMatchObject({ status: 409, code: 'installation_revoked' });

    expect(getActiveInstallationWithTokensById).toHaveBeenCalledWith(42);
    expect(operation).not.toHaveBeenCalled();
  });

  it('uses the currently stored access token after revalidating the installation', async () => {
    const getActiveInstallationWithTokensById = vi.fn(async () => ({
      id: 42,
      workspace_id: 'workspace-1',
      workspace_name: 'Workspace',
      tokens: { access_token: 'current-token' },
    }));
    const state = createState(getActiveInstallationWithTokensById);
    const operation = vi.fn(async (freshStore: WorkerStore) => freshStore.tokens?.access_token);

    await expect(state.withFreshInstallationStore(store, operation))
      .resolves.toBe('current-token');

    expect(operation).toHaveBeenCalledOnce();
  });
});
