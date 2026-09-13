import type {
  CaptureSelectionMessage,
  CreateWebsiteHighlightMessage,
  GetWebsiteHighlightsMessage,
  HeadingDragStartedMessage,
  InkwellRuntimeMessage,
  RemoveWebsiteHighlightsMessage,
  RestoreHighlightMessage,
  TextDragStartedMessage,
  WebsiteHighlight,
  WebsiteHighlightColor,
} from '@/src/types/messages';
import { detectCodeLanguage } from '@/src/lib/codeLanguages';
import { canonicalWebsiteUrl } from '@/src/lib/websiteUrls';

const BUTTON_ID = 'inkwell-inline-save';
const INKWELL_ACCENT = '#173494';
const INKWELL_ACCENT_STRONG = '#0f2673';
const HIGHLIGHT_STYLE_ID = 'inkwell-persistent-highlight-style';
const HIGHLIGHT_BLOCK_SELECTOR =
  'p,li,blockquote,pre,figcaption,td,th,dt,dd,h1,h2,h3,h4,h5,h6';
const HIGHLIGHT_COLORS: Record<WebsiteHighlightColor, string> = {
  yellow: '#fde68a',
  green: '#bbf7d0',
  blue: '#bfdbfe',
  pink: '#fbcfe8',
  gray: '#d4d4d8',
};
const INKWELL_DRAG_MIME = 'application/x-inkwell-capture';
const INKWELL_HEADING_DRAG_MIME = 'application/x-inkwell-heading-capture';
const INKWELL_SOURCE_DATA_ATTR = 'data-inkwell-source';
const LARGE_TEXT_PX = 22;
type HeadingLevel = 1 | 2 | 3 | 4 | 5 | 6;

