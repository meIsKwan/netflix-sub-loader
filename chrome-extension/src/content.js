/*
 * Netflix Sub Loader - content script for netflix.com: subtitle overlay, control panel, hotkeys and
 * subtitle search. Runs at document_start so its key listener comes before Netflix's player.
 */
(() => {
  "use strict";

  const P = globalThis.NSLParser;
  const A = globalThis.NSLAligner;
  const T = globalThis.NSLTable;
  const N = globalThis.NSLNetflix;
  const NAV = globalThis.NSLNavigation;
  const S = globalThis.NSLProviders;
  const CONFIG = globalThis.NSLConfig || {};
  const DONATE_URL = /^https:\/\//.test(CONFIG.donateUrl || "") ? CONFIG.donateUrl : "";
  const ext = globalThis.chrome && chrome.runtime && chrome.runtime.id ? chrome : null;

  // A copy left over from before the extension was updated steps aside for this one.
  const TAKEOVER = "sub-loader:takeover";
  document.dispatchEvent(new CustomEvent(TAKEOVER));
  const cleanups = [];
  let stopped = false;
  document.addEventListener(
    TAKEOVER,
    () => {
      stopped = true;
      for (const fn of cleanups.splice(0)) {
        try {
          fn();
        } catch (_e) {
          // extension context already gone
        }
      }
    },
    { once: true }
  );
  function listen(target, type, fn, opts) {
    target.addEventListener(type, fn, opts);
    cleanups.push(() => target.removeEventListener(type, fn, opts));
  }
  function every(fn, ms) {
    const id = setInterval(fn, ms);
    cleanups.push(() => clearInterval(id));
  }

  const ACCEPT = ".srt,.vtt,.webvtt,.ass,.ssa,.xml,.dfxp,.ttml,.txt,.xlsx,.xlsm,.csv,.tsv";
  const MAX_TITLES = 40;
  const TABS = [
    ["sub", "Subtitles"],
    ["sync", "Sync"],
    ["look", "Display"],
  ];
  const DEFAULT_SETTINGS = {
    enabled: true,
    fontScale: 1,
    bottom: 8,
    background: 0,
    color: "#ffffff",
    font: "netflix",
    searchLang: browserLanguage(),
    tab: "sub",
  };
  // "netflix" borrows Netflix Sans, which netflix.com already loads (it covers Vietnamese), with
  // the bold weight and soft shadow of Netflix's own subtitles.
  const FONTS = [
    ["netflix", "Netflix style"],
    ["outline", "Black outline (easier to read)"],
  ];
  const COLORS = [
    ["#ffffff", "White"],
    ["#ffe14d", "Yellow"],
    ["#9ff0ff", "Light blue"],
  ];

  // Subtitle search language: the browser's language when a site offers it, else English.
  function browserLanguage() {
    const code = String(navigator.language || "en").slice(0, 2).toLowerCase();
    return S.LANGS[code] ? code : "en";
  }

  const state = {
    movieId: null,
    sub: null, // { name, text, cues, format }
    ref: null, // the original, correctly timed subtitle
    alignment: A.IDENTITY,
    result: null, // stats of the last automatic alignment
    userOffset: 0, // manual fine-tuning on top of the alignment (ms)
    display: [], // cues as rendered
    settings: Object.assign({}, DEFAULT_SETTINGS),
    panelOpen: false,
    busy: false,
  };

  // Netflix's own subtitle tracks, reported by netflix-hook.js from inside the page.
  const HOOK = "netflix-sub-loader";
  const nf = {
    hook: false, // the page-side hook answered
    tracks: new Map(), // movieId -> usable tracks, best reference first
    seen: new Set(), // movieIds whose track list arrived (even if nothing was usable)
    loading: false,
    error: null,
    declined: null, // movieId whose Netflix reference the user removed
  };

  // Subtitle search on SubSource / SubDL / OpenSubtitles (requests go through the service worker).
  const search = {
    movieId: null, // `info` belongs to this title
    info: null, // { title, season, episode, year } from Netflix
    keys: {}, // API keys from the settings page (only whether they are set matters here)
    loading: false,
    results: null, // null: not searched yet
    errors: [],
    query: null, // the query behind `results`
    using: null, // "site:id" being downloaded
  };

  // ---------- storage ----------

  const local = ext && ext.storage && ext.storage.local;
  const store = {
    async get(key) {
      try {
        return local ? (await local.get(key))[key] : undefined;
      } catch (e) {
        console.warn("[Netflix Sub Loader] storage:", e);
        return undefined;
      }
    },
    async set(items) {
      try {
        if (local) await local.set(items);
      } catch (e) {
        console.warn("[Netflix Sub Loader] storage:", e);
      }
    },
    async remove(key) {
      try {
        if (local) await local.remove(key);
      } catch (_e) {
        /* ignore */
      }
    },
  };

  const titleKey = (id) => "title:" + id;
  let saveTimer = 0;
  function scheduleSave() {
    clearTimeout(saveTimer);
    saveTimer = setTimeout(flushSave, 400);
  }

  // Snapshots the current title synchronously, so it is safe to call right before switching titles.
  function flushSave() {
    if (!saveTimer) return;
    clearTimeout(saveTimer);
    saveTimer = 0;
    const id = state.movieId;
    if (!id) return;
    const track = (t) => t && { name: t.name, text: t.text, resolution: t.resolution || 0, trackId: t.trackId || null };
    const data = state.sub && {
      sub: track(state.sub),
      ref: track(state.ref),
      alignment: state.alignment,
      result: state.result,
      userOffset: state.userOffset,
      savedAt: Date.now(),
    };
    persistTitle(id, data);
  }

  async function persistTitle(id, data) {
    const index = ((await store.get("titles")) || []).filter((x) => x !== id);
    if (!data) {
      await store.remove(titleKey(id));
      await store.set({ titles: index });
      return;
    }
    await store.set({ [titleKey(id)]: data });
    index.push(id);
    const evicted = index.length > MAX_TITLES ? index.splice(0, index.length - MAX_TITLES) : [];
    await store.set({ titles: index });
    for (const old of evicted) await store.remove(titleKey(old));
  }

  async function restoreTitle(id) {
    const saved = await store.get(titleKey(id));
    if (id !== state.movieId || !saved || !saved.sub || state.sub) return;
    try {
      state.sub = makeTrack(saved.sub.name, saved.sub.text);
      state.ref = saved.ref ? makeTrack(saved.ref.name, saved.ref.text, saved.ref.resolution) : null;
      if (state.ref && saved.ref.trackId) state.ref.trackId = saved.ref.trackId;
    } catch (_e) {
      return;
    }
    state.alignment = saved.alignment || A.IDENTITY;
    state.result = saved.result || null;
    state.userOffset = saved.userOffset || 0;
    rebuild();
    toast("Restored subtitles: " + state.sub.name);
    autoReference();
  }

  let settingsTimer = 0;
  function saveSettings() {
    clearTimeout(settingsTimer);
    settingsTimer = setTimeout(() => store.set({ settings: state.settings }), 300);
  }

  // ---------- subtitle state ----------

  // `resolution` > 0 marks times rounded to that many ms (a Language Reactor export).
  function makeTrack(name, text, resolution) {
    const { cues, format } = P.parse(text);
    if (!cues.length) throw new Error(`No subtitle lines could be read from "${name}".`);
    return { name, text, cues, format, resolution: resolution || 0 };
  }

  // Subtitle files, or Excel/CSV sheets with a time column (stored as SRT text once converted).
  async function readFile(file, role) {
    if (file.size > 20 * 1024 * 1024) throw new Error("This file is too large to be a subtitle file.");
    if (/\.xls$/i.test(file.name)) {
      throw new Error("Old .xls files are not supported — open the file in Excel and save it as .xlsx or .csv.");
    }
    const buf = await file.arrayBuffer();
    if (T.isZip(buf) || /\.(csv|tsv)$/i.test(file.name)) {
      const table = await T.cuesFromFile(file.name, buf, role, P.decodeBuffer);
      if (!table.cues.length) {
        throw new Error(`No time column found in "${file.name}" (it needs a start-time column such as 1:37 or 00:01:37,250).`);
      }
      const track = makeTrack(file.name, P.toSrt(table.cues), table.resolution);
      const c = table.columns;
      track.note = `time column "${c.time}"${c.end ? `, "${c.end}"` : ""} · text column "${c.text || "—"}"`;
      return track;
    }
    return makeTrack(file.name, P.decodeBuffer(buf));
  }

  function rebuild() {
    state.display = state.sub ? A.applyAlignment(state.sub.cues, state.alignment, state.userOffset) : [];
    shown = null;
    renderPanel();
  }

  function resetAlignment() {
    state.alignment = A.IDENTITY;
    state.result = null;
    state.userOffset = 0;
  }

  // A new subtitle to display: align it right away when there is a reference.
  function setSub(track) {
    state.sub = track;
    resetAlignment();
    rebuild();
    scheduleSave();
    if (state.ref) runAlign(true);
    else autoReference();
  }

  function removeSub() {
    state.sub = null;
    resetAlignment();
    rebuild();
    scheduleSave();
  }

  async function loadSub(file) {
    try {
      const track = await readFile(file, "sub");
      setSub(track);
      toast(`Loaded ${track.cues.length} subtitle lines` + (track.note ? ` (${track.note})` : ""));
    } catch (e) {
      toast(e.message, true);
    }
  }

  async function loadRef(file) {
    try {
      state.ref = await readFile(file, "ref");
      renderPanel();
      scheduleSave();
      if (state.sub) runAlign(true);
      else toast("Reference loaded" + (state.ref.note ? ` (${state.ref.note})` : "") + " — now choose the subtitles to show");
    } catch (e) {
      toast(e.message, true);
    }
  }

  // `auto`: not started by the align button, so a result that does not fit is not applied.
  async function runAlign(auto) {
    if (!state.sub || !state.ref || state.busy) return;
    state.busy = true;
    renderPanel();
    await new Promise((r) => setTimeout(r, 30)); // let the busy state paint
    try {
      const { alignment, stats } = A.align(state.ref.cues, state.sub.cues, { refResolution: state.ref.resolution });
      if (auto && stats.quality === "poor") {
        toast("The reference and the subtitles don't seem to be the same episode/version — keeping the file's own timing.", true);
        return;
      }
      state.alignment = alignment;
      state.result = stats;
      state.userOffset = 0;
      rebuild();
      scheduleSave();
      if (stats.quality === "poor") toast("The two files don't seem to be the same episode/version — please check", true);
      else toast("Synced: offset " + fmtOffset(stats.offset));
    } catch (e) {
      toast(e.message, true);
    } finally {
      state.busy = false;
      renderPanel();
    }
  }

  // With a subtitle loaded and nothing aligned yet, use Netflix's own track as the reference.
  function autoReference() {
    const tracks = state.movieId ? nf.tracks.get(state.movieId) : null;
    if (!tracks || !tracks.length || !state.sub || state.ref || state.result || state.userOffset) return;
    if (nf.loading || nf.declined === state.movieId) return;
    useNetflixTrack(tracks[0], true);
  }

  async function useNetflixTrack(track, auto) {
    const id = state.movieId;
    nf.loading = true;
    nf.error = null;
    renderPanel();
    try {
      const got = await N.download(track, { fetch: (url, opts) => fetch(url, opts), decode: P.decodeBuffer, parse: P.parse });
      if (id !== state.movieId) return;
      state.ref = {
        name: "Netflix · " + N.trackLabel(track),
        text: got.text,
        cues: got.cues,
        format: got.format,
        resolution: 0,
        trackId: track.id,
      };
      nf.declined = null;
      scheduleSave();
      nf.loading = false;
      if (state.sub) await runAlign(auto);
      else toast(`Using Netflix's ${N.trackLabel(track)} subtitles as the reference`);
    } catch (e) {
      if (id !== state.movieId) return;
      nf.error = e.message;
      if (!auto) toast(e.message, true);
    } finally {
      nf.loading = false;
      renderPanel();
    }
  }

  function onHookMessage(e) {
    if (e.source !== window || !e.data || typeof e.data !== "object") return;
    const kind = e.data[HOOK];
    if (kind === "seeked") {
      const done = seeks.get(e.data.id);
      seeks.delete(e.data.id);
      if (done) done(!!e.data.ok);
      return;
    }
    if (kind === "ready") nf.hook = true;
    else if (kind === "tracks" && typeof e.data.movieId === "string") {
      nf.hook = true;
      nf.seen.add(e.data.movieId);
      nf.tracks.set(e.data.movieId, N.usableTracks(e.data.tracks));
      if (e.data.movieId === state.movieId) autoReference();
    } else return;
    renderPanel();
  }
  listen(window, "message", onHookMessage);
  const helloHook = () => window.postMessage({ [HOOK]: "hello" }, location.origin);
  helloHook();

  // Seeking goes through Netflix's own player inside the page (netflix-hook.js).
  const seeks = new Map();
  let seekId = 0;
  function seekTo(ms) {
    return new Promise((resolve) => {
      const id = ++seekId;
      seeks.set(id, resolve);
      window.postMessage({ [HOOK]: "seek", id, ms }, location.origin);
      setTimeout(() => {
        if (seeks.delete(id)) resolve(false);
      }, 1000);
    });
  }

  // Previous / next subtitle line. While playing, jumps land LEAD ms early so the start of the
  // line is not cut. Quick repeated presses step from the line just jumped to: the video may not
  // have moved yet.
  const LEAD = 300;
  let lastJump = null;
  async function jumpLine(dir) {
    const v = getVideo();
    const cues = state.display.length ? state.display : state.ref ? state.ref.cues : [];
    if (!v || !cues.length) return;
    if (!lastJump || lastJump.cues !== cues) lastJump = { cues, starts: NAV.lineStarts(cues), index: -1, at: 0 };
    const starts = lastJump.starts;
    const t = v.currentTime * 1000;
    const recent =
      lastJump.index >= 0 &&
      (performance.now() - lastJump.at < 1000 || Math.abs(t - (starts[lastJump.index] - LEAD)) < 400);
    const target = recent ? lastJump.index + dir : NAV.lineTarget(starts, t, dir, { lead: LEAD });
    if (target < 0 || target >= starts.length) {
      toast(dir < 0 ? "Already at the first line" : "No more lines");
      return;
    }
    lastJump.index = target;
    lastJump.at = performance.now();
    toast(`${dir < 0 ? "◀" : "▶"} Line ${target + 1}/${starts.length}`);
    // Paused: land on the line so it shows right away; playing: a little before, to hear its start.
    const at = v.paused ? starts[target] + 20 : Math.max(0, starts[target] - LEAD);
    if (!(await seekTo(at))) {
      lastJump.index = -1;
      toast("Couldn't seek — Netflix's player was not found. Try reloading the page (F5).", true);
    }
  }

  function setUserOffset(ms) {
    state.userOffset = Math.round(ms);
    rebuild();
    scheduleSave();
  }

  function nudge(delta) {
    if (!state.sub) return;
    setUserOffset(state.userOffset + delta);
    toast("Manual offset: " + fmtOffset(state.userOffset));
  }

  function exportSrt() {
    if (!state.display.length) return;
    const blob = new Blob(["﻿" + P.toSrt(state.display)], { type: "application/x-subrip;charset=utf-8" });
    const a = document.createElement("a");
    a.href = URL.createObjectURL(blob);
    a.download = state.sub.name.replace(/\.[^.]+$/, "") + ".synced.srt";
    a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 10000);
  }

  // ---------- subtitle search ----------

  // A message to the service worker, which talks to the subtitle sites.
  function ask(msg) {
    return new Promise((resolve, reject) => {
      const gone = () => new Error("The extension was just updated — reload the page (F5).");
      if (!ext || !chrome.runtime.id) return reject(gone());
      try {
        ext.runtime.sendMessage(msg, (res) => {
          if (ext.runtime.lastError || !res) reject(gone());
          else if (!res.ok) reject(new Error(res.error));
          else resolve(res.data);
        });
      } catch (_e) {
        reject(gone());
      }
    });
  }

  const openOptions = () => ask({ type: "nsl-open-options" }).catch((e) => toast(e.message, true));

  // Show title, season and episode from Netflix's metadata, or the player's title as a fallback.
  async function titleInfo(id) {
    try {
      const url = `${location.origin}/nq/website/memberapi/release/metadata?movieid=${id}`;
      const res = await fetch(url, { credentials: "include" });
      const video = res.ok ? (await res.json()).video : null;
      if (video && video.title) {
        for (const season of video.seasons || []) {
          for (const ep of season.episodes || []) {
            if (String(ep.episodeId || ep.id) === String(id)) {
              return { title: video.title, season: season.seq, episode: ep.seq };
            }
          }
        }
        return { title: video.title, year: video.year };
      }
    } catch (_e) {
      // fall back to the title shown in the player
    }
    const el = document.querySelector('[data-uia="video-title"]');
    if (!el) return null;
    const name = (el.querySelector("h4") || el).textContent.trim();
    const se = /S(\d+)\s*:\s*E(\d+)/i.exec(el.textContent);
    return name ? { title: name, season: se ? +se[1] : 0, episode: se ? +se[2] : 0 } : null;
  }

  async function prepareSearch() {
    if (!state.movieId || search.movieId === state.movieId) return;
    const id = state.movieId;
    Object.assign(search, { movieId: id, info: null, results: null, errors: [], query: null });
    for (const input of [ui.q, ui.s, ui.e]) {
      input.value = "";
      delete input.dataset.edited;
    }
    renderPanel();
    const info = await titleInfo(id);
    if (id !== state.movieId || !info) return;
    search.info = info;
    if (!ui.q.dataset.edited) ui.q.value = info.title;
    if (!ui.s.dataset.edited) ui.s.value = info.season || "";
    if (!ui.e.dataset.edited) ui.e.value = info.episode || "";
    renderPanel();
  }

  async function runSearch() {
    if (search.loading) return;
    const q = {
      title: ui.q.value.trim(),
      season: parseInt(ui.s.value, 10) || 0,
      episode: parseInt(ui.e.value, 10) || 0,
      year: search.info && search.info.year,
      lang: state.settings.searchLang,
    };
    if (!q.title) {
      toast("Enter a title to search.", true);
      ui.q.focus();
      return;
    }
    Object.assign(search, { loading: true, results: null, errors: [], query: q });
    renderSearch();
    try {
      const data = await ask({ type: "nsl-search", query: q });
      search.results = data.results;
      search.errors = data.errors;
    } catch (e) {
      search.results = [];
      search.errors = [{ site: "", message: e.message }];
    } finally {
      search.loading = false;
      renderPanel();
    }
  }

  // Subtitle archives from the sites: take the file for the wanted episode.
  async function subtitleFile(name, bytes, episode) {
    if (T.isZip(bytes)) {
      const files = await T.unzip(bytes, () => true);
      const pick = S.pickEpisodeFile([...files.keys()], episode);
      if (!pick) throw new Error("The download contains no subtitle file.");
      return { name: pick.split("/").pop(), bytes: files.get(pick) };
    }
    if (bytes[0] === 0x52 && bytes[1] === 0x61 && bytes[2] === 0x72 && bytes[3] === 0x21) {
      throw new Error("This subtitle is packed as .rar, which is not supported — pick another one.");
    }
    if (bytes[0] === 0x37 && bytes[1] === 0x7a && bytes[2] === 0xbc) {
      throw new Error("This subtitle is packed as .7z, which is not supported — pick another one.");
    }
    return { name, bytes };
  }

  async function useResult(item) {
    if (search.using) return;
    const id = state.movieId;
    search.using = item.site + ":" + item.id;
    renderPanel();
    try {
      const got = await ask({ type: "nsl-download", item });
      const bytes = Uint8Array.from(atob(got.base64), (c) => c.charCodeAt(0));
      const file = await subtitleFile(got.name, bytes, search.query && search.query.episode);
      const track = makeTrack(file.name, P.decodeBuffer(file.bytes));
      if (id !== state.movieId) return;
      setSub(track);
      toast(`Loaded "${file.name}" from ${S.SITES[item.site].name}`);
    } catch (e) {
      toast(e.message, true);
    } finally {
      search.using = null;
      renderPanel();
    }
  }

  async function loadKeys() {
    search.keys = (await store.get("providerKeys")) || {};
    renderPanel();
  }

  // ---------- formatting ----------

  function fmtOffset(ms) {
    return (ms < 0 ? "−" : "+") + (Math.abs(ms) / 1000).toFixed(3) + " s";
  }

  function fmtClock(ms) {
    const s = Math.max(0, Math.floor(ms / 1000));
    const mm = String(Math.floor(s / 60) % 60);
    const ss = String(s % 60).padStart(2, "0");
    return s >= 3600 ? `${Math.floor(s / 3600)}:${mm.padStart(2, "0")}:${ss}` : `${mm}:${ss}`;
  }

  const plain = (text) => text.replace(/<[^>]*>/g, "").replace(/\n/g, " / ");

  // ---------- video + rendering ----------

  let video = null;
  function getVideo() {
    if (!video || !video.isConnected) video = document.querySelector("video");
    return video;
  }

  // Cues active at time t (ms) in a list sorted by start.
  function activeAt(list, t) {
    let lo = 0;
    let hi = list.length - 1;
    let idx = -1;
    while (lo <= hi) {
      const mid = (lo + hi) >> 1;
      if (list[mid].start <= t) {
        idx = mid;
        lo = mid + 1;
      } else hi = mid - 1;
    }
    const out = [];
    for (let i = idx; i >= 0 && i > idx - 30; i--) if (list[i].end > t) out.push(list[i]);
    return out.reverse();
  }

  let shown = null;
  function frame() {
    if (stopped) return;
    requestAnimationFrame(frame);
    const v = state.movieId && state.settings.enabled && state.display.length ? getVideo() : null;
    const active = v ? activeAt(state.display, v.currentTime * 1000) : [];
    if (shown && active.length === shown.length && active.every((c, i) => c === shown[i])) return;
    shown = active;
    ui.bottom.replaceChildren(...active.filter((c) => !c.top).map(cueElement));
    ui.top.replaceChildren(...active.filter((c) => c.top).map(cueElement));
  }

  function cueElement(cue) {
    const text = h("span", { class: "cue-text" });
    const style = { i: 0, b: 0, u: 0 };
    for (const part of cue.text.split(/(<\/?[ibu]>)/)) {
      const tag = /^<(\/?)([ibu])>$/.exec(part);
      if (tag) {
        style[tag[2]] = Math.max(0, style[tag[2]] + (tag[1] ? -1 : 1));
        continue;
      }
      if (!part) continue;
      const span = document.createElement("span");
      span.textContent = part;
      if (style.i) span.style.fontStyle = "italic";
      if (style.b) span.style.fontWeight = "800";
      if (style.u) span.style.textDecoration = "underline";
      text.append(span);
    }
    return h("div", { class: "cue" }, text);
  }

  // ---------- UI ----------

  const ui = {};
  let host = null;

  function h(tag, props, ...children) {
    const el = document.createElement(tag);
    for (const [k, v] of Object.entries(props || {})) {
      if (k === "class") el.className = v;
      else if (k.startsWith("on")) el.addEventListener(k.slice(2), v);
      else if (v === true) el.setAttribute(k, "");
      else if (v !== false && v != null) el.setAttribute(k, v);
    }
    for (const c of children.flat()) if (c != null && c !== false) el.append(c);
    return el;
  }

  function svg(viewBox, parts, cls) {
    const ns = "http://www.w3.org/2000/svg";
    const el = document.createElementNS(ns, "svg");
    el.setAttribute("viewBox", viewBox);
    el.setAttribute("aria-hidden", "true");
    if (cls) el.setAttribute("class", cls);
    for (const [tag, attrs] of parts) {
      const p = document.createElementNS(ns, tag);
      for (const [k, v] of Object.entries(attrs)) p.setAttribute(k, v);
      el.append(p);
    }
    return el;
  }

  const logo = () =>
    svg("0 0 24 24", [
      ["rect", { x: 1, y: 1, width: 22, height: 22, rx: 6, fill: "#3164ec" }],
      ["path", { d: "M6 15.5h12M8.5 19h7", stroke: "#fff", "stroke-width": 2.2, "stroke-linecap": "round", fill: "none" }],
      ["path", { d: "M15.1 8.9a3.1 3.1 0 1 1-1.3-2.7", stroke: "#ffd23f", "stroke-width": 1.9, "stroke-linecap": "round", fill: "none" }],
      ["circle", { cx: 14.9, cy: 5.4, r: 1.25, fill: "#ffd23f" }],
    ], "logo");

  const fileIcon = () =>
    svg("0 0 24 24", [
      ["path", { d: "M6 2.8h8l4.2 4.2v14.2H6z", fill: "none", stroke: "currentColor", "stroke-width": 1.6, "stroke-linejoin": "round" }],
      ["path", { d: "M8.8 13h6.4M8.8 16.6h4.4", stroke: "currentColor", "stroke-width": 1.6, "stroke-linecap": "round" }],
    ], "file-icon");

  const CSS = `
    :host { all: initial; }
    .layer { position: fixed; inset: 0; pointer-events: none; color-scheme: dark;
      --ui-font: "Netflix Sans", "Segoe UI", system-ui, Roboto, "Helvetica Neue", Arial, sans-serif;
      --accent: #4b7bff; --accent-hi: #6b93ff; --card: #1e1e25; --field: #111116; --line: rgba(255, 255, 255, .09);
      --text: #ececf1; --muted: #9b9ba8; --good: #35c46a; --warn: #f0b429; --bad: #f05252;
      font-family: var(--ui-font); }

    .subs { position: absolute; left: 5%; right: 5%; display: flex; flex-direction: column;
      align-items: center; gap: .12em; line-height: 1.28; pointer-events: none;
      font-size: calc(var(--sub-scale, 1) * clamp(16px, 3.7vh, 68px)); transition: bottom .25s ease;
      font-family: "Netflix Sans", "Helvetica Neue", Helvetica, Arial, sans-serif; }
    .subs.bottom { bottom: var(--sub-bottom, 8%); }
    .layer.awake .subs.bottom { bottom: max(var(--sub-bottom, 8%), 15%); }
    .subs.top { top: 7%; }
    .cue { max-width: 100%; text-align: center; white-space: pre-line; }
    .cue-text { color: var(--sub-color, #fff); font-weight: 700; padding: .04em .34em; border-radius: .16em;
      background: rgba(0, 0, 0, var(--sub-bg, 0)); -webkit-box-decoration-break: clone; box-decoration-break: clone;
      text-shadow: 0 0 .175em #000; }
    .layer.font-outline .subs { font-family: "Segoe UI", system-ui, Roboto, "Helvetica Neue", Arial, sans-serif; }
    .layer.font-outline .cue-text { font-weight: 600;
      text-shadow: 0 0 .1em #000, 0 0 .14em #000, .05em .05em .12em #000, 0 0 .3em rgba(0,0,0,.6); }

    .fab { position: absolute; top: 18px; right: 96px; width: 44px; height: 44px; border-radius: 50%; padding: 0;
      display: none; align-items: center; justify-content: center; pointer-events: none; opacity: 0;
      background: rgba(16, 16, 20, .8); border: 1px solid rgba(255, 255, 255, .22); cursor: pointer;
      transition: opacity .3s, transform .2s, border-color .2s; }
    .fab .logo { width: 24px; height: 24px; }
    .layer.watching .fab { display: flex; }
    .layer.awake .fab, .layer.open .fab { opacity: 1; pointer-events: auto; }
    .fab:hover { transform: scale(1.06); border-color: rgba(255, 255, 255, .5); }
    .fab.loaded::after { content: ""; position: absolute; top: 2px; right: 2px; width: 10px; height: 10px;
      border-radius: 50%; background: var(--good); box-shadow: 0 0 0 2px rgba(16, 16, 20, .95); }

    .toast { position: absolute; top: 26px; left: 50%; max-width: min(70%, 560px); padding: 9px 16px;
      transform: translate(-50%, -8px); opacity: 0; transition: opacity .25s, transform .25s; text-align: center;
      background: rgba(22, 22, 27, .95); color: #fff; border-radius: 10px; font: 14px/1.4 var(--ui-font);
      box-shadow: 0 8px 26px rgba(0, 0, 0, .45); border: 1px solid var(--line); }
    .toast.show { opacity: 1; transform: translate(-50%, 0); }
    .toast.error { background: rgba(140, 26, 26, .96); }

    .panel { position: absolute; top: 64px; right: 24px; width: 364px; max-height: calc(100% - 110px);
      display: flex; flex-direction: column; overflow: hidden; pointer-events: auto;
      background: rgba(19, 19, 24, .97); color: var(--text); border: 1px solid rgba(255, 255, 255, .1);
      border-radius: 16px; box-shadow: 0 20px 56px rgba(0, 0, 0, .6); font: 13px/1.45 var(--ui-font); }
    .panel[hidden] { display: none; }
    @media (max-width: 440px) { .panel { left: 12px; right: 12px; width: auto; } }

    header { display: flex; align-items: center; gap: 10px; padding: 14px 12px 10px 16px; }
    .brand { display: flex; align-items: center; gap: 10px; flex: 1; min-width: 0; }
    .brand .logo { width: 28px; height: 28px; flex: none; }
    .brand b { display: block; font-size: 15px; font-weight: 700; letter-spacing: .01em; }
    .brand small { display: block; color: var(--muted); font-size: 12px; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
    .status { display: flex; align-items: center; gap: 9px; margin: 0 14px; padding: 8px 11px;
      border-radius: 10px; background: var(--card); font-size: 12.5px; }
    .status .dot { width: 8px; height: 8px; border-radius: 50%; background: #6b6b77; flex: none; }
    .status.good .dot { background: var(--good); box-shadow: 0 0 0 3px rgba(53, 196, 106, .18); }
    .status.warn .dot { background: var(--warn); }
    .status.bad .dot { background: var(--bad); }
    .status.busy .dot { background: var(--accent); animation: pulse 1s ease-in-out infinite; }
    @keyframes pulse { 50% { opacity: .3; } }
    nav.tabs { display: grid; grid-template-columns: repeat(3, 1fr); gap: 4px; margin: 10px 14px 0; padding: 4px;
      background: var(--field); border-radius: 11px; }
    nav.tabs button { border: 0; background: none; color: var(--muted); padding: 7px 0; border-radius: 8px; font-weight: 600; }
    nav.tabs button:hover { color: var(--text); background: none; }
    nav.tabs button.on { background: var(--card); color: var(--text); box-shadow: inset 0 1px 0 rgba(255, 255, 255, .06); }
    .body { overflow-y: auto; padding: 12px 14px 14px; scrollbar-width: thin; }
    .tab[hidden], [hidden] { display: none !important; }
    .card { background: var(--card); border-radius: 12px; padding: 12px; }
    .card + .card, .card + .block, .block + .card, .drop + .block, .card + .keys, .card + .wide,
    .result + .card { margin-top: 12px; }
    h3 { margin: 0 0 8px; font-size: 11px; font-weight: 700; letter-spacing: .07em; text-transform: uppercase; color: var(--muted); }
    .block h3 { margin: 14px 2px 8px; }
    p { margin: 0 0 8px; }
    .hint { color: var(--muted); font-size: 12px; }
    .grow { flex: 1; min-width: 0; }

    button { font: inherit; color: inherit; background: #2a2a32; border: 1px solid rgba(255, 255, 255, .12);
      border-radius: 8px; padding: 7px 12px; cursor: pointer; transition: background .15s, border-color .15s; }
    button:hover:not(:disabled) { background: #34343d; }
    button:focus-visible, input:focus-visible, select:focus-visible { outline: 2px solid var(--accent-hi); outline-offset: 1px; }
    button:disabled { opacity: .45; cursor: default; }
    button.primary { background: var(--accent); border-color: var(--accent); color: #fff; font-weight: 650; }
    button.primary:hover:not(:disabled) { background: var(--accent-hi); }
    button.small { padding: 4px 10px; font-size: 12px; }
    button.icon { padding: 2px 8px; font-size: 18px; line-height: 1.2; background: transparent; border-color: transparent; color: #a3a3ad; }
    button.icon:hover:not(:disabled) { color: #fff; background: #2e2e36; }
    a { color: #86a6ff; }
    button.link { background: none; border: 0; padding: 0; color: #86a6ff; text-decoration: underline; }
    .wide { width: 100%; margin-top: 12px; padding: 9px 12px; }
    input[type=text], select { font: inherit; color: var(--text); background: var(--field); border: 1px solid #3a3a44;
      border-radius: 8px; padding: 7px 9px; min-width: 0; }
    input[type=text]::placeholder { color: #6e6e7a; }
    .row { display: flex; gap: 6px; align-items: center; }
    .row + .row { margin-top: 6px; }
    .row select { flex: 1; }
    .num-in { width: 46px; text-align: center; }

    .drop { display: grid; justify-items: center; gap: 6px; padding: 20px 14px; border: 1.5px dashed rgba(255, 255, 255, .2);
      border-radius: 12px; text-align: center; }
    .drop .file-icon { width: 30px; height: 30px; color: #8a8a96; }
    .drop-title { font-weight: 650; }
    .drop button { margin-top: 4px; }
    .over { outline: 2px dashed var(--accent); outline-offset: -2px; background-color: rgba(75, 123, 255, .08); }
    .subline { display: flex; align-items: center; gap: 10px; }
    .subline .file-icon { width: 26px; height: 26px; flex: none; color: #8fb0ff; }
    .subline .name { font-weight: 650; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
    .subline .meta { color: var(--muted); font-size: 12px; }
    .toggle { display: flex; align-items: center; gap: 9px; margin-top: 10px; padding-top: 10px; border-top: 1px solid var(--line); cursor: pointer; }
    .switch { appearance: none; width: 34px; height: 20px; border-radius: 10px; background: #44444f; position: relative; margin: 0; cursor: pointer; transition: background .2s; flex: none; }
    .switch::after { content: ""; position: absolute; top: 3px; left: 3px; width: 14px; height: 14px; border-radius: 50%; background: #fff; transition: transform .2s; }
    .switch:checked { background: var(--accent); }
    .switch:checked::after { transform: translateX(14px); }

    .setup { padding: 12px; border-radius: 12px; background: linear-gradient(135deg, rgba(75, 123, 255, .16), rgba(75, 123, 255, .05)); border: 1px solid rgba(75, 123, 255, .3); }
    .setup p { color: #cfd6ee; font-size: 12.5px; }
    .search-note { margin-top: 8px; }
    .search-note .err { color: #ff9b9b; }
    .results { list-style: none; margin: 8px 0 0; padding: 0; display: flex; flex-direction: column; gap: 6px; }
    .result-item { display: grid; grid-template-columns: 1fr auto; gap: 4px 10px; padding: 9px 10px; background: #18181e; border: 1px solid var(--line); border-radius: 10px; }
    .result-item .rel { font-size: 12.5px; word-break: break-word; display: -webkit-box; -webkit-line-clamp: 2; -webkit-box-orient: vertical; overflow: hidden; }
    .result-item button { grid-row: 1 / span 2; grid-column: 2; align-self: center; }
    .result-item .meta { display: flex; flex-wrap: wrap; gap: 6px; align-items: center; color: var(--muted); font-size: 11.5px; }
    .site { padding: 1px 6px; border-radius: 5px; font-size: 10.5px; font-weight: 700; letter-spacing: .02em; }
    .site.subsource { background: #283d7c; color: #c0cfff; }
    .site.subdl { background: #24553a; color: #b8f0cd; }
    .site.opensubtitles { background: #5c4219; color: #ffdca8; }

    .file { display: flex; align-items: center; gap: 8px; min-height: 30px; }
    .file .name { flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; color: #c8c8d2; }
    .file .name.empty { color: #74747f; }
    .file select { flex: 1; min-width: 0; }
    .file + .file { margin-top: 6px; }
    .nf-status { margin: 6px 0 0; }
    .result { padding: 10px 12px; border-radius: 12px; background: var(--card); border-left: 3px solid #666; }
    .result.good { border-left-color: var(--good); }
    .result.fair { border-left-color: var(--warn); }
    .result.poor { border-left-color: var(--bad); }
    .result .head { font-weight: 700; margin-bottom: 4px; }
    .result ul { margin: 2px 0 4px; padding-left: 18px; }
    .num { font-variant-numeric: tabular-nums; }
    .offset { display: flex; align-items: center; gap: 5px; }
    .offset button { padding: 5px 7px; font-size: 12px; }
    .offset input { width: 74px; text-align: center; font-variant-numeric: tabular-nums; padding: 5px 4px; }
    .auto { margin-bottom: 8px; }
    .keys { padding: 0 2px; }
    .foot { margin: 10px 2px 0; }
    .keys p { margin: 0 0 4px; }
    kbd { padding: 0 5px; border: 1px solid #55555f; border-bottom-width: 2px; border-radius: 4px; font: 11px/1.5 var(--ui-font); color: #ddd; }
    .range { display: grid; grid-template-columns: 76px 1fr 44px; align-items: center; gap: 8px; margin: 2px 0; min-height: 32px; }
    .range output { text-align: right; color: #b8b8c2; font-variant-numeric: tabular-nums; }
    input[type=range] { width: 100%; margin: 0; accent-color: var(--accent); }
    .preview { margin-top: 10px; padding: 8px 10px; border-radius: 9px; background: var(--field); font-size: 12px; color: #b9b9c3; }
    .preview b { color: var(--text); font-weight: 650; }
    .preview div { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  `;

  function filePicker(onFile) {
    return h("input", {
      type: "file",
      accept: ACCEPT,
      hidden: true,
      onchange: (e) => {
        const f = e.target.files && e.target.files[0];
        e.target.value = "";
        if (f) onFile(f);
      },
    });
  }

  // Lets an element accept a dropped file.
  function dropTarget(el, onFile) {
    el.addEventListener("dragover", (e) => {
      e.preventDefault();
      el.classList.add("over");
    });
    el.addEventListener("dragleave", () => el.classList.remove("over"));
    el.addEventListener("drop", (e) => {
      e.preventDefault();
      el.classList.remove("over");
      const f = e.dataTransfer && e.dataTransfer.files[0];
      if (f) onFile(f);
    });
    return el;
  }

  function rangeRow(label, min, max, step, onInput) {
    const input = h("input", { type: "range", min, max, step, oninput: (e) => onInput(+e.target.value) });
    const out = h("output");
    return { row: h("label", { class: "range" }, h("span", null, label), input, out), input, out };
  }

  function selectRow(label, options, onChange) {
    const select = h("select", { onchange: (e) => onChange(e.target.value) }, options.map(([v, l]) => h("option", { value: v }, l)));
    return { row: h("label", { class: "range" }, h("span", null, label), select, h("span")), select };
  }

  function buildPanel() {
    const subInput = filePicker(loadSub);
    const refInput = filePicker(loadRef);

    // header, status, tabs
    ui.title = h("small");
    ui.statusText = h("span");
    ui.status = h("div", { class: "status", role: "status" }, h("i", { class: "dot" }), ui.statusText);
    ui.tabButtons = {};
    const nav = h(
      "nav",
      { class: "tabs", role: "tablist" },
      TABS.map(([id, label]) => (ui.tabButtons[id] = h("button", { role: "tab", onclick: () => selectTab(id) }, label)))
    );

    // tab: subtitle file + search
    ui.subName = h("div", { class: "name" });
    ui.subMeta = h("div", { class: "meta" });
    ui.enabled = h("input", {
      type: "checkbox",
      class: "switch",
      onchange: (e) => {
        state.settings.enabled = e.target.checked;
        saveSettings();
        renderPanel();
      },
    });
    ui.subCard = dropTarget(
      h("div", { class: "card" },
        h("div", { class: "subline" }, fileIcon(), h("div", { class: "grow" }, ui.subName, ui.subMeta),
          h("button", { class: "small", onclick: () => subInput.click() }, "Change"),
          h("button", { class: "icon", title: "Remove subtitles", "aria-label": "Remove subtitles", onclick: removeSub }, "×")),
        h("label", { class: "toggle" }, ui.enabled, h("span", null, "Show subtitles on the video"))),
      loadSub
    );
    ui.drop = dropTarget(
      h("div", { class: "drop" }, fileIcon(),
        h("div", { class: "drop-title" }, "Drop a subtitle file here"),
        h("div", { class: "hint" }, ".srt · .vtt · .ass · .xml · Excel/CSV"),
        h("button", { class: "primary", onclick: () => subInput.click() }, "Choose file…")),
      loadSub
    );
    const edited = (e) => (e.target.dataset.edited = "1");
    const enter = (e) => {
      if (e.key === "Enter") runSearch();
    };
    ui.q = h("input", { type: "text", class: "grow", placeholder: "Movie or series title", oninput: edited, onkeydown: enter });
    ui.s = h("input", { type: "text", class: "num-in", inputmode: "numeric", placeholder: "S", title: "Season", oninput: edited, onkeydown: enter });
    ui.e = h("input", { type: "text", class: "num-in", inputmode: "numeric", placeholder: "E", title: "Episode", oninput: edited, onkeydown: enter });
    ui.lang = h(
      "select",
      { title: "Subtitle language", onchange: (e) => { state.settings.searchLang = e.target.value; saveSettings(); } },
      Object.entries(S.LANGS).map(([code, l]) => h("option", { value: code }, l.name))
    );
    ui.searchBtn = h("button", { class: "primary", onclick: runSearch }, "Search");
    ui.searchNote = h("div", { class: "hint search-note" });
    ui.results = h("ul", { class: "results" });
    ui.searchForm = h("div", null,
      h("div", { class: "row" }, ui.q, ui.s, ui.e),
      h("div", { class: "row" }, ui.lang, ui.searchBtn),
      ui.searchNote, ui.results);
    ui.setup = h("div", { class: "setup" },
      h("p", null, "To search for subtitles, add a free API key for at least one site: SubSource (the former Subscene collection), SubDL or OpenSubtitles."),
      h("button", { class: "primary small", onclick: openOptions }, "Add API key…"));
    ui.keysLink = h("button", { class: "link", onclick: openOptions }, "API key settings");
    const subTab = h("div", { class: "tab" }, ui.subCard, ui.drop, subInput,
      h("div", { class: "block" }, h("h3", null, "Find subtitles online"), ui.setup, ui.searchForm));

    // tab: alignment
    ui.result = h("div", { class: "result", hidden: true });
    ui.refName = h("span", { class: "name" });
    ui.refRemove = h("button", {
      class: "icon",
      title: "Remove reference",
      "aria-label": "Remove reference",
      onclick: () => {
        state.ref = null;
        nf.declined = state.movieId;
        renderPanel();
        scheduleSave();
      },
    }, "×");
    ui.nfSelect = h("select", { title: "Subtitles Netflix has for this episode" });
    ui.nfUse = h("button", {
      title: "Use these Netflix subtitles as the reference",
      onclick: () => {
        const tracks = nf.tracks.get(state.movieId) || [];
        const track = tracks.find((t) => t.id === ui.nfSelect.value) || tracks[0];
        if (track) useNetflixTrack(track, false);
      },
    });
    ui.nfRow = h("div", { class: "file" }, ui.nfSelect, ui.nfUse);
    ui.nfStatus = h("p", { class: "hint nf-status" });
    ui.alignBtn = h("button", { class: "primary wide", onclick: () => runAlign(false) });
    ui.auto = h("div", { class: "auto hint" });
    ui.offsetInput = h("input", {
      type: "text",
      inputmode: "decimal",
      title: "Seconds; negative = show earlier",
      onchange: (e) => {
        const v = parseFloat(String(e.target.value).replace(",", ".").replace("−", "-"));
        if (Number.isFinite(v)) setUserOffset(v * 1000);
        else renderPanel();
      },
      onkeydown: (e) => {
        if (e.key === "Enter") e.target.blur();
      },
    });
    const step = (ms, label) =>
      h("button", { onclick: () => nudge(ms), title: "Show subtitles " + (ms < 0 ? "earlier" : "later") }, label);
    ui.preview = h("div", { class: "preview", hidden: true });
    const syncTab = h("div", { class: "tab" },
      ui.result,
      dropTarget(
        h("div", { class: "card" },
          h("h3", null, "Reference (correct timing)"),
          h("p", { class: "hint" }, "Taken straight from Netflix — any language works — or choose a file (.vtt/.srt/.xml, a Language Reactor Excel export)."),
          ui.nfRow, ui.nfStatus,
          h("div", { class: "file" }, h("button", { class: "small", onclick: () => refInput.click() }, "Choose file…"), ui.refName, ui.refRemove, refInput),
          ui.alignBtn),
        loadRef
      ),
      h("div", { class: "card" },
        h("h3", null, "Manual offset"),
        ui.auto,
        h("div", { class: "offset" },
          step(-1000, "−1s"), step(-100, "−0.1s"), ui.offsetInput, step(100, "+0.1s"), step(1000, "+1s"),
          h("button", { class: "icon", title: "Reset to 0", "aria-label": "Reset to 0", onclick: () => setUserOffset(0) }, "↺")),
        ui.preview),
      h("div", { class: "keys hint" },
        h("p", null, h("kbd", null, "A"), " / ", h("kbd", null, "D"), " (or ", h("kbd", null, "Shift"), "+", h("kbd", null, "←"), " / ", h("kbd", null, "→"), ") — previous / next line"),
        h("p", null, h("kbd", null, "G"), " / ", h("kbd", null, "H"), " — subtitles 0.1 s earlier / later, with ", h("kbd", null, "Shift"), " = 1 s"),
        h("p", null, h("kbd", null, "Alt"), "+", h("kbd", null, "Shift"), "+", h("kbd", null, "S"), " or the toolbar icon — open/close this panel")));

    // tab: appearance
    ui.fontStyle = selectRow("Font style", FONTS, (v) => updateSetting("font", v));
    ui.font = rangeRow("Size", 50, 200, 5, (v) => updateSetting("fontScale", v / 100));
    ui.pos = rangeRow("Position", 0, 85, 1, (v) => updateSetting("bottom", v));
    ui.bg = rangeRow("Background", 0, 100, 5, (v) => updateSetting("background", v / 100));
    ui.color = selectRow("Color", COLORS, (v) => updateSetting("color", v));
    ui.exportBtn = h("button", { class: "wide", onclick: exportSrt }, "⬇ Download synced subtitles (.srt)");
    const lookTab = h("div", { class: "tab" },
      h("div", { class: "card" }, ui.fontStyle.row, ui.font.row, ui.pos.row, ui.bg.row, ui.color.row),
      ui.exportBtn,
      h("p", { class: "hint foot" }, "Finding subtitles online needs an API key: ", ui.keysLink),
      DONATE_URL
        ? h("p", { class: "hint foot" }, "Enjoying Netflix Sub Loader? ",
            h("a", { href: DONATE_URL, target: "_blank", rel: "noopener noreferrer" }, "♥ Support it on PayPal"))
        : null);

    ui.tabs = { sub: subTab, sync: syncTab, look: lookTab };
    return h("section", { class: "panel", hidden: true, role: "dialog", "aria-label": "Netflix Sub Loader" },
      h("header", null,
        h("div", { class: "brand" }, logo(), h("div", { class: "grow" }, h("b", null, "Netflix Sub Loader"), ui.title)),
        h("button", { class: "icon", title: "Close (Esc)", "aria-label": "Close", onclick: () => togglePanel(false) }, "×")),
      ui.status,
      nav,
      h("div", { class: "body" }, subTab, syncTab, lookTab));
  }

  function selectTab(id) {
    state.settings.tab = id;
    saveSettings();
    renderPanel();
    if (id === "sub") prepareSearch();
  }

  function updateSetting(key, value) {
    state.settings[key] = value;
    applySettings();
    saveSettings();
  }

  function applySettings() {
    const s = state.settings;
    if (!FONTS.some(([value]) => value === s.font)) s.font = DEFAULT_SETTINGS.font;
    if (!S.LANGS[s.searchLang]) s.searchLang = DEFAULT_SETTINGS.searchLang;
    const st = ui.layer.style;
    st.setProperty("--sub-scale", String(s.fontScale));
    st.setProperty("--sub-bottom", s.bottom + "%");
    st.setProperty("--sub-bg", String(s.background));
    st.setProperty("--sub-color", s.color);
    ui.layer.classList.toggle("font-outline", s.font === "outline");
    ui.fontStyle.select.value = s.font;
    ui.font.input.value = Math.round(s.fontScale * 100);
    ui.font.out.textContent = Math.round(s.fontScale * 100) + "%";
    ui.pos.input.value = s.bottom;
    ui.pos.out.textContent = s.bottom + "%";
    ui.bg.input.value = Math.round(s.background * 100);
    ui.bg.out.textContent = Math.round(s.background * 100) + "%";
    ui.color.select.value = s.color;
    ui.lang.value = s.searchLang;
    ui.enabled.checked = s.enabled;
  }

  function movieLabel() {
    if (!state.movieId) return "Open a title on Netflix to start";
    const info = search.movieId === state.movieId && search.info;
    if (!info) return "Netflix #" + state.movieId;
    return info.title + (info.season ? ` · Season ${info.season}, episode ${info.episode}` : "");
  }

  function renderPanel() {
    if (!ui.panel) return;
    ui.fab.classList.toggle("loaded", !!state.sub);
    ui.layer.classList.toggle("watching", !!state.movieId);
    if (!state.panelOpen) return;

    const tab = ui.tabs[state.settings.tab] ? state.settings.tab : "sub";
    for (const [id, el] of Object.entries(ui.tabs)) el.hidden = id !== tab;
    for (const [id, b] of Object.entries(ui.tabButtons)) {
      b.classList.toggle("on", id === tab);
      b.setAttribute("aria-selected", String(id === tab));
    }
    ui.title.textContent = movieLabel();
    renderStatus();

    ui.subCard.hidden = !state.sub;
    ui.drop.hidden = !!state.sub;
    if (state.sub) {
      ui.subName.textContent = state.sub.name;
      ui.subName.title = state.sub.name;
      ui.subMeta.textContent = `${state.sub.cues.length} lines · ${String(state.sub.format || "").toUpperCase()}`;
    }
    ui.enabled.checked = state.settings.enabled;
    renderSearch();

    ui.refName.textContent = state.ref ? `${state.ref.name} · ${state.ref.cues.length} lines` : "None";
    ui.refName.className = "name" + (state.ref ? "" : " empty");
    ui.refName.title = state.ref ? state.ref.name : "";
    ui.refRemove.hidden = !state.ref;
    renderNetflix();
    ui.alignBtn.disabled = !state.sub || !state.ref || state.busy;
    ui.alignBtn.textContent = state.busy ? "Analyzing…" : state.result ? "⚡ Sync again" : "⚡ Sync automatically";
    renderResult();

    ui.auto.textContent = state.result
      ? `Auto: ${fmtOffset(state.result.offset)}${state.result.segments.length > 1 ? " (longest part)" : ""} · extra:`
      : "Extra offset (seconds):";
    if (ui.offsetInput !== ui.panel.getRootNode().activeElement) {
      ui.offsetInput.value = (state.userOffset >= 0 ? "+" : "") + (state.userOffset / 1000).toFixed(3);
    }
    ui.exportBtn.disabled = !state.display.length;
    updatePreview();
  }

  function renderStatus() {
    const r = state.result;
    let cls = "";
    let text;
    if (!state.movieId) text = "Open a title on Netflix to start";
    else if (state.busy) [cls, text] = ["busy", "Syncing…"];
    else if (search.using) [cls, text] = ["busy", "Downloading subtitles…"];
    else if (nf.loading) [cls, text] = ["busy", "Getting the reference from Netflix…"];
    else if (!state.sub) text = "No subtitles yet — choose a file or search online";
    else if (r) {
      cls = { good: "good", fair: "warn", poor: "bad" }[r.quality];
      const head = { good: "In sync", fair: "Partly in sync", poor: "Out of sync" }[r.quality];
      text = `${head} · offset ${fmtOffset(r.offset + state.userOffset)}`;
    } else if (state.userOffset) [cls, text] = ["warn", `Manual offset ${fmtOffset(state.userOffset)}`];
    else text = state.ref ? "Not synced yet — open the Sync tab" : "Using the file's own timing";
    if (state.sub && !state.settings.enabled) text += " · hidden";
    ui.status.className = "status " + cls;
    ui.statusText.textContent = text;
  }

  function renderSearch() {
    if (!ui.searchForm) return;
    const sites = Object.keys(S.SITES).filter((s) => search.keys && search.keys[s]);
    ui.setup.hidden = sites.length > 0;
    ui.searchForm.hidden = !sites.length;
    ui.searchBtn.disabled = search.loading;
    ui.searchBtn.textContent = search.loading ? "Searching…" : "Search";
    const lines = [];
    if (search.loading) lines.push("Searching " + sites.map((s) => S.SITES[s].name).join(", ") + "…");
    else if (search.results) {
      lines.push(
        search.results.length
          ? `${search.results.length} results — click "Use" to download and sync.`
          : "Nothing found — try the original or English title, or clear the episode number."
      );
    }
    ui.searchNote.replaceChildren(
      ...lines.map((l) => h("div", null, l)),
      ...search.errors.map((e) => h("div", { class: "err" }, e.message))
    );
    ui.searchNote.hidden = !lines.length && !search.errors.length;
    ui.results.replaceChildren(...(search.results || []).map(resultItem));
  }

  function resultItem(it) {
    const busy = search.using === it.site + ":" + it.id;
    const meta = [h("span", { class: "site " + it.site }, S.SITES[it.site].name)];
    if (it.fullSeason) meta.push(h("span", null, "full season"));
    else if (it.episode) meta.push(h("span", null, "episode " + it.episode));
    if (it.hi) meta.push(h("span", { title: "Includes sound descriptions for the deaf and hard of hearing" }, "SDH"));
    if (it.downloads) meta.push(h("span", { title: "Downloads" }, "↓ " + it.downloads));
    return h("li", { class: "result-item" },
      h("div", { class: "rel", title: it.release }, it.release || it.title),
      h("button", { class: "small" + (busy ? "" : " primary"), disabled: !!search.using, onclick: () => useResult(it) }, busy ? "Loading…" : "Use"),
      h("div", { class: "meta" }, meta));
  }

  function renderNetflix() {
    const tracks = (state.movieId && nf.tracks.get(state.movieId)) || [];
    ui.nfRow.hidden = !tracks.length;
    const ids = tracks.map((t) => t.id).join("|");
    if (ui.nfSelect.dataset.ids !== ids) {
      ui.nfSelect.replaceChildren(...tracks.map((t) => h("option", { value: t.id }, "Netflix: " + N.trackLabel(t))));
      ui.nfSelect.dataset.ids = ids;
    }
    if (state.ref && state.ref.trackId && tracks.some((t) => t.id === state.ref.trackId)) {
      ui.nfSelect.value = state.ref.trackId;
    }
    ui.nfUse.disabled = nf.loading || state.busy;
    ui.nfUse.textContent = nf.loading ? "Getting…" : "Get";
    let status = "";
    if (!state.movieId) status = "";
    else if (nf.loading) status = "Downloading subtitles from Netflix…";
    else if (nf.error) status = nf.error + " You can choose a reference file instead.";
    else if (tracks.length) status = state.sub || state.ref ? "" : "Pick subtitles in the Subtitles tab and they are synced to Netflix's automatically.";
    else if (state.ref) status = "";
    else if (nf.seen.has(state.movieId)) status = "Netflix only has image-based subtitles for this episode — choose a reference file.";
    else if (nf.hook) status = "Netflix's subtitle list hasn't arrived yet. If the video is playing and it still doesn't show up, reload the page (F5).";
    else status = "Reload the page (F5) so the extension can read Netflix's subtitles.";
    ui.nfStatus.textContent = status;
    ui.nfStatus.hidden = !status;
  }

  function renderResult() {
    const r = state.result;
    ui.result.hidden = !r;
    if (!r) return;
    ui.result.className = "result " + r.quality;
    const head = {
      good: "✓ In sync",
      fair: "⚠ Partly in sync — check a few lines",
      poor: "✗ Out of sync — maybe a different episode or version",
    }[r.quality];
    const lines = [h("div", { class: "head" }, head)];
    if (r.segments.length === 1) {
      lines.push(h("div", { class: "num" }, "Offset: " + fmtOffset(r.segments[0].offset)));
    } else {
      lines.push(
        h("div", null, `Different offsets in ${r.segments.length} parts (a different cut):`),
        h("ul", { class: "num" }, r.segments.map((s) => h("li", null, `from ${fmtClock(s.at)}: ${fmtOffset(s.offset)}`)))
      );
    }
    if (r.scaleLabel) lines.push(h("div", null, "Frame rate: " + r.scaleLabel));
    lines.push(
      h("div", { class: "num" },
        `${Math.round(r.matchRatio * 100)}% of lines match (before syncing: ${Math.round(r.baselineRatio * 100)}%)`)
    );
    if (r.droppedLines) lines.push(h("div", { class: "hint" }, `Hid ${r.droppedLines} lines from scenes Netflix doesn't have`));
    if (state.ref && state.ref.resolution) {
      lines.push(h("div", { class: "hint" },
        "The reference only has times rounded to the second, so it may be off by up to ~0.25 s — check and adjust with G/H if needed."));
    }
    lines.push(
      h("button", {
        class: "link",
        onclick: () => {
          resetAlignment();
          rebuild();
          scheduleSave();
        },
      }, "Undo — use the file's own timing")
    );
    ui.result.replaceChildren(...lines);
  }

  function updatePreview() {
    if (!state.panelOpen || !ui.preview) return;
    const v = state.movieId && getVideo();
    if (!v || !state.sub) {
      ui.preview.hidden = true;
      return;
    }
    const t = v.currentTime * 1000;
    const text = (list) => {
      const a = activeAt(list, t);
      return a.length ? a.map((c) => plain(c.text)).join(" · ") : "—";
    };
    const rows = [h("div", null, h("b", null, fmtClock(t)), " — quick check")];
    if (state.ref) rows.push(h("div", null, h("b", null, "Reference: "), text(state.ref.cues)));
    rows.push(h("div", null, h("b", null, "Sub: "), text(state.display)));
    ui.preview.replaceChildren(...rows);
    ui.preview.hidden = false;
  }

  let toastTimer = 0;
  function toast(message, isError) {
    if (!ui.toast) return;
    ui.toast.textContent = message;
    ui.toast.className = "toast show" + (isError ? " error" : "");
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => (ui.toast.className = "toast"), isError ? 4000 : 1800);
  }

  function togglePanel(open) {
    state.panelOpen = open === undefined ? !state.panelOpen : !!open;
    ui.panel.hidden = !state.panelOpen;
    ui.layer.classList.toggle("open", state.panelOpen);
    if (!state.panelOpen) {
      const active = ui.panel.getRootNode().activeElement;
      if (active) active.blur(); // give the keyboard back to the player
    } else if (state.settings.tab === "sub") prepareSearch();
    renderPanel();
  }

  let wakeTimer = 0;
  function wake() {
    if (!ui.layer) return;
    ui.layer.classList.add("awake");
    clearTimeout(wakeTimer);
    wakeTimer = setTimeout(() => ui.layer.classList.remove("awake"), 2600);
  }

  // In fullscreen only the fullscreen element's subtree is painted, so follow it.
  function ensureMounted() {
    if (!host) return;
    const fs = document.fullscreenElement;
    const parent =
      fs && fs !== document.documentElement && !(fs instanceof HTMLVideoElement)
        ? fs
        : document.body || document.documentElement;
    if (host.parentNode !== parent) parent.appendChild(host);
  }

  function checkUrl() {
    const m = /\/watch\/(\d+)/.exec(location.pathname);
    const id = m ? m[1] : null;
    if (id === state.movieId) return;
    flushSave();
    state.movieId = id;
    nf.error = null;
    state.sub = null;
    state.ref = null;
    resetAlignment();
    rebuild();
    if (id) restoreTitle(id);
    if (state.panelOpen && state.settings.tab === "sub") prepareSearch();
  }

  // ---------- keyboard ----------

  const isEditable = (el) => !!el && (el.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(el.tagName));

  function onKey(e) {
    if (host && e.composedPath().includes(host)) {
      // Typing in the panel must not reach Netflix's shortcuts (space, F, arrows...).
      e.stopImmediatePropagation();
      if (e.type === "keydown" && e.key === "Escape") togglePanel(false);
      return;
    }
    if (!state.movieId || e.ctrlKey || e.altKey || e.metaKey || isEditable(e.target)) return;
    const down = e.type === "keydown";
    const hasLines = state.display.length || (state.ref && state.ref.cues.length);
    const dir = hasLines ? NAV.lineKey(e) : 0;
    if (dir) {
      // keyup/keypress are swallowed too, so another extension bound to A/D does not also jump
      if (down) lineKeyDown(e, dir);
    } else if (down && state.sub && (e.code === "KeyG" || e.code === "KeyH")) {
      const step = e.shiftKey ? 1000 : 100;
      nudge(e.code === "KeyG" ? -step : step);
    } else return;
    e.preventDefault();
    e.stopImmediatePropagation();
  }

  // Unikey can type two letters ("a" + "a") for a single press: count one jump per burst.
  let lastTypedKey = -Infinity;
  function lineKeyDown(e, dir) {
    const typed = !e.code || e.code === "Unidentified";
    const now = performance.now();
    if (typed && now - lastTypedKey < 40) return;
    if (typed) lastTypedKey = now;
    jumpLine(dir);
  }
  for (const type of ["keydown", "keyup", "keypress"]) listen(window, type, onKey, true);

  // ---------- start ----------

  let ready = false;
  const pending = [];
  if (ext) {
    const onMessage = (msg, _sender, sendResponse) => {
      if (msg && msg.type === "nsl-toggle-panel") {
        if (ready) togglePanel();
        else pending.push(() => togglePanel());
        sendResponse({ ok: true });
      }
    };
    ext.runtime.onMessage.addListener(onMessage);
    cleanups.push(() => ext.runtime.onMessage.removeListener(onMessage));
    const onStorage = (changes, area) => {
      if (area === "local" && changes.providerKeys) {
        search.keys = changes.providerKeys.newValue || {};
        renderPanel();
      }
    };
    ext.storage.onChanged.addListener(onStorage);
    cleanups.push(() => ext.storage.onChanged.removeListener(onStorage));
  }

  async function init() {
    if (stopped) return;
    const old = document.getElementById("netflix-sub-loader"); // left by a version without takeover
    if (old) old.remove();
    host = document.createElement("div");
    host.id = "netflix-sub-loader";
    host.style.cssText = "position:fixed;inset:0;z-index:2147483647;pointer-events:none;";
    cleanups.push(() => host.remove());
    const root = host.attachShadow({ mode: "open" });
    const style = document.createElement("style");
    style.textContent = CSS;
    ui.layer = h("div", { class: "layer" });
    ui.top = h("div", { class: "subs top" });
    ui.bottom = h("div", { class: "subs bottom" });
    ui.toast = h("div", { class: "toast", role: "status", "aria-live": "polite" });
    ui.fab = h("button", { class: "fab", title: "Netflix Sub Loader (Alt+Shift+S)", "aria-label": "Open Netflix Sub Loader", onclick: () => togglePanel() }, logo());
    ui.panel = buildPanel();
    ui.layer.append(ui.top, ui.bottom, ui.fab, ui.toast, ui.panel);
    root.append(style, ui.layer);
    // A mouse click must not leave focus on a button, or the next Space meant for the player
    // would press it again. Keyboard (Tab) focus still works.
    root.addEventListener("mousedown", (e) => {
      if (e.target.closest && e.target.closest("button")) e.preventDefault();
    });
    // Clicks in the panel must not pause/play or fullscreen the video underneath.
    for (const type of ["click", "dblclick", "mousedown", "mouseup", "pointerdown", "pointerup", "contextmenu"]) {
      host.addEventListener(type, (e) => e.stopPropagation());
    }
    host.addEventListener("wheel", (e) => e.stopPropagation(), { passive: true });

    Object.assign(state.settings, (await store.get("settings")) || {});
    applySettings();
    ensureMounted();
    checkUrl();
    loadKeys();
    listen(window, "mousemove", wake, { passive: true });
    listen(window, "pagehide", flushSave);
    listen(document, "fullscreenchange", ensureMounted);
    every(() => {
      checkUrl();
      ensureMounted();
    }, 700);
    every(updatePreview, 250);
    requestAnimationFrame(frame);
    ready = true;
    pending.splice(0).forEach((fn) => fn());
    helloHook();
    // Lets the service worker know this tab can be toggled from the toolbar button.
    if (ext) ext.runtime.sendMessage({ type: "nsl-here" }).catch(() => {});
  }

  if (document.readyState === "loading") listen(document, "DOMContentLoaded", init, { once: true });
  else init();
})();
