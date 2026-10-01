import { afterEach, describe, expect, it, vi } from 'vitest';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import {
  computeHmacSignature,
  notionOAuthGenerationFromState,
  revokeNotionToken,
  verifyNotionWebhookSignature,
} from '@/apps/worker/src/notionAuth';
import { app as workerApp } from '@/apps/worker/src/worker';
import { initSingletons } from '@/apps/worker/src/services/workerRuntime';
import { isTrustedOrigin, MAX_SYNC_JSON_REQUEST_BYTES, readLimitedJsonBody } from '@/apps/worker/src/workerUtils';
import type { WorkerEnv } from '@/apps/worker/src/types';

const env = {
  WORKER_URL: 'https://sync.example.test',
  INKWELL_EXTENSION_ORIGIN: 'chrome-extension://inkwelldevextension',
  TRUSTED_ORIGINS: 'http://localhost:3000, https://sidepanel.example.test/path',
  NOTION_OAUTH_CLIENT_ID: 'client-id-test',
  NOTION_OAUTH_CLIENT_SECRET: 'client-secret-test',
  NOTION_VERSION: '2026-03-11',
  NOTION_WEBHOOK_SECRET: 'webhook-secret-test',
  NOTION_WEBHOOK_SETUP_TOKEN: 'setup-bearer-token-0123456789012345',
  SUPABASE_URL: 'https://supabase.example.test',
  SUPABASE_SERVICE_KEY: 'service-role-test-key',
} as WorkerEnv;

interface FakeWebhookDatabase {
  armed: boolean;
  callbackTokenHash: string | null;
  failStaleUpdate?: boolean;
  mappedPage?: boolean;
  retrieved: boolean;
  token: string | null;
}

function stubWebhookDatabase(database: FakeWebhookDatabase): void {
  vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(input instanceof Request ? input.url : String(input));
    const method = init?.method ?? (input instanceof Request ? input.method : 'GET');
    const bodyText = typeof init?.body === 'string'
      ? init.body
      : input instanceof Request
        ? await input.clone().text()
        : '{}';
    const body = JSON.parse(bodyText || '{}') as Record<string, unknown>;

    if (url.pathname.endsWith('/rpc/arm_notion_webhook_setup')) {
      const armed = database.token === null;
      database.armed = armed;
      if (armed && typeof body.p_callback_token_hash === 'string') {
        database.callbackTokenHash = body.p_callback_token_hash;
      }
      return new Response(JSON.stringify(armed), { headers: { 'Content-Type': 'application/json' } });
    }
    if (url.pathname.endsWith('/rpc/register_notion_webhook_verification_token')) {
      const token = body.p_token;
      const accepted = typeof token === 'string' && (
        (database.token === token && body.p_callback_token_hash === database.callbackTokenHash) ||
        (database.token === null && database.armed && body.p_callback_token_hash === database.callbackTokenHash)
      );
      if (accepted && database.token === null) {
        database.token = token as string;
        database.armed = false;
      }
      return new Response(JSON.stringify(accepted), { headers: { 'Content-Type': 'application/json' } });
    }
    if (url.pathname.endsWith('/rpc/consume_notion_webhook_verification_token')) {
      const token = database.token && !database.retrieved ? database.token : null;
      if (token) database.retrieved = true;
      return new Response(JSON.stringify(token), { headers: { 'Content-Type': 'application/json' } });
    }
    if (url.pathname.endsWith('/rpc/reset_notion_webhook_setup')) {
      database.token = null;
      database.callbackTokenHash = null;
      database.retrieved = false;
      database.armed = false;
      return new Response('true', { headers: { 'Content-Type': 'application/json' } });
    }
    if (url.pathname.endsWith('/notion_webhook_setup')) {
      const result = {
        verification_token: database.token,
        setup_callback_token_hash: database.callbackTokenHash,
      };
      return new Response(JSON.stringify(result), { headers: { 'Content-Type': 'application/json' } });
    }
    if (url.pathname.endsWith('/notion_block_sync')) {
      if (method === 'PATCH' && database.failStaleUpdate) {
        return new Response(JSON.stringify({ message: 'database failure' }), { status: 500 });
      }
      if (method === 'GET' && database.mappedPage) {
        return new Response(JSON.stringify([{ installation_id: 42, local_id: 'local-page-secret-id' }]), {
          headers: { 'Content-Type': 'application/json' },
        });
      }
      return new Response('[]', { headers: { 'Content-Type': 'application/json' } });
    }
    if (url.pathname.endsWith('/rpc/increment_block_version')) {
      return new Response('1', { headers: { 'Content-Type': 'application/json' } });
    }
    return new Response('{}', { status: 404, headers: { 'Content-Type': 'application/json' } });
  }));
}

function initializeWebhookRoutes(database: FakeWebhookDatabase): void {
  stubWebhookDatabase(database);
  initSingletons(env);
}

function stubAuthenticatedInkwellSession(sessionToken: string, accountId: string): void {
  vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL) => {
    const url = new URL(input instanceof Request ? input.url : String(input));
    if (url.pathname.endsWith('/session')) {
      return new Response(JSON.stringify([{
        id: 'session-id-account-binding-test',
        token: createHash('sha256').update(sessionToken).digest('hex'),
        expiresAt: new Date(Date.now() + 60_000).toISOString(),
        userId: accountId,
        user: { id: accountId, name: 'Test user', email: 'test@example.test', image: null, emailVerified: false },
      }]), { headers: { 'Content-Type': 'application/json' } });
    }
    return new Response('[]', { headers: { 'Content-Type': 'application/json' } });
  }));
  initSingletons(env);
}

