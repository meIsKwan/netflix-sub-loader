/*
 * Netflix Sub Loader - subtitles from spreadsheets: Excel .xlsx (read without libraries) and
 * CSV/TSV, e.g. a Language Reactor export (columns Time | Subtitle | ...). Columns are detected
 * from headers and content: a start time (optionally end time or duration, or one
 * "start --> end" column) and the subtitle text.
 */
(function (root, factory) {
  const api = factory();
  if (typeof module === "object" && module.exports) module.exports = api;
  else root.NSLTable = api;
})(typeof globalThis !== "undefined" ? globalThis : this, function () {
  "use strict";

  // ---------- .xlsx = zip of XML parts ----------

  const bytesOf = (buf) => (buf instanceof Uint8Array ? buf : new Uint8Array(buf));

  function isZip(buf) {
    const u8 = bytesOf(buf);
    return u8.length > 4 && u8[0] === 0x50 && u8[1] === 0x4b && u8[2] === 0x03 && u8[3] === 0x04;
  }

  async function inflateRaw(data) {
    const stream = new Blob([data]).stream().pipeThrough(new DecompressionStream("deflate-raw"));
    return new Uint8Array(await new Response(stream).arrayBuffer());
  }

  // Extracts the entries whose name passes `wanted`, using the zip's central directory.
  async function unzip(buf, wanted) {
    const u8 = bytesOf(buf);
    const dv = new DataView(u8.buffer, u8.byteOffset, u8.byteLength);
    let eocd = -1;
    for (let i = u8.length - 22; i >= Math.max(0, u8.length - 65557); i--) {
      if (dv.getUint32(i, true) === 0x06054b50) {
        eocd = i;
        break;
      }
    }
    if (eocd < 0) throw new Error("The Excel file is damaged or not in .xlsx format.");
    const count = dv.getUint16(eocd + 10, true);
    let p = dv.getUint32(eocd + 16, true);
    const utf8 = new TextDecoder();
    const files = new Map();
    for (let n = 0; n < count && p + 46 <= u8.length && dv.getUint32(p, true) === 0x02014b50; n++) {
      const method = dv.getUint16(p + 10, true);
      const size = dv.getUint32(p + 20, true);
      const nameLen = dv.getUint16(p + 28, true);
      const local = dv.getUint32(p + 42, true);
      const name = utf8.decode(u8.subarray(p + 46, p + 46 + nameLen));
      p += 46 + nameLen + dv.getUint16(p + 30, true) + dv.getUint16(p + 32, true);
      if (!wanted(name)) continue;
      const start = local + 30 + dv.getUint16(local + 26, true) + dv.getUint16(local + 28, true);
      const data = u8.subarray(start, start + size);
      if (method === 0) files.set(name, data);
      else if (method === 8) files.set(name, await inflateRaw(data));
    }
    return files;
  }

  function xmlText(s) {
    return s
      .replace(/&(#x[0-9a-f]+|#\d+|amp|lt|gt|quot|apos);/gi, (m, e) => {
        if (e[0] !== "#") return { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'" }[e.toLowerCase()];
        const n = e[1] === "x" || e[1] === "X" ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10);
        return n <= 0x10ffff ? String.fromCodePoint(n) : m;
      })
      .replace(/_x([0-9a-f]{4})_/gi, (_m, h) => String.fromCharCode(parseInt(h, 16)));
  }

  // Text of a shared-string item or inline string: every <t> run, without phonetic hints.
  function runsText(xml) {
    let out = "";
    const body = xml.replace(/<(?:\w+:)?rPh\b[\s\S]*?<\/(?:\w+:)?rPh>/g, "");
    for (const m of body.matchAll(/<(?:\w+:)?t(?:\s[^>]*)?>([\s\S]*?)<\/(?:\w+:)?t>/g)) out += xmlText(m[1]);
    return out;
  }

  function colIndex(letters) {
    let n = 0;
    for (let i = 0; i < letters.length; i++) n = n * 26 + (letters.charCodeAt(i) - 64);
    return n - 1;
  }

  function sheetRows(xml, strings) {
    const rows = [];
    for (const rm of xml.matchAll(/<(?:\w+:)?row\b[^>]*?(?:\/>|>([\s\S]*?)<\/(?:\w+:)?row>)/g)) {
      const row = [];
      let next = 0;
      for (const cm of (rm[1] || "").matchAll(/<(?:\w+:)?c\b([^>]*?)(?:\/>|>([\s\S]*?)<\/(?:\w+:)?c>)/g)) {
        const ref = /\br="([A-Z]+)\d+"/.exec(cm[1]);
        const col = ref ? colIndex(ref[1]) : next;
        next = col + 1;
        const type = (/\bt="(\w+)"/.exec(cm[1]) || [])[1] || "n";
        const body = cm[2] || "";
        const v = /<(?:\w+:)?v>([\s\S]*?)<\/(?:\w+:)?v>/.exec(body);
        let value = "";
        if (type === "s") value = v ? strings[+v[1]] || "" : "";
        else if (type === "inlineStr") value = runsText(body);
        else if (type === "str") value = v ? xmlText(v[1]) : "";
        else if (type === "n" && v) value = Number(v[1]);
        row[col] = value;
      }
      rows.push(Array.from(row, (x) => (x === undefined ? "" : x)));
    }
    return rows;
  }

  // Every worksheet as an array of rows (cells are strings or numbers).
  async function sheetsFromXlsx(buf) {
    const files = await unzip(buf, (n) => n === "xl/sharedStrings.xml" || /^xl\/worksheets\/[^/]+\.xml$/.test(n));
    const utf8 = new TextDecoder();
    const strings = [];
    const ss = files.get("xl/sharedStrings.xml");
    if (ss) {
      for (const m of utf8.decode(ss).matchAll(/<(?:\w+:)?si\b[^>]*?(?:\/>|>([\s\S]*?)<\/(?:\w+:)?si>)/g)) {
        strings.push(runsText(m[1] || ""));
      }
    }
    const num = (n) => parseInt(n.replace(/\D+/g, ""), 10) || 0;
    return [...files.keys()]
      .filter((n) => n !== "xl/sharedStrings.xml")
      .sort((a, b) => num(a) - num(b))
      .map((n) => sheetRows(utf8.decode(files.get(n)), strings));
  }

  // ---------- CSV / TSV ----------

  function rowsFromCsv(text) {
    // SRT-style "00:00:01,000" pasted into a comma-separated file would split the milliseconds off.
    text = text.replace(/(\d:\d{2}),(\d{3})(?!\d)/g, "$1.$2");
    const sample = text.split(/\r\n|\r|\n/).filter((l) => l.trim()).slice(0, 30);
    const medianCount = (d) => {
      const counts = sample.map((l) => l.split(d).length - 1).sort((a, b) => a - b);
      return counts.length ? counts[counts.length >> 1] : 0;
    };
    let delim = "\t";
    for (const d of ["\t", ";", ","]) if (medianCount(d) > medianCount(delim)) delim = d;
    const rows = [];
    let row = [];
    let field = "";
    let quoted = false;
    for (let i = 0; i < text.length; i++) {
      const ch = text[i];
      if (quoted) {
        if (ch !== '"') field += ch;
        else if (text[i + 1] === '"') {
          field += '"';
          i++;
        } else quoted = false;
      } else if (ch === '"' && field === "") quoted = true;
      else if (ch === delim) {
        row.push(field);
        field = "";
      } else if (ch === "\n" || ch === "\r") {
        if (ch === "\r" && text[i + 1] === "\n") i++;
        row.push(field);
        rows.push(row);
        row = [];
        field = "";
      } else field += ch;
    }
    if (field || row.length) {
      row.push(field);
      rows.push(row);
    }
    return rows;
  }

  // ---------- rows -> cues ----------

  const RANGE =
    /^\s*((?:\d+:)?\d{1,2}:\d{1,2}(?:[.,]\d+)?)\s*-->\s*((?:\d+:)?\d{1,2}:\d{1,2}(?:[.,]\d+)?)/;

  // A time cell as { ms } or, for bare numbers whose unit depends on the column, { num }.
  // Accepts "1:02:03,456", "1:30", "00:01:02:12" (frames), "6s", "1m30s", "1500ms", "62.5".
  function timeOf(v) {
    if (typeof v === "number") return Number.isFinite(v) ? { num: v } : null;
    const s = String(v).trim().toLowerCase();
    if (!s) return null;
    let m = /^(?:(\d+):)?(\d{1,2}):(\d{1,2})(?:[.,](\d{1,3}))?$/.exec(s);
    if (m) {
      const frac = m[4] ? Math.round(Number("0." + m[4]) * 1000) : 0;
      return { ms: ((+(m[1] || 0) * 60 + +m[2]) * 60 + +m[3]) * 1000 + frac };
    }
    m = /^(\d+):(\d{1,2}):(\d{1,2})[:;](\d{1,2})$/.exec(s);
    if (m) return { ms: ((+m[1] * 60 + +m[2]) * 60 + +m[3]) * 1000 + Math.round((+m[4] * 1000) / 25) };
    m = /^(\d+(?:[.,]\d+)?)\s*ms$/.exec(s);
    if (m) return { ms: Math.round(parseFloat(m[1].replace(",", "."))) };
    m = /^(?:(\d+)\s*h)?\s*(?:(\d+)\s*m(?:in)?)?\s*(?:(\d+(?:[.,]\d+)?)\s*s(?:ec)?)?$/.exec(s);
    if (m && (m[1] || m[2] || m[3])) {
      const sec = (+(m[1] || 0) * 60 + +(m[2] || 0)) * 60 + parseFloat((m[3] || "0").replace(",", "."));
      return { ms: Math.round(sec * 1000) };
    }
    if (/^\d+(?:[.,]\d+)?$/.test(s)) return { num: parseFloat(s.replace(",", ".")) };
    return null;
  }

  // Header names, compared without Vietnamese diacritics.
  const norm = (s) =>
    String(s)
      .normalize("NFD")
      .replace(/[̀-ͯ]/g, "")
      .replace(/[đĐ]/g, "d")
      .toLowerCase()
      .replace(/[^a-z0-9#]+/g, " ")
      .trim();
  const has = (name, words) => !!name && words.some((w) => (" " + name + " ").includes(" " + w + " "));
  const H = {
    start: ["start", "begin", "in", "from", "time", "timing", "timecode", "tc", "bat dau", "thoi gian", "tu", "vao", "moc"],
    end: ["end", "stop", "out", "to", "ket thuc", "den", "ra"],
    dur: ["duration", "dur", "length", "thoi luong", "do dai"],
    index: ["#", "stt", "no", "index", "id", "so thu tu"],
    text: ["text", "subtitle", "subtitles", "sub", "caption", "captions", "dialogue", "dialog", "line", "cau",
      "noi dung", "loi", "loi thoai", "thoai", "phu de"],
    original: ["original", "source", "english", "eng", "en", "goc", "ban goc", "tieng anh", "nguyen ban",
      "japanese", "ja", "jp", "tieng nhat"],
    translation: ["translation", "translated", "target", "vietnamese", "viet", "vi", "dich", "ban dich",
      "tieng viet", "nghia"],
    ms: ["ms", "msec", "milliseconds"],
    sec: ["s", "sec", "secs", "seconds", "giay"],
  };

  function analyse(data, names, width) {
    const cols = [];
    for (let c = 0; c < width; c++) {
      const col = { index: c, name: names[c] || "", filled: 0, ranges: 0, clocks: 0, nums: [], texts: 0 };
      for (const r of data) {
        const v = r[c];
        if (v === "" || v === undefined || v === null) continue;
        col.filled++;
        if (typeof v === "string" && RANGE.test(v)) col.ranges++;
        else {
          const t = timeOf(v);
          if (t && t.num !== undefined) col.nums.push(t.num);
          else if (t) col.clocks++;
          else if (/\p{L}/u.test(String(v))) col.texts++;
        }
      }
      cols.push(col);
    }
    return cols;
  }

  // ms per unit of a numeric time column.
  function unitOf(col) {
    if (has(col.name, H.ms)) return 1;
    if (has(col.name, H.sec)) return 1000;
    const max = Math.max(...col.nums);
    if (max < 1) return 86400000; // Excel time cells are fractions of a day
    return max >= 50000 ? 1 : 1000;
  }

  // Seconds a viewer needs for a line: ~4 CJK characters or ~15 Latin letters per second.
  function readingTime(text) {
    let ms = 600;
    for (const ch of text) ms += /[　-鿿가-힯＀-￯]/.test(ch) ? 220 : 65;
    return Math.min(6500, Math.max(1000, ms));
  }

  /**
   * Converts spreadsheet rows to cues. `role` ("ref" or "sub") picks the text column when the
   * sheet has both an original and a translation. Returns { cues, resolution, columns }, where
   * resolution is 1000 when the sheet only has start times rounded to whole seconds.
   */
  function cuesFromRows(rows, role) {
    const none = { cues: [], resolution: 0, columns: null };
    rows = rows.filter((r) => r.some((v) => v !== "" && v !== undefined && v !== null));
    if (rows.length < 2) return none;
    const first = rows[0];
    const isHeader =
      first.every((v) => typeof v !== "number" && !timeOf(v) && !RANGE.test(String(v))) &&
      first.some((v) => /\p{L}/u.test(String(v)));
    const data = isHeader ? rows.slice(1) : rows;
    const width = Math.max(...rows.map((r) => r.length));
    const labels = Array.from({ length: width }, (_v, c) =>
      isHeader && String(first[c] || "").trim() ? String(first[c]).trim() : "column " + String.fromCharCode(65 + (c % 26))
    );
    const cols = analyse(data, isHeader ? first.map(norm) : [], width);
    const enough = (col, k) => col.filled >= 0.3 * data.length && k >= 0.7 * col.filled;
    const isIndex = (col) => {
      if (has(col.name, H.index)) return true;
      const n = col.nums;
      if (n.length < 3 || n.some((x) => !Number.isInteger(x))) return false;
      let ones = 0;
      for (let i = 1; i < n.length; i++) if (n[i] - n[i - 1] === 1) ones++;
      return ones >= 0.8 * (n.length - 1);
    };

    const range = cols.find((col) => enough(col, col.ranges));
    const timed = cols.filter((col) => col !== range && !isIndex(col) && enough(col, col.clocks + col.nums.length));
    let start = null;
    let end = null;
    let dur = null;
    if (!range) {
      start = timed.find((col) => has(col.name, H.start) && !has(col.name, H.end) && !has(col.name, H.dur)) ||
        timed.find((col) => !has(col.name, H.end) && !has(col.name, H.dur));
      if (!start) return none;
      const rest = timed.filter((col) => col !== start);
      end = rest.find((col) => has(col.name, H.end)) || null;
      dur = rest.find((col) => has(col.name, H.dur)) || null;
      if (!end && !dur && rest.length && !rest[0].name) end = rest[0]; // headerless: start, end
    }
    const used = [range, start, end, dur];
    const texts = cols.filter((col) => !used.includes(col) && enough(col, col.texts));
    const prefer = role === "ref" ? [H.original, H.text, H.translation] : [H.translation, H.text, H.original];
    let text = null;
    for (const words of prefer) if (!text) text = texts.find((col) => has(col.name, words)) || null;
    if (!text && texts.length) text = role === "ref" ? texts[0] : texts[texts.length - 1];

    const toMs = (v, col) => {
      const t = timeOf(v);
      if (!t) return NaN;
      return t.num === undefined ? t.ms : Math.round(t.num * unitOf(col));
    };
    const cues = [];
    for (const r of data) {
      let s;
      let e = NaN;
      if (range) {
        const m = RANGE.exec(String(r[range.index] || ""));
        if (!m) continue;
        s = timeOf(m[1]).ms;
        e = timeOf(m[2]).ms;
      } else {
        s = toMs(r[start.index], start);
        if (end) e = toMs(r[end.index], end);
        else if (dur) e = s + toMs(r[dur.index], dur);
      }
      if (!Number.isFinite(s)) continue;
      const t = text ? String(r[text.index] === undefined ? "" : r[text.index]).replace(/\r\n?/g, "\n").trim() : "";
      if (!t && role !== "ref") continue;
      cues.push({ start: s, end: e, text: t || "…" });
    }
    cues.sort((a, b) => a.start - b.start);

    // Start times rounded to whole seconds (Language Reactor): the real start lies in [t, t+1 s)
    // if the exporter truncated or in [t-0.5 s, t+0.5 s) if it rounded; t + 0.25 s is off by at
    // most 0.25 s on average either way.
    const startsOnly = !range && !end && !dur;
    const resolution = startsOnly && cues.length && cues.every((c) => c.start % 1000 === 0) ? 1000 : 0;
    if (resolution) for (const c of cues) c.start += 250;
    for (let i = 0; i < cues.length; i++) {
      const c = cues[i];
      if (Number.isFinite(c.end) && c.end > c.start) continue;
      let next = i + 1;
      while (next < cues.length && cues[next].start <= c.start) next++;
      const want = readingTime(c.text);
      const room = next < cues.length ? cues[next].start - c.start - 80 : Infinity;
      c.end = c.start + Math.max(Math.min(want, room), Math.min(want, 500));
    }
    const label = (col) => (col ? labels[col.index] : null);
    return {
      cues,
      resolution,
      columns: { time: label(range || start), end: label(end), duration: label(dur), text: label(text) },
    };
  }

  // Reads an .xlsx/.csv/.tsv file (bytes) and returns the sheet that yields the most cues.
  async function cuesFromFile(name, buf, role, decodeText) {
    let sheets;
    if (isZip(buf)) sheets = await sheetsFromXlsx(buf);
    else sheets = [rowsFromCsv(decodeText(buf))];
    let best = { cues: [], resolution: 0, columns: null };
    for (const rows of sheets) {
      const r = cuesFromRows(rows, role);
      if (r.cues.length > best.cues.length) best = r;
    }
    return best;
  }

  return { isZip, unzip, sheetsFromXlsx, rowsFromCsv, cuesFromRows, cuesFromFile, timeOf };
});
