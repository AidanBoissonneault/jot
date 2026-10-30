import './demoBrowserShim';
import { prepareDemoWorkspace } from './demoWorkspace';
import { mountSidepanel } from '../../../entrypoints/sidepanel/bootstrap';
import { installInlineCaptureButton } from '../../../src/lib/inlineCaptureButton';
import './style.css';

await prepareDemoWorkspace();
mountSidepanel('#jottathing-demo-root', { showStoreCta: true });
installInlineCaptureButton({
  document,
  window,
  buildPayload: (selection, text) => {
    const sourceUrl = window.location.href;
    return {
      text,
      sourceUrl,
      pageTitle: document.title,
      highlightMeta: { text, sourceLink: sourceUrl },
    };
  },
  onSave: (payload) => window.browser.runtime.sendMessage({
    type: 'jottathing.captureSelection',
    payload,
  }),
});

const pageSplit = document.querySelector<HTMLElement>('.page-split');
const splitter = document.querySelector<HTMLElement>('#split-divider');
const desktopLayout = window.matchMedia('(min-width: 674px)');
const dividerSize = 14;
const minReadingWidth = 340;
const minEditorWidth = 320;
let editorWidthRatio = 0.25;

function setEditorWidth(width: number) {
  if (!pageSplit || !splitter || !desktopLayout.matches) return;

  const totalWidth = pageSplit.clientWidth;
  const maximumEditorWidth = Math.max(minEditorWidth, totalWidth - dividerSize - minReadingWidth);
  const editorWidth = Math.min(maximumEditorWidth, Math.max(minEditorWidth, width));
  const readingWidth = totalWidth - dividerSize - editorWidth;
  editorWidthRatio = editorWidth / totalWidth;
  pageSplit.style.gridTemplateColumns = `${readingWidth}px ${dividerSize}px ${editorWidth}px`;

  const minimumPercent = Math.ceil((minEditorWidth / totalWidth) * 100);
  const maximumPercent = Math.floor((maximumEditorWidth / totalWidth) * 100);
  const currentPercent = Math.round(editorWidthRatio * 100);
  splitter.setAttribute('aria-valuemin', String(minimumPercent));
  splitter.setAttribute('aria-valuemax', String(maximumPercent));
  splitter.setAttribute('aria-valuenow', String(currentPercent));
  splitter.setAttribute('aria-valuetext', `${currentPercent}% editor pane`);
}

function setEditorWidthFromRatio() {
  if (!pageSplit || !desktopLayout.matches) return;
  setEditorWidth(pageSplit.clientWidth * editorWidthRatio);
}

splitter?.addEventListener('pointerdown', (event) => {
  if (!desktopLayout.matches || event.button !== 0) return;
  event.preventDefault();
  splitter.setPointerCapture(event.pointerId);
  document.body.classList.add('is-resizing-panes');
});

splitter?.addEventListener('pointermove', (event) => {
  if (!splitter.hasPointerCapture(event.pointerId) || !pageSplit) return;
  const bounds = pageSplit.getBoundingClientRect();
  const dividerLeft = event.clientX - bounds.left - dividerSize / 2;
  setEditorWidth(bounds.width - dividerLeft - dividerSize);
});

function finishResizing(event: PointerEvent) {
  if (splitter?.hasPointerCapture(event.pointerId)) splitter.releasePointerCapture(event.pointerId);
  document.body.classList.remove('is-resizing-panes');
}

splitter?.addEventListener('pointerup', finishResizing);
splitter?.addEventListener('pointercancel', finishResizing);
splitter?.addEventListener('lostpointercapture', () => {
  document.body.classList.remove('is-resizing-panes');
});

splitter?.addEventListener('keydown', (event) => {
  if (!pageSplit || !desktopLayout.matches) return;
  const currentEditorWidth = pageSplit.clientWidth * editorWidthRatio;

  if (event.key === 'ArrowLeft') {
    event.preventDefault();
    setEditorWidth(currentEditorWidth + 16);
  } else if (event.key === 'ArrowRight') {
    event.preventDefault();
    setEditorWidth(currentEditorWidth - 16);
  } else if (event.key === 'Home') {
    event.preventDefault();
    setEditorWidth(minEditorWidth);
  } else if (event.key === 'End') {
    event.preventDefault();
    setEditorWidth(pageSplit.clientWidth - dividerSize - minReadingWidth);
  }
});

window.addEventListener('resize', setEditorWidthFromRatio);
setEditorWidthFromRatio();

const mediaPhotos = document.querySelectorAll<HTMLImageElement>('[data-media-photo]');

mediaPhotos.forEach((photo) => {
  photo.addEventListener('dragstart', (event) => {
    const transfer = event.dataTransfer;
    if (!transfer) return;

    const source = photo.currentSrc || photo.src;
    const imageMarkup = document.createElement('img');
    imageMarkup.src = source;
    imageMarkup.alt = photo.alt;
    transfer.setData('text/html', imageMarkup.outerHTML);
    transfer.setData('text/uri-list', source);
    transfer.setData('text/plain', source);
    transfer.effectAllowed = 'copy';
  });
});
