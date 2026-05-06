import type { Capture, CreateCaptureInput, Project } from '@/src/types/capture';

const mockProjects: Project[] = [
  {
    id: 'project-product-research',
    name: 'Product Research',
    status: 'active',
    tags: ['research', 'jot'],
  },
  {
    id: 'project-writing',
    name: 'Writing Queue',
    status: 'active',
    tags: ['notes'],
  },
];

let mockCaptures: Capture[] = [
  {
    id: 'capture-quote-1',
    projectId: 'project-product-research',
    type: 'quote',
    content: 'Capture without breaking flow.',
    sourceUrl: 'https://example.com/product-thinking',
    pageTitle: 'Product Thinking',
    highlightMeta: {
      text: 'Capture without breaking flow.',
    },
    createdAt: '2026-05-05T20:12:00.000Z',
  },
  {
    id: 'capture-task-1',
    projectId: 'project-product-research',
    type: 'task',
    content: 'Sketch the drag-to-sidebar interaction states.',
    sourceUrl: 'https://example.com/ux-notes',
    pageTitle: 'UX Notes',
    createdAt: '2026-05-05T20:42:00.000Z',
  },
  {
    id: 'capture-link-1',
    projectId: 'project-writing',
    type: 'link',
    content: 'https://example.com/notion-api-patterns',
    sourceUrl: 'https://example.com/notion-api-patterns',
    pageTitle: 'Notion API Patterns',
    createdAt: '2026-05-05T21:03:00.000Z',
  },
];

const waitForStub = () => new Promise((resolve) => window.setTimeout(resolve, 120));

export const notionClient = {
  async listProjects(): Promise<Project[]> {
    await waitForStub();
    return [...mockProjects];
  },

  async listCaptures(projectId: string): Promise<Capture[]> {
    await waitForStub();
    return mockCaptures
      .filter((capture) => capture.projectId === projectId)
      .sort(
        (first, second) =>
          new Date(second.createdAt).getTime() - new Date(first.createdAt).getTime(),
      );
  },

  async createCapture(input: CreateCaptureInput): Promise<Capture> {
    await waitForStub();

    const capture: Capture = {
      ...input,
      id: `capture-${crypto.randomUUID()}`,
      createdAt: input.createdAt ?? new Date().toISOString(),
    };

    mockCaptures = [capture, ...mockCaptures];
    return capture;
  },
};
