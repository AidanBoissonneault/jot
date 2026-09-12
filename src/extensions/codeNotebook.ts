import { mergeAttributes } from '@tiptap/core';
import { CodeBlock } from '@tiptap/extension-code-block';
import {
  browserExecutableLanguage,
  CODE_LANGUAGES,
  codeLanguageLabel,
  normalizeCodeLanguage,
} from '@/src/lib/codeLanguages';

type RunnerMessage = {
  type?: string;
  token?: string;
  height?: number;
};

export const CodeNotebook = CodeBlock.extend({
  addAttributes() {
    return {
      ...this.parent?.(),
      language: {
        default: 'plain text',
        parseHTML: (element: HTMLElement) => normalizeCodeLanguage(
          element.getAttribute('data-language') ||
          element.querySelector('code')?.getAttribute('data-language') ||
          element.querySelector('code')?.className ||
          element.className,
        ),
        renderHTML: (attributes: Record<string, unknown>) => {
          const language = normalizeCodeLanguage(attributes.language);
          return {
            'data-language': language,
            class: `language-${language.replace(/[^a-z0-9]+/g, '-')}`,
          };
        },
      },
    };
  },

  renderHTML({ node, HTMLAttributes }) {
    const language = normalizeCodeLanguage(node.attrs.language);
    return [
      'pre',
      mergeAttributes(this.options.HTMLAttributes, HTMLAttributes, {
        'data-language': language,
      }),
      ['code', { class: `language-${language.replace(/[^a-z0-9]+/g, '-')}` }, 0],
    ];
  },

  addNodeView() {
    return ({ editor, getPos, node }) => {
      let currentNode = node;
      let runnerToken = '';
      const wrapper = document.createElement('figure');
      wrapper.className = 'inkwell-code-cell';

      const toolbar = document.createElement('figcaption');
      toolbar.className = 'inkwell-code-toolbar';
      toolbar.contentEditable = 'false';

      const languageSelect = document.createElement('select');
      languageSelect.className = 'inkwell-code-language';
      languageSelect.setAttribute('aria-label', 'Code language');
      for (const language of CODE_LANGUAGES) {
        const option = document.createElement('option');
        option.value = language;
        option.textContent = codeLanguageLabel(language);
        languageSelect.append(option);
      }

      const actions = document.createElement('span');
      actions.className = 'inkwell-code-actions';
      const runButton = document.createElement('button');
      runButton.type = 'button';
      runButton.className = 'inkwell-code-run';
      runButton.textContent = 'Run';
      runButton.title = 'Run this code in an isolated browser sandbox';
      const clearButton = document.createElement('button');
      clearButton.type = 'button';
      clearButton.className = 'inkwell-code-clear';
      clearButton.textContent = 'Clear output';
      clearButton.title = 'Clear output';
      clearButton.hidden = true;
      actions.append(runButton, clearButton);
      toolbar.append(languageSelect, actions);

      const pre = document.createElement('pre');
      const code = document.createElement('code');
      code.spellcheck = false;
      pre.append(code);

      const output = document.createElement('div');
      output.className = 'inkwell-code-output';
      output.contentEditable = 'false';
      output.hidden = true;

      wrapper.append(toolbar, pre, output);

      function updateChrome() {
        const language = normalizeCodeLanguage(currentNode.attrs.language);
        const executable = browserExecutableLanguage(language);
        languageSelect.value = language;
        runButton.hidden = !executable;
        wrapper.dataset.language = language;
        code.className = `language-${language.replace(/[^a-z0-9]+/g, '-')}`;
      }

      function updateLanguage() {
        const pos = typeof getPos === 'function' ? getPos() : undefined;
        if (typeof pos !== 'number') {
          return;
        }

        const language = normalizeCodeLanguage(languageSelect.value);
        editor.view.dispatch(
          editor.view.state.tr.setNodeMarkup(pos, undefined, {
            ...currentNode.attrs,
            language,
          }),
        );
      }

      function clearOutput() {
        runnerToken = '';
        output.replaceChildren();
        output.hidden = true;
        clearButton.hidden = true;
        runButton.disabled = false;
        runButton.textContent = 'Run';
      }

      function runCode() {
        const language = browserExecutableLanguage(currentNode.attrs.language);
        if (!language) {
          return;
        }

        clearOutput();
        runnerToken = crypto.randomUUID();
        runButton.disabled = true;
        runButton.textContent = 'Running…';
        output.hidden = false;
        clearButton.hidden = false;

        const frame = document.createElement('iframe');
        frame.className = 'inkwell-code-runner';
        frame.title = `${codeLanguageLabel(language)} output`;
        frame.sandbox.add('allow-scripts');
        frame.src = browser.runtime.getURL('/code-runner.html');
        frame.addEventListener('load', () => {
          frame.contentWindow?.postMessage({
            type: 'inkwell.codeRunner.run',
            token: runnerToken,
            language,
            code: currentNode.textContent,
          }, '*');
        }, { once: true });
        output.append(frame);
      }

      function handleRunnerMessage(event: MessageEvent<RunnerMessage>) {
        const frame = output.querySelector('iframe');
        if (
          !frame ||
          event.source !== frame.contentWindow ||
          event.data?.token !== runnerToken
        ) {
          return;
        }

        if (event.data.type === 'inkwell.codeRunner.resize' && event.data.height) {
          frame.style.height = `${Math.min(480, Math.max(72, event.data.height))}px`;
        }

        if (event.data.type === 'inkwell.codeRunner.complete') {
          runButton.disabled = false;
          runButton.textContent = 'Run';
        }
      }

      languageSelect.addEventListener('change', updateLanguage);
      runButton.addEventListener('click', runCode);
      clearButton.addEventListener('click', clearOutput);
      window.addEventListener('message', handleRunnerMessage);
      updateChrome();

      return {
        dom: wrapper,
        contentDOM: code,
        update(nextNode) {
          if (nextNode.type !== currentNode.type) {
            return false;
          }

          currentNode = nextNode;
          updateChrome();
          return true;
        },
        stopEvent(event) {
          return toolbar.contains(event.target as Node) || output.contains(event.target as Node);
        },
        ignoreMutation(mutation) {
          return !code.contains(mutation.target);
        },
        destroy() {
          languageSelect.removeEventListener('change', updateLanguage);
          runButton.removeEventListener('click', runCode);
          clearButton.removeEventListener('click', clearOutput);
          window.removeEventListener('message', handleRunnerMessage);
        },
      };
    };
  },
});
