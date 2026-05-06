export default defineBackground(() => {
  if (browser.sidePanel?.setPanelBehavior) {
    void browser.sidePanel.setPanelBehavior({ openPanelOnActionClick: true });
  }

  browser.runtime.onMessage.addListener((message) => {
    if (message?.type !== 'jot.selectionChanged') {
      return false;
    }

    return false;
  });
});
