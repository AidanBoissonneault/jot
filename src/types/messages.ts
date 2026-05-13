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
  type: 'inkwell.captureSelection';
  payload: CaptureSelectionPayload;
};

export type InsertCaptureRequestMessage = {
  type: 'inkwell.insertCaptureRequest';
  payload: CaptureSelectionPayload;
};

export type HeadingDragStartedMessage = {
  type: 'inkwell.headingDragStarted';
  payload: CaptureSelectionPayload;
};

export type ConsumeHeadingDragMessage = {
  type: 'inkwell.consumeHeadingDrag';
  payload?: {
    text?: string;
  };
};

export type TextDragStartedMessage = {
  type: 'inkwell.textDragStarted';
  payload: CaptureSelectionPayload;
};

export type ConsumeTextDragMessage = {
  type: 'inkwell.consumeTextDrag';
  payload?: {
    text?: string;
  };
};

export type ProjectPageUpdatedMessage = {
  type: 'inkwell.projectPageUpdated';
  payload: {
    page: ProjectPage;
  };
};

export type OpenSourceRequestMessage = {
  type: 'inkwell.openSourceRequest';
  payload: SourceOpenPayload;
};

export type RestoreHighlightMessage = {
  type: 'inkwell.restoreHighlight';
  payload: SourceOpenPayload;
};

export type InkwellRuntimeMessage =
  | CaptureSelectionMessage
  | ConsumeHeadingDragMessage
  | ConsumeTextDragMessage
  | HeadingDragStartedMessage
  | InsertCaptureRequestMessage
  | ProjectPageUpdatedMessage
  | OpenSourceRequestMessage
  | RestoreHighlightMessage
  | TextDragStartedMessage;
