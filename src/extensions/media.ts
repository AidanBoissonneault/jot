import { Extension } from '@tiptap/core';
import { Image } from '@tiptap/extension-image';
import { Youtube } from '@tiptap/extension-youtube';
import { Audio } from '@tiptap/extension-audio';

export const JotImage = Image.extend({
  addAttributes() {
    return {
      ...this.parent?.(),
      uploadState: { default: 'idle' },
      mimeType: { default: '' },
      kind: { default: 'image' },
      notionFileUploadId: { default: '' },
    };
  },

  addNodeView() {
    return ({ node }) => {
      const wrapper = document.createElement('div');
      wrapper.className = 'jot-image-wrapper';
      const uploadState = String(node.attrs.uploadState ?? 'idle');
      const src = node.attrs.src ?? '';

      if (uploadState === 'error') {
        wrapper.classList.add('is-error');
        wrapper.textContent = 'Image was not synced. Drop it again to upload it to Notion.';
        return { dom: wrapper };
      }

      if (uploadState === 'uploading') {
        wrapper.classList.add('is-uploading');
      }

      const img = document.createElement('img');
      img.src = src;
      if (node.attrs.alt) img.alt = node.attrs.alt;
      if (node.attrs.title) img.title = node.attrs.title;

      img.addEventListener('error', () => {
        wrapper.removeChild(img);
        const link = document.createElement('a');
        link.href = src;
        link.textContent = src;
        link.target = '_blank';
        link.rel = 'noopener noreferrer';
        wrapper.appendChild(link);
      });

      wrapper.appendChild(img);

      return { dom: wrapper };
    };
  },
});

export const JotYoutube = Youtube.configure({
  HTMLAttributes: {
    referrerpolicy: 'strict-origin-when-cross-origin',
    allow: 'accelerometer; autoplay; clipboard-write; encrypted-media; gyroscope; picture-in-picture; web-share',
  },
}).extend({
  addNodeView() {
    return ({ node }) => {
      const src = String(node.attrs.src ?? '');
      const videoId = youtubeVideoId(src);
      const wrapper = document.createElement('div');
      wrapper.className = 'jot-youtube-wrapper';

      const link = document.createElement('a');
      link.href = src;
      link.target = '_blank';
      link.rel = 'noopener noreferrer';
      link.className = 'jot-youtube-link';

      if (videoId) {
        const thumbnail = document.createElement('img');
        thumbnail.src = `https://i.ytimg.com/vi/${videoId}/hqdefault.jpg`;
        thumbnail.alt = 'YouTube video thumbnail';
        thumbnail.loading = 'lazy';
        link.appendChild(thumbnail);
      }

      const play = document.createElement('span');
      play.className = 'jot-youtube-play';
      play.textContent = 'Play on YouTube';
      link.appendChild(play);

      wrapper.appendChild(link);
      return { dom: wrapper };
    };
  },
});

export const JotAudio = Audio.extend({
  addAttributes() {
    return {
      ...this.parent?.(),
      uploadState: { default: 'idle' },
      mimeType: { default: '' },
      kind: { default: 'audio' },
      notionFileUploadId: { default: '' },
    };
  },

  addNodeView() {
    return ({ node }) => {
      const wrapper = document.createElement('div');
      wrapper.className = 'jot-audio-wrapper';
      const uploadState = String(node.attrs.uploadState ?? 'idle');
      const src = String(node.attrs.src ?? '');

      if (uploadState === 'error') {
        wrapper.classList.add('is-error');
        wrapper.textContent = 'Audio was not synced. Record or add it again to upload it to Notion.';
        return { dom: wrapper };
      }

      if (uploadState === 'uploading') {
        wrapper.classList.add('is-uploading');
      }

      const audio = document.createElement('audio');
      audio.controls = true;
      audio.src = src;
      audio.preload = 'metadata';

      audio.addEventListener('error', () => {
        audio.remove();
        const link = document.createElement('a');
        link.href = src;
        link.textContent = src;
        link.target = '_blank';
        link.rel = 'noopener noreferrer';
        wrapper.appendChild(link);
      });

      wrapper.appendChild(audio);
      return { dom: wrapper };
    };
  },
});

export const MediaKit = Extension.create({
  name: 'mediaKit',

  addExtensions() {
    return [JotImage, JotYoutube, JotAudio];
  },
});

function youtubeVideoId(value: string): string {
  try {
    const url = new URL(value);
    const host = url.hostname.toLowerCase();

    if (host.endsWith('youtu.be')) {
      return url.pathname.split('/').filter(Boolean)[0] ?? '';
    }

    return (
      url.searchParams.get('v') ??
      url.pathname.match(/^\/(?:embed|shorts|v)\/([\w-]+)/i)?.[1] ??
      ''
    );
  } catch {
    return '';
  }
}
