interface PatchNote {
  version: string;
  date: string;
  title: string;
  body: string;
}

const patchNoteFiles = import.meta.glob('../patch-notes/posts/*.md', {
  eager: true,
  query: '?raw',
  import: 'default',
}) as Record<string, string>;

function parsePatchNote(source: string): PatchNote | null {
  const normalized = source.replace(/\r\n/g, '\n');
  if (!normalized.startsWith('---\n')) return null;

  const metadataEnd = normalized.indexOf('\n---\n', 4);
  if (metadataEnd < 0) return null;

  const metadata = new Map<string, string>();
  for (const line of normalized.slice(4, metadataEnd).split('\n')) {
    const separator = line.indexOf(':');
    if (separator < 1) continue;
    const key = line.slice(0, separator).trim();
    const value = line.slice(separator + 1).trim().replace(/^['"]|['"]$/g, '');
    metadata.set(key, value);
  }

  const version = metadata.get('version');
  const date = metadata.get('date');
  const title = metadata.get('title');
  if (!version || !date || !title) return null;

  return {
    version,
    date,
    title,
    body: normalized.slice(metadataEnd + 5).trim(),
  };
}

function appendMarkdownBody(target: HTMLElement, body: string) {
  let paragraph: string[] = [];
  let list: HTMLUListElement | null = null;

  const flushParagraph = () => {
    if (paragraph.length === 0) return;
    const element = document.createElement('p');
    element.textContent = paragraph.join(' ');
    target.append(element);
    paragraph = [];
  };

  for (const line of body.split('\n')) {
    const content = line.trim();
    if (!content) {
      flushParagraph();
      list = null;
      continue;
    }

    if (content.startsWith('### ')) {
      flushParagraph();
      list = null;
      const heading = document.createElement('h5');
      heading.textContent = content.slice(4).trim();
      target.append(heading);
      continue;
    }

    if (content.startsWith('## ')) {
      flushParagraph();
      list = null;
      const heading = document.createElement('h4');
      heading.textContent = content.slice(3).trim();
      target.append(heading);
      continue;
    }

    if (/^[-*]\s+/.test(content)) {
      flushParagraph();
      if (!list) {
        list = document.createElement('ul');
        target.append(list);
      }
      const item = document.createElement('li');
      item.textContent = content.replace(/^[-*]\s+/, '');
      list.append(item);
      continue;
    }

    list = null;
    paragraph.push(content);
  }

  flushParagraph();
}

export function renderPatchNotes(target: HTMLElement | null) {
  if (!target) return;

  const notes = Object.values(patchNoteFiles)
    .map(parsePatchNote)
    .filter((note): note is PatchNote => note !== null)
    .sort((left, right) => right.date.localeCompare(left.date));

  if (notes.length === 0) {
    const emptyMessage = document.createElement('p');
    emptyMessage.className = 'patch-note-empty';
    emptyMessage.textContent = 'No release notes yet.';
    target.append(emptyMessage);
    return;
  }

  for (const note of notes) {
    const article = document.createElement('article');
    article.className = 'patch-note';

    const metadata = document.createElement('div');
    metadata.className = 'patch-note-meta';

    const version = document.createElement('span');
    version.className = 'patch-note-version';
    version.textContent = note.version;

    const date = document.createElement('time');
    date.dateTime = note.date;
    const parsedDate = new Date(`${note.date}T00:00:00Z`);
    date.textContent = Number.isNaN(parsedDate.valueOf())
      ? note.date
      : new Intl.DateTimeFormat('en', {
          month: 'long',
          day: 'numeric',
          year: 'numeric',
          timeZone: 'UTC',
        }).format(parsedDate);

    metadata.append(version, date);

    const title = document.createElement('h3');
    title.className = 'patch-note-title';
    title.textContent = note.title;

    const body = document.createElement('div');
    body.className = 'patch-note-body';
    appendMarkdownBody(body, note.body);

    article.append(metadata, title, body);
    target.append(article);
  }
}
