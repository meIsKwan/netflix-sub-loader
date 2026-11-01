// Netflix Sub Loader - service worker: toolbar button, requests to subtitle sites, settings page.
importScripts("providers.js");

const CONTENT_FILES = [
  "src/subtitle-parser.js",
  "src/aligner.js",
  "src/table-import.js",
  "src/netflix-tracks.js",
  "src/navigation.js",
  "src/providers.js",
  "src/config.js",
  "src/content.js",
];
const NETFLIX = /^https:\/\/www\.netflix\.com\//;

// On Netflix the toolbar button toggles the panel in the page; elsewhere it opens the popup
// (how to use it, settings).
function setPopupFor(tabId, url) {
  chrome.action.setPopup({ tabId, popup: NETFLIX.test(url || "") ? "" : "pages/popup.html" }).catch(() => {});
}
chrome.tabs.onUpdated.addListener((tabId, info, tab) => {
  if (info.status === "loading" || info.url !== undefined) setPopupFor(tabId, tab.url);
});
async function markNetflixTabs() {
  for (const tab of await chrome.tabs.query({ url: "https://www.netflix.com/*" })) setPopupFor(tab.id, tab.url);
}
chrome.runtime.onInstalled.addListener(markNetflixTabs);
chrome.runtime.onStartup.addListener(markNetflixTabs);

async function togglePanel(tabId) {
  const toggle = () => chrome.tabs.sendMessage(tabId, { type: "nsl-toggle-panel" });
  try {
    await toggle();
  } catch (_e) {
    // The tab was opened before the extension was installed or updated: inject it now.
    // (Netflix's subtitle list then only shows up from the next title that loads.)
    const target = { tabId };
    await chrome.scripting.executeScript({ target, files: ["src/netflix-hook.js"], world: "MAIN" });
    await chrome.scripting.executeScript({ target, files: CONTENT_FILES });
    await toggle();
  }
}
chrome.action.onClicked.addListener((tab) => {
  if (tab.id && NETFLIX.test(tab.url || "")) togglePanel(tab.id).catch(() => {});
});

async function providerKeys() {
  const { providerKeys } = await chrome.storage.local.get("providerKeys");
  return providerKeys || {};
}

const reply = (promise, sendResponse) => {
  promise.then(
    (data) => sendResponse({ ok: true, data }),
    (e) => sendResponse({ ok: false, error: e && e.message ? e.message : String(e) })
  );
  return true; // answer asynchronously
};

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (!msg || typeof msg.type !== "string") return false;
  switch (msg.type) {
    case "nsl-here":
      if (sender.tab) setPopupFor(sender.tab.id, sender.tab.url);
      return false;
    case "nsl-open-options":
      return reply(chrome.runtime.openOptionsPage(), sendResponse);
    case "nsl-toggle-tab":
      return reply(togglePanel(msg.tabId), sendResponse);
    case "nsl-search":
    case "nsl-download":
      return reply(NSLProviders.handle(msg, { fetch: (url, opts) => fetch(url, opts), keys: providerKeys }), sendResponse);
    default:
      return false;
  }
});
