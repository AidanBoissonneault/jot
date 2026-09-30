import { describe, expect, it, vi } from 'vitest';
import { isNotionFileUploadBlock } from '@/apps/worker/src/blockConversion';
import { createNotionBlockOperations } from '@/apps/worker/src/services/notionBlockOperations';
import {
  chunks,
  mediaFallbackBlock,
  positionAfterCreatedBlocks,
  updateBodyFromNotionBlock,
} from '@/apps/worker/src/workerUtils';
import type {
  NotionBlock,
  NotionBlockPayload,
  NotionObject,
  NotionRequester,
  WorkerStore,
} from '@/apps/worker/src/types';

const store = { tokens: { access_token: 'test-token' } } as WorkerStore;

function returnedCodeBlock(id: string, sourceText: string): NotionBlock {
  return {
    object: 'block',
    id,
    type: 'code',
    code: {
      rich_text: [{
        type: 'text',
        text: { content: sourceText, link: null },
        annotations: {
          bold: false,
          italic: false,
          strikethrough: false,
          underline: false,
          code: false,
          color: 'default',
        },
        plain_text: sourceText,
        href: null,
      }],
      language: 'json',
      caption: [],
    },
  } as unknown as NotionBlock;
}

describe('Notion block append confirmation', () => {
  it('recovers a newly appended source block from Notion’s full child-list response', async () => {
    const sourceText = 'inkwell_source_v1:{"blockId":"source-1"}';
    const sourceBlock: NotionBlockPayload = {
      object: 'block',
      type: 'code',
      code: {
        rich_text: [{ type: 'text', text: { content: sourceText } }],
        language: 'json',
      },
    };
    const existingBlocks = Array.from({ length: 34 }, (_, index) => ({
      object: 'block',
      id: `existing-${index}`,
      type: 'paragraph',
      paragraph: { rich_text: [] },
    } as unknown as NotionBlock));
    const createdBlock = returnedCodeBlock('notion-source-1', sourceText);
    const fullChildList = [existingBlocks[0]!, createdBlock, ...existingBlocks.slice(1)];
    const notionRequest = vi.fn(async (
      _store: WorkerStore,
      _endpoint: string,
      _init?: { method?: string; body?: unknown; headers?: HeadersInit },
    ) => ({
      object: 'list',
      results: fullChildList,
    } as unknown as NotionObject)) as unknown as NotionRequester;
    const operations = createNotionBlockOperations({
      chunks,
      isNotionFileUploadBlock,
      mediaFallbackBlock,
      notionRequest,
      positionAfterCreatedBlocks,
      updateBodyFromNotionBlock,
    });

    const result = await operations.appendManagedBlocks(
      store,
      'project-state-container',
      [sourceBlock],
      { type: 'start' },
    );

    expect(result).toEqual([createdBlock]);
    expect(notionRequest).toHaveBeenCalledTimes(1);
  });

  it('prefers the new source at the start when older retries left duplicate source blocks', async () => {
    const sourceText = 'inkwell_source_v1:{"blockId":"source-duplicate"}';
    const sourceBlock: NotionBlockPayload = {
      object: 'block',
      type: 'code',
      code: {
        rich_text: [{ type: 'text', text: { content: sourceText } }],
        language: 'json',
      },
    };
    const duplicate = returnedCodeBlock('older-duplicate', sourceText);
    const createdBlock = returnedCodeBlock('new-source-block', sourceText);
    const otherBlocks = Array.from({ length: 33 }, (_, index) => ({
      object: 'block',
      id: `existing-${index}`,
      type: 'paragraph',
      paragraph: { rich_text: [] },
    } as unknown as NotionBlock));
    const notionRequest = vi.fn(async (
      _store: WorkerStore,
      _endpoint: string,
      _init?: { method?: string; body?: unknown; headers?: HeadersInit },
    ) => ({
      object: 'list',
      results: [createdBlock, ...otherBlocks.slice(0, 16), duplicate, ...otherBlocks.slice(16)],
    } as unknown as NotionObject)) as unknown as NotionRequester;
    const operations = createNotionBlockOperations({
      chunks,
      isNotionFileUploadBlock,
      mediaFallbackBlock,
      notionRequest,
      positionAfterCreatedBlocks,
      updateBodyFromNotionBlock,
    });

    const result = await operations.appendManagedBlocks(
      store,
      'project-state-container',
      [sourceBlock],
      { type: 'start' },
    );

    expect(result).toEqual([createdBlock]);
    expect(notionRequest).toHaveBeenCalledTimes(1);
  });

  it('confirms a paragraph in a full-list response with Notion default color fields', async () => {
    const paragraphBlock: NotionBlockPayload = {
      object: 'block',
      type: 'paragraph',
      paragraph: {
        rich_text: [{ type: 'text', text: { content: 'Remote edit' } }],
      },
    };
    const unrelatedBlock = {
      object: 'block',
      id: 'existing-paragraph',
      type: 'paragraph',
      paragraph: { rich_text: [{ type: 'text', text: { content: 'Existing' } }] },
    } as unknown as NotionBlock;
    const createdBlock = {
      object: 'block',
      id: 'notion-paragraph-1',
      type: 'paragraph',
      paragraph: {
        rich_text: [{
          type: 'text',
          text: { content: 'Remote edit', link: null },
          annotations: {
            bold: false,
            italic: false,
            strikethrough: false,
            underline: false,
            code: false,
            color: 'default',
          },
          plain_text: 'Remote edit',
          href: null,
        }],
        color: 'default',
      },
    } as unknown as NotionBlock;
    const notionRequest = vi.fn(async (
      _store: WorkerStore,
      _endpoint: string,
      _init?: { method?: string; body?: unknown; headers?: HeadersInit },
    ) => ({
      object: 'list',
      results: [unrelatedBlock, createdBlock],
    } as unknown as NotionObject)) as unknown as NotionRequester;
    const operations = createNotionBlockOperations({
      chunks,
      isNotionFileUploadBlock,
      mediaFallbackBlock,
      notionRequest,
      positionAfterCreatedBlocks,
      updateBodyFromNotionBlock,
    });

    const result = await operations.appendManagedBlocks(
      store,
      'project-state-container',
      [paragraphBlock],
      { type: 'start' },
    );

    expect(result).toEqual([createdBlock]);
    expect(notionRequest).toHaveBeenCalledTimes(1);
  });

  it('confirms a converted image from its requested position when Notion rewrites its URL', async () => {
    const imageBlock: NotionBlockPayload = {
      object: 'block',
      type: 'image',
      image: { type: 'external', external: { url: 'https://ontario.ca/assets/logo.png' } },
    };
    const createdBlock = {
      object: 'block',
      id: 'notion-image-1',
      type: 'image',
      image: {
        type: 'file',
        file: { url: 'https://prod-files-secure.s3.us-west-2.amazonaws.com/ontario/logo.png?X-Amz-Signature=rotated' },
      },
    } as unknown as NotionBlock;
    const otherBlocks = Array.from({ length: 4 }, (_, index) => ({
      object: 'block',
      id: `existing-image-${index}`,
      type: 'image',
      image: { type: 'external', external: { url: `https://example.com/${index}.png` } },
    } as unknown as NotionBlock));
    const notionRequest = vi.fn(async (
      _store: WorkerStore,
      _endpoint: string,
      _init?: { method?: string; body?: unknown; headers?: HeadersInit },
    ) => ({
      object: 'list',
      results: [createdBlock, ...otherBlocks],
    } as unknown as NotionObject)) as unknown as NotionRequester;
    const operations = createNotionBlockOperations({
      chunks,
      isNotionFileUploadBlock,
      mediaFallbackBlock,
      notionRequest,
      positionAfterCreatedBlocks,
      updateBodyFromNotionBlock,
    });

    const result = await operations.appendManagedBlocks(
      store,
      'project-page',
      [imageBlock],
      { type: 'start' },
    );

    expect(result).toEqual([createdBlock]);
    expect(notionRequest).toHaveBeenCalledTimes(1);
  });

  it('reads the parent back when the response list does not contain the inserted window', async () => {
    const sourceText = 'inkwell_source_v1:{"blockId":"source-2"}';
    const sourceBlock: NotionBlockPayload = {
      object: 'block',
      type: 'code',
      code: {
        rich_text: [{ type: 'text', text: { content: sourceText } }],
        language: 'json',
      },
    };
    const createdBlock = returnedCodeBlock('notion-source-2', sourceText);
    const incompleteResponse = {
      object: 'list',
      results: Array.from({ length: 30 }, (_, index) => ({
        object: 'block',
        id: `old-${index}`,
        type: 'paragraph',
        paragraph: { rich_text: [] },
      } as unknown as NotionBlock)),
    } as unknown as NotionObject;
    const notionRequest = vi.fn(async (
      _store: WorkerStore,
      endpoint: string,
      _init?: { method?: string; body?: unknown; headers?: HeadersInit },
    ) => endpoint.includes('/children?')
      ? { object: 'list', results: [createdBlock] } as unknown as NotionObject
      : incompleteResponse) as unknown as NotionRequester;
    const operations = createNotionBlockOperations({
      chunks,
      isNotionFileUploadBlock,
      mediaFallbackBlock,
      notionRequest,
      positionAfterCreatedBlocks,
      updateBodyFromNotionBlock,
    });

    const result = await operations.appendManagedBlocks(
      store,
      'project-state-container',
      [sourceBlock],
      { type: 'start' },
    );

    expect(result).toEqual([createdBlock]);
    expect(notionRequest).toHaveBeenCalledTimes(2);
  });
});
