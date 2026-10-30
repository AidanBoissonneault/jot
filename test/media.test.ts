import { describe, expect, it } from 'vitest';
import { MediaKit } from '@/src/extensions/media';
import { youtubeEmbedUrl } from '@/src/lib/youtubeUtils';

describe('media extensions', () => {
  it('does not treat hostnames that only end with youtu.be as YouTube links', () => {
    expect(youtubeEmbedUrl('https://notyoutu.be/dQw4w9WgXcQ')).toBe('');
  });

  it('normalizes YouTube URLs to privacy-enhanced embed URLs', () => {
    expect(youtubeEmbedUrl('https://www.youtube.com/watch?v=dQw4w9WgXcQ')).toBe(
      'https://www.youtube-nocookie.com/embed/dQw4w9WgXcQ?rel=1',
    );
    expect(youtubeEmbedUrl('https://youtu.be/dQw4w9WgXcQ?t=1m2s')).toBe(
      'https://www.youtube-nocookie.com/embed/dQw4w9WgXcQ?rel=1&start=62',
    );
    expect(youtubeEmbedUrl('https://www.youtube.com/shorts/dQw4w9WgXcQ')).toBe(
      'https://www.youtube-nocookie.com/embed/dQw4w9WgXcQ?rel=1',
    );
  });

  it('renders YouTube nodes as privacy-enhanced embedded iframes', () => {
    const youtube = MediaKit.config.addExtensions?.call(MediaKit)
      .find((extension) => extension.name === 'youtube');
    const renderHTML = youtube?.config.renderHTML;

    if (!youtube || !renderHTML) {
      throw new Error('MediaKit must register a YouTube renderer');
    }

    const html = renderHTML.call(
      {
        name: youtube.name,
        options: youtube.options,
        storage: youtube.storage,
        parent: youtube.parent,
      },
      {
        node: null as unknown as Parameters<typeof renderHTML>[0]['node'],
        HTMLAttributes: {
          src: 'https://www.youtube.com/watch?v=dQw4w9WgXcQ',
          start: 0,
        },
      },
    );

    expect(html).toEqual([
      'div',
      { 'data-youtube-video': '' },
      [
        'iframe',
        expect.objectContaining({
          src: 'https://www.youtube-nocookie.com/embed/dQw4w9WgXcQ?rel=1',
          allowfullscreen: true,
          autoplay: false,
          enableIFrameApi: false,
          referrerpolicy: 'strict-origin-when-cross-origin',
        }),
      ],
    ]);
  });
});
