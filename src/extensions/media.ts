import { Extension } from '@tiptap/core';
import { Image } from '@tiptap/extension-image';
import { Youtube } from '@tiptap/extension-youtube';
import { Audio } from '@tiptap/extension-audio';
import { notionClient } from '@/src/services/notionClient';

const DEFAULT_SYNC_SERVER_URL = 'http://localhost:8787';
const YOUTUBE_ALLOW =
  'accelerometer; autoplay; clipboard-write; encrypted-media; gyroscope; picture-in-picture; web-share';

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
  nocookie: true,
  controls: true,
  allowFullscreen: true,
  autoplay: false,
  enableIFrameApi: false,
  HTMLAttributes: {
    referrerpolicy: 'strict-origin-when-cross-origin',
    allow: YOUTUBE_ALLOW,
  },
}).extend({
  addNodeView() {
    return ({ node }) => {
      const src = String(node.attrs.src ?? '');
      const wrapper = document.createElement('div');
      wrapper.setAttribute('data-youtube-video', '');

      const iframe = document.createElement('iframe');
      iframe.width = '640';
      iframe.height = '480';
      iframe.allow = YOUTUBE_ALLOW;
      iframe.allowFullscreen = true;
      iframe.referrerPolicy = 'strict-origin-when-cross-origin';
      iframe.title = 'YouTube video player';

      wrapper.appendChild(iframe);
      void setYoutubeIframeSource(iframe, src);

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

async function setYoutubeIframeSource(iframe: HTMLIFrameElement, src: string) {
  const directEmbedUrl = youtubeEmbedUrl(src);

  if (!directEmbedUrl) {
    iframe.remove();
    return;
  }

  const proxyUrl = await youtubeProxyEmbedUrl(src).catch(() => '');
  iframe.src = proxyUrl || directEmbedUrl;
}

async function youtubeProxyEmbedUrl(src: string): Promise<string> {
  const syncConfig = await notionClient.getSyncConfig();
  const serverUrl = cleanServerUrl(syncConfig.serverUrl || DEFAULT_SYNC_SERVER_URL);
  const url = new URL('/youtube/embed', serverUrl);
  url.searchParams.set('src', src);
  return url.toString();
}

function cleanServerUrl(value: string) {
  return value.trim().replace(/\/+$/, '') || DEFAULT_SYNC_SERVER_URL;
}

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

function youtubeVideoInfo(value: string): { id: string; start: number } | null {
  try {
    const url = new URL(value);
    const host = url.hostname.toLowerCase();
    let id = '';

    if (host.endsWith('youtu.be')) {
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

function youtubeStartSeconds(value: string): number {
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

export const MediaKit = Extension.create({
  name: 'mediaKit',

  addExtensions() {
    return [JotImage, JotYoutube, JotAudio];
  },
});
