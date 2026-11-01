// Run from chrome-extension/: node --test
const test = require("node:test");
const assert = require("node:assert/strict");
const S = require("../src/providers.js");

// A fake fetch: routes are [predicate(url, opts), response] pairs; every call is recorded.
function fakeFetch(routes) {
  const calls = [];
  const fn = async (url, opts = {}) => {
    calls.push({ url: String(url), opts });
    for (const [match, res] of routes) {
      if (match(String(url), opts)) {
        const r = typeof res === "function" ? res(String(url), opts) : res;
        const body = r.body;
        return {
          ok: (r.status || 200) < 400,
          status: r.status || 200,
          text: async () => (typeof body === "string" ? body : JSON.stringify(body)),
          arrayBuffer: async () => (body instanceof Uint8Array ? body : new TextEncoder().encode(String(body))).buffer,
        };
      }
    }
    return { ok: false, status: 404, text: async () => "", arrayBuffer: async () => new ArrayBuffer(0) };
  };
  fn.calls = calls;
  return fn;
}
const params = (url) => Object.fromEntries(new URL(url).searchParams);
const Q = { title: "Hell Mode", season: 1, episode: 2, lang: "vi" };

test("SubSource: finds the title, then lists Vietnamese subtitles for the episode", async () => {
  const fetch = fakeFetch([
    [(u) => u.includes("/movies/search"), { body: { data: [
      { movieId: 12, title: "Hell Mode Gaiden", releaseYear: 2025 },
      { movieId: 77, title: "Hell Mode", alternateTitle: "Yarikomi Suki no Gamer", releaseYear: 2025 },
    ] } }],
    [(u) => u.includes("/subtitles?"), { body: { success: true, data: [
      { subtitleId: 9001, language: "vietnamese", releaseInfo: ["Hell.Mode.S01E02.1080p.NF.WEB-DL"], hearingImpaired: false },
      { subtitleId: 9002, language: "vietnamese", releaseInfo: "Hell Mode - 02 [SubsPlease]", hearingImpaired: true },
    ] } }],
  ]);
  const { results, errors } = await S.search(Q, { subsource: "KEY-SS" }, fetch);
  assert.deepEqual(errors, []);
  assert.equal(fetch.calls.length, 2);
  assert.equal(fetch.calls[0].opts.headers["X-API-Key"], "KEY-SS");
  assert.deepEqual(params(fetch.calls[0].url), { searchType: "text", q: "hell mode", season: "1" });
  assert.deepEqual(params(fetch.calls[1].url), { movieId: "77", language: "vietnamese", limit: "100", seasonNumber: "1", episodeNumber: "2" });
  assert.deepEqual(results.map((r) => [r.site, r.id, r.release, r.hi]), [
    ["subsource", "9001", "Hell.Mode.S01E02.1080p.NF.WEB-DL", false],
    ["subsource", "9002", "Hell Mode - 02 [SubsPlease]", true],
  ]);
  const dl = fakeFetch([[(u) => u.endsWith("/subtitles/9001/download"), { body: new Uint8Array([0x50, 0x4b, 3, 4]) }]]);
  const got = await S.download(results[0], { subsource: "KEY-SS" }, dl);
  assert.deepEqual([...got.bytes], [0x50, 0x4b, 3, 4]);
  assert.equal(dl.calls[0].opts.headers["X-API-Key"], "KEY-SS");
});

test("SubDL: right parameters, 'not found' is empty, a bad key is an error", async () => {
  const fetch = fakeFetch([[() => true, { body: { status: true, subtitles: [
    { release_name: "Hell.Mode.S01E02.WEB", url: "/subtitle/3197651-3213944.zip", lang: "vietnamese", season: 1, episode: 2 },
    { releases: ["Hell.Mode.S01.Complete"], url: "/subtitle/1-2.zip", language: "VI", season: 1, full_season: true },
  ] } }]]);
  const { results } = await S.search(Q, { subdl: "KEY-DL" }, fetch);
  assert.deepEqual(params(fetch.calls[0].url), {
    api_key: "KEY-DL", film_name: "Hell Mode", languages: "VI", subs_per_page: "30", releases: "1",
    type: "tv", season_number: "1", episode_number: "2",
  });
  assert.deepEqual(results.map((r) => [r.id, r.release, r.fullSeason]), [
    ["/subtitle/3197651-3213944.zip", "Hell.Mode.S01E02.WEB", false],
    ["/subtitle/1-2.zip", "Hell.Mode.S01.Complete", true],
  ]);

  const none = fakeFetch([[() => true, { status: 404, body: { status: false, error: "can't find movie or tv" } }]]);
  assert.deepEqual((await S.search(Q, { subdl: "K" }, none)).results, []);
  const badKey = fakeFetch([[() => true, { status: 403, body: { status: false, error: "Invalid API key" } }]]);
  const r = await S.search(Q, { subdl: "K" }, badKey);
  assert.equal(r.errors.length, 1);
  assert.match(r.errors[0].message, /SubDL: the API key is wrong/);

  const dl = fakeFetch([[(u) => u === "https://dl.subdl.com/subtitle/3197651-3213944.zip", { body: "zip" }]]);
  await S.download(results[0], { subdl: "KEY-DL" }, dl);
  assert.equal(dl.calls.length, 1);
});

