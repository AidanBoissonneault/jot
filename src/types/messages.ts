import type { ProjectPage } from '@/src/types/capture';

export type CaptureSelectionPayload = {
  text: string;
  sourceUrl: string;
  pageTitle: string;
  highlightMeta: {
    text: string;
    isHeading?: boolean;
    sourceLink?: string;
  };
};

export type CaptureSelectionMessage = {
  type: 'jot.captureSelection';
  payload: CaptureSelectionPayload;
};

export type InsertCaptureRequestMessage = {
  type: 'jot.insertCaptureRequest';
  payload: CaptureSelectionPayload;
};

export type ProjectPageUpdatedMessage = {
  type: 'jot.projectPageUpdated';
  payload: {
    page: ProjectPage;
  };
};

export type JotRuntimeMessage =
  | CaptureSelectionMessage
  | InsertCaptureRequestMessage
  | ProjectPageUpdatedMessage;
