import { notionClient } from '@/src/services/notionClient';
import type {
  CaptureSelectionMessage,
  CaptureSelectionPayload,
  ConsumeHeadingDragMessage,
  HeadingDragStartedMessage,
  InsertCaptureRequestMessage,
  JotRuntimeMessage,
  OpenSourceRequestMessage,
  ProjectPageUpdatedMessage,
  RestoreHighlightMessage,
} from '@/src/types/messages';

const HEADING_DRAG_TTL_MS = 8000;
let lastHeadingDrag:
  | {
      payload: CaptureSelectionPayload;
      createdAt: number;
    }
  | undefined;

export default defineBackground(() => {
  if (browser.sidePanel?.setPanelBehavior) {
    void browser.sidePanel.setPanelBehavior({ openPanelOnActionClick: true });
  }

  browser.runtime.onMessage.addListener((message: JotRuntimeMessage) => {
    if (message?.type === 'jot.captureSelection') {
      return handleCaptureSelection(message);
    }

    if (message?.type === 'jot.headingDragStarted') {
      return handleHeadingDragStarted(message);
    }

    if (message?.type === 'jot.consumeHeadingDrag') {
      return handleConsumeHeadingDrag(message);
    }

    if (message?.type === 'jot.openSourceRequest') {
      return handleOpenSourceRequest(message);
    }

    return false;
  });
});

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

async function handleCaptureSelection(message: CaptureSelectionMessage) {
  const wasInsertedBySidePanel = await browser.runtime
    .sendMessage({
      type: 'jot.insertCaptureRequest',
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
      type: 'jot.projectPageUpdated',
      payload: {
        page,
      },
    } satisfies ProjectPageUpdatedMessage)
    .catch(() => undefined);

  return true;
}

async function handleOpenSourceRequest(message: OpenSourceRequestMessage) {
  const url = message.payload.highlightMeta.sourceLink || message.payload.sourceUrl;
  const tab = await browser.tabs.create({ active: true, url });

  if (!tab.id) {
    return true;
  }

  await waitForTabLoaded(tab.id);

  await browser.tabs
    .sendMessage(tab.id, {
      type: 'jot.restoreHighlight',
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
