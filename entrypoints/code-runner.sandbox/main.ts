import { safeHtmlPreviewDocument } from '@/src/lib/safeHtmlPreview';
import {
  isCodeRunnerRequest,
  MAX_CODE_OUTPUT_LENGTH,
  MAX_CODE_OUTPUT_MESSAGES,
} from '@/src/lib/codeRunnerSecurity';

type WorkerResponse = {
  type: 'log' | 'result' | 'error' | 'complete';
  level?: string;
  values?: string[];
  value?: string;
};

const output = document.querySelector<HTMLElement>('#output');
let activeWorker: Worker | undefined;
let activeToken = '';
let timeoutId: number | undefined;

applyBaseStyles();

window.addEventListener('message', (event: MessageEvent<unknown>) => {
  if (event.source !== window.parent || !isCodeRunnerRequest(event.data)) {
    return;
  }

  activeToken = event.data.token;
  const runToken = activeToken;
  cleanupWorker();

  if (!output) {
    complete(runToken);
    return;
  }

  output.replaceChildren();
  document.body.classList.toggle('html-preview', event.data.language === 'html');

  if (event.data.language === 'html') {
    renderHtml(event.data.code, runToken);
    return;
  }

  runJavaScript(event.data.code, runToken);
});

function runJavaScript(code: string, runToken: string) {
  if (!output) {
    return;
  }

  let worker: Worker;
  const workerUrl = URL.createObjectURL(
    new Blob([javascriptWorkerSource()], { type: 'text/javascript' }),
  );
  try {
    worker = new Worker(workerUrl);
  } catch {
    URL.revokeObjectURL(workerUrl);
    appendLine('The code runner could not start.', 'error');
    announceSize(runToken);
    complete(runToken);
    return;
  }
  URL.revokeObjectURL(workerUrl);
  activeWorker = worker;
  let outputMessageCount = 0;

  worker.addEventListener('message', (event: MessageEvent<WorkerResponse>) => {
    const message = event.data;
    if (
      activeWorker !== worker ||
      !message ||
      typeof message !== 'object' ||
      !['log', 'result', 'error', 'complete'].includes(message.type)
    ) {
      return;
    }

    if (message.type !== 'complete') {
      outputMessageCount += 1;
      if (outputMessageCount > MAX_CODE_OUTPUT_MESSAGES) {
        appendLine('Output stopped after 100 messages.', 'error');
        cleanupWorker();
        announceSize(runToken);
        complete(runToken);
        return;
      }
    }

    if (message.type === 'log') {
      const values: string[] = [];
      let remainingOutputLength = MAX_CODE_OUTPUT_LENGTH;
      if (Array.isArray(message.values)) {
        for (const value of message.values) {
          if (remainingOutputLength <= 0) break;
          if (typeof value !== 'string') continue;
          const boundedValue = value.slice(0, remainingOutputLength);
          values.push(boundedValue);
          remainingOutputLength -= boundedValue.length;
        }
      }
      const level = ['log', 'info', 'warn', 'error'].includes(message.level ?? '')
        ? message.level
        : 'log';
      appendLine(values.join(' ').slice(0, MAX_CODE_OUTPUT_LENGTH), `log-${level}`);
      announceSize(runToken);
      return;
    }

    if (message.type === 'result' && message.value !== 'undefined') {
      appendLine(typeof message.value === 'string'
        ? message.value.slice(0, MAX_CODE_OUTPUT_LENGTH)
        : '', 'result');
    }

    if (message.type === 'error') {
      appendLine(typeof message.value === 'string'
        ? message.value.slice(0, MAX_CODE_OUTPUT_LENGTH)
        : 'Execution failed.', 'error');
    }

    if (message.type === 'complete') {
      if (!output.childElementCount) {
        appendLine('Completed without output.', 'empty');
      }
      cleanupWorker();
      announceSize(runToken);
      complete(runToken);
    }
  });

  worker.addEventListener('error', (event) => {
    if (activeWorker !== worker) return;
    appendLine(event.message || 'Execution failed.', 'error');
    cleanupWorker();
    announceSize(runToken);
    complete(runToken);
  });

  timeoutId = window.setTimeout(() => {
    if (activeWorker !== worker) return;
    appendLine('Execution stopped after 5 seconds.', 'error');
    cleanupWorker();
    announceSize(runToken);
    complete(runToken);
  }, 5000);

  worker.postMessage({ code });
}

