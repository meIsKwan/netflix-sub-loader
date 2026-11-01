// Run from chrome-extension/: node --test
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const N = require("../src/netflix-tracks.js");
const P = require("../src/subtitle-parser.js");

const TAG = "netflix-sub-loader";
const plain = (x) => JSON.parse(JSON.stringify(x)); // drop the vm realm's prototypes

// Runs netflix-hook.js the way Chrome runs it in the page, with a fake window.
function loadHook() {
  const posted = [];
  const listeners = [];
  const window = {
    postMessage: (data, origin) => posted.push({ data: plain(data), origin }),
    addEventListener: (_type, fn) => listeners.push(fn),
  };
  const context = vm.createContext({ window, location: { origin: "https://www.netflix.com" } });
  vm.runInContext(fs.readFileSync(path.join(__dirname, "../src/netflix-hook.js"), "utf8"), context);
  const say = (data) => listeners.forEach((fn) => fn({ source: window, data }));
  return { json: vm.runInContext("JSON", context), posted, say, window };
}

const MANIFEST = {
  version: 2,
  result: {
    movieId: 81234567,
    timedtexttracks: [
      { isNoneTrack: true, language: "none", ttDownloadables: {} },
      {
        language: "ja", languageDescription: "Japanese", trackType: "PRIMARY", new_track_id: "T:ja",
        ttDownloadables: { "nflx-cmisc": { downloadUrls: { 1: "https://cdn.example/ja.zip" } } },
      },
      {
        language: "en", languageDescription: "English (CC)", trackType: "ASSISTIVE", new_track_id: "T:en-cc",
        ttDownloadables: { "webvtt-lssdh-ios8": { urls: [{ cdn_id: 1, url: "https://cdn.example/en-cc.vtt" }] } },
      },
      {
        language: "en", languageDescription: "English", trackType: "PRIMARY", new_track_id: "T:en",
        ttDownloadables: {
          "dfxp-ls-sdh": { downloadUrls: { 1: "https://cdn.example/en.dfxp", 2: "https://cdn2.example/en.dfxp" } },
          "imsc1.1": { downloadUrls: { 1: "https://cdn.example/en.imsc" } },
        },
      },
      {
        language: "vi", languageDescription: "Vietnamese", trackType: "PRIMARY", new_track_id: "T:vi", isForcedNarrative: true,
        ttDownloadables: { "dfxp-ls-sdh": { downloadUrls: { 1: "https://cdn.example/vi.dfxp" } } },
      },
      {
        language: "fr", languageDescription: "Français", trackType: "PRIMARY",
        ttDownloadables: { "dfxp-ls-sdh": { downloadUrls: { 1: "javascript:alert(1)" } } },
      },
    ],
  },
};

test("hook: reads the subtitle list from the manifest without changing what JSON.parse returns", () => {
  const { json, posted } = loadHook();
  const text = JSON.stringify(MANIFEST);
  assert.deepEqual(plain(json.parse(text)), MANIFEST);
  assert.equal(posted.length, 1);
  const { data, origin } = posted[0];
  assert.equal(origin, "https://www.netflix.com");
  assert.equal(data[TAG], "tracks");
  assert.equal(data.movieId, "81234567");
  assert.deepEqual(data.tracks.map((t) => [t.id, t.language, t.kind, t.forced, Object.keys(t.formats)]), [
    ["T:ja", "ja", "PRIMARY", false, ["nflx-cmisc"]],
    ["T:en-cc", "en", "ASSISTIVE", false, ["webvtt-lssdh-ios8"]],
    ["T:en", "en", "PRIMARY", false, ["dfxp-ls-sdh", "imsc1.1"]],
    ["T:vi", "vi", "PRIMARY", true, ["dfxp-ls-sdh"]],
  ]);
  assert.deepEqual(data.tracks[2].formats["dfxp-ls-sdh"], ["https://cdn.example/en.dfxp", "https://cdn2.example/en.dfxp"]);
});

test("hook: other JSON is untouched, revivers still run, syntax errors still throw", () => {
  const { json, posted } = loadHook();
  assert.deepEqual(plain(json.parse('{"a":[1,2,{"b":null}]}')), { a: [1, 2, { b: null }] });
  assert.equal(json.parse("[1,2]", (k, v) => (typeof v === "number" ? v * 10 : v))[1], 20);
  assert.equal(json.parse('"text"'), "text");
  assert.throws(() => json.parse("{oops"), { name: "SyntaxError" });
  assert.equal(posted.length, 0);
});

