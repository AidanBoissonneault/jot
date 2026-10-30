/** @file Installs the inline Save control used by the extension and web demo. */

export interface InlineCaptureButtonOptions<Payload> {
  buildPayload: (selection: Selection, text: string) => Payload;
  onSave: (payload: Payload) => Promise<unknown>;
  document?: Document;
  window?: Window;
}

/** Renders the page selection control and forwards only a real user click. */
export function installInlineCaptureButton<Payload>({
  buildPayload,
  onSave,
  document: pageDocument = document,
  window: pageWindow = window,
}: InlineCaptureButtonOptions<Payload>): () => void {
  let selectedPayload: Payload | null = null;
  let removeTimer: number | undefined;

  const button = pageDocument.createElement('button');
  button.id = 'jottathing-inline-save';
  button.type = 'button';
  button.textContent = 'Save';
  button.setAttribute('aria-label', 'Save selection to Jottathing');
  Object.assign(button.style, {
    position: 'absolute',
    zIndex: '2147483647',
    display: 'none',
    minHeight: '30px',
    padding: '0 12px',
    border: '1px solid #0f2673',
    borderRadius: '8px',
    background: '#173494',
    boxShadow: '0 8px 24px rgb(0 0 0 / 18%)',
    color: '#ffffff',
    cursor: 'pointer',
    transition: 'background-color 120ms ease, box-shadow 120ms ease',
    font: '600 13px/1 system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif',
  });
  pageDocument.documentElement.append(button);

  button.addEventListener('mouseenter', () => {
    button.style.background = '#0f2673';
  });
  button.addEventListener('mouseleave', () => {
    button.style.background = '#173494';
  });

  function hideButton() {
    selectedPayload = null;
    button.style.display = 'none';
  }

  function showButton(selection: Selection, text: string) {
    const range = selection.rangeCount ? selection.getRangeAt(0) : null;
    if (!range) {
      hideButton();
      return;
    }

    const rect = range.getBoundingClientRect();
    if (!rect.width && !rect.height) {
      hideButton();
      return;
    }

    selectedPayload = buildPayload(selection, text);
    button.style.left = `${Math.max(8, rect.left + pageWindow.scrollX)}px`;
    button.style.top = `${Math.max(8, rect.bottom + pageWindow.scrollY + 8)}px`;
    button.style.display = 'block';
  }

  function handleSelectionChange() {
    pageWindow.clearTimeout(removeTimer);
    removeTimer = pageWindow.setTimeout(() => {
      const selection = pageWindow.getSelection();
      const selectedText = selection?.toString().replace(/\r\n/g, '\n').trimEnd() ?? '';
      if (!selection || !selectedText.trim()) {
        hideButton();
        return;
      }

      showButton(selection, selectedText);
    }, 80);
  }

  pageDocument.addEventListener('selectionchange', handleSelectionChange);
  button.addEventListener('mousedown', (event) => event.preventDefault());
  button.addEventListener('click', async (event) => {
    // Page scripts can see this injected DOM button; only a real user gesture may save text.
    if (!event.isTrusted || !selectedPayload) return;

    const payload = selectedPayload;
    button.disabled = true;
    button.textContent = 'Saved';
    try {
      await onSave(payload);
    } finally {
      pageWindow.setTimeout(() => {
        button.disabled = false;
        button.textContent = 'Save';
        hideButton();
      }, 500);
    }
  });

  return () => {
    pageWindow.clearTimeout(removeTimer);
    pageDocument.removeEventListener('selectionchange', handleSelectionChange);
    button.remove();
  };
}