afterEach(() => vi.unstubAllGlobals());

describe('Notion OAuth generation binding', () => {
  it('carries the signed database generation from OAuth start into the atomic commit', async () => {
    let commitBody: Record<string, unknown> | undefined;
    vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = new URL(input instanceof Request ? input.url : String(input));
      if (url.hostname === 'api.notion.com' && url.pathname === '/v1/oauth/token') {
        return new Response(JSON.stringify({
          access_token: 'notion-access-test',
          refresh_token: 'notion-refresh-test',
          owner: { user: { id: 'oauth-user-42', name: 'OAuth user', person: { email: 'oauth@example.test' } } },
          workspace_id: 'workspace-42',
          workspace_name: 'OAuth workspace',
        }), { headers: { 'Content-Type': 'application/json' } });
      }
      if (url.pathname.endsWith('/inkwell_oauth_generation')) {
        return new Response(JSON.stringify({ generation: '7' }), { headers: { 'Content-Type': 'application/json' } });
      }
      if (url.pathname.endsWith('/rpc/commit_notion_oauth_session')) {
        commitBody = JSON.parse(String(init?.body)) as Record<string, unknown>;
        return new Response('42', { headers: { 'Content-Type': 'application/json' } });
      }
      return new Response('[]', { headers: { 'Content-Type': 'application/json' } });
    }));
    initSingletons(env);

    const start = await workerApp.request('/auth/notion/start', {}, env);
    expect(start.status).toBe(302);
    const authorizeUrl = new URL(start.headers.get('location')!);
    const state = authorizeUrl.searchParams.get('state')!;
    const cookie = start.headers.get('set-cookie')!;
    const stateCookie = decodeURIComponent(cookie.match(/inkwell_notion_oauth_state=([^;]+)/)![1]);
    expect(stateCookie).toBe(state);
    await expect(notionOAuthGenerationFromState(env.NOTION_OAUTH_CLIENT_SECRET!, state)).resolves.toBe('7');

    const callback = await workerApp.request(
      `/auth/notion/callback?code=authorization-code&state=${encodeURIComponent(state)}`,
      { headers: { Cookie: `inkwell_notion_oauth_state=${stateCookie}` } },
      env,
    );

    expect(callback.status).toBe(200);
    expect(commitBody).toMatchObject({ p_oauth_generation: '7', p_user_id: 'notion:oauth-user-42' });
  });

  it('rejects a modified OAuth state before exchanging a code', async () => {
    const fetchMock = vi.fn(async () => new Response('{}', { status: 200 }));
    vi.stubGlobal('fetch', fetchMock);
    initSingletons(env);
    const state = 'v1.7.abcdefghijklmnopqrstuvwx12345678.' + 'a'.repeat(64);
    const response = await workerApp.request(
      `/auth/notion/callback?code=authorization-code&state=${state}`,
      { headers: { Cookie: `inkwell_notion_oauth_state=${state}` } },
      env,
    );
    expect(response.status).toBe(400);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('revokes a newly exchanged token when deletion invalidates its OAuth generation', async () => {
    let generation = '7';
    const revokedTokens: string[] = [];
    vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = new URL(input instanceof Request ? input.url : String(input));
      if (url.hostname === 'api.notion.com' && url.pathname === '/v1/oauth/token') {
        return new Response(JSON.stringify({
          access_token: 'stale-oauth-access-token',
          owner: { user: { id: 'oauth-user-42', person: { email: 'oauth@example.test' } } },
        }), { headers: { 'Content-Type': 'application/json' } });
      }
      if (url.hostname === 'api.notion.com' && url.pathname === '/v1/oauth/revoke') {
        revokedTokens.push((JSON.parse(String(init?.body)) as { token: string }).token);
        return new Response('{}', { status: 200 });
      }
      if (url.pathname.endsWith('/inkwell_oauth_generation')) {
        return new Response(JSON.stringify({ generation }), { headers: { 'Content-Type': 'application/json' } });
      }
      if (url.pathname.endsWith('/rpc/commit_notion_oauth_session')) {
        const body = JSON.parse(String(init?.body)) as { p_oauth_generation: string };
        return body.p_oauth_generation === generation
          ? new Response('42', { headers: { 'Content-Type': 'application/json' } })
          : new Response(JSON.stringify({ message: 'OAuth generation was invalidated.' }), {
              status: 400,
              headers: { 'Content-Type': 'application/json' },
            });
      }
      return new Response('[]', { headers: { 'Content-Type': 'application/json' } });
    }));
    initSingletons(env);

    const start = await workerApp.request('/auth/notion/start', {}, env);
    const state = new URL(start.headers.get('location')!).searchParams.get('state')!;
    const cookie = decodeURIComponent(start.headers.get('set-cookie')!.match(/inkwell_notion_oauth_state=([^;]+)/)![1]);
    generation = '8';
    const callback = await workerApp.request(
      `/auth/notion/callback?code=authorization-code&state=${encodeURIComponent(state)}`,
      { headers: { Cookie: `inkwell_notion_oauth_state=${cookie}` } },
      env,
    );

    expect(callback.status).toBe(500);
    expect(revokedTokens).toEqual(['stale-oauth-access-token']);
  });
});