export default defineContentScript({
  matches: ['<all_urls>'],
  allFrames: true,
  main() {
    let selectedPayload: CaptureSelectionMessage['payload'] | null = null;
    let selectedHighlight: WebsiteHighlight | null = null;
    let selectedHighlightRange: Range | null = null;
    let selectedExistingHighlightId: string | null = null;
    let removeTimer: number | undefined;
    let selectedHighlightColor: WebsiteHighlightColor = 'yellow';
    let highlightRefreshVersion = 0;
    const persistentHighlightNames = new Set<string>();
    const persistentHighlightMarks = new Set<HTMLElement>();
    const optimisticHighlightChanges = new Map<string, WebsiteHighlight | null>();
    const optimisticHighlightTokens = new Map<string, symbol>();

    const toolbarHost = document.createElement('inkwell-selection-ui');
    toolbarHost.setAttribute('data-inkwell-selection-ui', 'true');
    toolbarHost.style.setProperty('all', 'initial', 'important');
    toolbarHost.style.setProperty('display', 'block', 'important');
    const toolbarRoot = toolbarHost.attachShadow({ mode: 'closed' });

    const toolbar = document.createElement('div');
    toolbar.setAttribute('data-inkwell-highlight-toolbar', 'true');
    Object.assign(toolbar.style, {
      position: 'fixed',
      zIndex: '2147483647',
      display: 'none',
      width: 'max-content',
      maxWidth: 'calc(100vw - 16px)',
      padding: '6px',
      border: '1px solid #e4e4e7',
      borderRadius: '10px',
      background: '#ffffff',
      boxShadow: '0 10px 30px rgb(17 17 19 / 18%)',
      color: '#111113',
      font: '13px/1.35 system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif',
    });

    const actionRow = document.createElement('div');
    Object.assign(actionRow.style, { display: 'flex', gap: '6px' });

    const button = document.createElement('button');
    button.id = BUTTON_ID;
    button.type = 'button';
    button.textContent = 'Save';
    button.setAttribute('aria-label', 'Save selection to Inkwell');
    Object.assign(button.style, {
      flex: '0 0 auto',
      minHeight: '30px',
      padding: '0 12px',
      border: `1px solid ${INKWELL_ACCENT_STRONG}`,
      borderRadius: '8px',
      background: INKWELL_ACCENT,
      boxShadow: '0 8px 24px rgb(0 0 0 / 18%)',
      color: '#ffffff',
      cursor: 'pointer',
      font: '600 13px/1 system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif',
    });

    const detailsToggle = document.createElement('button');
    detailsToggle.type = 'button';
    detailsToggle.textContent = '⌄';
    detailsToggle.title = 'Highlight options';
    detailsToggle.setAttribute('aria-label', 'Show optional highlight details');
    detailsToggle.setAttribute('aria-expanded', 'false');
    Object.assign(detailsToggle.style, {
      flex: '0 0 auto',
      width: '28px',
      height: '28px',
      padding: '0 0 3px',
      border: '1px solid #c7c7cc',
      borderRadius: '8px',
      background: '#ffffff',
      color: '#6b6f76',
      cursor: 'pointer',
      font: '700 16px/1 system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif',
    });

    const highlightPanel = document.createElement('div');
    Object.assign(highlightPanel.style, {
      display: 'none',
      boxSizing: 'border-box',
      width: '290px',
      maxWidth: 'calc(100vw - 28px)',
      padding: '8px 2px 2px',
      borderTop: '1px solid #e4e4e7',
      marginTop: '6px',
    });

    const panelLabel = document.createElement('div');
    panelLabel.textContent = 'Optional details';
    Object.assign(panelLabel.style, {
      marginBottom: '6px',
      color: '#6b6f76',
      fontWeight: '600',
    });

    const colorRow = document.createElement('div');
    Object.assign(colorRow.style, {
      display: 'flex',
      alignItems: 'center',
      gap: '4px',
      paddingLeft: '2px',
    });
    const colorButtons = new Map<WebsiteHighlightColor, HTMLButtonElement>();
    for (const [color, value] of Object.entries(HIGHLIGHT_COLORS) as Array<
      [WebsiteHighlightColor, string]
    >) {
      const swatch = document.createElement('button');
      swatch.type = 'button';
      swatch.title = `${color[0].toUpperCase()}${color.slice(1)}`;
      swatch.setAttribute('aria-label', `${swatch.title} highlight`);
      swatch.setAttribute('aria-pressed', color === selectedHighlightColor ? 'true' : 'false');
      Object.assign(swatch.style, {
        width: '24px',
        height: '24px',
        padding: '0',
        border: color === selectedHighlightColor
          ? `2px solid ${INKWELL_ACCENT}`
          : '1px solid #c7c7cc',
        borderRadius: '999px',
        background: value,
        cursor: 'pointer',
      });
      swatch.addEventListener('mousedown', (event) => event.preventDefault());
      swatch.addEventListener('click', () => void handleHighlightColorClick(color));
      colorButtons.set(color, swatch);
      colorRow.append(swatch);
    }

    const removeHighlightButton = document.createElement('button');
    removeHighlightButton.type = 'button';
    removeHighlightButton.title = 'Remove highlight';
    removeHighlightButton.setAttribute('aria-label', 'Remove highlight');
    Object.assign(removeHighlightButton.style, {
      position: 'relative',
      width: '24px',
      height: '24px',
      padding: '0',
      border: '1px solid #fca5a5',
      borderRadius: '999px',
      background: '#fff7f7',
      cursor: 'pointer',
    });
    const removeHighlightLine = document.createElement('span');
    Object.assign(removeHighlightLine.style, {
      position: 'absolute',
      top: '10px',
      left: '3px',
      width: '16px',
      height: '2px',
      borderRadius: '999px',
      background: '#dc2626',
      transform: 'rotate(-45deg)',
      transformOrigin: 'center',
    });
    removeHighlightButton.append(removeHighlightLine);
    colorRow.append(removeHighlightButton);

    const highlightNote = document.createElement('textarea');
    highlightNote.rows = 2;
    highlightNote.maxLength = 2000;
    highlightNote.placeholder = 'Add details (optional)';
    highlightNote.setAttribute('aria-label', 'Highlight details');
    Object.assign(highlightNote.style, {
      display: 'block',
      boxSizing: 'border-box',
      width: '100%',
      minHeight: '50px',
      resize: 'vertical',
      padding: '7px 9px',
      border: '1px solid #c7c7cc',
      borderRadius: '8px',
      background: '#ffffff',
      color: '#111113',
      font: '13px/1.35 system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif',
    });

    const highlightStatus = document.createElement('div');
    highlightStatus.setAttribute('role', 'status');
    Object.assign(highlightStatus.style, {
      minHeight: '16px',
      marginTop: '5px',
      color: '#991b1b',
      fontSize: '12px',
    });

    const applyHighlightButton = document.createElement('button');
    applyHighlightButton.type = 'button';
    applyHighlightButton.textContent = 'Highlight with details';
    Object.assign(applyHighlightButton.style, {
      width: '100%',
      minHeight: '32px',
      padding: '0 12px',
      border: `1px solid ${INKWELL_ACCENT_STRONG}`,
      borderRadius: '8px',
      background: INKWELL_ACCENT,
      color: '#ffffff',
      cursor: 'pointer',
      font: '600 13px/1 system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif',
    });

    actionRow.append(button, colorRow, detailsToggle);
    highlightPanel.append(panelLabel, highlightNote, highlightStatus, applyHighlightButton);
    toolbar.append(actionRow, highlightPanel);
    toolbarRoot.append(toolbar);
    (document.body ?? document.documentElement).append(toolbarHost);

    browser.runtime.onMessage.addListener((message: InkwellRuntimeMessage) => {
      if (message?.type === 'inkwell.restoreHighlight') {
        return restoreHighlight(message);
      }

      if (message?.type === 'inkwell.refreshWebsiteHighlights') {
        void refreshPersistentHighlights(true);
        return true;
      }

      return false;
    });

    function hideButton() {
      selectedPayload = null;
      selectedHighlight = null;
      selectedHighlightRange = null;
      selectedExistingHighlightId = null;
      highlightPanel.style.display = 'none';
      detailsToggle.textContent = '⌄';
      detailsToggle.setAttribute('aria-expanded', 'false');
      toolbar.style.display = 'none';
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

    function buildWebsiteHighlight(range: Range): WebsiteHighlight | null {
      const url = canonicalWebsiteUrl(window.location.href);
      const startElement = getElementFromNode(range.startContainer);
      const endElement = getElementFromNode(range.endContainer);
      const startBlock = startElement?.closest(HIGHLIGHT_BLOCK_SELECTOR);
      const endBlock = endElement?.closest(HIGHLIGHT_BLOCK_SELECTOR);
      const fallbackBlock = getElementFromNode(range.commonAncestorContainer);
      const block = startBlock && startBlock === endBlock
        ? startBlock
        : !startBlock && !endBlock && fallbackBlock && !fallbackBlock.matches('html,body')
          ? fallbackBlock
          : null;
      const text = range.toString();

      if (
        !url ||
        !text.trim() ||
        text.length > 20_000 ||
        !block ||
        !block.contains(range.startContainer) ||
        !block.contains(range.endContainer) ||
        (block.textContent?.length ?? 0) > 100_000
      ) return null;

      const startXPath = getNodeXPath(range.startContainer);
      const endXPath = getNodeXPath(range.endContainer);
      const blockXPath = getNodeXPath(block);
      if (!startXPath || !endXPath || !blockXPath) return null;

      return {
        id: globalThis.crypto?.randomUUID?.() ??
          `${Date.now()}-${Math.random().toString(36).slice(2)}`,
        url,
        text,
        color: selectedHighlightColor,
        createdAt: new Date().toISOString(),
        anchor: {
          startXPath,
          startOffset: range.startOffset,
          endXPath,
          endOffset: range.endOffset,
          blockXPath,
          blockText: block.textContent ?? '',
        },
      };
    }

    function selectHighlightColor(color: WebsiteHighlightColor) {
      selectedHighlightColor = color;
      for (const [buttonColor, swatch] of colorButtons) {
        const selected = buttonColor === color;
        swatch.setAttribute('aria-pressed', selected ? 'true' : 'false');
        swatch.style.border = selected
          ? `2px solid ${INKWELL_ACCENT}`
          : '1px solid #c7c7cc';
      }
    }

    async function handleHighlightColorClick(color: WebsiteHighlightColor) {
      selectHighlightColor(color);
      if (highlightPanel.style.display === 'none') {
        await saveSelectedHighlight('', true);
      }
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

    function getSelectionCodeElement(selection: Selection) {
      const range = selection.rangeCount ? selection.getRangeAt(0) : null;
      const candidates = [
        getElementFromNode(selection.anchorNode),
        getElementFromNode(selection.focusNode),
        getElementFromNode(range?.commonAncestorContainer ?? null),
      ];

      for (const candidate of candidates) {
        const codeElement = candidate?.closest('code,pre');
        if (codeElement) {
          return codeElement.closest('pre') ?? codeElement;
        }
      }

      return null;
    }

    function languageFromCodeElement(element: Element) {
      const code = element.matches('code') ? element : element.querySelector('code');
      const parent = element.closest('figure,[data-language],[data-lang]');
      const ancestor = element.parentElement;
      const outerAncestor = ancestor?.parentElement;

      return detectCodeLanguage([
        code?.getAttribute('data-language'),
        code?.getAttribute('data-lang'),
        code?.className,
        element.getAttribute('data-language'),
        element.getAttribute('data-lang'),
        element.className,
        parent?.getAttribute('data-language'),
        parent?.getAttribute('data-lang'),
        parent?.className,
        ancestor?.getAttribute('data-language'),
        ancestor?.getAttribute('data-lang'),
        ancestor?.className,
        outerAncestor?.getAttribute('data-language'),
        outerAncestor?.getAttribute('data-lang'),
        outerAncestor?.className,
      ]);
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
      const codeElement = getSelectionCodeElement(selection);
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
        codeElement ?? (headingLevel ? headingElement : null),
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
          isHeading: includeHeadingMetadata && !codeElement && Boolean(headingLevel),
          headingLevel: includeHeadingMetadata && !codeElement ? headingLevel : undefined,
          isCodeBlock: Boolean(codeElement),
          codeLanguage: codeElement ? languageFromCodeElement(codeElement) : undefined,
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
      selectedHighlight = buildWebsiteHighlight(range.cloneRange());
      selectedHighlightRange = selectedHighlight ? range.cloneRange() : null;
      selectedExistingHighlightId = findExistingHighlightId(range, selectedHighlight);
      const existingHighlight = selectedExistingHighlightId
        ? currentRenderedHighlights.get(persistentHighlightName(selectedExistingHighlightId))
        : undefined;
      selectHighlightColor(existingHighlight?.color ?? selectedHighlightColor);
      highlightStatus.textContent = selectedHighlight
        ? ''
        : 'Select text within a single paragraph or heading.';
      applyHighlightButton.disabled = !selectedHighlight;
      applyHighlightButton.style.opacity = selectedHighlight ? '1' : '0.55';
      detailsToggle.disabled = false;
      for (const swatch of colorButtons.values()) {
        swatch.disabled = !selectedHighlight;
        swatch.style.opacity = selectedHighlight ? '1' : '0.45';
      }
      removeHighlightButton.disabled = !selectedExistingHighlightId;
      removeHighlightButton.style.opacity = selectedExistingHighlightId ? '1' : '0.4';
      highlightNote.value = existingHighlight?.note ?? '';
      highlightPanel.style.display = 'none';
      detailsToggle.setAttribute('aria-expanded', 'false');

      const left = Math.min(
        Math.max(8, rect.left),
        Math.max(8, window.innerWidth - 318),
      );
      toolbar.style.left = `${left}px`;
      toolbar.style.top = `${Math.min(
        Math.max(8, rect.bottom + 8),
        Math.max(8, window.innerHeight - 54),
      )}px`;
      toolbar.style.display = 'block';
    }

    function scheduleSelectionMenu() {
      window.clearTimeout(removeTimer);

      removeTimer = window.setTimeout(() => {
        if (toolbar.matches(':hover') || toolbar.contains(toolbarRoot.activeElement)) return;
        const selection = window.getSelection();
        const selectedText = selection?.toString().replace(/\r\n/g, '\n').trimEnd() ?? '';

        if (!selection || !selectedText.trim()) {
          hideButton();
          return;
        }

        showButton(selection, selectedText);
      }, 80);
    }

    document.addEventListener('selectionchange', scheduleSelectionMenu);
    document.addEventListener('pointerup', scheduleSelectionMenu, true);
    document.addEventListener('mouseup', scheduleSelectionMenu, true);
    document.addEventListener('touchend', scheduleSelectionMenu, true);
    document.addEventListener('keyup', scheduleSelectionMenu, true);
    document.addEventListener('contextmenu', scheduleSelectionMenu, true);
    window.addEventListener('scroll', hideButton, { passive: true });

    button.addEventListener('mousedown', (event) => {
      event.preventDefault();
    });

    detailsToggle.addEventListener('mousedown', (event) => event.preventDefault());
    detailsToggle.addEventListener('click', () => {
      const willOpen = highlightPanel.style.display === 'none';
      highlightPanel.style.display = willOpen ? 'block' : 'none';
      detailsToggle.textContent = willOpen ? '⌃' : '⌄';
      detailsToggle.setAttribute('aria-expanded', willOpen ? 'true' : 'false');
    });

    applyHighlightButton.addEventListener('mousedown', (event) => event.preventDefault());
    applyHighlightButton.addEventListener('click', () => {
      void saveSelectedHighlight(highlightNote.value.trim());
    });

    removeHighlightButton.addEventListener('mousedown', (event) => event.preventDefault());
    removeHighlightButton.addEventListener('click', () => {
      void removeSelectedHighlight();
    });

    async function saveSelectedHighlight(note: string, preserveExistingNote = false) {
      if (!selectedHighlight) return;

      const existingHighlight = selectedExistingHighlightId
        ? currentRenderedHighlights.get(persistentHighlightName(selectedExistingHighlightId))
        : undefined;
      const highlight: WebsiteHighlight = {
        ...selectedHighlight,
        id: existingHighlight?.id ?? selectedHighlight.id,
        createdAt: existingHighlight?.createdAt ?? selectedHighlight.createdAt,
        color: selectedHighlightColor,
        ...(note || preserveExistingNote && existingHighlight?.note
          ? { note: note || existingHighlight?.note }
          : {}),
      };
      const optimisticRange = selectedHighlightRange?.cloneRange() ??
        resolvePersistentHighlight(highlight)?.cloneRange();
      const optimisticToken = Symbol(highlight.id);

      highlightRefreshVersion += 1;
      optimisticHighlightChanges.set(highlight.id, highlight);
      optimisticHighlightTokens.set(highlight.id, optimisticToken);
      removePersistentHighlight(highlight.id);
      if (optimisticRange) renderPersistentHighlight(highlight, optimisticRange);
      hideButton();
      window.getSelection()?.removeAllRanges();

      const saved = await browser.runtime.sendMessage({
        type: 'inkwell.createWebsiteHighlight',
        payload: { highlight },
      } satisfies CreateWebsiteHighlightMessage).catch(() => false);

      const isLatestMutation = optimisticHighlightTokens.get(highlight.id) === optimisticToken;
      if (isLatestMutation) {
        highlightRefreshVersion += 1;
        optimisticHighlightChanges.delete(highlight.id);
        optimisticHighlightTokens.delete(highlight.id);
      }
      if (!saved && isLatestMutation) {
        removePersistentHighlight(highlight.id);
        const previousRange = existingHighlight
          ? resolvePersistentHighlight(existingHighlight)?.cloneRange()
          : undefined;
        if (existingHighlight && previousRange) {
          renderPersistentHighlight(existingHighlight, previousRange);
        }
        restoreFailedHighlightSelection(
          optimisticRange,
          'Unable to save this highlight. Try again.',
        );
      }
    }

    async function removeSelectedHighlight() {
      const id = selectedExistingHighlightId;
      const url = canonicalWebsiteUrl(window.location.href);
      if (!id || !url) return;

      const highlightName = persistentHighlightName(id);
      const existingHighlight = currentRenderedHighlights.get(highlightName);
      const previousRange = currentRenderedHighlightRanges.get(highlightName)?.[0]?.cloneRange() ??
        selectedHighlightRange?.cloneRange() ??
        (existingHighlight ? resolvePersistentHighlight(existingHighlight)?.cloneRange() : undefined);
      const optimisticToken = Symbol(id);

      highlightRefreshVersion += 1;
      optimisticHighlightChanges.set(id, null);
      optimisticHighlightTokens.set(id, optimisticToken);
      removePersistentHighlight(id);
      hideButton();
      window.getSelection()?.removeAllRanges();

      const removed = await browser.runtime.sendMessage({
        type: 'inkwell.removeWebsiteHighlights',
        payload: { ids: [id], url },
      } satisfies RemoveWebsiteHighlightsMessage).catch(() => false);

      const isLatestMutation = optimisticHighlightTokens.get(id) === optimisticToken;
      if (isLatestMutation) {
        highlightRefreshVersion += 1;
        optimisticHighlightChanges.delete(id);
        optimisticHighlightTokens.delete(id);
      }
      if (!removed && isLatestMutation) {
        if (existingHighlight && previousRange) {
          renderPersistentHighlight(existingHighlight, previousRange);
        }
        restoreFailedHighlightSelection(
          previousRange,
          'Unable to remove this highlight. Try again.',
        );
      }
    }

    function restoreFailedHighlightSelection(range: Range | undefined, message: string) {
      if (!range) return;
      const selection = window.getSelection();
      if (!selection) return;
      selection.removeAllRanges();
      selection.addRange(range);
      showButton(selection, range.toString());
      highlightPanel.style.display = 'block';
      detailsToggle.textContent = '⌃';
      detailsToggle.setAttribute('aria-expanded', 'true');
      highlightStatus.textContent = message;
    }

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
        const selectedText = selection?.toString().replace(/\r\n/g, '\n').trimEnd() ?? '';

        if (!selection || !selectedText.trim()) {
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

    async function refreshPersistentHighlights(pruneStale: boolean) {
      const url = canonicalWebsiteUrl(window.location.href);
      const version = ++highlightRefreshVersion;
      if (!url) {
        clearPersistentHighlights();
        return;
      }

      const response = await browser.runtime.sendMessage({
        type: 'inkwell.getWebsiteHighlights',
        payload: { url },
      } satisfies GetWebsiteHighlightsMessage).catch(() => []);
      if (version !== highlightRefreshVersion) return;

      const storedHighlights = Array.isArray(response) ? response as WebsiteHighlight[] : [];
      const highlightsById = new Map(storedHighlights.map((highlight) => [highlight.id, highlight]));
      for (const [id, highlight] of optimisticHighlightChanges) {
        if (highlight) highlightsById.set(id, highlight);
        else highlightsById.delete(id);
      }
      const highlights = Array.from(highlightsById.values());
      clearPersistentHighlights();
      let unresolved = [...highlights];
      const delays = pruneStale ? [0, 500, 1500, 4000, 8000] : [0];

      for (const delay of delays) {
        if (delay) await new Promise((resolve) => window.setTimeout(resolve, delay));
        if (version !== highlightRefreshVersion) return;

        const nextUnresolved: WebsiteHighlight[] = [];
        for (const highlight of unresolved) {
          const range = resolvePersistentHighlight(highlight);
          if (range) renderPersistentHighlight(highlight, range);
          else nextUnresolved.push(highlight);
        }
        unresolved = nextUnresolved;
        if (!unresolved.length) break;
      }

      if (pruneStale && unresolved.length && version === highlightRefreshVersion) {
        const staleIds = unresolved
          .map((highlight) => highlight.id)
          .filter((id) => !optimisticHighlightChanges.has(id));
        if (!staleIds.length) return;
        await browser.runtime.sendMessage({
          type: 'inkwell.removeWebsiteHighlights',
          payload: { ids: staleIds, url },
        } satisfies RemoveWebsiteHighlightsMessage).catch(() => undefined);
      }
    }

    function resolvePersistentHighlight(highlight: WebsiteHighlight) {
      try {
        if (
          !highlight?.id ||
          !highlight.text ||
          !highlight.anchor ||
          !(highlight.color in HIGHLIGHT_COLORS)
        ) return null;

        const startNode = nodeFromXPath(highlight.anchor.startXPath);
        const endNode = nodeFromXPath(highlight.anchor.endXPath);
        const blockNode = nodeFromXPath(highlight.anchor.blockXPath);
        if (
          !startNode ||
          !endNode ||
          blockNode?.nodeType !== Node.ELEMENT_NODE ||
          !(blockNode as Element).contains(startNode) ||
          !(blockNode as Element).contains(endNode) ||
          blockNode.textContent !== highlight.anchor.blockText
        ) return null;

        const range = document.createRange();
        range.setStart(startNode, highlight.anchor.startOffset);
        range.setEnd(endNode, highlight.anchor.endOffset);
        return range.toString() === highlight.text ? range : null;
      } catch {
        return null;
      }
    }

    function findExistingHighlightId(
      range: Range,
      selected: WebsiteHighlight | null = null,
    ) {
      for (const [name, renderedRanges] of currentRenderedHighlightRanges) {
        if (!renderedRanges.some((renderedRange) => rangesOverlap(range, renderedRange))) continue;
        const highlight = currentRenderedHighlights.get(name);
        if (highlight) return highlight.id;
      }

      const markedElement = getElementFromNode(range.commonAncestorContainer)
        ?.closest('[data-inkwell-persistent-highlight]');
      const markedId = markedElement?.getAttribute('data-inkwell-persistent-highlight');
      if (markedId) return markedId;

      for (const mark of persistentHighlightMarks) {
        if (!range.intersectsNode(mark)) continue;
        const id = mark.getAttribute('data-inkwell-persistent-highlight');
        if (id) return id;
      }

      for (const highlight of currentRenderedHighlights.values()) {
        const highlightRange = resolvePersistentHighlight(highlight);
        if (
          highlightRange &&
          range.compareBoundaryPoints(Range.END_TO_START, highlightRange) > 0 &&
          range.compareBoundaryPoints(Range.START_TO_END, highlightRange) < 0
        ) {
          return highlight.id;
        }

        if (selected && highlightAnchorsOverlap(selected, highlight)) {
          return highlight.id;
        }
      }
      return null;
    }

    function highlightAnchorsOverlap(first: WebsiteHighlight, second: WebsiteHighlight) {
      if (
        first.url !== second.url ||
        first.anchor.blockXPath !== second.anchor.blockXPath ||
        first.anchor.blockText !== second.anchor.blockText
      ) return false;

      if (
        first.anchor.startXPath === first.anchor.endXPath &&
        second.anchor.startXPath === second.anchor.endXPath &&
        first.anchor.startXPath === second.anchor.startXPath
      ) {
        return first.anchor.endOffset > second.anchor.startOffset &&
          first.anchor.startOffset < second.anchor.endOffset;
      }

      const firstText = first.text.replace(/\s+/g, ' ').trim();
      const secondText = second.text.replace(/\s+/g, ' ').trim();
      return Boolean(firstText && secondText) &&
        (firstText.includes(secondText) || secondText.includes(firstText));
    }

    function rangesOverlap(first: Range, second: Range) {
      try {
        return first.compareBoundaryPoints(Range.END_TO_START, second) > 0 &&
          first.compareBoundaryPoints(Range.START_TO_END, second) < 0;
      } catch {
        return false;
      }
    }

    function nodeFromXPath(xpath: string) {
      if (!xpath) return null;
      return document.evaluate(
        xpath,
        document,
        null,
        XPathResult.FIRST_ORDERED_NODE_TYPE,
      ).singleNodeValue;
    }

    function renderPersistentHighlight(highlight: WebsiteHighlight, range: Range) {
      const css = globalThis.CSS as typeof CSS & {
        highlights?: { delete: (name: string) => void; set: (name: string, value: unknown) => void };
      };
      const HighlightConstructor = (
        globalThis as typeof globalThis & { Highlight?: new (...ranges: Range[]) => unknown }
      ).Highlight;
      const name = persistentHighlightName(highlight.id);

      if (css?.highlights && HighlightConstructor) {
        const renderedRange = range.cloneRange();
        css.highlights.set(name, new HighlightConstructor(renderedRange));
        persistentHighlightNames.add(name);
        currentRenderedHighlights.set(name, highlight);
        currentRenderedHighlightRanges.set(name, [renderedRange]);
        updatePersistentHighlightStyle();
        return;
      }

      const textSegments = textRangesWithin(range);
      let renderedSegment = false;
      for (const textRange of textSegments.reverse()) {
        try {
          const mark = document.createElement('mark');
          mark.setAttribute('data-inkwell-persistent-highlight', highlight.id);
          mark.title = highlight.note ?? '';
          Object.assign(mark.style, {
            background: HIGHLIGHT_COLORS[highlight.color],
            color: 'inherit',
            padding: '0',
          });
          textRange.surroundContents(mark);
          persistentHighlightMarks.add(mark);
          renderedSegment = true;
        } catch {
          // Ignore a segment if the host page mutates it between selection and paint.
        }
      }
      if (renderedSegment) {
        currentRenderedHighlights.set(name, highlight);
        currentRenderedHighlightRanges.set(name, [range.cloneRange()]);
      }
    }

    function textRangesWithin(range: Range) {
      const root = range.commonAncestorContainer.nodeType === Node.TEXT_NODE
        ? range.commonAncestorContainer.parentNode
        : range.commonAncestorContainer;
      if (!root) return [];

      const textNodes: Text[] = [];
      const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
      let node = walker.nextNode();
      while (node) {
        if (range.intersectsNode(node) && node.textContent?.length) {
          textNodes.push(node as Text);
        }
        node = walker.nextNode();
      }

      return textNodes.flatMap((textNode) => {
        const start = textNode === range.startContainer ? range.startOffset : 0;
        const end = textNode === range.endContainer ? range.endOffset : textNode.length;
        if (start >= end) return [];
        const textRange = document.createRange();
        textRange.setStart(textNode, start);
        textRange.setEnd(textNode, end);
        return [textRange];
      });
    }

    function persistentHighlightName(id: string) {
      return `inkwell-persistent-${id.replace(/[^a-zA-Z0-9_-]/g, '-')}`;
    }

    function updatePersistentHighlightStyle() {
      let style = document.getElementById(HIGHLIGHT_STYLE_ID);
      if (!style) {
        style = document.createElement('style');
        style.id = HIGHLIGHT_STYLE_ID;
        document.documentElement.append(style);
      }

      const highlights = Array.from(persistentHighlightNames).map((name) => {
        const source = currentRenderedHighlights.get(name);
        return source ? `::highlight(${name}) { background: ${HIGHLIGHT_COLORS[source.color]}; color: inherit; }` : '';
      });
      style.textContent = highlights.join('\n');
    }

    const currentRenderedHighlights = new Map<string, WebsiteHighlight>();
    const currentRenderedHighlightRanges = new Map<string, Range[]>();

    function removePersistentHighlight(id: string) {
      const name = persistentHighlightName(id);
      const css = globalThis.CSS as typeof CSS & {
        highlights?: { delete: (highlightName: string) => void };
      };
      css?.highlights?.delete(name);
      persistentHighlightNames.delete(name);
      currentRenderedHighlights.delete(name);
      currentRenderedHighlightRanges.delete(name);

      for (const mark of Array.from(persistentHighlightMarks)) {
        if (mark.getAttribute('data-inkwell-persistent-highlight') !== id) continue;
        const parent = mark.parentNode;
        persistentHighlightMarks.delete(mark);
        if (!parent) continue;
        while (mark.firstChild) parent.insertBefore(mark.firstChild, mark);
        parent.removeChild(mark);
        parent.normalize();
      }
      updatePersistentHighlightStyle();
    }

    function clearPersistentHighlights() {
      const css = globalThis.CSS as typeof CSS & {
        highlights?: { delete: (name: string) => void };
      };
      for (const name of persistentHighlightNames) css?.highlights?.delete(name);
      persistentHighlightNames.clear();
      currentRenderedHighlights.clear();
      currentRenderedHighlightRanges.clear();

      for (const mark of persistentHighlightMarks) {
        const parent = mark.parentNode;
        if (!parent) continue;
        while (mark.firstChild) parent.insertBefore(mark.firstChild, mark);
        parent.removeChild(mark);
        parent.normalize();
      }
      persistentHighlightMarks.clear();
      document.getElementById(HIGHLIGHT_STYLE_ID)?.remove();
    }

    let observedWebsiteUrl = canonicalWebsiteUrl(window.location.href);
    void refreshPersistentHighlights(true);
    window.addEventListener('pageshow', () => void refreshPersistentHighlights(true));
    window.addEventListener('focus', () => void refreshPersistentHighlights(true));
    document.addEventListener('visibilitychange', () => {
      if (!document.hidden) void refreshPersistentHighlights(true);
    });
    window.setInterval(() => {
      const nextUrl = canonicalWebsiteUrl(window.location.href);
      if (nextUrl === observedWebsiteUrl) return;
      observedWebsiteUrl = nextUrl;
      void refreshPersistentHighlights(true);
    }, 1000);

    async function restoreHighlight(message: RestoreHighlightMessage) {
      const retryDelays = [0, 250, 750, 1500];

      for (const delay of retryDelays) {
        if (delay) {
          await new Promise((resolve) => window.setTimeout(resolve, delay));
        }

        const range =
          getRangeFromXPath(message.payload.highlightMeta) ??
          getRangeFromWindowFind(message.payload.highlightMeta.text);

        if (range) {
          scrollRangeIntoView(range);
          temporarilyHighlightRange(range);
          return true;
        }
      }

      return false;
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

      try {
        const range = document.createRange();
        range.setStart(textNode, matchingOffset);
        range.setEnd(textNode, matchingOffset + meta.text.length);
        return range;
      } catch {
        // Multi-node selections cannot be restored from one text node. The
        // browser text search fallback below can still produce a spanning range.
        return null;
      }
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

      if (highlightWithCssRange(range)) {
        return;
      }

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

    function highlightWithCssRange(range: Range) {
      const css = globalThis.CSS as typeof CSS & {
        highlights?: {
          delete: (name: string) => void;
          set: (name: string, highlight: unknown) => void;
        };
      };
      const HighlightConstructor = (
        globalThis as typeof globalThis & {
          Highlight?: new (...ranges: Range[]) => unknown;
        }
      ).Highlight;

      if (!css?.highlights || !HighlightConstructor) {
        return false;
      }

      const highlightName = 'inkwell-restored';
      let style = document.getElementById('inkwell-restored-highlight-style');

      if (!style) {
        style = document.createElement('style');
        style.id = 'inkwell-restored-highlight-style';
        style.textContent =
          '::highlight(inkwell-restored) { background: #fff2a8; color: inherit; }';
        document.documentElement.append(style);
      }

      css.highlights.set(highlightName, new HighlightConstructor(range.cloneRange()));
      window.setTimeout(() => {
        css.highlights?.delete(highlightName);
        window.getSelection()?.removeAllRanges();
      }, 4200);
      return true;
    }
  },
});
