/** @file Normalizes YouTube links used by both inbound and outbound block conversion. */

/**
 * Normalizes supported YouTube URLs to a canonical watch URL.
 * @param src - Candidate YouTube URL.
 * @returns Canonical URL or an empty string when invalid.
 */
export function normalizeYoutubeVideoUrl(src: string): string {
  try {
    const url = new URL(src);
    const host = url.hostname.toLowerCase();

    if (host === 'youtu.be' || host.endsWith('.youtu.be')) {
      const id = url.pathname.split('/').filter(Boolean)[0];
      return id && /^[\w-]+$/.test(id) ? youtubeWatchUrl(id, url.searchParams) : '';
    }

    if (
      host !== 'youtube.com' &&
      !host.endsWith('.youtube.com') &&
      host !== 'youtube-nocookie.com' &&
      !host.endsWith('.youtube-nocookie.com')
    ) {
      return '';
    }

    const embedMatch = url.pathname.match(/^\/(?:embed|shorts|v)\/([\w-]+)/i);
    const id = url.searchParams.get('v') ?? embedMatch?.[1];

    if (!id) {
      return '';
    }

    return /^[\w-]+$/.test(id) ? youtubeWatchUrl(id, url.searchParams) : '';
  } catch {
    return '';
  }
}

/**
 * Builds a canonical YouTube watch URL and preserves its start time.
 * @param id - YouTube video identifier.
 * @param sourceParams - Query parameters from the source URL.
 * @returns Canonical watch URL.
 */
export function youtubeWatchUrl(id: string, sourceParams: URLSearchParams): string {
  const url = new URL('https://www.youtube.com/watch');
  url.searchParams.set('v', id);

  const start = sourceParams.get('t') ?? sourceParams.get('start');
  if (start) {
    url.searchParams.set('t', start);
  }

  return url.toString();
}