describe('worker request origin policy', () => {
  it('adds security headers without preventing the intended YouTube embed', async () => {
    const page = await workerApp.request('/terms', {}, env);
    expect(page.headers.get('x-content-type-options')).toBe('nosniff');
    expect(page.headers.get('referrer-policy')).toBe('no-referrer');
    expect(page.headers.get('cache-control')).toBe('no-store');
    expect(page.headers.get('x-frame-options')).toBe('DENY');
    expect(page.headers.get('strict-transport-security')).toBe('max-age=31536000');

    const localPage = await workerApp.request('/terms', {}, {
      ...env,
      WORKER_URL: 'http://localhost:8787',
    } as WorkerEnv);
    expect(localPage.headers.get('strict-transport-security')).toBeNull();

    const embed = await workerApp.request(
      '/youtube/embed?src=https%3A%2F%2Fwww.youtube.com%2Fwatch%3Fv%3DdQw4w9WgXcQ',
      {},
      env,
    );
    expect(embed.status).toBe(200);
    expect(embed.headers.get('x-frame-options')).toBeNull();
    expect(embed.headers.get('content-security-policy')).toContain('youtube-nocookie.com');
  });

  it('allows only configured extension and web origins', () => {
    expect(isTrustedOrigin(env, 'chrome-extension://inkwelldevextension')).toBe(true);
    expect(isTrustedOrigin(env, 'http://localhost:3000')).toBe(true);
    expect(isTrustedOrigin(env, 'https://sidepanel.example.test')).toBe(true);
    expect(isTrustedOrigin(env, 'https://sync.example.test')).toBe(true);
  });

  it('rejects missing, malformed, and lookalike origins', () => {
    expect(isTrustedOrigin(env, undefined)).toBe(false);
    expect(isTrustedOrigin(env, 'chrome-extension://otherextension')).toBe(false);
    expect(isTrustedOrigin(env, 'chrome-extension://inkwelldevextension.evil')).toBe(false);
    expect(isTrustedOrigin(env, 'https://sync.example.test.evil')).toBe(false);
    expect(isTrustedOrigin(env, 'null')).toBe(false);
  });

  it('bounds JSON bodies when Content-Length is missing', async () => {
    const request = new Request('https://sync.example.test/sync/push', {
      method: 'POST',
      body: 'x'.repeat(33),
    });

    const result = await readLimitedJsonBody(request, 32);

    expect(result).toEqual({ body: null, tooLarge: true });
  });

  it('rejects oversized authenticated sync requests before JSON parsing', async () => {
    const sessionToken = 'sync-size-session-token-test';
    const accountId = 'notion:sync-size-test';
    stubAuthenticatedInkwellSession(sessionToken, accountId);

    const response = await workerApp.request('/sync/push', {
      method: 'POST',
      headers: {
        Origin: 'http://localhost:3000',
        Cookie: `inkwell_session=${sessionToken}`,
        'X-Inkwell-Account': accountId,
        'Content-Type': 'application/json',
        'Content-Length': String(MAX_SYNC_JSON_REQUEST_BYTES + 1),
      },
      body: '{}',
    }, env);

    expect(response.status).toBe(413);
  });

  it('allows trusted browser preflight for the protected webhook reset endpoint', async () => {
    initializeWebhookRoutes({ armed: false, callbackTokenHash: null, retrieved: false, token: null });

    const response = await workerApp.request('/webhooks/notion/verification-token', {
      method: 'OPTIONS',
      headers: {
        Origin: 'http://localhost:3000',
        'Access-Control-Request-Method': 'DELETE',
        'Access-Control-Request-Headers': 'authorization, x-inkwell-account',
      },
    }, env);

    expect(response.status).toBe(204);
    expect(response.headers.get('access-control-allow-origin')).toBe('http://localhost:3000');
    expect(response.headers.get('access-control-allow-methods')).toContain('DELETE');
    expect(response.headers.get('access-control-allow-headers')).toContain('X-Inkwell-Account');
  });
});

describe('connected route authorization', () => {
  it('returns JSON authorization errors for routes without an Inkwell session', async () => {
    initializeWebhookRoutes({ armed: false, callbackTokenHash: null, retrieved: false, token: null });
    const headers = { Origin: 'http://localhost:3000' };

    const responses = await Promise.all([
      workerApp.request('/notion/pages', { headers }, env),
      workerApp.request('/sync/status?pageId=page-test', { headers }, env),
      workerApp.request('/logs', { headers }, env),
      workerApp.request('/sync/page/resync', {
        method: 'POST',
        headers: { ...headers, 'Content-Type': 'application/json' },
        body: JSON.stringify({ page: { id: 'page-test' }, project: { id: 'project-test' } }),
      }, env),
    ]);

    for (const response of responses) {
      expect(response.status).toBe(401);
      expect(response.headers.get('content-type')).toContain('application/json');
      await expect(response.json()).resolves.toMatchObject({ error: 'Unauthorized' });
    }
  });

  it('rejects sync requests when the cookie belongs to a different account than the queued data', async () => {
    const sessionToken = 'account-binding-session-token-test';
    const accountId = 'notion:new-account';
    stubAuthenticatedInkwellSession(sessionToken, accountId);

    const response = await workerApp.request('/sync/status?pageId=private-local-page', {
      headers: {
        Origin: 'http://localhost:3000',
        Cookie: `inkwell_session=${sessionToken}`,
        'X-Inkwell-Account': 'notion:original-account',
      },
    }, env);

    expect(response.status).toBe(409);
    await expect(response.json()).resolves.toMatchObject({ error: expect.stringContaining('account changed') });
  });

  it('expires the session cookie when logout is requested without a valid session', async () => {
    initializeWebhookRoutes({ armed: false, callbackTokenHash: null, retrieved: false, token: null });
    const response = await workerApp.request('/auth/notion/logout', {
      method: 'POST',
      headers: {
        Origin: 'http://localhost:3000',
        'Content-Type': 'application/json',
      },
      body: '{}',
    }, env);

    expect(response.status).toBe(401);
    expect(response.headers.get('set-cookie')).toContain('Max-Age=0');
    expect(await response.json()).toMatchObject({ error: 'Unauthorized' });
  });
});

