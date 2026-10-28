import { createHash } from 'node:crypto';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { app } from '@/apps/worker/src/worker';
import { initSingletons } from '@/apps/worker/src/services/workerRuntime';
import type { WorkerEnv } from '@/apps/worker/src/types';

const env = {
  WORKER_URL: 'https://sync.example.test',
  JOTTATHING_EXTENSION_ORIGIN: 'chrome-extension://jottathingdevextension',
  TRUSTED_ORIGINS: 'http://localhost:3000',
  NOTION_VERSION: '2026-03-11',
  SUPABASE_URL: 'https://supabase.example.test',
  SUPABASE_SERVICE_KEY: 'service-role-test-key',
} as WorkerEnv;

const sessionToken = 'media-route-session-token';
const accountId = 'notion:media-route-test';

afterEach(() => vi.unstubAllGlobals());

describe('Notion media routes', () => {
  it('uploads validated local image bytes to Notion and returns the file upload id', async () => {
    const notionUploadRequests: Array<{ url: string; init?: RequestInit }> = [];
    stubConnectedNotion({
      notion: async (url, init) => {
        notionUploadRequests.push({ url, init });
        return url.endsWith('/file_uploads')
          ? jsonResponse({ id: 'file-upload-1' })
          : jsonResponse({ status: 'uploaded' });
      },
    });

    const response = await app.request('/media/upload', {
      method: 'POST',
      headers: sessionHeaders(),
      body: JSON.stringify({
        dataBase64: 'iVBORw0KGgo=',
        mimeType: 'image/png',
        filename: 'folder/screenshot.png',
      }),
    }, env);

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({ fileUploadId: 'file-upload-1' });
    expect(notionUploadRequests).toHaveLength(2);
    expect(JSON.parse(String(notionUploadRequests[0].init?.body))).toMatchObject({
      mode: 'single_part',
      filename: 'folder-screenshot.png',
      content_type: 'image/png',
    });
    const uploadForm = notionUploadRequests[1].init?.body as FormData;
    expect(uploadForm.get('file')).toMatchObject({
      name: 'folder-screenshot.png',
      type: 'image/png',
    });
  });

  it('refreshes an expired Notion image URL by its mapped file upload id', async () => {
    const notionBlockRequests: string[] = [];
    stubConnectedNotion({
      blockMappings: {
        'local-page-1': [{
          localPageId: 'local-page-1',
          jottathingBlockId: 'image-1',
          localNodeId: 'image-1',
          notionBlockId: 'notion-image-1',
          kind: 'media',
          order: 0,
          oldState: null,
          newState: {
            object: 'block',
            type: 'image',
            image: { type: 'file_upload', file_upload: { id: 'file-upload-1' } },
          },
        }],
      },
      notion: async (url) => {
        notionBlockRequests.push(url);
        return jsonResponse({
          id: 'notion-image-1',
          type: 'image',
          image: { file: { url: 'https://secure.notion-static.com/refreshed.png?expires=2' } },
        });
      },
    });

    const response = await app.request('/media/refresh', {
      method: 'POST',
      headers: sessionHeaders(),
      body: JSON.stringify({ fileUploadId: 'file-upload-1' }),
    }, env);

    expect({ status: response.status, body: await response.clone().json() }).toEqual({
      status: 200,
      body: { url: 'https://secure.notion-static.com/refreshed.png?expires=2' },
    });
    await expect(response.json()).resolves.toEqual({
      url: 'https://secure.notion-static.com/refreshed.png?expires=2',
    });
    expect(notionBlockRequests).toEqual(['https://api.notion.com/v1/blocks/notion-image-1']);
  });
});

function stubConnectedNotion(options: {
  blockMappings?: Record<string, unknown>;
  notion: (url: string, init?: RequestInit) => Promise<Response>;
}) {
  vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(input instanceof Request ? input.url : String(input));
    const method = init?.method ?? (input instanceof Request ? input.method : 'GET');

    if (url.hostname === 'api.notion.com') return options.notion(url.toString(), init);
    if (url.hostname !== 'supabase.example.test') return jsonResponse({}, 404);

    if (url.pathname.endsWith('/session')) {
      return jsonResponse([{
        id: 'session-id-media-test',
        token: createHash('sha256').update(sessionToken).digest('hex'),
        expiresAt: new Date(Date.now() + 60_000).toISOString(),
        userId: accountId,
        user: { id: accountId, name: 'Media test', email: 'media@example.test', image: null, emailVerified: false },
      }]);
    }
    if (url.pathname.endsWith('/account')) return jsonResponse([{ accessToken: 'notion-access-test' }]);
    if (url.pathname.endsWith('/notion_installations')) {
      return jsonResponse([{ id: 'installation-1', workspace_id: 'workspace-1', workspace_name: 'Test workspace' }]);
    }
    if (url.pathname.endsWith('/jottathing_sync_state')) {
      if (method === 'POST') return jsonResponse([]);
      return jsonResponse({
        installation_id: 'installation-1',
        jottathing_database_id: null,
        jottathing_data_source_id: null,
        jottathing_parent_page_id: null,
        jottathing_database_title: null,
        note_pages_json: {},
        block_mappings_json: options.blockMappings ?? {},
        parent_pages_json: {},
        project_pages_json: {},
        project_blocks_json: {},
        thread_blocks_json: {},
      });
    }
    return jsonResponse([], 404);
  }));
  initSingletons(env);
}

function sessionHeaders(): HeadersInit {
  return {
    'Content-Type': 'application/json',
    Origin: 'http://localhost:3000',
    Cookie: `jottathing_session=${sessionToken}`,
    'X-Jottathing-Account': accountId,
  };
}

function jsonResponse(value: unknown, status = 200): Response {
  return new Response(JSON.stringify(value), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}
