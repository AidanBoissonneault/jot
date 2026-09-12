import { Extension } from '@tiptap/core';
import { Image } from '@tiptap/extension-image';
import { Youtube } from '@tiptap/extension-youtube';
import { Audio } from '@tiptap/extension-audio';
import { NodeSelection } from '@tiptap/pm/state';
import { INKWELL_IMAGE_MOVE_MIME, rememberInkwellImageMovePayload } from '@/src/extensions/inkwellImageMove';
import { notionClient } from '@/src/services/notionClient';
import { youtubeEmbedUrl } from '@/src/lib/youtubeUtils';
export { youtubeEmbedUrl } from '@/src/lib/youtubeUtils';

const DEFAULT_SYNC_SERVER_URL = 'http://localhost:8787';
const YOUTUBE_ALLOW =
  'accelerometer; autoplay; clipboard-write; encrypted-media; gyroscope; picture-in-picture; web-share';

export const InkwellImage = Image.extend({
  addAttributes() {
    return {
      ...this.parent?.(),
      uploadState: { default: 'idle' },
      mimeType: { default: '' },
      kind: { default: 'image' },
      notionFileUploadId: { default: '' },
      notionBlockId: { default: '' },
      filename: { default: '' },
      width: {
        default: '',
        parseHTML: (element: HTMLElement) => element.getAttribute('data-width') ?? '',
        renderHTML: (attributes: Record<string, unknown>) => {
          const width = normalizeImageWidth(attributes.width);
          return width ? { 'data-width': width, style: `width: ${width}` } : {};
        },
      },
    };
  },

  addNodeView() {
    return ({ node, editor, getPos }) => {
      const wrapper = document.createElement('div');
      wrapper.className = 'inkwell-image-wrapper';
      wrapper.draggable = true;
      wrapper.tabIndex = -1;
      const uploadState = String(node.attrs.uploadState ?? 'idle');
      let currentNode = node;
      let isRefreshing = false;

      if (uploadState === 'error') {
        wrapper.classList.add('is-error');
        wrapper.textContent = 'Image was not synced. Drop it again to upload it to Notion.';
        return { dom: wrapper };
      }

      if (uploadState === 'uploading') {
        wrapper.classList.add('is-uploading');
      }

      const img = document.createElement('img');
      img.draggable = false;
      img.src = String(node.attrs.src ?? '');
      if (node.attrs.alt) img.alt = node.attrs.alt;
      if (node.attrs.title) img.title = node.attrs.title;
      applyImageWidth(wrapper, img, node.attrs.width);
      applyImageUploadState(wrapper, uploadState);

      const onImageError = () => {
        const fileUploadId = String(currentNode.attrs.notionFileUploadId ?? '');
        const notionBlockId = String(currentNode.attrs.notionBlockId ?? '');
        const failedSrc = String(currentNode.attrs.src ?? img.src ?? '');

        if (isRefreshing) {
          return;
        }

        if (!fileUploadId && !notionBlockId) {
          showImageFallback(wrapper, img, failedSrc);
          return;
        }

        isRefreshing = true;
        wrapper.classList.add('is-uploading');
        void notionClient.refreshMediaUrl(fileUploadId, notionBlockId)
          .then((freshSrc) => {
            if (!freshSrc || freshSrc === img.src) {
              throw new Error('Media URL did not change.');
            }

            restoreImageElement(wrapper, img);
            img.src = freshSrc;

            // Uploaded files keep a stable upload id, so persisting the fresh URL
            // cannot turn the Notion file into an external, expiring URL.
            if (fileUploadId) {
              const pos = typeof getPos === 'function' ? getPos() : undefined;
              if (typeof pos === 'number') {
                const attrs = {
                  ...currentNode.attrs,
                  src: freshSrc,
                  uploadState: 'done',
                  ...(notionBlockId ? { notionBlockId } : {}),
                };
                currentNode = currentNode.type.create(
                  attrs,
                  currentNode.content,
                  currentNode.marks,
                );
                editor.view.dispatch(
                  editor.view.state.tr.setNodeMarkup(pos, undefined, attrs),
                );
              }
            }
          })
          .catch(() => {
            showImageFallback(wrapper, img, failedSrc);
          })
          .finally(() => {
            isRefreshing = false;
            wrapper.classList.remove('is-uploading');
          });
      };

      img.addEventListener('error', onImageError);

      wrapper.appendChild(img);
      const resizeHandle = document.createElement('span');
      resizeHandle.className = 'inkwell-image-resize-handle';
      resizeHandle.setAttribute('aria-hidden', 'true');
      wrapper.appendChild(resizeHandle);

      const selectImage = (event?: Event) => {
        const pos = typeof getPos === 'function' ? getPos() : undefined;

        if (typeof pos !== 'number') {
          return;
        }

        event?.preventDefault();
        editor.view.focus();
        editor.view.dispatch(
          editor.view.state.tr.setSelection(NodeSelection.create(editor.view.state.doc, pos)),
        );
      };

      const onClick = (event: MouseEvent) => {
        selectImage(event);
      };

      const onDragStart = (event: DragEvent) => {
        const pos = typeof getPos === 'function' ? getPos() : undefined;

        if (typeof pos !== 'number') {
          return;
        }

        selectImage();
        const payload = {
          kind: 'image' as const,
          pos,
          attrs: currentNode.attrs,
        };
        rememberInkwellImageMovePayload(payload);
        event.dataTransfer?.setData(
          INKWELL_IMAGE_MOVE_MIME,
          JSON.stringify(payload),
        );
        event.dataTransfer?.setData('text/plain', String(currentNode.attrs.src ?? ''));
        event.dataTransfer?.setDragImage(img, 0, 0);
      };

      const onResizePointerDown = (event: PointerEvent) => {
        const pos = typeof getPos === 'function' ? getPos() : undefined;

        if (typeof pos !== 'number') {
          return;
        }

        event.preventDefault();
        event.stopPropagation();
        selectImage();
        resizeHandle.setPointerCapture(event.pointerId);

        const parentWidth = wrapper.parentElement?.getBoundingClientRect().width ?? 0;
        const maxWidth = Math.max(48, parentWidth || wrapper.getBoundingClientRect().width);
        const ownerDocument = wrapper.ownerDocument;

        const onPointerMove = (moveEvent: PointerEvent) => {
          const left = wrapper.getBoundingClientRect().left;
          const nextPixels = clamp(moveEvent.clientX - left, 48, maxWidth);
          const nextWidth = `${((nextPixels / maxWidth) * 100).toFixed(2)}%`;

          currentNode = currentNode.type.create(
            { ...currentNode.attrs, width: nextWidth },
            currentNode.content,
            currentNode.marks,
          );
          applyImageWidth(wrapper, img, nextWidth);
          editor.view.dispatch(
            editor.view.state.tr.setNodeMarkup(pos, undefined, currentNode.attrs),
          );
        };

        const onPointerUp = (upEvent: PointerEvent) => {
          resizeHandle.releasePointerCapture(upEvent.pointerId);
          ownerDocument.removeEventListener('pointermove', onPointerMove);
          ownerDocument.removeEventListener('pointerup', onPointerUp);
        };

        ownerDocument.addEventListener('pointermove', onPointerMove);
        ownerDocument.addEventListener('pointerup', onPointerUp);
      };

      wrapper.addEventListener('click', onClick);
      wrapper.addEventListener('dragstart', onDragStart, true);
      img.addEventListener('dragstart', onDragStart, true);
      resizeHandle.addEventListener('pointerdown', onResizePointerDown);
      applyImageBlockId(wrapper, currentNode.attrs.inkwellBlockId);

      return {
        dom: wrapper,
        selectNode() {
          wrapper.classList.add('is-selected');
        },
        deselectNode() {
          wrapper.classList.remove('is-selected');
        },
        update(nextNode) {
          if (
            nextNode.type !== currentNode.type ||
            String(nextNode.attrs.uploadState ?? 'idle') === 'error'
          ) {
            return false;
          }

          currentNode = nextNode;
          applyImageBlockId(wrapper, nextNode.attrs.inkwellBlockId);
          applyImageUploadState(wrapper, String(nextNode.attrs.uploadState ?? 'idle'));
          restoreImageElement(wrapper, img);
          const nextSrc = String(nextNode.attrs.src ?? '');
          if (img.getAttribute('src') !== nextSrc) img.src = nextSrc;
          img.alt = String(nextNode.attrs.alt ?? '');
          img.title = String(nextNode.attrs.title ?? '');
          applyImageWidth(wrapper, img, nextNode.attrs.width);
          return true;
        },
        stopEvent(event) {
          return (
            event.target instanceof Element &&
            event.target.closest('.inkwell-image-resize-handle') !== null
          );
        },
        destroy() {
          wrapper.removeEventListener('click', onClick);
          wrapper.removeEventListener('dragstart', onDragStart, true);
          img.removeEventListener('error', onImageError);
          img.removeEventListener('dragstart', onDragStart, true);
          resizeHandle.removeEventListener('pointerdown', onResizePointerDown);
        },
      };
    };
  },
});

