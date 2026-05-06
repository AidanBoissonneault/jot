export type CaptureType = 'quote' | 'task' | 'idea' | 'link';

export type HighlightMeta = {
  text: string;
  xpath?: string;
  offset?: number;
};

export type Capture = {
  id: string;
  projectId: string;
  type: CaptureType;
  content: string;
  note?: string;
  sourceUrl: string;
  pageTitle: string;
  highlightMeta?: HighlightMeta;
  createdAt: string;
};

export type Project = {
  id: string;
  name: string;
  status: 'active' | 'archived';
  tags: string[];
};

export type DocumentContent = {
  type?: string;
  attrs?: Record<string, unknown>;
  content?: DocumentContent[];
  marks?: Array<{
    type: string;
    attrs?: Record<string, unknown>;
  }>;
  text?: string;
};

export type ProjectPage = {
  id: string;
  projectId: string;
  title: string;
  status?: 'active' | 'archived';
  content: DocumentContent;
  createdAt: string;
  updatedAt: string;
};

export type CreateCaptureInput = Omit<Capture, 'id' | 'createdAt'> & {
  createdAt?: string;
};
