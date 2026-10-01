/**
 * @file Parses YouTube URLs and produces privacy-enhanced embed URLs for Inkwell media nodes.
 * @author Aidan Boissonneault
 * @lastModified September 2026
 */

/**
 * Converts a supported YouTube URL into a privacy-enhanced embed URL.
 * @param value - Candidate YouTube URL.
 * @returns Embed URL or an empty string when invalid.
 */
export function youtubeEmbedUrl(value: string): string {
  const info = youtubeVideoInfo(value);

  if (!info) {
    return '';
  }

  const url = new URL(`https://www.youtube-nocookie.com/embed/${info.id}`);
  url.searchParams.set('rel', '1');

  if (info.start > 0) {
    url.searchParams.set('start', String(info.start));
  }

  return url.toString();
}

/**
 * Extracts a video identifier and playback offset from a YouTube URL.
 * @param value - Candidate YouTube URL.
 * @returns Parsed video details or null when invalid.
 */
export function youtubeVideoInfo(value: string): { id: string; start: number } | null {
  try {
    const url = new URL(value);
    const host = url.hostname.toLowerCase();
    let id = '';

    if (host === 'youtu.be' || host.endsWith('.youtu.be')) {
      id = url.pathname.split('/').filter(Boolean)[0] ?? '';
    } else if (
      host === 'youtube.com' ||
      host.endsWith('.youtube.com') ||
      host === 'youtube-nocookie.com' ||
      host.endsWith('.youtube-nocookie.com')
    ) {
      id =
        url.searchParams.get('v') ??
        url.pathname.match(/^\/(?:embed|shorts|v)\/([\w-]+)/i)?.[1] ??
        '';
    }

    if (!/^[\w-]+$/.test(id)) {
      return null;
    }

    return {
      id,
      start: youtubeStartSeconds(url.searchParams.get('start') ?? url.searchParams.get('t') ?? ''),
    };
  } catch {
    return null;
  }
}

/**
 * Converts a YouTube time expression to seconds.
 * @param value - Numeric seconds or an h/m/s expression.
 * @returns Non-negative playback offset in seconds.
 */
export function youtubeStartSeconds(value: string): number {
  if (!value) {
    return 0;
  }

  if (/^\d+$/.test(value)) {
    return Number(value);
  }

  const match = value.match(/^(?:(\d+)h)?(?:(\d+)m)?(?:(\d+)s?)?$/i);

  if (!match) {
    return 0;
  }

  return (
    Number(match[1] ?? 0) * 3600 +
    Number(match[2] ?? 0) * 60 +
    Number(match[3] ?? 0)
  );
}