export const InkwellYoutube = Youtube.configure({
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

const InkwellAudio = Audio.extend({
  addCommands() {
    return {
      setAudio:
        (options) =>
        ({ commands }) => {
          return commands.insertContent({
            type: this.name,
            attrs: options,
          });
        },
    };
  },

  addAttributes() {
    return {
      ...this.parent?.(),
      uploadState: { default: 'idle' },
      mimeType: { default: '' },
      kind: { default: 'audio' },
      notionFileUploadId: { default: '' },
      notionBlockId: { default: '' },
      filename: { default: '' },
      duration: { default: 0 },
    };
  },

  addNodeView() {
    return ({ editor, getPos, node }) => {
      const wrapper = document.createElement('div');
      wrapper.className = 'inkwell-audio-wrapper';
      const uploadState = String(node.attrs.uploadState ?? 'idle');
      let currentNode = node;
      let isRefreshing = false;

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
      audio.src = String(node.attrs.src ?? '');
      audio.preload = 'metadata';

      audio.addEventListener('error', () => {
        const fileUploadId = String(currentNode.attrs.notionFileUploadId ?? '');
        const notionBlockId = String(currentNode.attrs.notionBlockId ?? '');
        const failedSrc = String(currentNode.attrs.src ?? audio.src ?? '');

        if ((fileUploadId || notionBlockId) && !isRefreshing) {
          isRefreshing = true;
          void notionClient.refreshMediaUrl(fileUploadId, notionBlockId)
            .then((freshSrc) => {
              if (!freshSrc || freshSrc === audio.src) {
                throw new Error('Media URL did not change.');
              }

              audio.src = freshSrc;
              const pos = typeof getPos === 'function' ? getPos() : undefined;
              if (fileUploadId && typeof pos === 'number') {
                const attrs = {
                  ...currentNode.attrs,
                  src: freshSrc,
                  uploadState: 'done',
                };
                currentNode = currentNode.type.create(
                  attrs,
                  currentNode.content,
                  currentNode.marks,
                );
                editor.view.dispatch(
                  editor.view.state.tr.setNodeMarkup(pos, undefined, attrs),
                );
              }
            })
            .catch(() => {
              showAudioFallback(wrapper, audio, failedSrc);
            })
            .finally(() => {
              isRefreshing = false;
            });
          return;
        }

        showAudioFallback(wrapper, audio, failedSrc);
      });

      wrapper.appendChild(audio);
      return { dom: wrapper };
    };
  },
});

function showImageFallback(wrapper: HTMLElement, img: HTMLImageElement, src: string) {
  img.remove();
  if (wrapper.querySelector('[data-inkwell-image-fallback]')) {
    return;
  }

  const link = document.createElement('a');
  link.dataset.inkwellImageFallback = '';
  link.href = src;
  link.textContent = 'Open image';
  link.target = '_blank';
  link.rel = 'noopener noreferrer';
  wrapper.prepend(link);
}

function restoreImageElement(wrapper: HTMLElement, img: HTMLImageElement) {
  wrapper.querySelector('[data-inkwell-image-fallback]')?.remove();
  if (!img.isConnected) wrapper.prepend(img);
}

function showAudioFallback(wrapper: HTMLElement, audio: HTMLAudioElement, src: string) {
  if (!audio.isConnected && wrapper.querySelector('a')) {
    return;
  }

  audio.remove();
  if (wrapper.querySelector('a')) {
    return;
  }

  const link = document.createElement('a');
  link.href = src;
  link.textContent = 'Open audio file';
  link.target = '_blank';
  link.rel = 'noopener noreferrer';
  wrapper.appendChild(link);
}

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



function normalizeImageWidth(value: unknown): string {
  const width = String(value ?? '').trim();

  if (/^\d+(?:\.\d+)?%$/.test(width)) {
    return `${clamp(Number.parseFloat(width), 5, 100)}%`;
  }

  if (/^\d+(?:\.\d+)?px$/.test(width)) {
    return `${Math.max(48, Number.parseFloat(width))}px`;
  }

  return '';
}

function applyImageWidth(wrapper: HTMLElement, img: HTMLImageElement, value: unknown) {
  const width = normalizeImageWidth(value);
  wrapper.style.width = width;
  img.style.width = width ? '100%' : '';
}

function applyImageUploadState(wrapper: HTMLElement, uploadState: string) {
  wrapper.classList.toggle('is-uploading', uploadState === 'uploading');
}

function applyImageBlockId(wrapper: HTMLElement, value: unknown) {
  const blockId = typeof value === 'string' ? value : '';

  if (blockId) {
    wrapper.setAttribute('data-inkwell-block-id', blockId);
    wrapper.setAttribute('data-inkwell-image-block-id', blockId);
    wrapper.title = blockId;
  } else {
    wrapper.removeAttribute('data-inkwell-block-id');
    wrapper.removeAttribute('data-inkwell-image-block-id');
    wrapper.removeAttribute('title');
  }
}

function clamp(value: number, min: number, max: number) {
  return Math.min(Math.max(value, min), max);
}

export const MediaKit = Extension.create({
  name: 'mediaKit',

  addExtensions() {
    return [InkwellImage, InkwellYoutube, InkwellAudio];
  },
});
