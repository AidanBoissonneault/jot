/** Normalizes a trusted sync-server base URL and rejects insecure endpoints. */
export function cleanSyncServerUrl(
  value: string,
  allowInsecureLocalhost = import.meta.env.DEV,
): string {
  const fallback = allowInsecureLocalhost
    ? 'http://localhost:8787'
    : import.meta.env.VITE_API_URL ?? '';
  const candidate = typeof value === 'string' && value.trim() ? value.trim() : fallback;
  if (!candidate) {
    throw new Error('A secure sync server URL is not configured.');
  }

  let url: URL;
  try {
    url = new URL(candidate);
  } catch {
    throw new Error('Enter a valid sync server URL.');
  }

  if (url.username || url.password || url.search || url.hash) {
    throw new Error('The sync server URL cannot contain credentials, a query, or a fragment.');
  }

  const isDevelopmentLocalhost = allowInsecureLocalhost &&
    url.protocol === 'http:' &&
    ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname);
  if (url.protocol !== 'https:' && !isDevelopmentLocalhost) {
    throw new Error('Use HTTPS for the sync server. HTTP is allowed only for localhost in a development build.');
  }

  return `${url.origin}${url.pathname.replace(/\/+$/, '')}`;
}