test("OpenSubtitles: sorted query, Api-Key header, download via POST /download", async () => {
  const fetch = fakeFetch([[() => true, { body: { data: [
    { attributes: { language: "vi", release: "Hell Mode S01E02", download_count: 50, hearing_impaired: false,
      files: [{ file_id: 555, file_name: "hm02.srt" }], feature_details: { season_number: 1, episode_number: 2, parent_title: "Hell Mode" } } },
    { attributes: { language: "vi", release: "no files", files: [] } },
  ] } }]]);
  const { results } = await S.search(Q, { opensubtitles: "KEY-OS" }, fetch);
  const url = new URL(fetch.calls[0].url);
  assert.deepEqual([...url.searchParams.keys()], [...url.searchParams.keys()].sort());
  assert.equal(url.searchParams.get("query"), "hell mode");
  assert.equal(url.searchParams.get("languages"), "vi");
  assert.equal(fetch.calls[0].opts.headers["Api-Key"], "KEY-OS");
  assert.equal(fetch.calls[0].opts.headers["X-User-Agent"], S.APP);
  assert.deepEqual(results.map((r) => [r.id, r.downloads, r.episode]), [["555", 50, 2]]);

  const dl = fakeFetch([
    [(u, o) => u.endsWith("/download") && o.method === "POST", { body: { link: "https://www.opensubtitles.com/download/abc/hm02.srt", file_name: "hm02.srt", remaining: 4 } }],
    [(u) => u.startsWith("https://www.opensubtitles.com/download/"), { body: "1\n00:00:01,000 --> 00:00:02,000\nXin chào\n" }],
  ]);
  const got = await S.download(results[0], { opensubtitles: "KEY-OS" }, dl);
  assert.deepEqual(JSON.parse(dl.calls[0].opts.body), { file_id: 555 });
  assert.equal(got.name, "hm02.srt");
  assert.match(new TextDecoder().decode(got.bytes), /Xin chào/);
});

test("several sites: only sites with a key, one failing site does not break the others, right episode first", async () => {
  const fetch = fakeFetch([
    [(u) => u.includes("subsource"), { status: 401, body: { message: "unauthorized" } }],
    [(u) => u.includes("opensubtitles"), { body: { data: [
      { attributes: { release: "E03 wrong", download_count: 900, files: [{ file_id: 1 }], feature_details: { episode_number: 3 } } },
      { attributes: { release: "E02 few", download_count: 5, files: [{ file_id: 2 }], feature_details: { episode_number: 2 } } },
      { attributes: { release: "E02 popular", download_count: 70, files: [{ file_id: 3 }], feature_details: { episode_number: 2 } } },
    ] } }],
  ]);
  const r = await S.search(Q, { subsource: "bad", opensubtitles: "ok", subdl: "" }, fetch);
  assert.deepEqual(r.searched, ["subsource", "opensubtitles"]);
  assert.deepEqual(r.errors.map((e) => e.site), ["subsource"]);
  assert.deepEqual(r.results.map((x) => x.release), ["E02 popular", "E02 few", "E03 wrong"]);
  await assert.rejects(S.search({ title: "  " }, { subdl: "k" }, fetch), /Enter a title/);
});

test("handle(): downloads come back as base64 for extension messaging", async () => {
  const bytes = new Uint8Array(70000).map((_, i) => i % 256);
  const fetch = fakeFetch([[() => true, { body: bytes }]]);
  const out = await S.handle({ type: "nsl-download", item: { site: "subsource", id: "1", release: "x" } }, { fetch, keys: async () => ({ subsource: "k" }) });
  assert.deepEqual(Buffer.from(out.base64, "base64"), Buffer.from(bytes));
});

test("picks the episode's file from an archive", () => {
  const pack = ["Hell.Mode.S01E01.srt", "Hell.Mode.S01E02.srt", "Hell.Mode.S01E03.srt", "__MACOSX/._Hell.Mode.S01E02.srt", "readme.nfo"];
  assert.equal(S.pickEpisodeFile(pack, 2), "Hell.Mode.S01E02.srt");
  assert.equal(S.pickEpisodeFile(["[Subs] Hell Mode - 01 (1080p).ass", "[Subs] Hell Mode - 02 (1080p).ass"], 2), "[Subs] Hell Mode - 02 (1080p).ass");
  assert.equal(S.pickEpisodeFile(["hm_1x01.srt", "hm_1x02.srt"], 2), "hm_1x02.srt");
  assert.equal(S.pickEpisodeFile(["Hell Mode Ep 1.srt", "Hell Mode Ep 2.srt"], 2), "Hell Mode Ep 2.srt");
  assert.equal(S.pickEpisodeFile(["movie.vi.srt"], 5), "movie.vi.srt");
  assert.equal(S.pickEpisodeFile(["a.ass", "b.srt"], null), "b.srt");
  assert.equal(S.pickEpisodeFile(["notes.nfo"], 1), null);
});

test("picks the right title from search results", () => {
  const list = [{ title: "Hell Mode Gaiden" }, { title: "HELL MODE!", year: 2025 }];
  assert.equal(S.pickTitle(list, { title: "hell mode" }, (m) => [m.title], (m) => m.year), list[1]);
  assert.equal(S.pickTitle([{ title: "Totally Different" }, { title: "Other" }], { title: "Hell Mode" }, (m) => [m.title], () => null), null);
});