describe('logout lifecycle route', () => {
  it('serializes logout, revokes the Notion token, and expires the cookie', async () => {
    const sessionToken = 'logout-session-token-test';
    const accountToken = 'logout-notion-token-test';
    const accountId = 'notion:user-42';
    const calls: Array<{ body: string; method: string; pathname: string }> = [];
    vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = new URL(input instanceof Request ? input.url : String(input));
      const method = init?.method ?? (input instanceof Request ? input.method : 'GET');
      const body = typeof init?.body === 'string'
        ? init.body
        : input instanceof Request
          ? await input.clone().text()
          : '';
      calls.push({ body, method, pathname: url.pathname });

      if (url.hostname === 'api.notion.com' && url.pathname === '/v1/oauth/revoke') {
        return new Response('{}', { status: 200 });
      }
      if (url.pathname.endsWith('/rpc/begin_inkwell_notion_logout')
        || url.pathname.endsWith('/rpc/complete_inkwell_notion_logout')) {
        return new Response('true', { headers: { 'Content-Type': 'application/json' } });
      }
      if (url.pathname.endsWith('/session') && method === 'GET') {
        return new Response(JSON.stringify([{
          id: 'session-id-test',
          token: createHash('sha256').update(sessionToken).digest('hex'),
          expiresAt: new Date(Date.now() + 60_000).toISOString(),
          userId: accountId,
          user: { id: accountId, name: 'Test user', email: 'test@example.test', image: null, emailVerified: false },
        }]), { headers: { 'Content-Type': 'application/json' } });
      }
      if (url.pathname.endsWith('/account') && method === 'GET') {
        return new Response(JSON.stringify([{ accessToken: accountToken, refreshToken: 'refresh-token-test' }]), {
          headers: { 'Content-Type': 'application/json' },
        });
      }
      if (['PATCH', 'DELETE'].includes(method)) return new Response(null, { status: 204 });
      return new Response('[]', { headers: { 'Content-Type': 'application/json' } });
    }));
    initSingletons(env);

    const response = await workerApp.request('/auth/notion/logout', {
      method: 'POST',
      headers: {
        Origin: 'http://localhost:3000',
        Cookie: `inkwell_session=${sessionToken}`,
        'Content-Type': 'application/json',
      },
      body: '{}',
    }, env);

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      connected: false,
      loggedOut: true,
      notionTokenRevoked: true,
      serverDataCleanupComplete: true,
      retryable: false,
    });
    expect(response.headers.get('set-cookie')).toContain('Max-Age=0');
    const beginIndex = calls.findIndex((call) => call.pathname.endsWith('/rpc/begin_inkwell_notion_logout'));
    const accountReadIndex = calls.findIndex((call) => call.pathname.endsWith('/account') && call.method === 'GET');
    const revokeIndex = calls.findIndex((call) => call.pathname === '/v1/oauth/revoke');
    const completeIndex = calls.findIndex((call) => call.pathname.endsWith('/rpc/complete_inkwell_notion_logout'));
    expect(beginIndex).toBeGreaterThanOrEqual(0);
    expect(accountReadIndex).toBeGreaterThan(beginIndex);
    expect(revokeIndex).toBeGreaterThan(accountReadIndex);
    expect(completeIndex).toBeGreaterThan(revokeIndex);
    expect(JSON.parse(calls[beginIndex].body)).toEqual({ p_user_id: accountId });
    expect(JSON.parse(calls[completeIndex].body)).toEqual({
      p_user_id: accountId,
      p_session_token_hash: createHash('sha256').update(sessionToken).digest('hex'),
    });
  });

  it('keeps the session cookie available when atomic logout cleanup must be retried', async () => {
    const sessionToken = 'logout-retry-session-token';
    const accountId = 'notion:user-logout-retry';
    let completeAttempts = 0;
    vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = new URL(input instanceof Request ? input.url : String(input));
      const method = init?.method ?? (input instanceof Request ? input.method : 'GET');

      if (url.pathname.endsWith('/rpc/begin_inkwell_notion_logout')) {
        return new Response('true', { headers: { 'Content-Type': 'application/json' } });
      }
      if (url.pathname.endsWith('/rpc/complete_inkwell_notion_logout')) {
        completeAttempts += 1;
        return new Response(JSON.stringify({ message: 'temporary database failure' }), {
          status: 503,
          headers: { 'Content-Type': 'application/json' },
        });
      }
      if (url.hostname === 'api.notion.com' && url.pathname === '/v1/oauth/revoke') {
        return new Response('{}', { status: 200 });
      }
      if (url.pathname.endsWith('/session') && method === 'GET') {
        return new Response(JSON.stringify([{
          id: 'session-id-logout-retry',
          token: createHash('sha256').update(sessionToken).digest('hex'),
          expiresAt: new Date(Date.now() + 60_000).toISOString(),
          userId: accountId,
          user: { id: accountId, name: 'Test user', email: 'test@example.test', image: null, emailVerified: false },
        }]), { headers: { 'Content-Type': 'application/json' } });
      }
      if (url.pathname.endsWith('/account') && method === 'GET') {
        return new Response(JSON.stringify([{ accessToken: 'logout-retry-access-token', refreshToken: null }]), {
          headers: { 'Content-Type': 'application/json' },
        });
      }
      return new Response('[]', { headers: { 'Content-Type': 'application/json' } });
    }));
    initSingletons(env);

    const response = await workerApp.request('/auth/notion/logout', {
      method: 'POST',
      headers: {
        Origin: 'http://localhost:3000',
        Cookie: `inkwell_session=${sessionToken}`,
        'Content-Type': 'application/json',
      },
      body: '{}',
    }, env);

    expect(response.status).toBe(503);
    expect(await response.json()).toEqual({
      connected: false,
      loggedOut: false,
      notionTokenRevoked: true,
      serverDataCleanupComplete: false,
      retryable: true,
    });
    expect(response.headers.get('set-cookie')).toBeNull();
    expect(completeAttempts).toBe(2);
  });
});

