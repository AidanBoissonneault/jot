import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { runSmokeCli } from '../scripts/inkwell-sync-smoke.js';

const SESSION_COOKIE = 'inkwell_session=smoke-test-cookie-value';

describe('Inkwell sync smoke CLI', () => {
  let cwd = '';
  let requests: Array<{ method: string; route: string; cookie: string | null; body: Record<string, any> }>;
  let versions: Map<string, number>;

  beforeEach(async () => {
    cwd = await mkdtemp(join(tmpdir(), 'inkwell-smoke-cli-'));
    requests = [];
    versions = new Map();
  });

  afterEach(async () => {
    if (cwd) await rm(cwd, { recursive: true, force: true });
  });

  function fetchMock(): typeof fetch {
    return async (input, init) => {
      const url = new URL(String(input));
      const method = init?.method ?? 'GET';
      const body = init?.body ? JSON.parse(String(init.body)) as Record<string, any> : {};
      const cookie = new Headers(init?.headers).get('cookie');
      requests.push({ method, route: `${url.pathname}${url.search}`, cookie, body });

      if (method === 'GET') {
        const pageId = url.searchParams.get('pageId') ?? '';
        const version = versions.get(pageId) ?? 0;
        return new Response(JSON.stringify({ status: version ? 'synced' : 'pending', localVersion: version, syncedVersion: version }));
      }
      if (url.pathname === '/sync/project') return new Response(JSON.stringify({ status: 'saved' }));

      const pageId = body.page.id as string;
      const version = body.page.localSyncVersion as number;
      versions.set(pageId, version);
      return new Response(JSON.stringify({ queued: true, version }));
    };
  }

  const dependencies = (fetchImpl: typeof fetch, output: string[] = []) => ({
    cwd,
    env: { INKWELL_SESSION_COOKIE: SESSION_COOKIE },
    fetchImpl,
    output: (message: string) => output.push(message),
  });

  it('creates a Test project, queues consecutive Unicode edits, observes sync, and archives both records', async () => {
    const fetchImpl = fetchMock();
    const output: string[] = [];
    const deps = dependencies(fetchImpl, output);

    await runSmokeCli(['create'], deps);
    const runId = (await readFile(join(cwd, '.tmp/inkwell-sync-smoke/latest.txt'), 'utf8')).trim();
    const statePath = join(cwd, '.tmp/inkwell-sync-smoke', `${runId}.json`);
    const initial = JSON.parse(await readFile(statePath, 'utf8'));
    expect(initial.project.category).toBe('Test');
    expect(initial.project.tags).toContain('Test');
    expect(JSON.stringify(initial)).not.toContain(SESSION_COOKIE);
    expect(JSON.stringify(initial)).toContain('東京');

    await runSmokeCli(['edit', '--text', 'First edit — café.\\n\\nSecond paragraph.'], deps);
    await runSmokeCli(['edit', '--text', 'Latest edit — 東京 🧪.\\n\\nSecond paragraph.\\n\\nThird paragraph.'], deps);
    await runSmokeCli(['status', '--wait', '--poll-interval-ms', '1'], deps);
    await runSmokeCli(['archive', '--poll-interval-ms', '1'], deps);

    const finalState = JSON.parse(await readFile(statePath, 'utf8'));
    expect(finalState.page.status).toBe('archived');
    expect(finalState.project.status).toBe('archived');
    expect(finalState.lastQueuedVersion).toBe(4);
    expect(finalState.archivedAt).toEqual(expect.any(String));

    const queuedVersions = requests
      .filter(({ method, route }) => method === 'POST' && route === '/sync/push')
      .map(({ body }) => body.page.localSyncVersion);
    expect(queuedVersions).toEqual([1, 2, 3, 4]);
    expect(requests.filter(({ method, route }) => method === 'POST' && route === '/sync/project').map(({ body }) => body.project.status))
      .toEqual(['active', 'archived']);
    expect(requests.every(({ cookie }) => cookie === SESSION_COOKIE)).toBe(true);
    expect(output.join('\n')).toContain('synced, local v3, synced v3; expected v3.');
    expect(output.join('\n')).toContain('Archived page');
    expect(output.join('\n')).not.toContain('smoke-test-cookie-value');
  }, 20_000);

  it('rejects a non-loopback Worker URL before making a request', async () => {
    const output: string[] = [];
    await expect(runSmokeCli(['create', '--base-url', 'https://example.com'], dependencies(fetchMock(), output)))
      .rejects.toThrow('loopback Worker');
    expect(requests).toHaveLength(0);
    expect(output.join('\n')).not.toContain('smoke-test-cookie-value');
  });

  it('requires the session cookie without echoing it or sending requests', async () => {
    const output: string[] = [];
    await expect(runSmokeCli(['create'], {
      cwd,
      env: {},
      fetchImpl: fetchMock(),
      output: (message) => output.push(message),
    })).rejects.toThrow('INKWELL_SESSION_COOKIE');
    expect(requests).toHaveLength(0);
    expect(output.join('\n')).not.toContain('smoke-test-cookie-value');
  });
});
