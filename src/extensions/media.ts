import { Extension } from '@tiptap/core';
import { Image } from '@tiptap/extension-image';
import { Youtube } from '@tiptap/extension-youtube';
import { Audio } from '@tiptap/extension-audio';
import { NodeSelection } from '@tiptap/pm/state';
import { JOTTATHING_IMAGE_MOVE_MIME, rememberJottathingImageMovePayload } from '@/src/extensions/jottathingImageMove';
import { notionClient } from '@/src/services/notionClient';
import { cleanSyncServerUrl } from '@/src/lib/syncServerUrl';
import { youtubeEmbedUrl } from '@/src/lib/youtubeUtils';
export { youtubeEmbedUrl } from '@/src/lib/youtubeUtils';

const YOUTUBE_ALLOW =
  'accelerometer; autoplay; clipboard-write; encrypted-media; gyroscope; picture-in-picture; web-share';

export const JottathingImage = Image.extend({
  addAttributes() {
    return {
      ...this.parent?.(),
      uploadState: { default: 'idle' },
      uploadStartedAt: { default: null },
      mimeType: { default: '' },
      kind: { default: 'image' },
      notionFileUploadId: { default: '' },
      notionBlockId: { default: '' },
      filename: { default: '' },
      caption: {
        default: [],
        parseHTML: (element: HTMLElement) => {
          const caption = element.getAttribute('data-caption') ?? '';
          return caption ? [{ type: 'text', text: caption }] : [];
        },
        renderHTML: ({ caption }: Record<string, unknown>) =>
          imageCaptionText(caption) ? { 'data-caption': imageCaptionText(caption) } : {},
      },
      localSrc: {
        default: '',
        parseHTML: () => '',
        renderHTML: () => ({}),
      },
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
      wrapper.className = 'jottathing-image-wrapper';
      wrapper.draggable = false;
      wrapper.tabIndex = -1;
      const uploadState = String(node.attrs.uploadState ?? 'idle');
      let currentNode = node;
      let isRefreshing = false;
      let lastRefreshedSrc = '';
      let imageElement: HTMLImageElement | null = null;
      let previewOverlay: HTMLElement | null = null;
      let closePreview: (restoreFocus?: boolean) => void = () => undefined;

      const controls = document.createElement('div');
      controls.className = 'jottathing-image-controls';
      controls.setAttribute('role', 'group');
      controls.setAttribute('aria-label', 'Image actions');
      const title = document.createElement('span');
      title.className = 'jottathing-image-title';
      const dragButton = document.createElement('button');
      dragButton.className = 'jottathing-image-drag';
      dragButton.type = 'button';
      dragButton.draggable = true;
      dragButton.appendChild(createDragIcon(document));
      dragButton.setAttribute('aria-label', 'Drag image to move');
      dragButton.title = 'Drag image to move';
      const deleteButton = document.createElement('button');
      deleteButton.className = 'jottathing-image-delete';
      deleteButton.type = 'button';
      deleteButton.appendChild(createTrashIcon(document));
      deleteButton.setAttribute('aria-label', 'Delete image');
      deleteButton.title = 'Delete image';
      controls.append(title, dragButton, deleteButton);
      applyImageTitle(wrapper, title, currentNode.attrs);
      applyImageBlockId(wrapper, currentNode.attrs.jottathingBlockId);

      const captionButton = document.createElement('button');
      captionButton.className = 'jottathing-image-caption-display';
      captionButton.type = 'button';
      captionButton.setAttribute('aria-label', 'Add image caption');
      captionButton.textContent = 'Add caption';

      const captionInput = document.createElement('textarea');
      captionInput.className = 'jottathing-image-caption';
      captionInput.rows = 1;
      captionInput.maxLength = 2000;
      captionInput.placeholder = 'Add caption…';
      captionInput.setAttribute('aria-label', 'Image caption');
      captionInput.hidden = true;
      captionInput.value = imageCaptionText(currentNode.attrs.caption);
      let editingCaption = false;

      const showCaptionButton = () => {
        const caption = imageCaptionText(currentNode.attrs.caption);
        captionButton.textContent = caption || 'Add caption';
        captionButton.setAttribute('aria-label', caption ? 'Edit image caption' : 'Add image caption');
        captionButton.dataset.empty = caption ? 'false' : 'true';
      };
      showCaptionButton();

      const selectImage = (event?: Event) => {
        const pos = typeof getPos === 'function' ? getPos() : undefined;

        if (typeof pos !== 'number') return;
        event?.preventDefault();
        editor.view.focus();
        editor.view.dispatch(
          editor.view.state.tr.setSelection(NodeSelection.create(editor.view.state.doc, pos)),
        );
      };

      const onDeleteImage = (event: MouseEvent) => {
        event.preventDefault();
        event.stopPropagation();
        const pos = typeof getPos === 'function' ? getPos() : undefined;
        if (typeof pos !== 'number') return;
        editor.view.dispatch(editor.view.state.tr.delete(pos, pos + currentNode.nodeSize));
        editor.view.focus();
      };

      const onPreviewKeyDown = (event: KeyboardEvent) => {
        if (event.key === 'Escape') {
          event.preventDefault();
          closePreview();
        } else if (event.key === 'Tab') {
          event.preventDefault();
          previewOverlay?.querySelector<HTMLButtonElement>('.jottathing-image-preview-close')?.focus();
        }
      };

      const onPreviewDocumentKeyDown = (event: KeyboardEvent) => {
        if (event.key === 'Escape') {
          event.preventDefault();
          closePreview();
        } else if (event.key === 'Tab' && previewOverlay) {
          event.preventDefault();
          previewOverlay.querySelector<HTMLButtonElement>('.jottathing-image-preview-close')?.focus();
        }
      };

      const openImagePreview = () => {
        if (!imageElement || previewOverlay || !imageElement.src) return;
        const ownerDocument = wrapper.ownerDocument;
        const overlay = ownerDocument.createElement('div');
        overlay.className = 'jottathing-image-preview-overlay';
        overlay.setAttribute('role', 'dialog');
        overlay.setAttribute('aria-modal', 'true');
        overlay.setAttribute('aria-label', `Image preview: ${imageDisplayTitle(currentNode.attrs)}`);

        const preview = ownerDocument.createElement('img');
        preview.className = 'jottathing-image-preview';
        preview.src = imageElement.currentSrc || imageElement.src;
        preview.alt = String(currentNode.attrs.alt ?? imageDisplayTitle(currentNode.attrs));
        preview.draggable = false;

        const caption = ownerDocument.createElement('div');
        caption.className = 'jottathing-image-preview-caption';
        caption.textContent = imageCaptionText(currentNode.attrs);

        const closeButton = ownerDocument.createElement('button');
        closeButton.className = 'jottathing-image-preview-close';
        closeButton.type = 'button';
        closeButton.textContent = 'Close';
        closeButton.setAttribute('aria-label', 'Close image preview');
        const finishPreview = (_restoreFocus = true) => {
          ownerDocument.removeEventListener('keydown', onPreviewDocumentKeyDown);
          overlay.removeEventListener('keydown', onPreviewKeyDown);
          overlay.remove();
          previewOverlay = null;
          if (_restoreFocus && imageElement?.isConnected) imageElement.focus();
        };
        closePreview = finishPreview;
        closeButton.addEventListener('click', () => finishPreview());
        overlay.addEventListener('click', (event) => {
          if (event.target === overlay) finishPreview();
        });
        overlay.addEventListener('keydown', onPreviewKeyDown);
        ownerDocument.addEventListener('keydown', onPreviewDocumentKeyDown);
        overlay.append(closeButton, preview, caption);
        ownerDocument.body.appendChild(overlay);
        previewOverlay = overlay;
        closeButton.focus();
      };

      const onClick = (event: MouseEvent) => {
        const target = event.target;
        if (target instanceof Element && target.closest('.jottathing-image-controls, .jottathing-image-caption')) return;
        selectImage(event);
        if (imageElement && target === imageElement) openImagePreview();
      };

      const onImageKeyDown = (event: KeyboardEvent) => {
        if (event.key !== 'Enter' && event.key !== ' ') return;
        event.preventDefault();
        event.stopPropagation();
        selectImage();
        openImagePreview();
      };

      const onDeleteClick = (event: MouseEvent) => onDeleteImage(event);
      deleteButton.addEventListener('click', onDeleteClick);

      const onCaptionInput = () => {
        const pos = typeof getPos === 'function' ? getPos() : undefined;
        if (typeof pos !== 'number') return;
        const attrs = {
          ...currentNode.attrs,
          caption: captionInput.value ? [{ type: 'text', text: captionInput.value }] : [],
        };
        currentNode = currentNode.type.create(attrs, currentNode.content, currentNode.marks);
        editor.view.dispatch(editor.view.state.tr.setNodeMarkup(pos, undefined, attrs));
        resizeImageCaption(captionInput);
      };
      const onCaptionButtonClick = (event: MouseEvent) => {
        event.preventDefault();
        event.stopPropagation();
        editingCaption = true;
        captionButton.hidden = true;
        captionInput.hidden = false;
        captionInput.focus();
        captionInput.setSelectionRange(captionInput.value.length, captionInput.value.length);
        resizeImageCaption(captionInput);
      };
      const onCaptionBlur = () => {
        onCaptionInput();
        editingCaption = false;
        captionInput.hidden = true;
        captionButton.hidden = false;
        showCaptionButton();
      };
      captionButton.addEventListener('click', onCaptionButtonClick);
      captionInput.addEventListener('input', onCaptionInput);
      captionInput.addEventListener('blur', onCaptionBlur);
      resizeImageCaption(captionInput);

      const stopNodeViewEvent = (event: Event) => {
        const target = event.target;
        return target instanceof Element && Boolean(
          target.closest('.jottathing-image-resize-handle, .jottathing-image-controls, .jottathing-image-caption-display, .jottathing-image-caption'),
        );
      };

      if (uploadState === 'error') {
        wrapper.classList.add('is-error');
        const error = document.createElement('span');
        error.className = 'jottathing-image-error-message';
        error.textContent = 'Image was not synced. Drop it again to upload it to Notion.';
        wrapper.append(error, controls, captionButton, captionInput);
        wrapper.addEventListener('click', onClick);
        return {
          dom: wrapper,
          selectNode() { wrapper.classList.add('is-selected'); },
          deselectNode() { wrapper.classList.remove('is-selected'); },
          stopEvent: stopNodeViewEvent,
          destroy() {
            wrapper.removeEventListener('click', onClick);
            deleteButton.removeEventListener('click', onDeleteClick);
            captionButton.removeEventListener('click', onCaptionButtonClick);
            captionInput.removeEventListener('input', onCaptionInput);
            captionInput.removeEventListener('blur', onCaptionBlur);
          },
        };
      }

      if (uploadState === 'uploading') {
        wrapper.classList.add('is-uploading');
      }

      const img = document.createElement('img');
      imageElement = img;
      img.draggable = false;
      img.tabIndex = 0;
      img.setAttribute('role', 'button');
      img.setAttribute('aria-haspopup', 'dialog');
      img.setAttribute('aria-label', `Preview image: ${imageDisplayTitle(currentNode.attrs)}`);
      img.addEventListener('keydown', onImageKeyDown);
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

        if (lastRefreshedSrc && failedSrc === lastRefreshedSrc) {
          if (!restoreLocalImageSource()) showImageFallback(wrapper, img, failedSrc);
          return;
        }

        if (!fileUploadId && !notionBlockId) {
          if (!restoreLocalImageSource()) showImageFallback(wrapper, img, failedSrc);
          return;
        }

        isRefreshing = true;
        wrapper.classList.add('is-uploading');
        void notionClient.refreshMediaUrl(fileUploadId, notionBlockId)
          .then((freshSrc) => {
            if (!freshSrc || freshSrc === img.src) {
              throw new Error('Media URL did not change.');
            }

            lastRefreshedSrc = freshSrc;
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
            if (!restoreLocalImageSource()) showImageFallback(wrapper, img, failedSrc);
          })
          .finally(() => {
            isRefreshing = false;
            wrapper.classList.remove('is-uploading');
          });
      };

      const restoreLocalImageSource = () => {
        const localSrc = String(currentNode.attrs.localSrc ?? '');
        const originalSrc = String(currentNode.attrs.src ?? '');
        const hasStableUpload = Boolean(currentNode.attrs.notionFileUploadId);
        const fallbackSrc = /^data:image\//i.test(localSrc)
          ? localSrc
          : hasStableUpload && /^data:image\//i.test(originalSrc)
            ? originalSrc
            : '';
        if (!fallbackSrc || !isInlineImageFormatSupported(currentNode.attrs, fallbackSrc)) return false;

        restoreImageElement(wrapper, img);
        img.src = fallbackSrc;
        return true;
      };

      img.addEventListener('error', onImageError);

      wrapper.appendChild(img);
      wrapper.appendChild(controls);
      wrapper.appendChild(captionButton);
      wrapper.appendChild(captionInput);
      const resizeHandle = document.createElement('span');
      resizeHandle.className = 'jottathing-image-resize-handle';
      resizeHandle.setAttribute('aria-hidden', 'true');
      wrapper.appendChild(resizeHandle);

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
        rememberJottathingImageMovePayload(payload);
        event.dataTransfer?.setData(
          JOTTATHING_IMAGE_MOVE_MIME,
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
          applyImageBlockId(wrapper, nextNode.attrs.jottathingBlockId);
          applyImageTitle(wrapper, title, nextNode.attrs);
          applyImageUploadState(wrapper, String(nextNode.attrs.uploadState ?? 'idle'));
          restoreImageElement(wrapper, img);
          const nextSrc = String(nextNode.attrs.src ?? '');
          if (img.getAttribute('src') !== nextSrc) img.src = nextSrc;
          img.alt = String(nextNode.attrs.alt ?? '');
          img.title = String(nextNode.attrs.title ?? '');
          img.setAttribute('aria-label', `Preview image: ${imageDisplayTitle(nextNode.attrs)}`);
          const preview = previewOverlay?.querySelector<HTMLImageElement>('.jottathing-image-preview');
          if (preview && preview.src !== nextSrc) preview.src = nextSrc;
          const caption = previewOverlay?.querySelector<HTMLElement>('.jottathing-image-preview-caption');
          if (caption) caption.textContent = imageCaptionText(nextNode.attrs);
          previewOverlay?.setAttribute(
            'aria-label',
            `Image preview: ${imageDisplayTitle(nextNode.attrs)}`,
          );
          const nextCaption = imageCaptionText(nextNode.attrs.caption);
          showCaptionButton();
          if (!editingCaption && captionInput.value !== nextCaption) {
            captionInput.value = nextCaption;
            resizeImageCaption(captionInput);
          }
          applyImageWidth(wrapper, img, nextNode.attrs.width);
          return true;
        },
        stopEvent: stopNodeViewEvent,
        destroy() {
          closePreview(false);
          wrapper.removeEventListener('click', onClick);
          wrapper.removeEventListener('dragstart', onDragStart, true);
          img.removeEventListener('error', onImageError);
          img.removeEventListener('keydown', onImageKeyDown);
          img.removeEventListener('dragstart', onDragStart, true);
          deleteButton.removeEventListener('click', onDeleteClick);
          captionButton.removeEventListener('click', onCaptionButtonClick);
          captionInput.removeEventListener('input', onCaptionInput);
          captionInput.removeEventListener('blur', onCaptionBlur);
          resizeHandle.removeEventListener('pointerdown', onResizePointerDown);
        },
      };
    };
  },
});

