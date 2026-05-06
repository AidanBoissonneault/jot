import { notionClient } from '@/src/services/notionClient';
import type {
  CaptureSelectionMessage,
  InsertCaptureRequestMessage,
  JotRuntimeMessage,
  ProjectPageUpdatedMessage,
} from '@/src/types/messages';

export default defineBackground(() => {
  if (browser.sidePanel?.setPanelBehavior) {
    void browser.sidePanel.setPanelBehavior({ openPanelOnActionClick: true });
  }

  browser.runtime.onMessage.addListener((message: JotRuntimeMessage) => {
    if (message?.type !== 'jot.captureSelection') {
      return false;
    }

    return handleCaptureSelection(message);
  });
});

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
