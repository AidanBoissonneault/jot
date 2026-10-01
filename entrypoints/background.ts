import { notionClient } from '@/src/services/notionClient';
import { safeInkwellSourceUrl } from '@/src/extensions/inkwellLink';
import { parseCaptureSelectionPayload } from '@/src/lib/capturePayload';
import type {
  CaptureSelectionMessage,
  CaptureSelectionPayload,
  ConsumeHeadingDragMessage,
  ConsumeTextDragMessage,
  HeadingDragStartedMessage,
  InsertCaptureRequestMessage,
  InkwellRuntimeMessage,
  OpenSourceRequestMessage,
  ProjectPageUpdatedMessage,
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
    if (message?.type === 'inkwell.prepareConnectionDeletion') {
      return notionClient.prepareConnectionDeletion();
    }

    if (message?.type === 'inkwell.abortConnectionDeletion') {
      return notionClient.abortConnectionDeletion().then(() => true);
    }

    if (message?.type === 'inkwell.completeConnectionDeletion') {
      return notionClient.completeConnectionDeletion().then(() => true);
    }

    if (message?.type === 'inkwell.captureSelection') {
      return handleCaptureSelection(message);
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
  // resume durable work, unless the user has an unfinished connection wipe.
  void browser.storage.local.get('inkwellPendingConnectionDeletion').then(
    async (stored: Record<string, unknown>) => {
      if (stored.inkwellPendingConnectionDeletion) {
        notionClient.markConnectionDeletionPending();
      } else {
        await notionClient.flushPendingSyncOps({ force: true });
      }
    },
  ).catch(() => undefined);
});

function handleHeadingDragStarted(message: HeadingDragStartedMessage) {
  const payload = parseCaptureSelectionPayload(message.payload);
  if (!payload?.highlightMeta.isHeading) {
    return false;
  }

  lastHeadingDrag = {
    payload,
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
  const payload = parseCaptureSelectionPayload(message.payload);
  if (!payload || payload.highlightMeta.isHeading) return false;

  lastTextDrag = {
    payload,
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
  const payload = parseCaptureSelectionPayload(message.payload);
  if (!payload) return false;

  const wasInsertedBySidePanel = await browser.runtime
    .sendMessage({
      type: 'inkwell.insertCaptureRequest',
      payload,
    } satisfies InsertCaptureRequestMessage)
    .then((response: unknown) => response === true)
    .catch(() => false);

  if (wasInsertedBySidePanel) {
    return true;
  }

  const page = await notionClient.appendCaptureToCurrentPage(payload);

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
