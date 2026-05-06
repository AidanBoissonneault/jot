import type { CaptureSelectionMessage } from '@/src/types/messages';

const BUTTON_ID = 'jot-inline-save';
const JOT_DRAG_MIME = 'application/x-jot-capture';
const LARGE_TEXT_PX = 22;

export default defineContentScript({
  matches: ['<all_urls>'],
  main() {
    let selectedPayload: CaptureSelectionMessage['payload'] | null = null;
    let removeTimer: number | undefined;

    const button = document.createElement('button');
    button.id = BUTTON_ID;
    button.type = 'button';
    button.textContent = 'Save';
    button.setAttribute('aria-label', 'Save selection to Jot');
    Object.assign(button.style, {
      position: 'absolute',
      zIndex: '2147483647',
      display: 'none',
      minHeight: '30px',
      padding: '0 12px',
      border: '1px solid #17483f',
      borderRadius: '8px',
      background: '#28635a',
      boxShadow: '0 8px 24px rgb(0 0 0 / 18%)',
      color: '#ffffff',
      cursor: 'pointer',
      font: '600 13px/1 system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif',
    });

    document.documentElement.append(button);

    function hideButton() {
      selectedPayload = null;
      button.style.display = 'none';
    }

    function buildSourceLink(text: string) {
      const url = new URL(window.location.href);
      const textFragment = encodeURIComponent(text.replace(/\s+/g, ' ').trim());

      if (!textFragment) {
        return url.toString();
      }

      const baseUrl = `${url.origin}${url.pathname}${url.search}`;
      return url.hash
        ? `${baseUrl}${url.hash}:~:text=${textFragment}`
        : `${baseUrl}#:~:text=${textFragment}`;
    }

    function getSelectionElement(selection: Selection) {
      const node = selection.anchorNode;

      if (!node) {
        return null;
      }

      return node.nodeType === Node.ELEMENT_NODE
        ? (node as Element)
        : node.parentElement;
    }

    function isHeadingLike(selection: Selection) {
      const element = getSelectionElement(selection);

      if (!element) {
        return false;
      }

      const heading = element.closest('h1,h2,h3,h4,h5,h6,[role="heading"]');

      if (heading) {
        return true;
      }

      const style = window.getComputedStyle(element);
      const fontSize = Number.parseFloat(style.fontSize);
      const fontWeight = Number.parseInt(style.fontWeight, 10);

      return fontSize >= LARGE_TEXT_PX || (fontSize >= 18 && fontWeight >= 600);
    }

    function buildCapturePayload(
      selection: Selection,
      text: string,
      includeHeadingMetadata = false,
    ) {
      const isHeading = isHeadingLike(selection);

      return {
        text,
        sourceUrl: window.location.href,
        pageTitle: document.title,
        highlightMeta: {
          text,
          isHeading: includeHeadingMetadata && isHeading,
          ...(includeHeadingMetadata && isHeading
            ? { sourceLink: buildSourceLink(text) }
            : {}),
        },
      } satisfies CaptureSelectionMessage['payload'];
    }

    function showButton(selection: Selection, text: string) {
      const range = selection.rangeCount ? selection.getRangeAt(0) : null;

      if (!range) {
        hideButton();
        return;
      }

      const rect = range.getBoundingClientRect();

      if (!rect.width && !rect.height) {
        hideButton();
        return;
      }

      selectedPayload = buildCapturePayload(selection, text);

      button.style.left = `${Math.max(8, rect.left + window.scrollX)}px`;
      button.style.top = `${Math.max(8, rect.bottom + window.scrollY + 8)}px`;
      button.style.display = 'block';
    }

    document.addEventListener('selectionchange', () => {
      window.clearTimeout(removeTimer);

      removeTimer = window.setTimeout(() => {
        const selection = window.getSelection();
        const selectedText = selection?.toString().trim();

        if (!selection || !selectedText) {
          hideButton();
          return;
        }

        showButton(selection, selectedText);
      }, 80);
    });

    button.addEventListener('mousedown', (event) => {
      event.preventDefault();
    });

    button.addEventListener('click', async () => {
      if (!selectedPayload) {
        return;
      }

      button.disabled = true;
      button.textContent = 'Saved';

      await browser.runtime.sendMessage({
        type: 'jot.captureSelection',
        payload: selectedPayload,
      } satisfies CaptureSelectionMessage);

      window.setTimeout(() => {
        button.disabled = false;
        button.textContent = 'Save';
        hideButton();
      }, 500);
    });

    document.addEventListener(
      'dragstart',
      (event) => {
        const selection = window.getSelection();
        const selectedText = selection?.toString().trim();

        if (!event.dataTransfer || !selection || !selectedText) {
          return;
        }

        const payload = buildCapturePayload(selection, selectedText, true);

        if (!payload.highlightMeta.isHeading) {
          return;
        }

        event.dataTransfer.setData(JOT_DRAG_MIME, JSON.stringify(payload));
        event.dataTransfer.setData('text/plain', selectedText);
        event.dataTransfer.effectAllowed = 'copy';
      },
      true,
    );
  },
});
