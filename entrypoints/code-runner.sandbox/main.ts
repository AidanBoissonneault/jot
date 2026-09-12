type RunRequest = {
  type: 'inkwell.codeRunner.run';
  token: string;
  language: 'javascript' | 'html';
  code: string;
};

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

window.addEventListener('message', (event: MessageEvent<RunRequest>) => {
  if (event.source !== window.parent || event.data?.type !== 'inkwell.codeRunner.run') {
    return;
  }

  activeToken = event.data.token;
  cleanupWorker();

  if (!output) {
    complete();
    return;
  }

  output.replaceChildren();

  if (event.data.language === 'html') {
    renderHtml(event.data.code);
    return;
  }

  runJavaScript(event.data.code);
});

function runJavaScript(code: string) {
  if (!output) {
    return;
  }

  const workerBlob = new Blob([javascriptWorkerSource()], { type: 'text/javascript' });
  const workerUrl = URL.createObjectURL(workerBlob);
  const worker = new Worker(workerUrl);
  URL.revokeObjectURL(workerUrl);
  activeWorker = worker;

  worker.addEventListener('message', (event: MessageEvent<WorkerResponse>) => {
    const message = event.data;

    if (message.type === 'log') {
      appendLine(message.values?.join(' ') ?? '', `log-${message.level ?? 'log'}`);
      announceSize();
      return;
    }

    if (message.type === 'result' && message.value !== 'undefined') {
      appendLine(message.value ?? '', 'result');
    }

    if (message.type === 'error') {
      appendLine(message.value ?? 'Execution failed.', 'error');
    }

    if (message.type === 'complete') {
      if (!output.childElementCount) {
        appendLine('Completed without output.', 'empty');
      }
      cleanupWorker();
      announceSize();
      complete();
    }
  });

  worker.addEventListener('error', (event) => {
    appendLine(event.message || 'Execution failed.', 'error');
    cleanupWorker();
    announceSize();
    complete();
  });

  timeoutId = window.setTimeout(() => {
    appendLine('Execution stopped after 5 seconds.', 'error');
    cleanupWorker();
    announceSize();
    complete();
  }, 5000);

  worker.postMessage({ code });
}

function renderHtml(code: string) {
  if (!output) {
    return;
  }

  document.body.classList.add('html-preview');
  const preview = document.createElement('iframe');
  preview.title = 'HTML preview';
  preview.sandbox.add('allow-scripts');
  preview.srcdoc = code;
  preview.addEventListener('load', () => {
    announceSize();
    complete();
  }, { once: true });
  output.append(preview);
  window.setTimeout(() => {
    announceSize();
    complete();
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

function announceSize() {
  window.parent.postMessage({
    type: 'inkwell.codeRunner.resize',
    token: activeToken,
    height: Math.ceil(document.documentElement.scrollHeight),
  }, '*');
}

function complete() {
  window.parent.postMessage({
    type: 'inkwell.codeRunner.complete',
    token: activeToken,
  }, '*');
}

function javascriptWorkerSource() {
  return String.raw`
    const serialize = (value) => {
      if (typeof value === 'string') return value;
      if (typeof value === 'undefined') return 'undefined';
      if (typeof value === 'function') return value.toString();
      if (value instanceof Error) return value.stack || value.message;
      try {
        const json = JSON.stringify(value, (_key, item) =>
          typeof item === 'bigint' ? item.toString() + 'n' : item,
          2,
        );
        return json === undefined ? String(value) : json;
      } catch {
        return String(value);
      }
    };

    for (const level of ['log', 'info', 'warn', 'error']) {
      console[level] = (...values) => self.postMessage({
        type: 'log',
        level,
        values: values.map(serialize),
      });
    }

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
