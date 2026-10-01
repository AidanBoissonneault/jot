import { describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { createAuth } from '@/apps/worker/src/auth';
import { hash } from '@/apps/worker/src/workerUtils';
import type { WorkerSupabaseClient } from '@/apps/worker/src/types';

type DbCall = { args: unknown[]; method: string; table: string };

function fakeSupabase(failTable?: string) {
  const calls: DbCall[] = [];
  const rpcError = failTable === 'rpc' ? new Error('database failure') : null;
  const client = {
    from(table: string) {
      const error = failTable === table ? new Error('database failure') : null;
      const builder: Record<string, unknown> & {
        then: (resolve: (value: unknown) => unknown, reject: (reason: unknown) => unknown) => Promise<unknown>;
      } = {
        select: (...args: unknown[]) => { calls.push({ table, method: 'select', args }); return builder; },
        eq: (...args: unknown[]) => { calls.push({ table, method: 'eq', args }); return builder; },
        limit: (...args: unknown[]) => { calls.push({ table, method: 'limit', args }); return builder; },
        update: (...args: unknown[]) => { calls.push({ table, method: 'update', args }); return builder; },
        delete: (...args: unknown[]) => { calls.push({ table, method: 'delete', args }); return builder; },
        insert: (...args: unknown[]) => { calls.push({ table, method: 'insert', args }); return builder; },
        upsert: (...args: unknown[]) => { calls.push({ table, method: 'upsert', args }); return builder; },
        or: (...args: unknown[]) => { calls.push({ table, method: 'or', args }); return builder; },
        maybeSingle: async () => ({ data: null, error }),
        single: async () => ({
          data: table === 'inkwell_oauth_generation' ? { generation: '7' } : { id: 42 },
          error,
        }),
        then: (resolve, reject) => Promise.resolve({ data: null, error }).then(resolve, reject),
      };
      return builder;
    },
    async rpc(functionName: string, args: unknown) {
      calls.push({ table: 'rpc', method: functionName, args: [args] });
      const rpcArgs = args as Record<string, unknown>;
      const data = functionName === 'commit_notion_oauth_session'
        ? 42
        : functionName === 'prepare_inkwell_connection_deletion'
          ? {
              request_id_hash: rpcArgs.p_request_id_hash,
              user_id: rpcArgs.p_user_id,
              status: 'pending',
              notion_token_revoked: false,
            }
          : true;
      return { data, error: rpcError };
    },
  };
  return { calls, client: client as unknown as WorkerSupabaseClient };
}

describe('server authentication data lifecycle', () => {
  it('clears only the matching user’s Notion access and refresh tokens on logout', async () => {
    const { calls, client } = fakeSupabase();
    await createAuth(client).clearNotionAccountTokens('notion:user-42');

    expect(calls).toContainEqual({
      table: 'account', method: 'update', args: [{ accessToken: null, refreshToken: null }],
    });
    expect(calls.filter((call) => call.table === 'account' && call.method === 'eq')).toEqual([
      { table: 'account', method: 'eq', args: ['userId', 'notion:user-42'] },
      { table: 'account', method: 'eq', args: ['providerId', 'notion'] },
    ]);
    await expect(createAuth(fakeSupabase('account').client).clearNotionAccountTokens('notion:user-42'))
      .rejects.toThrow('Unable to remove the stored Notion credentials.');
  });

  it('reads the signed OAuth generation from the service-only version row', async () => {
    const { calls, client } = fakeSupabase();
    await expect(createAuth(client).getNotionOAuthGeneration()).resolves.toBe('7');
    expect(calls).toContainEqual({
      table: 'inkwell_oauth_generation', method: 'select', args: ['generation'],
    });
    expect(calls).toContainEqual({ table: 'inkwell_oauth_generation', method: 'eq', args: ['id', 1] });
    await expect(createAuth(fakeSupabase('inkwell_oauth_generation').client).getNotionOAuthGeneration())
      .rejects.toThrow('Unable to start a secure Notion connection.');
  });

  it('revokes queued sync access without deleting the installation row', async () => {
    const { calls, client } = fakeSupabase();
    await createAuth(client).revokeInstallation('notion:user-42');

    expect(calls).toContainEqual({
      table: 'notion_installations',
      method: 'update',
      args: [expect.objectContaining({ active: 0, revoked_at: expect.any(String) })],
    });
    expect(calls).toContainEqual({
      table: 'notion_installations',
      method: 'eq',
      args: ['user_id', 'notion:user-42'],
    });
    await expect(createAuth(fakeSupabase('notion_installations').client).revokeInstallation('notion:user-42'))
      .rejects.toThrow('Unable to revoke the Notion installation.');
  });

  it('revalidates a sync installation by ID and rejects an inactive row', async () => {
    const { calls, client } = fakeSupabase();

    await expect(createAuth(client).getActiveInstallationWithTokensById(42))
      .resolves.toBeUndefined();

    expect(calls).toContainEqual({
      table: 'notion_installations', method: 'eq', args: ['id', 42],
    });
    expect(calls).toContainEqual({
      table: 'notion_installations', method: 'eq', args: ['active', 1],
    });
    expect(calls.some((call) => call.table === 'account')).toBe(false);
  });

  it('commits the account and session by stable Notion user ID without linking by email', async () => {
    const { calls, client } = fakeSupabase();
    const auth = createAuth(client);
    const result = await auth.createNotionSession({
      userId: 'notion:user-42',
      notionAccountId: 'user-42',
      accessToken: 'notion-access-token-test',
      refreshToken: 'notion-refresh-token-test',
      workspaceId: 'workspace-1',
      workspaceName: 'Workspace',
      user: { id: 'user-42', email: 'same@example.test', name: 'Notion user', image: null },
      ipAddress: null,
      userAgent: null,
      sessionToken: 'session-token-test',
      sessionId: 'session-id-test',
      SESSION_MAX_AGE_SECONDS: 1800,
      oauthGeneration: '7',
    });

    const commit = calls.find((call) => call.method === 'commit_notion_oauth_session');
    expect(commit).toBeDefined();
    expect(commit?.args[0]).toMatchObject({
      p_user_id: 'notion:user-42',
      p_account_id: 'notion:user-42',
      p_session_token_hash: hash('session-token-test'),
      p_access_token: 'notion-access-token-test',
    });
    expect((commit?.args[0] as Record<string, unknown>).p_session_token_hash).not.toBe('session-token-test');
    expect(result.installationId).toBe(42);
    expect(result.sessionToken).toBe('session-token-test');
    expect(calls.filter((call) => call.table !== 'rpc')).toEqual([]);
  });

  it('retries the atomic OAuth commit after a lost or failed response', async () => {
    const { client } = fakeSupabase('rpc');
    const rpc = vi.spyOn(client, 'rpc');
    rpc.mockResolvedValueOnce({ data: null, error: new Error('response interrupted') } as never);
    rpc.mockResolvedValueOnce({ data: 42, error: null } as never);

    await expect(createAuth(client).createNotionSession({
      userId: 'notion:user-42',
      notionAccountId: 'user-42',
      accessToken: 'notion-access-token-test',
      refreshToken: 'notion-refresh-token-test',
      workspaceId: 'workspace-1',
      workspaceName: 'Workspace',
      user: { id: 'user-42', email: 'same@example.test', name: 'Notion user', image: null },
      ipAddress: null,
      userAgent: null,
      sessionToken: 'session-token-test',
      sessionId: 'session-id-test',
      SESSION_MAX_AGE_SECONDS: 1800,
      oauthGeneration: '7',
    })).resolves.toMatchObject({ installationId: 42 });
    expect(rpc).toHaveBeenCalledTimes(2);
    expect(rpc.mock.calls[0][1]).toEqual(rpc.mock.calls[1][1]);
  });

  it('defines OAuth persistence as one idempotent, service-role-only database transaction', () => {
    const migration = readFileSync(
      new URL('../apps/worker/migrations/008_atomic_notion_oauth_session.sql', import.meta.url),
      'utf8',
    );
    const insertSession = migration.indexOf('INSERT INTO public.session AS new_session');
    const removeOldSessions = migration.indexOf('DELETE FROM public.session AS old_session');

    expect(migration).toContain('CREATE OR REPLACE FUNCTION public.commit_notion_oauth_session(');
    expect(migration).toContain('SECURITY INVOKER');
    expect(migration).toContain('SET search_path = pg_catalog, public, pg_temp');
    expect(migration).toContain('public."user"');
    expect(migration).toContain('public.account');
    expect(migration).toContain('public.notion_installations');
    expect(migration).toContain('public.inkwell_sync_state');
    expect(migration).toContain('v_existing_token IS DISTINCT FROM p_session_token_hash');
    expect(insertSession).toBeGreaterThanOrEqual(0);
    expect(removeOldSessions).toBeGreaterThan(insertSession);
    expect(migration).toContain('REVOKE ALL ON FUNCTION public.commit_notion_oauth_session(');
    expect(migration).toContain('TO service_role');
  });

  it('completes account deletion through the atomic receipt RPC', async () => {
    const { calls, client } = fakeSupabase();
    const requestIdHash = 'a'.repeat(64);

    await createAuth(client).completeConnectionDeletionReceipt(requestIdHash);

    expect(calls).toContainEqual({
      table: 'rpc',
      method: 'complete_inkwell_connection_deletion',
      args: [{ p_request_id_hash: requestIdHash }],
    });
    await expect(createAuth(fakeSupabase('rpc').client).completeConnectionDeletionReceipt(requestIdHash))
      .rejects.toThrow('Unable to complete the Inkwell connection deletion.');
  });

  it('prepares deletion under the OAuth serialization transaction', async () => {
    const { calls, client } = fakeSupabase();
    const requestIdHash = 'b'.repeat(64);

    await expect(createAuth(client).prepareConnectionDeletionReceipt(requestIdHash, 'notion:user-42'))
      .resolves.toEqual({
        requestIdHash,
        userId: 'notion:user-42',
        status: 'pending',
        notionTokenRevoked: false,
      });

    expect(calls).toContainEqual({
      table: 'rpc',
      method: 'prepare_inkwell_connection_deletion',
      args: [{ p_request_id_hash: requestIdHash, p_user_id: 'notion:user-42' }],
    });
    await expect(createAuth(fakeSupabase('rpc').client)
      .prepareConnectionDeletionReceipt(requestIdHash, 'notion:user-42'))
      .rejects.toThrow('Unable to prepare the connection deletion.');
  });

  it('serializes OAuth persistence against pending connection deletion', () => {
    const migration = readFileSync(
      new URL('../apps/worker/migrations/009_serialize_connection_deletion.sql', import.meta.url),
      'utf8',
    );
    const oauthFunction = migration.slice(
      migration.indexOf('CREATE OR REPLACE FUNCTION public.commit_notion_oauth_session('),
    );
    const lock = oauthFunction.indexOf('pg_advisory_xact_lock');
    const pendingCheck = oauthFunction.indexOf("receipt.status = 'pending'");
    const persistUser = oauthFunction.indexOf('INSERT INTO public."user"');

    expect(migration).toContain('CREATE OR REPLACE FUNCTION public.prepare_inkwell_connection_deletion(');
    expect(migration).toContain('CREATE TABLE IF NOT EXISTS public.inkwell_oauth_generation');
    expect(migration).toContain('UPDATE public.notion_installations');
    expect(migration).toContain('CREATE OR REPLACE FUNCTION public.commit_notion_oauth_session(');
    expect(lock).toBeGreaterThanOrEqual(0);
    expect(pendingCheck).toBeGreaterThan(lock);
    expect(persistUser).toBeGreaterThan(pendingCheck);
    expect(oauthFunction).toContain('FOR SHARE');
    expect(oauthFunction).toContain('IS DISTINCT FROM p_oauth_generation');
    expect(migration).toContain('DROP FUNCTION IF EXISTS public.commit_notion_oauth_session(');
    expect(migration.match(/generation = generation \+ 1/g)).toHaveLength(1);
    expect(migration).toContain('CREATE OR REPLACE FUNCTION public.complete_inkwell_connection_deletion(');
    expect(migration).toContain('REVOKE ALL ON FUNCTION public.prepare_inkwell_connection_deletion(TEXT, TEXT)');
    expect(migration).toContain('TO service_role');
  });
});
