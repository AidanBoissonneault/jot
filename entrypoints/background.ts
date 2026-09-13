import { notionClient } from '@/src/services/notionClient';
import { safeInkwellSourceUrl } from '@/src/extensions/inkwellLink';
import { canonicalWebsiteUrl } from '@/src/lib/websiteUrls';
import type {
  CaptureSelectionMessage,
  CaptureSelectionPayload,
  CreateWebsiteHighlightMessage,
  ConsumeHeadingDragMessage,
  ConsumeTextDragMessage,
  GetWebsiteHighlightsMessage,
  HeadingDragStartedMessage,
  InsertCaptureRequestMessage,
  InkwellRuntimeMessage,
  OpenSourceRequestMessage,
  ProjectPageUpdatedMessage,
  ProjectStateUpdatedMessage,
  RefreshWebsiteHighlightsMessage,
  RemoveWebsiteHighlightsMessage,
  RestoreHighlightMessage,
  TextDragStartedMessage,
} from '@/src/types/messages';

const HEADING_DRAG_TTL_MS = 8000;
const TEXT_DRAG_TTL_MS = 8000;
let lastHeadingDrag:
  | {
      payload: CaptureSelectionPayload;
      createdAt: number;
    }
  | undefined;
let lastTextDrag:
  | {
      payload: CaptureSelectionPayload;
      createdAt: number;
    }
  | undefined;

export default defineBackground(() => {
  if (browser.sidePanel?.setPanelBehavior) {
    void browser.sidePanel.setPanelBehavior({ openPanelOnActionClick: true });
  }

  browser.runtime.onMessage.addListener((message: InkwellRuntimeMessage) => {
    if (message?.type === 'inkwell.captureSelection') {
      return handleCaptureSelection(message);
    }

    if (message?.type === 'inkwell.getWebsiteHighlights') {
      return handleGetWebsiteHighlights(message).catch(() => []);
    }

    if (message?.type === 'inkwell.createWebsiteHighlight') {
      return handleCreateWebsiteHighlight(message).catch(() => false);
    }

    if (message?.type === 'inkwell.removeWebsiteHighlights') {
      return handleRemoveWebsiteHighlights(message).catch(() => false);
    }

    if (message?.type === 'inkwell.refreshWebsiteHighlights') {
      return refreshWebsiteHighlightsInTabs().catch(() => false);
    }

    if (message?.type === 'inkwell.headingDragStarted') {
      return handleHeadingDragStarted(message);
    }

    if (message?.type === 'inkwell.consumeHeadingDrag') {
      return handleConsumeHeadingDrag(message);
    }

    if (message?.type === 'inkwell.textDragStarted') {
      return handleTextDragStarted(message);
    }

    if (message?.type === 'inkwell.consumeTextDrag') {
      return handleConsumeTextDrag(message);
    }

    if (message?.type === 'inkwell.openSourceRequest') {
      return handleOpenSourceRequest(message);
    }

    return false;
  });

  // A background restart (including a browser reload) is an opportunity to
  // resume durable work that was queued while the network was unavailable.
  void notionClient.flushPendingSyncOps({ force: true }).catch(() => undefined);
});

async function handleGetWebsiteHighlights(message: GetWebsiteHighlightsMessage) {
  const url = canonicalWebsiteUrl(message.payload.url);
  return url ? await notionClient.getCurrentProjectWebsiteHighlights(url) : [];
}

async function handleCreateWebsiteHighlight(message: CreateWebsiteHighlightMessage) {
  const highlight = message.payload.highlight;
  const url = canonicalWebsiteUrl(highlight.url);
  if (!url || url !== highlight.url || !isValidWebsiteHighlight(highlight)) return false;
  const project = await notionClient.createWebsiteHighlight(message.payload.highlight);
  if (project) notifyProjectStateUpdated(project);
  return Boolean(project);
}

function isValidWebsiteHighlight(
  highlight: CreateWebsiteHighlightMessage['payload']['highlight'],
) {
  const anchor = highlight?.anchor;
  return Boolean(
    highlight.id && highlight.id.length <= 100 &&
    highlight.text && highlight.text.length <= 20_000 &&
    (!highlight.note || highlight.note.length <= 2_000) &&
    ['yellow', 'green', 'blue', 'pink', 'gray'].includes(highlight.color) &&
    anchor?.startXPath && anchor.startXPath.length <= 4_000 &&
    anchor.endXPath && anchor.endXPath.length <= 4_000 &&
    anchor.blockXPath && anchor.blockXPath.length <= 4_000 &&
    typeof anchor.blockText === 'string' && anchor.blockText.length <= 100_000 &&
    Number.isInteger(anchor.startOffset) && anchor.startOffset >= 0 &&
    Number.isInteger(anchor.endOffset) && anchor.endOffset >= 0
  );
}

