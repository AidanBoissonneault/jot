import type { Project, ProjectPage } from '@/src/types/capture';

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

export type WebsiteHighlightColor = 'yellow' | 'green' | 'blue' | 'pink' | 'gray';

export type WebsiteHighlight = {
  id: string;
  url: string;
  text: string;
  color: WebsiteHighlightColor;
  note?: string;
  createdAt: string;
  anchor: {
    startXPath: string;
    startOffset: number;
    endXPath: string;
    endOffset: number;
    blockXPath: string;
    blockText: string;
  };
};

export type GetWebsiteHighlightsMessage = {
  type: 'inkwell.getWebsiteHighlights';
  payload: { url: string };
};

export type CreateWebsiteHighlightMessage = {
  type: 'inkwell.createWebsiteHighlight';
  payload: { highlight: WebsiteHighlight };
};

export type RemoveWebsiteHighlightsMessage = {
  type: 'inkwell.removeWebsiteHighlights';
  payload: { ids: string[]; url: string };
};

export type RefreshWebsiteHighlightsMessage = {
  type: 'inkwell.refreshWebsiteHighlights';
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

export type ProjectStateUpdatedMessage = {
  type: 'inkwell.projectStateUpdated';
  payload: { project: Project };
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
  | CreateWebsiteHighlightMessage
  | ConsumeHeadingDragMessage
  | ConsumeTextDragMessage
  | GetWebsiteHighlightsMessage
  | HeadingDragStartedMessage
  | InsertCaptureRequestMessage
  | ProjectPageUpdatedMessage
  | ProjectStateUpdatedMessage
  | RefreshWebsiteHighlightsMessage
  | RemoveWebsiteHighlightsMessage
  | OpenSourceRequestMessage
  | RestoreHighlightMessage
  | TextDragStartedMessage;
