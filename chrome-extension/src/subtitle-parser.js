/*
 * Netflix Sub Loader - subtitle parsing.
 * Supports SRT, WebVTT, ASS/SSA and TTML/DFXP (the XML format Netflix serves).
 * Every parser returns cues as { start, end, text, top? } with times in milliseconds;
 * text keeps only <i>, <b> and <u> markup and uses "\n" for line breaks.
 */
(function (root, factory) {
  const api = factory();
  if (typeof module === "object" && module.exports) module.exports = api;
  else root.NSLParser = api;
})(typeof globalThis !== "undefined" ? globalThis : this, function () {
  "use strict";

  const ENTITIES = {
    amp: "&",
    lt: "<",
    gt: ">",
    quot: '"',
    apos: "'",
    nbsp: "\u00a0",
    lrm: "\u200e",
    rlm: "\u200f",
  };

  function decodeEntities(s) {
    return s.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (m, code) => {
      if (code[0] === "#") {
        const hex = code[1] === "x" || code[1] === "X";
        const n = parseInt(code.slice(hex ? 2 : 1), hex ? 16 : 10);
        return Number.isFinite(n) && n <= 0x10ffff ? String.fromCodePoint(n) : m;
      }
      const v = ENTITIES[code.toLowerCase()];
      return v === undefined ? m : v;
    });
  }

  // "01:02:03,456" | "02:03.456" | "1:02:03.45" (ASS centiseconds) -> ms
  function parseClock(str) {
    const m = /^\s*(?:(\d+):)?(\d{1,2}):(\d{1,2})(?:[.,](\d+))?\s*$/.exec(str || "");
    if (!m) return NaN;
    const frac = m[4] ? Number("0." + m[4]) : 0;
    return Math.round(((+(m[1] || 0) * 60 + +m[2]) * 60 + +m[3] + frac) * 1000);
  }

  // Normalises cue markup. ASS override blocks ({\an8}, {\i1}) are honoured in every format
  // because many SRT files carry them too.
  function cleanText(raw, isAss) {
    let top = false;
    let t = raw.replace(/\{(\\[^}]*)\}/g, (_m, body) => {
      if (/\\an[789]/.test(body) || /\\a[567](?!\d)/.test(body)) top = true;
      let out = "";
      if (/\\i1/.test(body)) out += "<i>";
      if (/\\i0/.test(body)) out += "</i>";
      if (/\\b1/.test(body)) out += "<b>";
      if (/\\b0/.test(body)) out += "</b>";
      return out;
    });
    if (isAss) t = t.replace(/\\[Nn]/g, "\n").replace(/\\h/g, " ");
    t = t
      .replace(/<\d[\d:.]*>/g, "") // WebVTT karaoke timestamps
      .replace(/<(\/?)([a-z][\w-]*)(?:[.\s][^>]*)?\/?>/gi, (_m, slash, tag) =>
        /^[ibu]$/i.test(tag) ? `<${slash}${tag.toLowerCase()}>` : ""
      );
    t = decodeEntities(t);
    const lines = t
      .split("\n")
      .map((l) => l.replace(/[ \t\u00a0]+/g, " ").trim())
      .filter((l) => l && !/^(<\/?[ibu]>)+$/.test(l));
    return { text: lines.join("\n"), top };
  }

  const TIMING_RE =
    /^\s*((?:\d+:)?\d{1,2}:\d{1,2}(?:[.,]\d+)?)\s*-->\s*((?:\d+:)?\d{1,2}:\d{1,2}(?:[.,]\d+)?)(.*)$/;

  // SRT and WebVTT share the "start --> end" timing line, so one tolerant parser handles both.
  function parseTimed(src) {
    const raw = [];
    let cur = null;
    for (const line of src.split(/\r\n|\r|\n/)) {
      const m = TIMING_RE.exec(line);
      if (m) {
        // Files without blank lines between cues leave the next cue's index on the previous one.
        if (cur && cur.lines.length && /^\d+$/.test(cur.lines[cur.lines.length - 1].trim())) {
          cur.lines.pop();
        }
        cur = { start: parseClock(m[1]), end: parseClock(m[2]), lines: [], settings: m[3] };
        raw.push(cur);
      } else if (cur) {
        if (line.trim() === "") cur = null;
        else cur.lines.push(line);
      }
    }
    return raw.map((c) => {
      const { text, top } = cleanText(c.lines.join("\n"), false);
      const pct = /\bline:\s*(-?\d+(?:\.\d+)?)%/.exec(c.settings);
      const num = /\bline:\s*(\d+)(?![\d.%])/.exec(c.settings);
      const vttTop = (pct && +pct[1] < 40) || (num && +num[1] <= 3);
      return { start: c.start, end: c.end, text, top: top || !!vttTop };
    });
  }

  function splitN(s, sep, n) {
    const out = [];
    let rest = s;
    while (out.length < n - 1) {
      const i = rest.indexOf(sep);
      if (i < 0) break;
      out.push(rest.slice(0, i));
      rest = rest.slice(i + 1);
    }
    out.push(rest);
    return out;
  }

  function parseAss(src) {
    const cues = [];
    let section = "";
    let format = null;
    for (const rawLine of src.split(/\r\n|\r|\n/)) {
      const line = rawLine.trim();
      const sec = /^\[(.+)\]$/.exec(line);
      if (sec) {
        section = sec[1].trim().toLowerCase();
        continue;
      }
      if (section !== "events") continue;
      const fm = /^Format\s*:(.*)$/i.exec(line);
      if (fm) {
        format = fm[1].split(",").map((s) => s.trim().toLowerCase());
        continue;
      }
      const dm = /^Dialogue\s*:(.*)$/i.exec(line);
      if (!dm) continue;
      const fields = format || [
        "layer", "start", "end", "style", "name", "marginl", "marginr", "marginv", "effect", "text",
      ];
      const parts = splitN(dm[1], ",", fields.length);
      const field = (name) => {
        const i = fields.indexOf(name);
        return i >= 0 && parts[i] !== undefined ? parts[i] : "";
      };
      const body = field("text");
      if (/\{[^}]*\\p[1-9]/.test(body)) continue; // vector drawings, not text
      const { text, top } = cleanText(body, true);
      cues.push({ start: parseClock(field("start")), end: parseClock(field("end")), text, top });
    }
    return cues;
  }

  function xmlAttr(attrs, name) {
    const re = new RegExp("(?:^|\\s)" + name.replace(":", "\\:") + "\\s*=\\s*(?:\"([^\"]*)\"|'([^']*)')");
    const m = re.exec(attrs);
    return m ? (m[1] !== undefined ? m[1] : m[2]) : null;
  }

  function ttmlTime(v, tickRate, frameRate) {
    if (!v) return NaN;
    v = v.trim();
    let m = /^(\d+(?:\.\d+)?)(h|ms|m|s|f|t)$/.exec(v);
    if (m) {
      const unit = { h: 3600000, m: 60000, s: 1000, ms: 1, f: 1000 / frameRate, t: 1000 / tickRate };
      return Math.round(parseFloat(m[1]) * unit[m[2]]);
    }
    m = /^(\d+):(\d{2}):(\d{2}(?:\.\d+)?)(?::(\d+(?:\.\d+)?))?$/.exec(v);
    if (m) {
      const frames = m[4] ? (parseFloat(m[4]) * 1000) / frameRate : 0;
      return Math.round(((+m[1] * 60 + +m[2]) * 60 + parseFloat(m[3])) * 1000 + frames);
    }
    return parseClock(v);
  }

  function parseTtml(src) {
    const tt = /<(?:[\w-]+:)?tt\b([^>]*)>/.exec(src);
    const ttAttrs = tt ? tt[1] : "";
    const frAttr = parseFloat(xmlAttr(ttAttrs, "ttp:frameRate"));
    let frameRate = frAttr > 0 ? frAttr : 30;
    const mult = (xmlAttr(ttAttrs, "ttp:frameRateMultiplier") || "").split(/\s+/).map(Number);
    if (mult.length === 2 && mult[0] > 0 && mult[1] > 0) frameRate = (frameRate * mult[0]) / mult[1];
    const tickRate = parseFloat(xmlAttr(ttAttrs, "ttp:tickRate")) || (frAttr > 0 ? frameRate : 1);

    const italicStyles = new Set();
    const topRegions = new Set();
    for (const m of src.matchAll(/<(?:[\w-]+:)?style\b([^>]*)>/g)) {
      const id = xmlAttr(m[1], "xml:id") || xmlAttr(m[1], "id");
      if (id && xmlAttr(m[1], "tts:fontStyle") === "italic") italicStyles.add(id);
    }
    for (const m of src.matchAll(/<(?:[\w-]+:)?region\b([^>]*)>/g)) {
      const id = xmlAttr(m[1], "xml:id") || xmlAttr(m[1], "id");
      const origin = /[\d.]+%\s+([\d.]+)%/.exec(xmlAttr(m[1], "tts:origin") || "");
      const extent = /[\d.]+%\s+([\d.]+)%/.exec(xmlAttr(m[1], "tts:extent") || "");
      const align = xmlAttr(m[1], "tts:displayAlign");
      const y = origin ? +origin[1] : null;
      const h = extent ? +extent[1] : null;
      let isTop;
      if (align === "before") isTop = y === null || y < 50;
      else if (align === "after") isTop = y !== null && h !== null && y + h < 50;
      else isTop = y !== null && y < 30 && (h === null || y + h < 60);
      if (id && isTop) topRegions.add(id);
    }
    const isItalic = (attrs) =>
      xmlAttr(attrs, "tts:fontStyle") === "italic" ||
      (xmlAttr(attrs, "style") || "").split(/\s+/).some((s) => italicStyles.has(s));

    const cues = [];
    const pRe = /<(?:[\w-]+:)?p\b([^>]*?)(?:\/>|>([\s\S]*?)<\/(?:[\w-]+:)?p\s*>)/g;
    for (const m of src.matchAll(pRe)) {
      const attrs = m[1];
      const start = ttmlTime(xmlAttr(attrs, "begin"), tickRate, frameRate);
      const endAttr = xmlAttr(attrs, "end");
      const end = endAttr
        ? ttmlTime(endAttr, tickRate, frameRate)
        : start + ttmlTime(xmlAttr(attrs, "dur"), tickRate, frameRate);
      const spans = [];
      let body = (m[2] || "")
        .replace(/\s+/g, " ")
        .replace(/<(?:[\w-]+:)?br\s*\/?>/gi, "\n")
        .replace(/<(\/?)(?:[\w-]+:)?span\b([^>]*)>/gi, (_s, close, a) => {
          if (close) return spans.pop() ? "</i>" : "";
          const it = isItalic(a);
          spans.push(it);
          return it ? "<i>" : "";
        });
      if (isItalic(attrs)) body = "<i>" + body + "</i>";
      const { text } = cleanText(body, false);
      cues.push({ start, end, text, top: topRegions.has(xmlAttr(attrs, "region")) });
    }
    return cues;
  }

  function detectFormat(src) {
    const head = src.slice(0, 4000).trimStart();
    if (/^WEBVTT/.test(head)) return "vtt";
    if (/^\[Script Info\]/im.test(head) || /^\s*\[Events\]/im.test(src) || /^Dialogue\s*:/im.test(src)) {
      return "ass";
    }
    if (/<(?:[\w-]+:)?tt[\s>]/.test(head) || (/^<\?xml/.test(head) && /\bbegin\s*=/.test(src))) {
      return "ttml";
    }
    return "srt";
  }

  const PARSERS = { srt: parseTimed, vtt: parseTimed, ass: parseAss, ttml: parseTtml };

  function normalize(cues) {
    const out = [];
    for (const c of cues) {
      if (!Number.isFinite(c.start) || !c.text) continue;
      const end = Number.isFinite(c.end) && c.end > c.start ? c.end : c.start + 1000;
      const cue = { start: c.start, end, text: c.text };
      if (c.top) cue.top = true;
      out.push(cue);
    }
    out.sort((a, b) => a.start - b.start || a.end - b.end);
    return out.filter(
      (c, i) => i === 0 || c.start !== out[i - 1].start || c.end !== out[i - 1].end || c.text !== out[i - 1].text
    );
  }

  // Returns { format, cues }. Falls back to the other parsers when the detected one finds nothing.
  function parse(src) {
    src = String(src).replace(/^\uFEFF/, "");
    const detected = detectFormat(src);
    for (const format of [detected, "srt", "ass", "ttml"]) {
      const cues = normalize(PARSERS[format](src));
      if (cues.length) return { format, cues };
    }
    return { format: detected, cues: [] };
  }

  // Bytes -> string. Handles BOMs, BOM-less UTF-16 and falls back to Windows-1258 (Vietnamese)
  // for legacy files that are not valid UTF-8.
  function decodeBuffer(buf) {
    const bytes = buf instanceof Uint8Array ? buf : new Uint8Array(buf);
    const dec = (enc, fatal) => new TextDecoder(enc, { fatal: !!fatal }).decode(bytes);
    if (bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf) return dec("utf-8");
    if (bytes[0] === 0xff && bytes[1] === 0xfe) return dec("utf-16le");
    if (bytes[0] === 0xfe && bytes[1] === 0xff) return dec("utf-16be");
    const n = Math.min(bytes.length, 4000);
    let even = 0;
    let odd = 0;
    for (let i = 0; i < n; i++) if (bytes[i] === 0) i % 2 ? odd++ : even++;
    if (odd > n / 8 && odd > even * 4) return dec("utf-16le");
    if (even > n / 8 && even > odd * 4) return dec("utf-16be");
    try {
      return dec("utf-8", true);
    } catch (_e) {
      return dec("windows-1258");
    }
  }

  function formatSrtTime(ms) {
    ms = Math.max(0, Math.round(ms));
    const p2 = (v) => String(v).padStart(2, "0");
    return (
      p2(Math.floor(ms / 3600000)) + ":" + p2(Math.floor(ms / 60000) % 60) + ":" +
      p2(Math.floor(ms / 1000) % 60) + "," + String(ms % 1000).padStart(3, "0")
    );
  }

  function toSrt(cues) {
    return cues
      .filter((c) => c.end > 0)
      .map(
        (c, i) =>
          `${i + 1}\r\n${formatSrtTime(c.start)} --> ${formatSrtTime(c.end)}\r\n` +
          `${c.top ? "{\\an8}" : ""}${c.text.replace(/\n/g, "\r\n")}\r\n`
      )
      .join("\r\n");
  }

  return { parse, decodeBuffer, detectFormat, parseClock, formatSrtTime, toSrt };
});