async function handleRemoveWebsiteHighlights(message: RemoveWebsiteHighlightsMessage) {
  const url = canonicalWebsiteUrl(message.payload.url);
  if (!url) return false;
  const project = await notionClient.removeWebsiteHighlights(message.payload.ids, url);
  if (project) notifyProjectStateUpdated(project);
  return Boolean(project);
}

function notifyProjectStateUpdated(project: ProjectStateUpdatedMessage['payload']['project']) {
  void browser.runtime.sendMessage({
    type: 'inkwell.projectStateUpdated',
    payload: { project },
  } satisfies ProjectStateUpdatedMessage).catch(() => undefined);
}

async function refreshWebsiteHighlightsInTabs() {
  const tabs = await browser.tabs.query({});
  await Promise.allSettled(tabs.map((tab) =>
    typeof tab.id === 'number'
      ? browser.tabs.sendMessage(tab.id, {
          type: 'inkwell.refreshWebsiteHighlights',
        } satisfies RefreshWebsiteHighlightsMessage)
      : Promise.resolve(),
  ));
  return true;
}

function handleHeadingDragStarted(message: HeadingDragStartedMessage) {
  if (!message.payload.highlightMeta.isHeading) {
    return false;
  }

  lastHeadingDrag = {
    payload: message.payload,
    createdAt: Date.now(),
  };

  return true;
}

function handleConsumeHeadingDrag(message: ConsumeHeadingDragMessage) {
  if (!lastHeadingDrag) {
    return null;
  }

  const drag = lastHeadingDrag;
  const requestedText = message.payload?.text?.replace(/\s+/g, ' ').trim();
  const draggedText = drag.payload.text.replace(/\s+/g, ' ').trim();
  const isFresh = Date.now() - drag.createdAt <= HEADING_DRAG_TTL_MS;
  const isMatchingText =
    !requestedText ||
    requestedText === draggedText ||
    draggedText.includes(requestedText) ||
    requestedText.includes(draggedText);

  if (!isFresh || !isMatchingText) {
    return null;
  }

  lastHeadingDrag = undefined;
  return drag.payload;
}

function handleTextDragStarted(message: TextDragStartedMessage) {
  lastTextDrag = {
    payload: message.payload,
    createdAt: Date.now(),
  };

  return true;
}

function handleConsumeTextDrag(message: ConsumeTextDragMessage) {
  if (!lastTextDrag) {
    return null;
  }

  const drag = lastTextDrag;
  const requestedText = message.payload?.text?.replace(/\s+/g, ' ').trim();
  const draggedText = drag.payload.text.replace(/\s+/g, ' ').trim();
  const isFresh = Date.now() - drag.createdAt <= TEXT_DRAG_TTL_MS;
  const isMatchingText =
    !requestedText ||
    requestedText === draggedText ||
    draggedText.includes(requestedText) ||
    requestedText.includes(draggedText);

  if (!isFresh || !isMatchingText) {
    return null;
  }

  lastTextDrag = undefined;
  return drag.payload;
}

async function handleCaptureSelection(message: CaptureSelectionMessage) {
  const wasInsertedBySidePanel = await browser.runtime
    .sendMessage({
      type: 'inkwell.insertCaptureRequest',
      payload: message.payload,
    } satisfies InsertCaptureRequestMessage)
    .then((response: unknown) => response === true)
    .catch(() => false);

  if (wasInsertedBySidePanel) {
    return true;
  }

  const page = await notionClient.appendCaptureToCurrentPage(message.payload);

  void browser.runtime
    .sendMessage({
      type: 'inkwell.projectPageUpdated',
      payload: {
        page,
      },
    } satisfies ProjectPageUpdatedMessage)
    .catch(() => undefined);

  return true;
}

async function handleOpenSourceRequest(message: OpenSourceRequestMessage) {
  const url = safeInkwellSourceUrl(message.payload);

  if (!url) {
    return false;
  }

  const tab = await browser.tabs.create({ active: true, url });

  if (!tab.id) {
    return true;
  }

  await waitForTabLoaded(tab.id);

  await browser.tabs
    .sendMessage(tab.id, {
      type: 'inkwell.restoreHighlight',
      payload: message.payload,
    } satisfies RestoreHighlightMessage)
    .catch(() => undefined);

  return true;
}

function waitForTabLoaded(tabId: number) {
  return new Promise<void>((resolve) => {
    const timeout = globalThis.setTimeout(() => {
      browser.tabs.onUpdated.removeListener(listener);
      resolve();
    }, 3500);

    function listener(
      updatedTabId: number,
      changeInfo: { status?: string },
    ) {
      if (updatedTabId !== tabId || changeInfo.status !== 'complete') {
        return;
      }

      globalThis.clearTimeout(timeout);
      browser.tabs.onUpdated.removeListener(listener);
      resolve();
    }

    browser.tabs.onUpdated.addListener(listener);
  });
}
