import { describe, expect, it } from 'vitest';
import { JotYoutube, youtubeEmbedUrl } from '@/src/extensions/media';

describe('media extensions', () => {
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
    const renderHTML = JotYoutube.config.renderHTML;

    if (!renderHTML) {
      throw new Error('JotYoutube must render HTML');
    }

    const html = renderHTML.call(
      {
        name: JotYoutube.name,
        options: JotYoutube.options,
        storage: {},
        parent: null,
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
