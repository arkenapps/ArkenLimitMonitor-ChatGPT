// Fires an OS notification when the content script reports a threshold crossing.
chrome.runtime.onMessage.addListener((msg) => {
  if (msg && msg.type === "notify") {
    chrome.notifications.create({
      type: "basic",
      iconUrl: "icons/icon128.png",
      title: "Arken Limit Monitor \u2014 " + (msg.title || "usage alert"),
      message: msg.message || "",
      priority: 2
    });
  } else if (msg && msg.type === "openPrivacy") {
    chrome.tabs.create({ url: chrome.runtime.getURL("privacy.html") });
  }
});

// Clicking the toolbar icon shows/hides the on-page widget.
chrome.action.onClicked.addListener((tab) => {
  if (tab && tab.id) {
    chrome.tabs.sendMessage(tab.id, { type: "toggle" }).catch(() => {});
  }
});
