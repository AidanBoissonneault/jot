import { notionClient } from '@/src/services/notionClient';
import { safeJottathingSourceUrl } from '@/src/extensions/jottathingLink';
import { parseCaptureSelectionPayload } from '@/src/lib/capturePayload';
import { createDragCaptureState } from '@/src/lib/dragCapture';
import type {
  CaptureSelectionMessage,
  ConsumeHeadingDragMessage,
  ConsumeTextDragMessage,
  HeadingDragStartedMessage,
  InsertCaptureRequestMessage,
  JottathingRuntimeMessage,
  OpenSourceRequestMessage,
  ProjectPageUpdatedMessage,
  RestoreHighlightMessage,
  TextDragStartedMessage,
} from '@/src/types/messages';

const dragCaptures = createDragCaptureState();

export default defineBackground(() => {
  if (browser.sidePanel?.setPanelBehavior) {
    void browser.sidePanel.setPanelBehavior({ openPanelOnActionClick: true });
  }

  browser.runtime.onMessage.addListener((message: JottathingRuntimeMessage) => {
    if (message?.type === 'jottathing.prepareConnectionDeletion') {
      return notionClient.prepareConnectionDeletion();
    }

    if (message?.type === 'jottathing.abortConnectionDeletion') {
      return notionClient.abortConnectionDeletion().then(() => true);
    }

    if (message?.type === 'jottathing.completeConnectionDeletion') {
      return notionClient.completeConnectionDeletion().then(() => true);
    }

    if (message?.type === 'jottathing.captureSelection') {
      return handleCaptureSelection(message);
    }

    if (message?.type === 'jottathing.headingDragStarted') {
      return handleHeadingDragStarted(message);
    }

    if (message?.type === 'jottathing.consumeHeadingDrag') {
      return handleConsumeHeadingDrag(message);
    }

    if (message?.type === 'jottathing.textDragStarted') {
      return handleTextDragStarted(message);
    }

    if (message?.type === 'jottathing.consumeTextDrag') {
      return handleConsumeTextDrag(message);
    }

    if (message?.type === 'jottathing.openSourceRequest') {
      return handleOpenSourceRequest(message);
    }

    return false;
  });

  // A background restart (including a browser reload) is an opportunity to
  // resume durable work, unless the user has an unfinished connection wipe.
  void browser.storage.local.get('jottathingPendingConnectionDeletion').then(
    async (stored: Record<string, unknown>) => {
      if (stored.jottathingPendingConnectionDeletion) {
        notionClient.markConnectionDeletionPending();
      } else {
        await notionClient.flushPendingSyncOps({ force: true });
      }
    },
  ).catch(() => undefined);
});

function handleHeadingDragStarted(message: HeadingDragStartedMessage) {
  return dragCaptures.start(message.payload, 'heading');
}

function handleConsumeHeadingDrag(message: ConsumeHeadingDragMessage) {
  return dragCaptures.consume(message.payload?.text, 'heading');
}

function handleTextDragStarted(message: TextDragStartedMessage) {
  return dragCaptures.start(message.payload, 'text');
}

function handleConsumeTextDrag(message: ConsumeTextDragMessage) {
  return dragCaptures.consume(message.payload?.text, 'text');
}

async function handleCaptureSelection(message: CaptureSelectionMessage) {
  const payload = parseCaptureSelectionPayload(message.payload);
  if (!payload) return false;

  const wasInsertedBySidePanel = await browser.runtime
    .sendMessage({
      type: 'jottathing.insertCaptureRequest',
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
      type: 'jottathing.projectPageUpdated',
      payload: {
        page,
      },
    } satisfies ProjectPageUpdatedMessage)
    .catch(() => undefined);

  return true;
}

async function handleOpenSourceRequest(message: OpenSourceRequestMessage) {
  const url = safeJottathingSourceUrl(message.payload);

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
      type: 'jottathing.restoreHighlight',
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
