// Netflix Sub Loader - settings page: API keys of the subtitle sites, shortcuts, saved data, support.
const $ = (id) => document.getElementById(id);
const NOTES = {
  subsource: "largest collection (formerly Subscene)",
  subdl: "large collection, fast downloads",
  opensubtitles: "daily download limit",
};
const inputs = {};

for (const [id, site] of Object.entries(NSLProviders.SITES)) {
  const label = document.createElement("label");
  label.htmlFor = "key-" + id;
  label.textContent = site.name;
  const note = document.createElement("small");
  note.textContent = NOTES[id];
  label.append(note);
  const input = document.createElement("input");
  Object.assign(input, { id: "key-" + id, type: "password", autocomplete: "off", spellcheck: false, placeholder: "Paste API key" });
  const show = document.createElement("button");
  show.type = "button";
  show.textContent = "Show";
  show.onclick = () => {
    input.type = input.type === "password" ? "text" : "password";
    show.textContent = input.type === "password" ? "Show" : "Hide";
  };
  const link = document.createElement("a");
  Object.assign(link, { href: site.keyUrl, target: "_blank", rel: "noopener", textContent: "Get a key ↗" });
  const row = document.createElement("div");
  row.className = "site";
  row.append(label, input, show, link);
  $("sites").append(row);
  inputs[id] = input;
}

chrome.storage.local.get("providerKeys").then(({ providerKeys = {} }) => {
  for (const [id, input] of Object.entries(inputs)) input.value = providerKeys[id] || "";
});

let savedTimer = 0;
$("save").onclick = async () => {
  const providerKeys = {};
  for (const [id, input] of Object.entries(inputs)) providerKeys[id] = input.value.trim();
  await chrome.storage.local.set({ providerKeys });
  $("saved").textContent = "Saved ✓";
  clearTimeout(savedTimer);
  savedTimer = setTimeout(() => ($("saved").textContent = ""), 2500);
};

$("shortcuts").onclick = () => chrome.tabs.create({ url: "chrome://extensions/shortcuts" });

$("clear").onclick = async () => {
  if (!confirm("Delete all saved subtitles and sync results?")) return;
  const all = await chrome.storage.local.get(null);
  const keys = Object.keys(all).filter((k) => k.startsWith("title:") || k === "titles");
  await chrome.storage.local.remove(keys);
  const n = keys.filter((k) => k !== "titles").length;
  $("cleared").textContent = `Deleted ${n} episode${n === 1 ? "" : "s"}.`;
};

const donateUrl = (globalThis.NSLConfig || {}).donateUrl || "";
if (/^https:\/\//.test(donateUrl)) {
  $("donate").href = donateUrl;
  $("support").hidden = false;
}
