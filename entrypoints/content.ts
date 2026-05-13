import type {
  CaptureSelectionMessage,
  HeadingDragStartedMessage,
  InkwellRuntimeMessage,
  RestoreHighlightMessage,
  TextDragStartedMessage,
} from '@/src/types/messages';

const BUTTON_ID = 'inkwell-inline-save';
const INKWELL_DRAG_MIME = 'application/x-inkwell-capture';
const INKWELL_HEADING_DRAG_MIME = 'application/x-inkwell-heading-capture';
const INKWELL_SOURCE_DATA_ATTR = 'data-inkwell-source';
const LARGE_TEXT_PX = 22;
type HeadingLevel = 1 | 2 | 3 | 4 | 5 | 6;

export default defineContentScript({
  matches: ['<all_urls>'],
  main() {
    let selectedPayload: CaptureSelectionMessage['payload'] | null = null;
    let removeTimer: number | undefined;

    const button = document.createElement('button');
    button.id = BUTTON_ID;
    button.type = 'button';
    button.textContent = 'Save';
    button.setAttribute('aria-label', 'Save selection to Inkwell');
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

    browser.runtime.onMessage.addListener((message: InkwellRuntimeMessage) => {
      if (message?.type !== 'inkwell.restoreHighlight') {
        return false;
      }

      return restoreHighlight(message);
    });

    function hideButton() {
      selectedPayload = null;
      button.style.display = 'none';
    }

    function buildSourceLink(text: string, targetElement?: Element | null) {
      const url = new URL(window.location.href);
      const elementId = targetElement?.id?.trim();

      if (elementId) {
        url.hash = elementId;
        return url.toString();
      }

      const textFragment = encodeURIComponent(text.replace(/\s+/g, ' ').trim());

      if (!textFragment) {
        return url.toString();
      }

      const baseUrl = `${url.origin}${url.pathname}${url.search}`;
      return url.hash
        ? `${baseUrl}${url.hash}:~:text=${textFragment}`
        : `${baseUrl}#:~:text=${textFragment}`;
    }

    function getNodeXPath(node: Node) {
      const segments: string[] = [];
      let current: Node | null = node;

      while (current && current !== document) {
        if (current.nodeType === Node.TEXT_NODE) {
          let textIndex = 1;
          let sibling = current.previousSibling;

          while (sibling) {
            if (sibling.nodeType === Node.TEXT_NODE) {
              textIndex += 1;
            }

            sibling = sibling.previousSibling;
          }

          segments.unshift(`text()[${textIndex}]`);
        } else if (current.nodeType === Node.ELEMENT_NODE) {
          const element = current as Element;
          let elementIndex = 1;
          let sibling = element.previousElementSibling;

          while (sibling) {
            if (sibling.tagName === element.tagName) {
              elementIndex += 1;
            }

            sibling = sibling.previousElementSibling;
          }

          segments.unshift(
            `${element.tagName.toLowerCase()}[${elementIndex}]`,
          );
        }

        current = current.parentNode;
      }

      return segments.length ? `/${segments.join('/')}` : undefined;
    }

    function getContext(textNode: Text, offset: number, selectedLength: number) {
      const sourceText = textNode.data;

      return {
        prefix: sourceText.slice(Math.max(0, offset - 32), offset),
        suffix: sourceText.slice(offset + selectedLength, offset + selectedLength + 32),
      };
    }

    function getSelectionTextNode(range: Range) {
      if (range.startContainer.nodeType === Node.TEXT_NODE) {
        return range.startContainer as Text;
      }

      const root =
        range.commonAncestorContainer.nodeType === Node.ELEMENT_NODE
          ? (range.commonAncestorContainer as Element)
          : range.commonAncestorContainer.parentElement;

      if (!root) {
        return null;
      }

      const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT, {
        acceptNode: (node) =>
          range.intersectsNode(node) && node.textContent?.trim()
            ? NodeFilter.FILTER_ACCEPT
            : NodeFilter.FILTER_REJECT,
      });

      return walker.nextNode() as Text | null;
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

    function getElementFromNode(node: Node | null) {
      if (!node) {
        return null;
      }

      return node.nodeType === Node.ELEMENT_NODE
        ? (node as Element)
        : node.parentElement;
    }

    function getHtmlHeadingElement(element: Element | null) {
      return element?.closest('h1,h2,h3,h4,h5,h6') ?? null;
    }

    function getHtmlHeadingLevel(element: Element): HeadingLevel | undefined {
      return /^H[1-6]$/.test(element.tagName)
        ? (Number(element.tagName.slice(1)) as HeadingLevel)
        : undefined;
    }

    function getSelectionHtmlHeading(selection: Selection) {
      const range = selection.rangeCount ? selection.getRangeAt(0) : null;
      const anchorHeading = getHtmlHeadingElement(getElementFromNode(selection.anchorNode));

      if (anchorHeading) {
        return anchorHeading;
      }

      return getHtmlHeadingElement(
        getElementFromNode(range?.commonAncestorContainer ?? null),
      );
    }

    function getHeadingElement(element: Element) {
      const heading = element.closest('h1,h2,h3,h4,h5,h6');

      if (heading) {
        return heading;
      }

      const roleHeading = element.closest('[role="heading"]');

      if (roleHeading) {
        return roleHeading;
      }

      return element;
    }

    function getHeadingLevelFromElement(element: Element): HeadingLevel | undefined {
      const heading = element.closest('h1,h2,h3,h4,h5,h6');

      if (heading) {
        return Number(heading.tagName.slice(1)) as HeadingLevel;
      }

      const roleHeading = element.closest('[role="heading"]');
      const ariaLevel = roleHeading?.getAttribute('aria-level');
      const parsedAriaLevel = ariaLevel ? Number(ariaLevel) : undefined;

      if (
        parsedAriaLevel &&
        parsedAriaLevel >= 1 &&
        parsedAriaLevel <= 6
      ) {
        return parsedAriaLevel as HeadingLevel;
      }

      const style = window.getComputedStyle(element);
      const fontSize = Number.parseFloat(style.fontSize);
      const fontWeight = Number.parseInt(style.fontWeight, 10);

      return fontSize >= LARGE_TEXT_PX || (fontSize >= 18 && fontWeight >= 600)
        ? 2
        : undefined;
    }

    function getHeadingLevel(selection: Selection): HeadingLevel | undefined {
      const element = getSelectionElement(selection);

      return element ? getHeadingLevelFromElement(element) : undefined;
    }

    function getFirstTextNode(element: Element) {
      const walker = document.createTreeWalker(element, NodeFilter.SHOW_TEXT, {
        acceptNode: (node) =>
          node.textContent?.trim()
            ? NodeFilter.FILTER_ACCEPT
            : NodeFilter.FILTER_REJECT,
      });

      return walker.nextNode() as Text | null;
    }

    function buildCapturePayload(
      selection: Selection,
      text: string,
      includeHeadingMetadata = false,
    ) {
      const selectionElement = getSelectionElement(selection);
      const headingElement = selectionElement
        ? getHeadingElement(selectionElement)
        : null;
      const headingLevel = getHeadingLevel(selection);
      const range = selection.rangeCount ? selection.getRangeAt(0) : null;
      const textNode = range ? getSelectionTextNode(range) : null;
      const offset =
        textNode && range?.startContainer === textNode
          ? range.startOffset
          : textNode?.data.indexOf(text);
      const context =
        textNode && typeof offset === 'number' && offset >= 0
          ? getContext(textNode, offset, text.length)
          : {};
      const sourceLink = buildSourceLink(
        text,
        headingLevel ? headingElement : null,
      );

      return {
        text,
        sourceUrl: window.location.href,
        pageTitle: document.title,
        highlightMeta: {
          text,
          sourceLink,
          xpath: textNode ? getNodeXPath(textNode) : undefined,
          offset: typeof offset === 'number' && offset >= 0 ? offset : undefined,
          ...context,
          isHeading: includeHeadingMetadata && Boolean(headingLevel),
          headingLevel: includeHeadingMetadata ? headingLevel : undefined,
        },
      } satisfies CaptureSelectionMessage['payload'];
    }

    function buildHeadingDragPayload(event: DragEvent) {
      const selection = window.getSelection();
      const selectedText = selection?.toString().trim();
      const selectedHeading = selection
        ? getSelectionHtmlHeading(selection)
        : null;

      if (selection && selectedText && selectedHeading) {
        return buildHtmlHeadingPayload(selectedHeading, selectedText);
      }

      const target = event.target instanceof Node
        ? getElementFromNode(event.target)
        : null;
      const headingElement = getHtmlHeadingElement(target);

      if (!headingElement) {
        return null;
      }

      return buildHtmlHeadingPayload(headingElement);
    }

    function buildHtmlHeadingPayload(
      headingElement: Element,
      selectedText?: string,
    ) {
      const headingLevel = headingElement
        ? getHtmlHeadingLevel(headingElement)
        : undefined;
      const text = (selectedText || headingElement.textContent || '')
        .replace(/\s+/g, ' ')
        .trim();

      if (!headingElement || !headingLevel || !text) {
        return null;
      }

      const textNode = getFirstTextNode(headingElement);
      const context = textNode ? getContext(textNode, 0, text.length) : {};

      return {
        text,
        sourceUrl: window.location.href,
        pageTitle: document.title,
        highlightMeta: {
          text,
          sourceLink: buildSourceLink(text, headingElement),
          xpath: textNode ? getNodeXPath(textNode) : undefined,
          offset: textNode ? 0 : undefined,
          ...context,
          isHeading: true,
          headingLevel,
        },
      } satisfies CaptureSelectionMessage['payload'];
    }

    function sourceOpenPayloadFromCapture(
      payload: CaptureSelectionMessage['payload'],
    ) {
      return {
        sourceUrl: payload.sourceUrl,
        pageTitle: payload.pageTitle,
        highlightMeta: {
          text: payload.highlightMeta.text,
          sourceLink: payload.highlightMeta.sourceLink,
          xpath: payload.highlightMeta.xpath,
          offset: payload.highlightMeta.offset,
          prefix: payload.highlightMeta.prefix,
          suffix: payload.highlightMeta.suffix,
        },
      };
    }

    function htmlEscape(value: string) {
      return value
        .replaceAll('&', '&amp;')
        .replaceAll('<', '&lt;')
        .replaceAll('>', '&gt;')
        .replaceAll('"', '&quot;');
    }

    function linkedHeadingHtml(payload: CaptureSelectionMessage['payload']) {
      const level = payload.highlightMeta.headingLevel ?? 2;
      const href = payload.highlightMeta.sourceLink || payload.sourceUrl;
      const sourcePayload = JSON.stringify(sourceOpenPayloadFromCapture(payload));

      return `<h${level}><a href="${htmlEscape(href)}" ${INKWELL_SOURCE_DATA_ATTR}="${htmlEscape(sourcePayload)}">${htmlEscape(payload.text)}</a></h${level}>`;
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

      selectedPayload = buildCapturePayload(selection, text, true);

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
        type: 'inkwell.captureSelection',
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
        if (!event.dataTransfer) {
          return;
        }

        const headingPayload = buildHeadingDragPayload(event);

        if (headingPayload) {
          event.dataTransfer.setData(INKWELL_DRAG_MIME, JSON.stringify(headingPayload));
          event.dataTransfer.setData(INKWELL_HEADING_DRAG_MIME, '1');
          event.dataTransfer.setData('text/html', linkedHeadingHtml(headingPayload));
          void browser.runtime
            .sendMessage({
              type: 'inkwell.headingDragStarted',
              payload: headingPayload,
            } satisfies HeadingDragStartedMessage)
            .catch(() => undefined);
          return;
        }

        const selection = window.getSelection();
        const selectedText = selection?.toString().trim();

        if (!selection || !selectedText) {
          return;
        }

        const textPayload = buildCapturePayload(selection, selectedText);
        event.dataTransfer.setData(INKWELL_DRAG_MIME, JSON.stringify(textPayload));
        void browser.runtime
          .sendMessage({
            type: 'inkwell.textDragStarted',
            payload: textPayload,
          } satisfies TextDragStartedMessage)
          .catch(() => undefined);
      },
      true,
    );

    function restoreHighlight(message: RestoreHighlightMessage) {
      const range =
        getRangeFromXPath(message.payload.highlightMeta) ??
        getRangeFromWindowFind(message.payload.highlightMeta.text);

      if (!range) {
        return false;
      }

      scrollRangeIntoView(range);
      temporarilyHighlightRange(range);
      return true;
    }

    function getRangeFromXPath(meta: RestoreHighlightMessage['payload']['highlightMeta']) {
      if (!meta.xpath) {
        return null;
      }

      const node = document.evaluate(
        meta.xpath,
        document,
        null,
        XPathResult.FIRST_ORDERED_NODE_TYPE,
      ).singleNodeValue;

      if (node?.nodeType !== Node.TEXT_NODE) {
        return null;
      }

      const textNode = node as Text;
      const startOffset =
        typeof meta.offset === 'number' && meta.offset >= 0
          ? meta.offset
          : textNode.data.indexOf(meta.text);
      const matchingOffset =
        startOffset >= 0 &&
        textNode.data.slice(startOffset, startOffset + meta.text.length) ===
          meta.text
          ? startOffset
          : textNode.data.indexOf(meta.text);

      if (matchingOffset < 0) {
        return null;
      }

      const range = document.createRange();
      range.setStart(textNode, matchingOffset);
      range.setEnd(textNode, matchingOffset + meta.text.length);
      return range;
    }

    function getRangeFromWindowFind(text: string) {
      if (!text) {
        return null;
      }

      const selection = window.getSelection();
      selection?.removeAllRanges();

      const findText = (
        window as Window & {
          find?: (
            string: string,
            caseSensitive?: boolean,
            backwards?: boolean,
            wrapAround?: boolean,
            wholeWord?: boolean,
            searchInFrames?: boolean,
            showDialog?: boolean,
          ) => boolean;
        }
      ).find;

      if (!findText?.(text, false, false, true, false, true, false)) {
        return null;
      }

      return selection?.rangeCount ? selection.getRangeAt(0).cloneRange() : null;
    }

    function scrollRangeIntoView(range: Range) {
      const rect = range.getBoundingClientRect();

      if (!rect.width && !rect.height) {
        return;
      }

      window.scrollTo({
        top: rect.top + window.scrollY - window.innerHeight / 2,
        behavior: 'smooth',
      });
    }

    function temporarilyHighlightRange(range: Range) {
      const selection = window.getSelection();
      selection?.removeAllRanges();
      selection?.addRange(range.cloneRange());

      try {
        const highlightRange = range.cloneRange();
        const highlight = document.createElement('mark');
        highlight.setAttribute('data-inkwell-restored-highlight', 'true');
        Object.assign(highlight.style, {
          background: '#fff2a8',
          color: 'inherit',
          padding: '0 2px',
        });

        highlightRange.surroundContents(highlight);

        window.setTimeout(() => {
          const parent = highlight.parentNode;

          if (!parent) {
            return;
          }

          while (highlight.firstChild) {
            parent.insertBefore(highlight.firstChild, highlight);
          }

          parent.removeChild(highlight);
          parent.normalize();
        }, 4200);
      } catch {
        window.setTimeout(() => selection?.removeAllRanges(), 4200);
      }
    }
  },
});
