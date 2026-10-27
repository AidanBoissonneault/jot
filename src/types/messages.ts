import type { ProjectPage } from '@/src/types/capture';

export type CaptureSourceBlockType = 'heading' | 'paragraph' | 'blockquote' | 'codeBlock';

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
    isCodeBlock?: boolean;
    codeLanguage?: string;
    sourceBlockType?: CaptureSourceBlockType;
  };
};

export type CaptureSelectionMessage = {
  type: 'jottathing.captureSelection';
  payload: CaptureSelectionPayload;
};

export type InsertCaptureRequestMessage = {
  type: 'jottathing.insertCaptureRequest';
  payload: CaptureSelectionPayload;
};

export type HeadingDragStartedMessage = {
  type: 'jottathing.headingDragStarted';
  payload: CaptureSelectionPayload;
};

export type ConsumeHeadingDragMessage = {
  type: 'jottathing.consumeHeadingDrag';
  payload?: {
    text?: string;
  };
};

export type TextDragStartedMessage = {
  type: 'jottathing.textDragStarted';
  payload: CaptureSelectionPayload;
};

export type ConsumeTextDragMessage = {
  type: 'jottathing.consumeTextDrag';
  payload?: {
    text?: string;
  };
};

export type ProjectPageUpdatedMessage = {
  type: 'jottathing.projectPageUpdated';
  payload: {
    page: ProjectPage;
  };
};

export type OpenSourceRequestMessage = {
  type: 'jottathing.openSourceRequest';
  payload: SourceOpenPayload;
};

export type RestoreHighlightMessage = {
  type: 'jottathing.restoreHighlight';
  payload: SourceOpenPayload;
};

export type PrepareConnectionDeletionMessage = {
  type: 'jottathing.prepareConnectionDeletion';
};

export type AbortConnectionDeletionMessage = {
  type: 'jottathing.abortConnectionDeletion';
};

export type CompleteConnectionDeletionMessage = {
  type: 'jottathing.completeConnectionDeletion';
};

export type JottathingRuntimeMessage =
  | CaptureSelectionMessage
  | AbortConnectionDeletionMessage
  | CompleteConnectionDeletionMessage
  | ConsumeHeadingDragMessage
  | ConsumeTextDragMessage
  | HeadingDragStartedMessage
  | InsertCaptureRequestMessage
  | ProjectPageUpdatedMessage
  | PrepareConnectionDeletionMessage
  | OpenSourceRequestMessage
  | RestoreHighlightMessage
  | TextDragStartedMessage;
