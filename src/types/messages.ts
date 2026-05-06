import type { ProjectPage } from '@/src/types/capture';

export type SourceHighlightMeta = {
  text: string;
  sourceLink?: string;
  xpath?: string;
  offset?: number;
  prefix?: string;
  suffix?: string;
};

export type SourceOpenPayload = {
  sourceUrl: string;
  pageTitle?: string;
  highlightMeta: SourceHighlightMeta;
};

export type CaptureSelectionPayload = {
  text: string;
  sourceUrl: string;
  pageTitle: string;
  highlightMeta: SourceHighlightMeta & {
    isHeading?: boolean;
    headingLevel?: 1 | 2 | 3 | 4 | 5 | 6;
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

export type OpenSourceRequestMessage = {
  type: 'jot.openSourceRequest';
  payload: SourceOpenPayload;
};

export type RestoreHighlightMessage = {
  type: 'jot.restoreHighlight';
  payload: SourceOpenPayload;
};

export type JotRuntimeMessage =
  | CaptureSelectionMessage
  | InsertCaptureRequestMessage
  | ProjectPageUpdatedMessage
  | OpenSourceRequestMessage
  | RestoreHighlightMessage;
