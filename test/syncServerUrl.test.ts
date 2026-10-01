import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanSyncServerUrl } from '@/src/lib/syncServerUrl';
import { notionClient } from '@/src/services/notionClient';
import { readBrowserStorage, resetBrowserStorage } from './setup';

const originalFetch = globalThis.fetch;

afterEach(() => {
  vi.stubGlobal('fetch', originalFetch);
  resetBrowserStorage();
});

describe('sync server URL validation', () => {
  it('normalizes trusted HTTPS server origins and optional base paths', () => {
    expect(cleanSyncServerUrl(' https://sync.example.test/worker/// ')).toBe(
      'https://sync.example.test/worker',
    );
  });

  it('allows plain HTTP only for localhost in development builds', () => {
    expect(cleanSyncServerUrl('', true)).toBe('http://localhost:8787');
    expect(cleanSyncServerUrl('http://127.0.0.1:8787', true)).toBe('http://127.0.0.1:8787');
    expect(() => cleanSyncServerUrl('http://127.0.0.1:8787', false)).toThrow('Use HTTPS');
    expect(() => cleanSyncServerUrl('http://sync.example.test', true)).toThrow('Use HTTPS');
    expect(() => cleanSyncServerUrl('http://localhost.example.test', true)).toThrow('Use HTTPS');
  });

  it('rejects embedded credentials, queries, and fragments', () => {
    for (const value of [
      'https://user:password@sync.example.test',
      'https://sync.example.test?redirect=attacker.test',
      'https://sync.example.test/#fragment',
    ]) {
      expect(() => cleanSyncServerUrl(value)).toThrow('cannot contain credentials');
    }
  });

  it('stops an insecure configured server before sending a request', async () => {
    resetBrowserStorage({
      syncConfig: {
        serverUrl: 'http://attacker.example.test',
        authenticated: false,
        connected: false,
      },
    });
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);

    await expect(notionClient.refreshSyncSession(true)).rejects.toThrow('Use HTTPS');

    expect(fetchMock).not.toHaveBeenCalled();
    expect(readBrowserStorage().syncConfig).toMatchObject({
      serverUrl: 'http://attacker.example.test',
      authenticated: false,
      connected: false,
    });
  });
});