test("hook: sends the list again when the content script says hello later", () => {
  const { json, posted, say } = loadHook();
  json.parse(JSON.stringify(MANIFEST));
  posted.length = 0;
  say({ [TAG]: "hello" });
  assert.deepEqual(posted.map((p) => p.data[TAG]), ["ready", "tracks"]);
});

test("hook: seeks through Netflix's player API, reports failure without it", () => {
  const { posted, say, window } = loadHook();
  const seeks = [];
  window.netflix = { appContext: { state: { playerApp: { getAPI: () => ({ videoPlayer: {
    getAllPlayerSessionIds: () => ["motion-billboard-1", "watch-abc"],
    getVideoPlayerBySessionId: (id) => ({ seek: (ms) => seeks.push([id, ms]) }),
  } }) } } } };
  say({ [TAG]: "seek", ms: 12345.6, id: 7 });
  assert.deepEqual(seeks, [["watch-abc", 12346]]);
  assert.deepEqual(posted.at(-1).data, { [TAG]: "seeked", id: 7, ok: true });
  delete window.netflix;
  say({ [TAG]: "seek", ms: 1000, id: 8 });
  assert.deepEqual(posted.at(-1).data, { [TAG]: "seeked", id: 8, ok: false });
});

test("track choice: skips image-based and forced tracks, plain English before CC", () => {
  const { json, posted } = loadHook();
  json.parse(JSON.stringify(MANIFEST));
  const tracks = N.usableTracks(posted[0].data.tracks);
  assert.deepEqual(tracks.map((t) => t.id), ["T:en", "T:en-cc"]);
  assert.deepEqual(N.textProfiles(tracks[0]), ["dfxp-ls-sdh", "imsc1.1"]);
  assert.equal(N.trackLabel(tracks[1]), "English (CC)");
  assert.equal(N.trackLabel({ label: "English", kind: "ASSISTIVE" }), "English (CC)");
  assert.deepEqual(N.usableTracks("not an array"), []);
  assert.deepEqual(N.usableTracks([{ formats: { "dfxp-ls-sdh": ["file:///etc/passwd"] } }]), []);
});

const DFXP = `<?xml version="1.0" encoding="UTF-8"?>
<tt xmlns="http://www.w3.org/ns/ttml" xmlns:ttp="http://www.w3.org/ns/ttml#parameter" ttp:tickRate="10000000">
<body><div>
<p begin="12000000t" end="30000000t">Hello there.</p>
<p begin="35000000t" end="52500000t">General Kenobi!</p>
</div></body></tt>`;

function fakeFetch(routes, calls) {
  return async (url) => {
    calls.push(url);
    const body = routes[url];
    if (body === undefined) return { ok: false, status: 404 };
    return { ok: true, status: 200, arrayBuffer: async () => new TextEncoder().encode(body).buffer };
  };
}

test("track download: tries each link/profile until one parses", async () => {
  const track = N.usableTracks([
    { id: "T:en", language: "en", label: "English", kind: "PRIMARY",
      formats: { "imsc1.1": ["https://cdn.example/en.imsc"], "dfxp-ls-sdh": ["https://cdn.example/en.dfxp", "https://cdn2.example/en.dfxp"] } },
  ])[0];
  const calls = [];
  const got = await N.download(track, {
    fetch: fakeFetch({ "https://cdn2.example/en.dfxp": DFXP, "https://cdn.example/en.imsc": "<html>not subtitles</html>" }, calls),
    decode: P.decodeBuffer,
    parse: P.parse,
  });
  assert.deepEqual(calls, ["https://cdn.example/en.dfxp", "https://cdn2.example/en.dfxp"]);
  assert.equal(got.profile, "dfxp-ls-sdh");
  assert.deepEqual(got.cues.map((c) => [c.start, c.end, c.text]), [
    [1200, 3000, "Hello there."],
    [3500, 5250, "General Kenobi!"],
  ]);

  await assert.rejects(
    N.download(track, { fetch: fakeFetch({}, []), decode: P.decodeBuffer, parse: P.parse }),
    /Could not download the "English" subtitles from Netflix \(HTTP 404\)/
  );
});
