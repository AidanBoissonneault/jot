export default defineContentScript({
  matches: ['<all_urls>'],
  main() {
    document.addEventListener('selectionchange', () => {
      const selectedText = window.getSelection()?.toString().trim();

      if (!selectedText) {
        return;
      }

      void browser.runtime.sendMessage({
        type: 'jot.selectionChanged',
        payload: {
          text: selectedText,
          sourceUrl: window.location.href,
          pageTitle: document.title,
        },
      });
    });
  },
});