describe('connection deletion retry receipts', () => {
  it('revokes and deletes through the atomic user-data deletion RPC', async () => {
    const sessionToken = 'delete-session-token-test';
    const accountToken = 'delete-notion-token-test';
    const accountId = 'notion:user-delete-test';
    const requestId = 'r'.repeat(43);
    const requestIdHash = createHash('sha256').update(requestId).digest('hex');
    const calls: Array<{ body: string; method: string; pathname: string }> = [];
    let receipt: Record<string, unknown> | null = null;
    vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = new URL(input instanceof Request ? input.url : String(input));
      const method = init?.method ?? (input instanceof Request ? input.method : 'GET');
      const body = typeof init?.body === 'string'
        ? init.body
        : input instanceof Request
          ? await input.clone().text()
          : '';
      calls.push({ body, method, pathname: url.pathname });

      if (url.hostname === 'api.notion.com' && url.pathname === '/v1/oauth/revoke') {
        return new Response('{}', { status: 200 });
      }
      if (url.pathname.endsWith('/session') && method === 'GET') {
        return new Response(JSON.stringify([{
          id: 'session-id-delete-test',
          token: createHash('sha256').update(sessionToken).digest('hex'),
          expiresAt: new Date(Date.now() + 60_000).toISOString(),
          userId: accountId,
          user: { id: accountId, name: 'Test user', email: 'test@example.test', image: null, emailVerified: false },
        }]), { headers: { 'Content-Type': 'application/json' } });
      }
      if (url.pathname.endsWith('/inkwell_connection_deletion_receipts')) {
        if (method === 'GET') {
          return new Response(JSON.stringify(receipt ? [receipt] : []), { headers: { 'Content-Type': 'application/json' } });
        }
        const patchBody = JSON.parse(body || '{}') as Record<string, unknown>;
        if (method === 'POST') {
          receipt = { ...patchBody };
          return new Response('[]', { status: 201, headers: { 'Content-Type': 'application/json' } });
        }
        if (method === 'PATCH' && receipt) {
          receipt = { ...receipt, ...patchBody };
          return new Response(null, { status: 204 });
        }
      }
      if (url.pathname.endsWith('/rpc/prepare_inkwell_connection_deletion')) {
        const prepareBody = JSON.parse(body || '{}') as Record<string, unknown>;
        receipt ??= {
          request_id_hash: prepareBody.p_request_id_hash,
          user_id: prepareBody.p_user_id,
          status: 'pending',
          notion_token_revoked: false,
        };
        return new Response(JSON.stringify(receipt), { headers: { 'Content-Type': 'application/json' } });
      }
      if (url.pathname.endsWith('/account') && method === 'GET') {
        return new Response(JSON.stringify([{ accessToken: accountToken, refreshToken: 'refresh-token-test' }]), {
          headers: { 'Content-Type': 'application/json' },
        });
      }
      if (url.pathname.endsWith('/rpc/complete_inkwell_connection_deletion')) {
        receipt = { ...receipt, user_id: null, status: 'completed' };
        return new Response('true', { headers: { 'Content-Type': 'application/json' } });
      }
      if (method === 'DELETE' || method === 'PATCH') return new Response(null, { status: 204 });
      return new Response('[]', { headers: { 'Content-Type': 'application/json' } });
    }));
    initSingletons(env);

    const response = await workerApp.request('/auth/notion/delete-connection', {
      method: 'POST',
      headers: {
        Origin: 'http://localhost:3000',
        Cookie: `inkwell_session=${sessionToken}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ requestId }),
    }, env);

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ deleted: true, notionTokenRevoked: true });
    expect(response.headers.get('set-cookie')).toContain('Max-Age=0');
    expect(receipt).toMatchObject({ request_id_hash: requestIdHash, user_id: null, status: 'completed' });
    expect(calls.some((call) => call.pathname.endsWith('/rpc/complete_inkwell_connection_deletion'))).toBe(true);
    expect(calls.some((call) => call.pathname.endsWith('/user') && call.method === 'DELETE')).toBe(false);
    expect(calls.findIndex((call) => call.pathname.endsWith('/rpc/prepare_inkwell_connection_deletion')))
      .toBeLessThan(calls.findIndex((call) => call.pathname.endsWith('/account') && call.method === 'GET'));
  });

  it('completes a confirmed deletion retry without needing the deleted session', async () => {
    const requestId = 'd'.repeat(43);
    const requestIdHash = createHash('sha256').update(requestId).digest('hex');
    const databaseCalls: string[] = [];
    vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL) => {
      const url = new URL(input instanceof Request ? input.url : String(input));
      databaseCalls.push(url.pathname);
      if (url.pathname.endsWith('/inkwell_connection_deletion_receipts')) {
        return new Response(JSON.stringify([{
          request_id_hash: requestIdHash,
          user_id: null,
          status: 'completed',
          notion_token_revoked: true,
        }]), { headers: { 'Content-Type': 'application/json' } });
      }
      return new Response('[]', { headers: { 'Content-Type': 'application/json' } });
    }));
    initSingletons(env);

    const response = await workerApp.request('/auth/notion/delete-connection', {
      method: 'POST',
      headers: { Origin: 'http://localhost:3000', 'Content-Type': 'application/json' },
      body: JSON.stringify({ requestId }),
    }, env);

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ deleted: true, notionTokenRevoked: true });
    expect(databaseCalls).toEqual(['/rest/v1/inkwell_connection_deletion_receipts']);
  });

  it('keeps a confirmed token revocation when retrying an unfinished deletion', async () => {
    const sessionToken = 'delete-retry-session-token-test';
    const accountToken = 'delete-retry-notion-token-test';
    const accountId = 'notion:user-delete-retry-test';
    const requestId = 'p'.repeat(43);
    const requestIdHash = createHash('sha256').update(requestId).digest('hex');
    let receipt: Record<string, unknown> = {
      request_id_hash: requestIdHash,
      user_id: accountId,
      status: 'pending',
      notion_token_revoked: true,
    };
    let notionRevokeCalls = 0;
    vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = new URL(input instanceof Request ? input.url : String(input));
      const method = init?.method ?? (input instanceof Request ? input.method : 'GET');
      if (url.hostname === 'api.notion.com' && url.pathname === '/v1/oauth/revoke') {
        notionRevokeCalls += 1;
        return new Response('{}', { status: 400 });
      }
      if (url.pathname.endsWith('/session') && method === 'GET') {
        return new Response(JSON.stringify([{
          id: 'delete-retry-session-id-test',
          token: createHash('sha256').update(sessionToken).digest('hex'),
          expiresAt: new Date(Date.now() + 60_000).toISOString(),
          userId: accountId,
          user: { id: accountId, name: 'Test user', email: 'test@example.test', image: null, emailVerified: false },
        }]), { headers: { 'Content-Type': 'application/json' } });
      }
      if (url.pathname.endsWith('/inkwell_connection_deletion_receipts')) {
        if (method === 'GET') {
          return new Response(JSON.stringify([receipt]), { headers: { 'Content-Type': 'application/json' } });
        }
        const patchBody = JSON.parse(typeof init?.body === 'string' ? init.body : '{}') as Record<string, unknown>;
        receipt = { ...receipt, ...patchBody };
        return new Response(null, { status: 204 });
      }
      if (url.pathname.endsWith('/rpc/prepare_inkwell_connection_deletion')) {
        return new Response(JSON.stringify(receipt), { headers: { 'Content-Type': 'application/json' } });
      }
      if (url.pathname.endsWith('/account') && method === 'GET') {
        return new Response(JSON.stringify([{ accessToken: accountToken, refreshToken: 'refresh-token-test' }]), {
          headers: { 'Content-Type': 'application/json' },
        });
      }
      if (url.pathname.endsWith('/rpc/complete_inkwell_connection_deletion')) {
        receipt = { ...receipt, user_id: null, status: 'completed' };
        return new Response('true', { headers: { 'Content-Type': 'application/json' } });
      }
      if (method === 'DELETE' || method === 'PATCH') return new Response(null, { status: 204 });
      return new Response('[]', { headers: { 'Content-Type': 'application/json' } });
    }));
    initSingletons(env);

    const response = await workerApp.request('/auth/notion/delete-connection', {
      method: 'POST',
      headers: {
        Origin: 'http://localhost:3000',
        Cookie: `inkwell_session=${sessionToken}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ requestId }),
    }, env);

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ deleted: true, notionTokenRevoked: true });
    expect(notionRevokeCalls).toBe(0);
    expect(receipt).toMatchObject({ user_id: null, status: 'completed', notion_token_revoked: true });
  });

  it('rejects malformed deletion request IDs before querying account data', async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
    initSingletons(env);

    const response = await workerApp.request('/auth/notion/delete-connection', {
      method: 'POST',
      headers: { Origin: 'http://localhost:3000', 'Content-Type': 'application/json' },
      body: JSON.stringify({ requestId: 'short' }),
    }, env);

    expect(response.status).toBe(400);
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

describe('Notion access token revocation', () => {
  it('uses Notion OAuth client authentication and does not log or return the token', async () => {
    const fetchMock = vi.fn(async () => new Response('{}', { status: 200 }));
    vi.stubGlobal('fetch', fetchMock);

    await expect(revokeNotionToken(env, 'notion-token-test')).resolves.toBe(true);

    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe('https://api.notion.com/v1/oauth/revoke');
    expect(init.method).toBe('POST');
    expect((init.headers as Record<string, string>).Authorization).toBe(
      `Basic ${Buffer.from('client-id-test:client-secret-test').toString('base64')}`,
    );
    expect((init.headers as Record<string, string>)['Notion-Version']).toBe('2026-03-11');
    expect(init.body).toBe(JSON.stringify({ token: 'notion-token-test' }));
  });

  it('reports revocation failures without throwing token details', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => { throw new Error('network error'); }));

    await expect(revokeNotionToken(env, 'notion-token-test')).resolves.toBe(false);
  });
});

