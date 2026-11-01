/*
 * Netflix Sub Loader - choosing and downloading one of Netflix's own subtitle tracks (reported by
 * netflix-hook.js) to use as the correctly timed reference.
 */
(function (root, factory) {
  const api = factory();
  if (typeof module === "object" && module.exports) module.exports = api;
  else root.NSLNetflix = api;
})(typeof globalThis !== "undefined" ? globalThis : this, function () {
  "use strict";

  // Text profiles, best first. Image-based subtitles (nflx-cmisc) carry no usable text.
  const TEXT_PROFILES = ["webvtt-lssdh-ios8", "dfxp-ls-sdh", "simplesdh", "imsc1.1", "dfxp-ls"];

  function textProfiles(track) {
    const names = Object.keys(track.formats || {});
    const known = TEXT_PROFILES.filter((p) => names.includes(p));
    const other = names.filter(
      (p) => !known.includes(p) && /webvtt|dfxp|ttml|imsc|sdh/i.test(p) && !/cmisc|image|bitmap|png/i.test(p)
    );
    return known.concat(other);
  }

  function trackLabel(track) {
    return /ASSISTIVE/i.test(track.kind) && !/\b(CC|SDH)\b/i.test(track.label) ? track.label + " (CC)" : track.label;
  }

  /**
   * Validates tracks received from the page and keeps those with a text profile, best reference
   * first: English (the most complete track on Netflix), then plain subtitles before CC/SDH.
   * Forced-narrative tracks only cover foreign-language bits and are skipped.
   */
  function usableTracks(raw) {
    if (!Array.isArray(raw)) return [];
    const out = [];
    for (const t of raw.slice(0, 300)) {
      if (!t || typeof t !== "object" || t.forced) continue;
      const formats = {};
      for (const [name, urls] of Object.entries(t.formats || {})) {
        if (!Array.isArray(urls)) continue;
        const ok = urls.filter((u) => typeof u === "string" && /^https?:\/\//.test(u)).slice(0, 5);
        if (ok.length) formats[String(name)] = ok;
      }
      const track = {
        id: String(t.id || out.length),
        language: String(t.language || ""),
        label: String(t.label || t.language || "?").slice(0, 80),
        kind: String(t.kind || ""),
        formats,
      };
      if (textProfiles(track).length) out.push(track);
    }
    const score = (t) =>
      (/^en(\b|-)/i.test(t.language) ? 4 : 0) + (/ASSISTIVE|\bCC\b|\bSDH\b/i.test(t.kind + " " + t.label) ? 0 : 2);
    return out.sort((a, b) => score(b) - score(a));
  }

  /**
   * Downloads the first text profile/URL of `track` that parses into cues.
   * deps: { fetch, decode(bytes) -> string, parse(string) -> { cues, format } }
   */
  async function download(track, deps) {
    let lastError = null;
    for (const profile of textProfiles(track)) {
      for (const url of track.formats[profile]) {
        try {
          const res = await deps.fetch(url, { credentials: "omit" });
          if (!res.ok) {
            lastError = new Error("HTTP " + res.status);
            continue;
          }
          const text = deps.decode(await res.arrayBuffer());
          const parsed = deps.parse(text);
          if (parsed.cues.length) return { text, cues: parsed.cues, format: parsed.format, profile };
          lastError = new Error("no subtitle lines");
        } catch (e) {
          lastError = e;
        }
      }
    }
    throw new Error(
      `Could not download the "${trackLabel(track)}" subtitles from Netflix` + (lastError ? ` (${lastError.message})` : "") + "."
    );
  }

  return { usableTracks, textProfiles, trackLabel, download };
});
