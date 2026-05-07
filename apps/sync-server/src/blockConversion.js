export function tiptapDocumentToNotionBlocks(doc) {
  return (doc?.content ?? []).map((node) => tiptapNodeToNotionBlock(node));
}

function tiptapNodeToNotionBlock(node) {
  const richText = inlineContentToRichText(node.content);

  if (node.type === 'heading') {
    const level = Math.min(3, Math.max(1, Number(node.attrs?.level ?? 2)));
    return {
      object: 'block',
      type: `heading_${level}`,
      [`heading_${level}`]: {
        rich_text: richText,
        color: 'default',
        is_toggleable: false,
      },
    };
  }

  if (node.type === 'blockquote') {
    return {
      object: 'block',
      type: 'quote',
      quote: {
        rich_text: richText,
        color: 'default',
      },
    };
  }

  if (node.type === 'codeBlock') {
    return {
      object: 'block',
      type: 'code',
      code: {
        rich_text: plainRichText(textFromNode(node)),
        language: 'plain text',
      },
    };
  }

  if (node.type === 'bulletList' || node.type === 'orderedList') {
    const listItems = node.content ?? [];
    return {
      object: 'block',
      type: 'paragraph',
      paragraph: {
        rich_text: plainRichText(listItems.map((item) => `- ${textFromNode(item)}`).join('\n')),
        color: 'default',
      },
    };
  }

  if (node.type === 'taskList') {
    return {
      object: 'block',
      type: 'paragraph',
      paragraph: {
        rich_text: plainRichText(
          (node.content ?? [])
            .map((item) => `${item.attrs?.checked ? '[x]' : '[ ]'} ${textFromNode(item)}`)
            .join('\n'),
        ),
        color: 'default',
      },
    };
  }

  if (node.type === 'horizontalRule') {
    return {
      object: 'block',
      type: 'divider',
      divider: {},
    };
  }

  if (node.type === 'image') {
    const src = node.attrs?.src;
    const fileUploadId = node.attrs?.notionFileUploadId;

    if (fileUploadId) {
      return {
        object: 'block',
        type: 'image',
        image: { type: 'file_upload', file_upload: { id: fileUploadId } },
      };
    }

    if (!src || !/^https?:\/\//i.test(src)) {
      return paragraphFallback('');
    }

    return { object: 'block', type: 'image', image: { type: 'external', external: { url: src } } };
  }

  if (node.type === 'youtube') {
    const src = node.attrs?.src;
    if (!src) return paragraphFallback('');
    const videoUrl = normalizeYoutubeVideoUrl(src);
    return {
      object: 'block',
      type: 'video',
      video: { type: 'external', external: { url: videoUrl } },
    };
  }

  if (node.type === 'audio') {
    const src = node.attrs?.src;
    const fileUploadId = node.attrs?.notionFileUploadId;

    if (fileUploadId) {
      return {
        object: 'block',
        type: 'audio',
        audio: { type: 'file_upload', file_upload: { id: fileUploadId } },
      };
    }

    if (!src || !/^https?:\/\//i.test(src)) return paragraphFallback('');
    return { object: 'block', type: 'audio', audio: { type: 'external', external: { url: src } } };
  }

  return paragraphFallback(richText.length ? richText : plainRichText(''));
}

function paragraphFallback(richText) {
  const rt = typeof richText === 'string' ? plainRichText(richText) : richText;
  return {
    object: 'block',
    type: 'paragraph',
    paragraph: {
      rich_text: rt,
      color: 'default',
    },
  };
}

function inlineContentToRichText(content = []) {
  const richText = [];

  for (const node of content) {
    if (node.type === 'text') {
      richText.push(textNodeToRichText(node));
    } else if (node.type === 'hardBreak') {
      richText.push(...plainRichText('\n'));
    } else {
      richText.push(...inlineContentToRichText(node.content ?? []));
    }
  }

  return richText.length ? richText : [];
}

function textNodeToRichText(node) {
  const marks = node.marks ?? [];
  const link = marks.find((mark) => mark.type === 'link')?.attrs?.href;
  const textStyle = marks.find((mark) => mark.type === 'textStyle')?.attrs ?? {};

  return {
    type: 'text',
    text: {
      content: node.text ?? '',
      ...(link ? { link: { url: link } } : {}),
    },
    annotations: {
      bold: marks.some((mark) => mark.type === 'bold'),
      italic: marks.some((mark) => mark.type === 'italic'),
      strikethrough: marks.some((mark) => mark.type === 'strike'),
      underline: marks.some((mark) => mark.type === 'underline'),
      code: marks.some((mark) => mark.type === 'code'),
      color: notionColor(textStyle.color),
    },
  };
}

function plainRichText(text) {
  return [
    {
      type: 'text',
      text: {
        content: text,
      },
    },
  ];
}

export function notionBlocksToTiptapDocument(blocks) {
  return {
    type: 'doc',
    content: blocks.map(notionBlockToTiptapNode).filter(Boolean),
  };
}

function notionBlockToTiptapNode(block) {
  if (block.type?.startsWith('heading_')) {
    return {
      type: 'heading',
      attrs: {
        level: Number(block.type.replace('heading_', '')),
      },
      content: richTextToTiptapInline(block[block.type].rich_text),
    };
  }

  if (block.type === 'quote') {
    return {
      type: 'blockquote',
      content: [
        {
          type: 'paragraph',
          content: richTextToTiptapInline(block.quote.rich_text),
        },
      ],
    };
  }

  if (block.type === 'code') {
    return {
      type: 'codeBlock',
      content: plainTiptapText(block.code.rich_text.map((text) => text.plain_text).join('')),
    };
  }

  if (block.type === 'divider') {
    return {
      type: 'horizontalRule',
    };
  }

  if (block.type === 'image') {
    const url = block.image?.external?.url ?? block.image?.file?.url ?? block.image?.file_upload?.url;
    if (!url) return null;
    return { type: 'image', attrs: { src: url } };
  }

  if (block.type === 'video' || block.type === 'embed') {
    const data = block[block.type];
    const url = data?.external?.url ?? data?.url ?? data?.file?.url;
    if (!url) return null;
    return { type: 'youtube', attrs: { src: url } };
  }

  if (block.type === 'audio') {
    const url = block.audio?.external?.url ?? block.audio?.file?.url ?? block.audio?.file_upload?.url;
    if (!url) return null;
    return { type: 'audio', attrs: { src: url } };
  }

  if (block.type !== 'paragraph') {
    return null;
  }

  return {
    type: 'paragraph',
    content: richTextToTiptapInline(block.paragraph.rich_text),
  };
}

function richTextToTiptapInline(richText = []) {
  const content = [];

  for (const item of richText) {
    const plainText = String(item.plain_text ?? '').replace(/\s*jot_capture_id:[\w-]+/g, '');

    if (!plainText) {
      continue;
    }

    const marks = marksFromRichText(item);
    const parts = plainText.split('\n');

    parts.forEach((part, index) => {
      if (index > 0) {
        content.push({ type: 'hardBreak' });
      }

      if (part) {
        content.push({
          type: 'text',
          text: part,
          ...(marks.length ? { marks } : {}),
        });
      }
    });
  }

  return content.length ? content : undefined;
}

function marksFromRichText(item) {
  const marks = [];
  const annotations = item.annotations ?? {};

  if (annotations.bold) marks.push({ type: 'bold' });
  if (annotations.italic) marks.push({ type: 'italic' });
  if (annotations.strikethrough) marks.push({ type: 'strike' });
  if (annotations.underline) marks.push({ type: 'underline' });
  if (annotations.code) marks.push({ type: 'code' });
  if (item.href) marks.push({ type: 'link', attrs: { href: item.href } });

  return marks;
}

function plainTiptapText(text) {
  return text
    ? [
        {
          type: 'text',
          text,
        },
      ]
    : undefined;
}

function textFromNode(node) {
  if (node.text) {
    return node.text;
  }

  if (node.type === 'hardBreak') {
    return '\n';
  }

  return (node.content ?? []).map(textFromNode).join('');
}

function notionColor(color) {
  return typeof color === 'string' && color ? 'default' : 'default';
}

function normalizeYoutubeVideoUrl(src) {
  try {
    const url = new URL(src);
    const host = url.hostname.toLowerCase();

    if (host.endsWith('youtu.be')) {
      const id = url.pathname.split('/').filter(Boolean)[0];
      return id ? youtubeWatchUrl(id, url.searchParams) : src;
    }

    const embedMatch = url.pathname.match(/^\/(?:embed|shorts|v)\/([\w-]+)/i);
    const id = url.searchParams.get('v') ?? embedMatch?.[1];

    if (!id) {
      return src;
    }

    return youtubeWatchUrl(id, url.searchParams);
  } catch {
    return src;
  }
}

function youtubeWatchUrl(id, sourceParams) {
  const url = new URL('https://www.youtube.com/watch');
  url.searchParams.set('v', id);

  const start = sourceParams.get('t') ?? sourceParams.get('start');
  if (start) {
    url.searchParams.set('t', start);
  }

  return url.toString();
}

export function kindFromNotionBlock(block) {
  if (block.type?.startsWith('heading_')) return 'heading';
  if (block.type === 'quote') return 'quote';
  if (['image', 'video', 'audio', 'embed', 'file'].includes(block.type)) return 'media';
  return block.type === 'paragraph' ? 'paragraph' : 'source';
}
