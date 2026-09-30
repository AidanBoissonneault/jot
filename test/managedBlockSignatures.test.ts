import { describe, expect, it } from 'vitest';
import { managedBlockSignature } from '@/apps/worker/src/managedBlockSignatures';

describe('managed Notion block signatures', () => {
  it('ignores Notion defaults added to unformatted code rich text', () => {
    const sourceText = 'inkwell_source_v1:{"blockId":"source-1"}';
    const outgoing = {
      object: 'block',
      type: 'code',
      code: {
        rich_text: [{ type: 'text', text: { content: sourceText } }],
        language: 'json',
      },
    };
    const returned = {
      object: 'block',
      id: 'notion-source-1',
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
    };

    expect(managedBlockSignature(returned)).toBe(managedBlockSignature(outgoing));
  });

  it('ignores the default block color added to paragraph responses', () => {
    const outgoing = {
      object: 'block',
      type: 'paragraph',
      paragraph: {
        rich_text: [{ type: 'text', text: { content: 'Remote edit' } }],
      },
    };
    const returned = {
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
    };

    expect(managedBlockSignature(returned)).toBe(managedBlockSignature(outgoing));
  });

  it('preserves non-default paragraph colors in the signature', () => {
    const outgoing = {
      object: 'block',
      type: 'paragraph',
      paragraph: {
        rich_text: [{ type: 'text', text: { content: 'Remote edit' } }],
      },
    };
    const returned = {
      object: 'block',
      type: 'paragraph',
      paragraph: {
        rich_text: [{ type: 'text', text: { content: 'Remote edit' } }],
        color: 'red',
      },
    };

    expect(managedBlockSignature(returned)).not.toBe(managedBlockSignature(outgoing));
  });

  it('treats an empty text item like Notion’s empty paragraph rich_text array', () => {
    const outgoing = {
      object: 'block',
      type: 'paragraph',
      paragraph: {
        rich_text: [{ type: 'text', text: { content: '' } }],
        color: 'default',
      },
    };
    const returned = {
      object: 'block',
      id: 'notion-empty-paragraph',
      type: 'paragraph',
      paragraph: {
        rich_text: [],
        color: 'default',
      },
    };

    expect(managedBlockSignature(returned)).toBe(managedBlockSignature(outgoing));
  });

  it('keeps authored formatting differences in the signature', () => {
    const sourceText = 'source';
    const outgoing = {
      object: 'block',
      type: 'code',
      code: {
        rich_text: [{ type: 'text', text: { content: sourceText } }],
        language: 'json',
      },
    };
    const returned = {
      object: 'block',
      type: 'code',
      code: {
        rich_text: [{
          type: 'text',
          text: { content: sourceText },
          annotations: { bold: true, color: 'default' },
        }],
        language: 'json',
      },
    };

    expect(managedBlockSignature(returned)).not.toBe(managedBlockSignature(outgoing));
  });
});