function renderHtml(code: string, runToken: string) {
  if (!output) {
    return;
  }

  document.body.classList.add('html-preview');
  const preview = document.createElement('iframe');
  preview.title = 'HTML preview';
  preview.setAttribute('sandbox', '');
  preview.srcdoc = safeHtmlPreviewDocument(code);
  preview.addEventListener('load', () => {
    if (!output?.contains(preview)) return;
    announceSize(runToken);
    complete(runToken);
  }, { once: true });
  output.append(preview);
  window.setTimeout(() => {
    if (!output.contains(preview)) return;
    announceSize(runToken);
    complete(runToken);
  }, 400);
}

function appendLine(text: string, className: string) {
  if (!output) {
    return;
  }

  const line = document.createElement('div');
  line.className = className;
  line.textContent = text;
  output.append(line);
}

function cleanupWorker() {
  window.clearTimeout(timeoutId);
  timeoutId = undefined;
  activeWorker?.terminate();
  activeWorker = undefined;
}

function announceSize(token = activeToken) {
  window.parent.postMessage({
    type: 'inkwell.codeRunner.resize',
    token,
    height: Math.ceil(document.documentElement.scrollHeight),
  }, '*');
}

function complete(token = activeToken) {
  window.parent.postMessage({
    type: 'inkwell.codeRunner.complete',
    token,
  }, '*');
}

function javascriptWorkerSource() {
  return String.raw`
    const MAX_OUTPUT_LENGTH = ${MAX_CODE_OUTPUT_LENGTH};
    const limitOutput = (value) => value.length > MAX_OUTPUT_LENGTH
      ? value.slice(0, MAX_OUTPUT_LENGTH) + '… (truncated)'
      : value;

    const serialize = (value) => {
      if (typeof value === 'string') return limitOutput(value);
      if (typeof value === 'undefined') return 'undefined';
      if (typeof value === 'function') return limitOutput(value.toString());
      if (value instanceof Error) return limitOutput(value.stack || value.message);
      try {
        const json = JSON.stringify(value, (_key, item) =>
          typeof item === 'bigint' ? item.toString() + 'n' : item,
          2,
        );
        return limitOutput(json === undefined ? String(value) : json);
      } catch {
        return limitOutput(String(value));
      }
    };

    for (const level of ['log', 'info', 'warn', 'error']) {
      console[level] = (...values) => self.postMessage({
        type: 'log',
        level,
        values: serializeLogArguments(values),
      });
    }

    const serializeLogArguments = (values) => {
      const serialized = [];
      let remaining = MAX_OUTPUT_LENGTH;
      for (const value of values.slice(0, 20)) {
        if (remaining <= 0) break;
        const bounded = serialize(value).slice(0, remaining);
        serialized.push(bounded);
        remaining -= bounded.length;
      }
      return serialized;
    };

    self.onmessage = async ({ data }) => {
      const AsyncFunction = Object.getPrototypeOf(async function () {}).constructor;
      try {
        let result;
        try {
          result = await new AsyncFunction('"use strict"; return (\\n' + data.code + '\\n);')();
        } catch (expressionError) {
          if (!(expressionError instanceof SyntaxError)) throw expressionError;
          result = await new AsyncFunction('"use strict";\\n' + data.code)();
        }
        self.postMessage({ type: 'result', value: serialize(result) });
      } catch (error) {
        self.postMessage({ type: 'error', value: serialize(error) });
      } finally {
        self.postMessage({ type: 'complete' });
      }
    };
  `;
}

function applyBaseStyles() {
  const style = document.createElement('style');
  style.textContent = `
    :root { color-scheme: light dark; font: 12px/1.5 ui-monospace, SFMono-Regular, Consolas, monospace; }
    * { box-sizing: border-box; }
    html, body { margin: 0; min-height: 100%; background: transparent; color: #27272a; }
    body { padding: 10px 12px; }
    #output { white-space: pre-wrap; overflow-wrap: anywhere; }
    #output > div + div { margin-top: 5px; }
    .log-warn { color: #a16207; }
    .log-error, .error { color: #b42318; }
    .result { color: #155e75; }
    .result::before { content: 'Out: '; color: #71717a; }
    .empty { color: #71717a; font-style: italic; }
    .html-preview { padding: 0; }
    .html-preview #output, .html-preview iframe { width: 100%; min-height: 180px; border: 0; background: white; }
    @media (prefers-color-scheme: dark) {
      html, body { color: #e4e4e7; }
      .result { color: #67e8f9; }
      .html-preview #output, .html-preview iframe { background: white; }
    }
  `;
  document.head.append(style);
}