describe('privileged RPC migration', () => {
  const migration = readFileSync(
    new URL('../apps/worker/migrations/007_harden_privileged_rpc_search_path.sql', import.meta.url),
    'utf8',
  );

  it('pins RPC name resolution and limits execution to the service role', () => {
    const functions = [
      ['arm_notion_webhook_setup', 'SECURITY DEFINER', 'public.notion_webhook_setup'],
      ['register_notion_webhook_verification_token', 'SECURITY DEFINER', 'public.notion_webhook_setup'],
      ['consume_notion_webhook_verification_token', 'SECURITY DEFINER', 'public.notion_webhook_setup'],
      ['reset_notion_webhook_setup', 'SECURITY DEFINER', 'public.notion_webhook_setup'],
      ['complete_inkwell_connection_deletion', 'SECURITY DEFINER', 'public.inkwell_connection_deletion_receipts'],
      ['increment_block_version', 'SECURITY INVOKER', 'public.notion_block_sync'],
    ] as const;

    for (const [name, securityMode, tableName] of functions) {
      const start = migration.indexOf(`CREATE OR REPLACE FUNCTION public.${name}(`);
      const end = migration.indexOf('\n$$;', start);
      expect(start).toBeGreaterThanOrEqual(0);
      expect(end).toBeGreaterThan(start);
      const definition = migration.slice(start, end + 4);
      expect(definition).toContain(securityMode);
      expect(definition).toContain('SET search_path = pg_catalog, public, pg_temp');
      expect(definition).toContain(tableName);
    }

    expect(migration).toContain('REVOKE ALL ON TABLE public.notion_webhook_setup FROM PUBLIC, anon, authenticated');
    expect(migration).toContain('REVOKE ALL ON FUNCTION public.consume_notion_webhook_verification_token() FROM PUBLIC, anon, authenticated');
    expect(migration).toContain('GRANT EXECUTE ON FUNCTION public.consume_notion_webhook_verification_token() TO service_role');
  });
});

