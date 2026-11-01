/*
 * Netflix Sub Loader - searching subtitle sites through their official APIs: SubSource (successor of
 * Subscene, the most Vietnamese subtitles), SubDL and OpenSubtitles.com. Each needs a free API
 * key from the site. Network calls run in the service worker; the helpers are also used by the
 * content script and by the tests.
 */
(function (root, factory) {
  const api = factory();
  if (typeof module === "object" && module.exports) module.exports = api;
  else root.NSLProviders = api;
})(typeof globalThis !== "undefined" ? globalThis : this, function () {
  "use strict";

  const APP = "NetflixSubLoader v1.0";

  // Our language codes and what each site calls them.
  const LANGS = {
    vi: { name: "Vietnamese", subsource: "vietnamese", subdl: "VI", opensubtitles: "vi" },
    en: { name: "English", subsource: "english", subdl: "EN", opensubtitles: "en" },
    ja: { name: "Japanese", subsource: "japanese", subdl: "JA", opensubtitles: "ja" },
    ko: { name: "Korean", subsource: "korean", subdl: "KO", opensubtitles: "ko" },
    th: { name: "Thai", subsource: "thai", subdl: "TH", opensubtitles: "th" },
    id: { name: "Indonesian", subsource: "indonesian", subdl: "ID", opensubtitles: "id" },
    es: { name: "Spanish", subsource: "spanish", subdl: "ES", opensubtitles: "es" },
    fr: { name: "French", subsource: "french", subdl: "FR", opensubtitles: "fr" },
  };

  const SITES = {
    subsource: { name: "SubSource", keyUrl: "https://subsource.net/api" },
    subdl: { name: "SubDL", keyUrl: "https://subdl.com/panel/api" },
    opensubtitles: { name: "OpenSubtitles", keyUrl: "https://www.opensubtitles.com/consumers" },
  };

  async function readJson(res) {
    try {
      return JSON.parse(await res.text());
    } catch (_e) {
      return null;
    }
  }

  function siteError(site, res, body) {
    const name = SITES[site].name;
    const detail = body && (body.message || body.error || body.errors);
    if (res.status === 401 || res.status === 403) return new Error(`${name}: the API key is wrong or was refused.`);
    if (res.status === 406 || res.status === 429) return new Error(`${name}: daily limit reached or too many requests — try again later.`);
    return new Error(`${name}: error ${res.status}${detail ? " — " + String(detail).slice(0, 120) : ""}`);
  }

  const norm = (s) =>
    String(s || "")
      .normalize("NFD")
      .replace(/[̀-ͯ]/g, "")
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, " ")
      .trim();

  // Best title match: exact name (or alternate name), then the right year, then the site's order.
  function pickTitle(list, q, names, year) {
    const want = norm(q.title);
    let best = null;
    let bestScore = -1;
    list.forEach((item, i) => {
      const exact = names(item).some((n) => norm(n) === want);
      const close = names(item).some((n) => norm(n).includes(want) || want.includes(norm(n)));
      const yearOk = q.year && year(item) && Math.abs(Number(year(item)) - Number(q.year)) <= 1;
      const score = (exact ? 4 : close ? 2 : 0) + (yearOk ? 1 : 0) - i * 0.001;
      if (score > bestScore) {
        bestScore = score;
        best = item;
      }
    });
    return bestScore >= 2 ? best : list.length === 1 ? list[0] : null;
  }

  const releaseText = (r) => (Array.isArray(r) ? r.filter(Boolean).join(" · ") : String(r || ""));

  const providers = {
    subsource: {
      base: "https://api.subsource.net/api/v1/",
      headers: (key) => ({ "X-API-Key": key, Accept: "application/json" }),
      async search(q, key, fetch) {
        const params = new URLSearchParams({ searchType: "text", q: q.title.toLowerCase() });
        if (q.season) params.set("season", q.season);
        let res = await fetch(this.base + "movies/search?" + params, { headers: this.headers(key) });
        let body = await readJson(res);
        if (!res.ok) throw siteError("subsource", res, body);
        const movie = pickTitle((body && body.data) || [], q, (m) => [m.title, m.alternateTitle], (m) => m.releaseYear);
        if (!movie) return [];
        const subs = new URLSearchParams({ movieId: movie.movieId, language: LANGS[q.lang].subsource, limit: 100 });
        if (q.season) subs.set("seasonNumber", q.season);
        if (q.season && q.episode) subs.set("episodeNumber", q.episode);
        res = await fetch(this.base + "subtitles?" + subs, { headers: this.headers(key) });
        body = await readJson(res);
        if (!res.ok) throw siteError("subsource", res, body);
        return ((body && body.data) || []).map((s) => ({
          site: "subsource",
          id: String(s.subtitleId),
          release: releaseText(s.releaseInfo) || movie.title,
          title: movie.title,
          lang: s.language || LANGS[q.lang].name,
          hi: !!s.hearingImpaired,
          downloads: Number(s.downloads) || 0,
        }));
      },
      async download(item, key, fetch) {
        const res = await fetch(this.base + `subtitles/${encodeURIComponent(item.id)}/download`, { headers: this.headers(key) });
        if (!res.ok) throw siteError("subsource", res, await readJson(res));
        return { name: (item.release || "subtitle").slice(0, 80) + ".zip", bytes: new Uint8Array(await res.arrayBuffer()) };
      },
    },

    subdl: {
      base: "https://api.subdl.com/api/v1/",
      async search(q, key, fetch) {
        const params = new URLSearchParams({
          api_key: key,
          film_name: q.title,
          languages: LANGS[q.lang].subdl,
          subs_per_page: 30,
          releases: 1,
        });
        if (q.season) {
          params.set("type", "tv");
          params.set("season_number", q.season);
          if (q.episode) params.set("episode_number", q.episode);
        } else {
          params.set("type", "movie");
          if (q.year) params.set("year", q.year);
        }
        const res = await fetch(this.base + "subtitles?" + params);
        const body = await readJson(res);
        // "nothing found" comes back as { status: false, error: "..." }
        if (body && body.status === false && !/key|auth|forbidden/i.test(String(body.error))) return [];
        if (!res.ok || !body || body.status === false) throw siteError("subdl", res, body);
        return (body.subtitles || []).map((s) => ({
          site: "subdl",
          id: String(s.url),
          release: s.release_name || releaseText(s.releases) || s.name,
          title: q.title,
          lang: s.language || s.lang || LANGS[q.lang].name,
          hi: !!s.hi,
          season: s.season,
          episode: s.episode,
          fullSeason: !!s.full_season,
        }));
      },
      async download(item, _key, fetch) {
        const res = await fetch("https://dl.subdl.com" + (item.id.startsWith("/") ? "" : "/") + item.id);
        if (!res.ok) throw siteError("subdl", res, null);
        return { name: (item.release || "subtitle").slice(0, 80) + ".zip", bytes: new Uint8Array(await res.arrayBuffer()) };
      },
    },

    opensubtitles: {
      base: "https://api.opensubtitles.com/api/v1/",
      // Browsers cannot set User-Agent, so the app name also goes in X-User-Agent.
      headers: (key) => ({ "Api-Key": key, "X-User-Agent": APP, Accept: "application/json" }),
      async search(q, key, fetch) {
        const params = new URLSearchParams({ query: q.title.toLowerCase(), languages: LANGS[q.lang].opensubtitles });
        if (q.season) {
          params.set("type", "episode");
          params.set("season_number", q.season);
          if (q.episode) params.set("episode_number", q.episode);
        } else {
          params.set("type", "movie");
          if (q.year) params.set("year", q.year);
        }
        params.set("order_by", "download_count");
        params.sort(); // the API redirects unsorted queries
        const res = await fetch(this.base + "subtitles?" + params, { headers: this.headers(key) });
        const body = await readJson(res);
        if (!res.ok) throw siteError("opensubtitles", res, body);
        return ((body && body.data) || [])
          .filter((d) => d && d.attributes && d.attributes.files && d.attributes.files.length)
          .map((d) => {
            const a = d.attributes;
            const f = a.feature_details || {};
            return {
              site: "opensubtitles",
              id: String(a.files[0].file_id),
              release: a.release || a.files[0].file_name || "",
              title: f.parent_title || f.title || f.movie_name || q.title,
              lang: a.language || LANGS[q.lang].name,
              hi: !!a.hearing_impaired,
              downloads: Number(a.download_count) || 0,
              season: f.season_number,
              episode: f.episode_number,
            };
          });
      },
      async download(item, key, fetch) {
        const res = await fetch(this.base + "download", {
          method: "POST",
          headers: Object.assign({ "Content-Type": "application/json" }, this.headers(key)),
          body: JSON.stringify({ file_id: Number(item.id) }),
        });
        const body = await readJson(res);
        if (!res.ok || !body || !body.link) throw siteError("opensubtitles", res, body);
        const file = await fetch(body.link);
        if (!file.ok) throw siteError("opensubtitles", file, null);
        return { name: body.file_name || item.release + ".srt", bytes: new Uint8Array(await file.arrayBuffer()) };
      },
    },
  };

  // Results that name the wanted episode first, then by downloads; keeps each site's order otherwise.
  function rank(items, q) {
    const fits = (it) => {
      if (!q.episode || it.episode === undefined || it.episode === null || it.episode === "") return 1;
      return Number(it.episode) === Number(q.episode) ? 2 : 0;
    };
    return items
      .map((it, i) => ({ it, i }))
      .sort((a, b) => fits(b.it) - fits(a.it) || (b.it.downloads || 0) - (a.it.downloads || 0) || a.i - b.i)
      .map((x) => x.it);
  }

  /**
   * Searches every site that has a key. q: { title, season, episode, year, lang }.
   * Returns { results, errors: [{ site, message }], searched: [site] }.
   */
  async function search(q, keys, fetch) {
    if (!q || !String(q.title || "").trim()) throw new Error("Enter a title to search.");
    q = Object.assign({}, q, { title: String(q.title).trim(), lang: LANGS[q.lang] ? q.lang : "vi" });
    const sites = Object.keys(providers).filter((s) => keys && keys[s]);
    const settled = await Promise.allSettled(sites.map((s) => providers[s].search(q, keys[s], fetch)));
    const results = [];
    const errors = [];
    settled.forEach((r, i) => {
      if (r.status === "fulfilled") results.push(...r.value);
      else errors.push({ site: sites[i], message: r.reason && r.reason.message ? r.reason.message : String(r.reason) });
    });
    return { results: rank(results, q).slice(0, 60), errors, searched: sites };
  }

  async function download(item, keys, fetch) {
    const p = providers[item && item.site];
    if (!p) throw new Error("Unknown subtitle site.");
    return p.download(item, keys[item.site], fetch);
  }

  // From the files of a downloaded archive, the one for `episode` (or the only/best subtitle).
  const SUB_FILE = /\.(srt|ass|ssa|vtt|sub|txt)$/i;
  function pickEpisodeFile(names, episode) {
    const subs = names.filter((n) => SUB_FILE.test(n) && !/(^|\/)__MACOSX\//.test(n));
    if (subs.length <= 1) return subs[0] || null;
    const epOf = (n) => {
      const base = n.split("/").pop();
      const m =
        /(?:^|[^a-z0-9])(?:s\d{1,2}[ ._-]?)?e(?:p(?:isode)?)?[ ._-]?0*(\d{1,3})(?!\d)/i.exec(base) ||
        /(?:^|[^0-9])\d{1,2}x0*(\d{1,3})(?!\d)/i.exec(base) ||
        /(?:^|[ ._\-[(])0*(\d{1,3})(?:v\d)?(?=[ ._\-\])]|\.\w+$)/.exec(base);
      return m ? Number(m[1]) : null;
    };
    if (episode) {
      const hit = subs.find((n) => epOf(n) === Number(episode));
      if (hit) return hit;
    }
    return subs.find((n) => /\.srt$/i.test(n)) || subs[0];
  }

  /**
   * One message handler for the service worker (and the test page): "nsl-search" and
   * "nsl-download". deps: { fetch, keys: async () => keys }. Downloads come back as base64.
   */
  async function handle(msg, deps) {
    const keys = (await deps.keys()) || {};
    if (msg.type === "nsl-search") return search(msg.query, keys, deps.fetch);
    if (msg.type === "nsl-download") {
      const got = await download(msg.item, keys, deps.fetch);
      let bin = "";
      for (let i = 0; i < got.bytes.length; i += 0x8000) bin += String.fromCharCode.apply(null, got.bytes.subarray(i, i + 0x8000));
      return { name: got.name, base64: btoa(bin) };
    }
    throw new Error("Invalid request.");
  }

  return { APP, LANGS, SITES, search, download, handle, rank, pickTitle, pickEpisodeFile };
});
