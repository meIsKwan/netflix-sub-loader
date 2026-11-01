// Netflix Sub Loader - toolbar popup, shown outside Netflix: how to use it and the subtitle-site keys.
const $ = (id) => document.getElementById(id);

(async () => {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  // Normally the button toggles the panel on Netflix without this popup; just in case it shows up.
  if (tab && /^https:\/\/www\.netflix\.com\//.test(tab.url || "")) {
    $("on-netflix").hidden = false;
    $("toggle").onclick = async () => {
      await chrome.runtime.sendMessage({ type: "nsl-toggle-tab", tabId: tab.id });
      window.close();
    };
  }
  const { providerKeys = {} } = await chrome.storage.local.get("providerKeys");
  for (const [id, site] of Object.entries(NSLProviders.SITES)) {
    const name = document.createElement("span");
    name.textContent = site.name;
    const has = document.createElement("span");
    has.textContent = providerKeys[id] ? "✓ key added" : "no key";
    has.className = providerKeys[id] ? "ok" : "no";
    const row = document.createElement("div");
    row.append(name, has);
    $("sites").append(row);
  }
})();

const donateUrl = (globalThis.NSLConfig || {}).donateUrl || "";
if (/^https:\/\//.test(donateUrl)) {
  $("donate").href = donateUrl;
  $("donate").hidden = false;
}

$("open-netflix").onclick = () => {
  chrome.tabs.create({ url: "https://www.netflix.com/" });
  window.close();
};
$("options").onclick = () => {
  chrome.runtime.openOptionsPage();
  window.close();
};