export const JottathingYoutube = Youtube.configure({
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

const JottathingAudio = Audio.extend({
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
      uploadStartedAt: { default: null },
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
      wrapper.className = 'jottathing-audio-wrapper';
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
  if (wrapper.querySelector('[data-jottathing-image-fallback]')) {
    return;
  }

  const link = document.createElement('a');
  link.dataset.jottathingImageFallback = '';
  link.href = src;
  link.textContent = 'Open image';
  link.target = '_blank';
  link.rel = 'noopener noreferrer';
  wrapper.prepend(link);
}

function restoreImageElement(wrapper: HTMLElement, img: HTMLImageElement) {
  wrapper.querySelector('[data-jottathing-image-fallback]')?.remove();
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
  const serverUrl = cleanSyncServerUrl(syncConfig.serverUrl);
  const url = new URL('/youtube/embed', serverUrl);
  url.searchParams.set('src', src);
  return url.toString();
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
    wrapper.setAttribute('data-jottathing-block-id', blockId);
    wrapper.setAttribute('data-jottathing-image-block-id', blockId);
  } else {
    wrapper.removeAttribute('data-jottathing-block-id');
    wrapper.removeAttribute('data-jottathing-image-block-id');
  }
}

function imageDisplayTitle(attrs: Record<string, unknown>): string {
  const value = [attrs.title, attrs.alt, attrs.filename]
    .find((candidate) => typeof candidate === 'string' && candidate.trim());
  const candidate = typeof value === 'string' ? value : String(attrs.src ?? '');
  if (!candidate || /^data:/i.test(candidate)) return 'Image';
  let filename = candidate.split(/[\\/]/).pop()?.trim() ?? candidate.trim();
  try {
    const pathname = new URL(candidate, 'https://jottathing.invalid').pathname;
    filename = decodeURIComponent(pathname.split('/').pop() ?? '').trim() || filename;
  } catch {
    // Use the source text fallback for non-URL image data.
  }
  return filename || 'Image';
}

function isInlineImageFormatSupported(attrs: Record<string, unknown>, src: string): boolean {
  const mimeType = String(attrs.mimeType ?? '').trim().toLowerCase();
  if (mimeType === 'image/heic' || mimeType === 'image/tiff') return false;
  const dataMimeType = src.match(/^data:([^;,]+)/i)?.[1]?.toLowerCase();
  if (dataMimeType === 'image/heic' || dataMimeType === 'image/tiff') return false;
  try {
    const path = decodeURIComponent(new URL(src, 'https://jottathing.invalid').pathname);
    return !/\.(?:heic|tif|tiff)$/i.test(path);
  } catch {
    return true;
  }
}

function imageCaptionText(value: unknown): string {
  const isAttributes = Boolean(value && typeof value === 'object' && !Array.isArray(value));
  const caption = isAttributes
    ? (value as Record<string, unknown>).caption
    : value;
  const text = typeof caption === 'string'
    ? caption.trim()
    : Array.isArray(caption)
      ? caption.map(readImageCaptionNodeText).join('').trim()
      : '';
  return text || (isAttributes ? imageDisplayTitle(value as Record<string, unknown>) : '');
}

function readImageCaptionNodeText(value: unknown): string {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return '';
  const node = value as Record<string, unknown>;
  if (typeof node.text === 'string') return node.text;
  if (node.type === 'hardBreak') return '\n';
  return Array.isArray(node.content) ? node.content.map(readImageCaptionNodeText).join('') : '';
}

function applyImageTitle(
  wrapper: HTMLElement,
  label: HTMLElement,
  attrs: Record<string, unknown>,
) {
  const displayTitle = imageDisplayTitle(attrs);
  wrapper.title = displayTitle;
  label.textContent = displayTitle;
}

function createTrashIcon(ownerDocument: Document): SVGSVGElement {
  const icon = ownerDocument.createElementNS('http://www.w3.org/2000/svg', 'svg');
  icon.setAttribute('viewBox', '0 0 24 24');
  icon.setAttribute('aria-hidden', 'true');
  icon.setAttribute('focusable', 'false');
  const path = ownerDocument.createElementNS('http://www.w3.org/2000/svg', 'path');
  path.setAttribute('d', 'M4 7h16M10 11v6m4-6v6M5 7l1 14h12l1-14M9 7V4h6v3');
  path.setAttribute('fill', 'none');
  path.setAttribute('stroke', 'currentColor');
  path.setAttribute('stroke-linecap', 'round');
  path.setAttribute('stroke-linejoin', 'round');
  path.setAttribute('stroke-width', '2');
  icon.appendChild(path);
  return icon;
}

function createDragIcon(ownerDocument: Document): SVGSVGElement {
  const icon = ownerDocument.createElementNS('http://www.w3.org/2000/svg', 'svg');
  icon.setAttribute('viewBox', '0 0 16 16');
  icon.setAttribute('aria-hidden', 'true');
  icon.setAttribute('focusable', 'false');
  for (const x of [5, 11]) {
    for (const y of [3, 8, 13]) {
      const dot = ownerDocument.createElementNS('http://www.w3.org/2000/svg', 'circle');
      dot.setAttribute('cx', String(x));
      dot.setAttribute('cy', String(y));
      dot.setAttribute('r', '1.2');
      dot.setAttribute('fill', 'currentColor');
      icon.appendChild(dot);
    }
  }
  return icon;
}

function resizeImageCaption(caption: HTMLTextAreaElement) {
  caption.style.height = 'auto';
  caption.style.height = `${Math.max(22, caption.scrollHeight)}px`;
}

function clamp(value: number, min: number, max: number) {
  return Math.min(Math.max(value, min), max);
}

export const MediaKit = Extension.create({
  name: 'mediaKit',

  addExtensions() {
    return [JottathingImage, JottathingYoutube, JottathingAudio];
  },
});
