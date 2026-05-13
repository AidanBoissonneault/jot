import type { DocumentContent } from '@/src/types/capture';

export function doc(content: DocumentContent[]): DocumentContent {
  return { type: 'doc', content };
}

export function paragraph(text: string): DocumentContent {
  return {
    type: 'paragraph',
    content: [{ type: 'text', text }],
  };
}

export function image(attrs: Record<string, unknown>): DocumentContent {
  return { type: 'image', attrs };
}

export function audio(attrs: Record<string, unknown>): DocumentContent {
  return { type: 'audio', attrs };
}