describe('Notion webhook verification', () => {
  it('accepts only the expected sha256 signature in constant-time verification', async () => {
    const body = JSON.stringify({ type: 'page.content_updated', entity: { id: 'page-test' } });
    const signature = `sha256=${await computeHmacSignature(env.NOTION_WEBHOOK_SECRET!, body)}`;

    await expect(verifyNotionWebhookSignature(env.NOTION_WEBHOOK_SECRET!, body, signature)).resolves.toBe(true);
    await expect(verifyNotionWebhookSignature(env.NOTION_WEBHOOK_SECRET!, body, `v0=${signature.slice(7)}`)).resolves.toBe(false);
    await expect(verifyNotionWebhookSignature(env.NOTION_WEBHOOK_SECRET!, body, `${signature.slice(0, -1)}0`)).resolves.toBe(false);
    await expect(verifyNotionWebhookSignature(env.NOTION_WEBHOOK_SECRET!, body, undefined)).resolves.toBe(false);
  });

  it('fails closed when the webhook secret is missing or the signature is invalid', async () => {
    const body = JSON.stringify({ type: 'page.content_updated', entity: { id: 'page-test' } });
    const database = { armed: false, callbackTokenHash: null, retrieved: false, token: null };
    initializeWebhookRoutes(database);

    const noSecret = await workerApp.request('/webhooks/notion', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Origin: 'http://localhost:3000' },
      body,
    }, { ...env, NOTION_WEBHOOK_SECRET: undefined } as WorkerEnv);
    expect(noSecret.status).toBe(503);

    const badSignature = await workerApp.request('/webhooks/notion', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Origin: 'http://localhost:3000', 'x-notion-signature': 'sha256=0000000000000000000000000000000000000000000000000000000000000000' },
      body,
    }, env);
    expect(badSignature.status).toBe(401);
  });

  it('requires an armed setup, returns the token once, and keeps it for signature verification', async () => {
    const token = 'setup-verification-token-test';
    const database = { armed: false, callbackTokenHash: null, retrieved: false, token: null };
    initializeWebhookRoutes(database);
    const info = vi.spyOn(console, 'info').mockImplementation(() => undefined);
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);

    const unarmed = await workerApp.request('/webhooks/notion', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ verification_token: token }),
    }, { ...env, NOTION_WEBHOOK_SECRET: undefined } as WorkerEnv);
    expect(unarmed.status).toBe(409);
    expect(database.token).toBeNull();

    const unauthorizedArm = await workerApp.request('/webhooks/notion/setup/arm', {
      method: 'POST',
    }, env);
    expect(unauthorizedArm.status).toBe(401);

    const authorization = { Authorization: `Bearer ${env.NOTION_WEBHOOK_SETUP_TOKEN}` };
    const arm = await workerApp.request('/webhooks/notion/setup/arm', {
      method: 'POST',
      headers: authorization,
    }, env);
    expect(arm.status).toBe(200);
    const armResult = await arm.json() as { callbackUrl: string };
    const callbackPath = new URL(armResult.callbackUrl).pathname;
    expect(armResult.callbackUrl).toContain('/webhooks/notion/');
    const callbackToken = callbackPath.split('/').at(-1)!;
    expect(database.callbackTokenHash).toBe(
      createHash('sha256').update(callbackToken).digest('hex'),
    );

    const response = await workerApp.request('/webhooks/notion', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ verification_token: token }),
    }, { ...env, NOTION_WEBHOOK_SECRET: undefined } as WorkerEnv);
    expect(response.status).toBe(404);

    const wrongCallback = await workerApp.request('/webhooks/notion/wrongcallbacktoken12345678901234567890', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ verification_token: token }),
    }, { ...env, NOTION_WEBHOOK_SECRET: undefined } as WorkerEnv);
    expect(wrongCallback.status).toBe(404);

    const setupResponse = await workerApp.request(callbackPath, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ verification_token: token }),
    }, { ...env, NOTION_WEBHOOK_SECRET: undefined } as WorkerEnv);

    expect(setupResponse.status).toBe(200);
    expect(await setupResponse.text()).not.toContain(token);
    expect(database.token).toBe(token);
    expect(info).toHaveBeenCalledWith('[webhooks/notion] verification token received (redacted).');
    expect(info.mock.calls.flat().join(' ')).not.toContain(token);
    expect(warn.mock.calls.flat().join(' ')).not.toContain(token);

    const unauthorizedRetrieve = await workerApp.request('/webhooks/notion/verification-token', {}, env);
    expect(unauthorizedRetrieve.status).toBe(401);

    const retrieve = await workerApp.request('/webhooks/notion/verification-token', {
      headers: authorization,
    }, env);
    expect(retrieve.status).toBe(200);
    expect(retrieve.headers.get('cache-control')).toContain('no-store');
    expect(await retrieve.json()).toEqual({ verificationToken: token });

    const secondRetrieve = await workerApp.request('/webhooks/notion/verification-token', {
      headers: authorization,
    }, env);
    expect(secondRetrieve.status).toBe(409);

    const eventBody = JSON.stringify({ type: 'page.content_updated', entity: { id: 'page-test' } });
    const signature = `sha256=${await computeHmacSignature(token, eventBody)}`;
    const verifiedEvent = await workerApp.request(callbackPath, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-notion-signature': signature },
      body: eventBody,
    }, { ...env, NOTION_WEBHOOK_SECRET: undefined } as WorkerEnv);
    expect(verifiedEvent.status).toBe(200);

    const conflict = await workerApp.request(callbackPath, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ verification_token: 'different-verification-token' }),
    }, { ...env, NOTION_WEBHOOK_SECRET: undefined } as WorkerEnv);
    expect(conflict.status).toBe(409);
    expect(database.token).toBe(token);

    const reset = await workerApp.request('/webhooks/notion/verification-token', {
      method: 'DELETE',
      headers: authorization,
    }, env);
    expect(reset.status).toBe(200);
    expect(database.token).toBeNull();
  });

  it('asks Notion to retry when a verified event cannot be persisted', async () => {
    const database = {
      armed: false,
      callbackTokenHash: null,
      retrieved: false,
      token: null,
      mappedPage: true,
      failStaleUpdate: true,
    };
    initializeWebhookRoutes(database);
    const body = JSON.stringify({ type: 'page.content_updated', entity: { id: 'notion-page-test' } });
    const signature = `sha256=${await computeHmacSignature(env.NOTION_WEBHOOK_SECRET!, body)}`;

    const response = await workerApp.request('/webhooks/notion', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-notion-signature': signature },
      body,
    }, env);

    expect(response.status).toBe(503);
    expect(await response.json()).toEqual({ error: 'Webhook processing failed.' });
  });

  it('rejects webhook requests larger than the route limit before parsing JSON', async () => {
    const response = await workerApp.request('/webhooks/notion', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Origin: 'http://localhost:3000' },
      body: 'x'.repeat(1024 * 1024 + 1),
    }, env);

    expect(response.status).toBe(413);
  });

  it('rejects media requests over the upload envelope before parsing JSON', async () => {
    const sessionToken = 'media-size-session-token-test';
    const accountId = 'notion:media-test';
    stubAuthenticatedInkwellSession(sessionToken, accountId);
    const response = await workerApp.request('/media/upload', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Content-Length': String(28 * 1024 * 1024),
        Origin: 'http://localhost:3000',
        Cookie: `inkwell_session=${sessionToken}`,
        'X-Inkwell-Account': accountId,
      },
      body: '{}',
    }, env);

    expect(response.status).toBe(413);
  });

  it('returns a client error for non-string media fields instead of throwing', async () => {
    const sessionToken = 'media-fields-session-token-test';
    const accountId = 'notion:media-fields-test';
    stubAuthenticatedInkwellSession(sessionToken, accountId);

    const response = await workerApp.request('/media/upload', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Origin: 'http://localhost:3000',
        Cookie: `inkwell_session=${sessionToken}`,
        'X-Inkwell-Account': accountId,
      },
      body: JSON.stringify({ dataBase64: {}, mimeType: {} }),
    }, env);

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toEqual({ error: 'Invalid upload request.' });
  });
});
