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

export const JotYoutube = Youtube;

export const JotAudio = Audio.extend({
  addAttributes() {
    return {
      ...this.parent?.(),
      uploadState: { default: 'idle' },
      mimeType: { default: '' },
      kind: { default: 'audio' },
    };
  },
});

export const MediaKit = Extension.create({
  name: 'mediaKit',

  addExtensions() {
    return [JotImage, JotYoutube, JotAudio];
  },
});
