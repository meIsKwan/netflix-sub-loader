/*
 * Netflix Sub Loader - runs inside the page (MAIN world) at document_start.
 * Netflix's player parses a playback manifest that lists every subtitle track of the title with
 * its download URLs. This wraps JSON.parse - read-only, the parsed value is returned untouched -
 * to note those tracks, and hands them to the extension's content script via window.postMessage.
 */
(() => {
  "use strict";
  const TAG = "netflix-sub-loader";
  if (window[TAG + "-hook"]) return;
  Object.defineProperty(window, TAG + "-hook", { value: true });

  const byMovie = new Map(); // movieId -> tracks, kept for the whole page session

  function urlsOf(d) {
    let urls = [];
    if (d.downloadUrls && typeof d.downloadUrls === "object") urls = Object.values(d.downloadUrls);
    else if (Array.isArray(d.urls)) urls = d.urls.map((u) => (u && typeof u === "object" ? u.url : u));
    return urls.filter((u) => typeof u === "string" && /^https?:\/\//.test(u));
  }

  function tracksOf(list) {
    const out = [];
    for (const t of list) {
      if (!t || typeof t !== "object" || t.isNoneTrack) continue;
      const formats = {};
      for (const [profile, d] of Object.entries(t.ttDownloadables || {})) {
        const urls = d && typeof d === "object" ? urlsOf(d) : [];
        if (urls.length) formats[profile] = urls;
      }
      if (!Object.keys(formats).length) continue;
      out.push({
        id: String(t.new_track_id || t.trackId || t.id || out.length),
        language: String(t.language || t.bcp47 || ""),
        label: String(t.languageDescription || t.language || "?"),
        kind: String(t.trackType || t.rawTrackType || ""),
        forced: !!t.isForcedNarrative,
        formats,
      });
    }
    return out;
  }

  function post(movieId) {
    window.postMessage({ [TAG]: "tracks", movieId, tracks: byMovie.get(movieId) }, location.origin);
  }

  function inspect(data) {
    if (!data || typeof data !== "object") return;
    const roots = Array.isArray(data.result) ? data.result : [data.result || data];
    for (const r of roots) {
      if (!r || typeof r !== "object" || !Array.isArray(r.timedtexttracks) || r.movieId == null) continue;
      const tracks = tracksOf(r.timedtexttracks);
      if (!tracks.length) continue;
      const movieId = String(r.movieId);
      byMovie.set(movieId, tracks);
      post(movieId);
    }
  }

  const parse = JSON.parse;
  JSON.parse = function (text, reviver) {
    const data = parse.apply(this, arguments);
    try {
      inspect(data);
    } catch (_e) {
      // never get in the way of the page
    }
    return data;
  };

  // Netflix's own player object; seeking by setting video.currentTime makes it fail (M7375).
  function netflixPlayer() {
    const vp = window.netflix.appContext.state.playerApp.getAPI().videoPlayer;
    const ids = vp.getAllPlayerSessionIds();
    const id = ids.find((s) => /^watch/.test(s)) || ids[ids.length - 1];
    return id ? vp.getVideoPlayerBySessionId(id) : null;
  }

  window.addEventListener("message", (e) => {
    if (e.source !== window || !e.data) return;
    const kind = e.data[TAG];
    if (kind === "hello") {
      // The content script starts up, possibly after the manifest arrived.
      window.postMessage({ [TAG]: "ready" }, location.origin);
      for (const id of byMovie.keys()) post(id);
    } else if (kind === "seek") {
      let ok = false;
      try {
        const player = netflixPlayer();
        if (player && Number.isFinite(e.data.ms)) {
          player.seek(Math.max(0, Math.round(e.data.ms)));
          ok = true;
        }
      } catch (_e) {
        // player not ready, or Netflix changed its API
      }
      window.postMessage({ [TAG]: "seeked", id: e.data.id, ok }, location.origin);
    }
  });
})();
