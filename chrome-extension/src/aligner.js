/*
 * Netflix Sub Loader - automatic synchronisation of a subtitle against a reference subtitle
 * (e.g. the original Netflix track). Only timing is compared, so the two files can be in
 * different languages.
 *
 * Model: refTime = scale * subTime + offset, where scale covers frame-rate conversions
 * (25 fps PAL vs 23.976 fps, ...) and offset may change between segments (different cuts).
 *
 *  1. For every common frame-rate ratio, compute the exact overlap between the two speech
 *     timelines for all offsets in +/-maxOffset and keep the best ratio/offset.
 *  2. Snap the offset so line starts agree (starts are timed more consistently than ends).
 *  3. Find regions that prefer another offset (sliding windows), then pick an offset per line
 *     with dynamic programming that penalises every change of offset. The piecewise result is
 *     kept only when it clearly matches more lines than the single offset.
 */
(function (root, factory) {
  const api = factory();
  if (typeof module === "object" && module.exports) module.exports = api;
  else root.NSLAligner = api;
})(typeof globalThis !== "undefined" ? globalThis : this, function () {
  "use strict";

  // subFps / refFps: a subtitle timed for subFps playback lands on refFps video at t * ratio.
  const SCALES = [
    { ratio: 1, label: null },
    { ratio: 25 / 23.976, label: "25 → 23.976 fps" },
    { ratio: 23.976 / 25, label: "23.976 → 25 fps" },
    { ratio: 25 / 24, label: "25 → 24 fps" },
    { ratio: 24 / 25, label: "24 → 25 fps" },
    { ratio: 24 / 23.976, label: "24 → 23.976 fps" },
    { ratio: 23.976 / 24, label: "23.976 → 24 fps" },
  ];

  const DEFAULTS = {
    maxOffset: 30 * 60000, // search range of the global offset (+/-)
    coarseStep: 50,
    maxCueDuration: 8000, // long cues (credits, signs) would dominate the overlap score
    piecewise: true,
    windowLines: 40,
    windowStride: 20,
    windowRange: 10 * 60000, // how far a segment may deviate from the global offset
    windowStep: 100,
    splitPenalty: 5000, // ms of overlap a new segment has to gain
    minSegmentLines: 12,
    matchThreshold: 0.5, // share of a line that must overlap reference speech...
    matchTolerance: 400, // ...with its start or end this close (ms) to a reference start/end
    refResolution: 0, // > 0 when reference times are rounded (e.g. 1000 for whole seconds)
  };

  const IDENTITY = { scale: 1, segments: [{ from: null, offset: 0 }], drops: [] };

  const now = () => (typeof performance !== "undefined" ? performance.now() : Date.now());

  // ---------- preparation ----------

  const SOUND_ONLY = /^[[(（［【][^\])）］】]*[\])）］】]$/;
  const SYMBOLS_ONLY = /^[♪♫#*~～〜…\s-]*$/;

  // SDH descriptions ("[door slams]") and bare music notes rarely exist in the other file.
  function isDialogue(text) {
    const lines = text
      .replace(/<[^>]*>/g, "")
      .split("\n")
      .map((l) => l.replace(/^[-–—]\s*/, "").trim())
      .filter(Boolean);
    return lines.length > 0 && !lines.every((l) => SOUND_ONLY.test(l) || SYMBOLS_ONLY.test(l));
  }

  // Dialogue lines sorted by start; `at` is the start that gets snapped to reference starts and
  // `raw` the original start. With rounded reference times (e.g. a Language Reactor export) only
  // starts carry information, so both sides become intervals around their starts: a bucket
  // covering the rounding for the reference, a short mark for the subtitle.
  function prepare(cues, opts, isRef) {
    const coarse = opts.refResolution > 0;
    const half = isRef ? 0.6 * opts.refResolution : 100;
    const out = [];
    for (const c of cues) {
      if (!(c.end > c.start) || !isDialogue(c.text || "")) continue;
      const end = coarse ? c.start + half : Math.min(c.end, c.start + opts.maxCueDuration);
      out.push({ start: coarse ? c.start - half : c.start, end, at: c.start, raw: c.start });
    }
    return out.sort((a, b) => a.start - b.start);
  }

  function transform(lines, k, d) {
    return lines.map((l) => ({ start: l.start * k + d, end: l.end * k + d, at: l.at * k + d, raw: l.raw }));
  }

  // Union of lines[from, to) (sorted by start) as a flat array [s0, e0, s1, e1, ...].
  function unionOf(lines, from, to) {
    const out = [];
    for (let i = from; i < to; i++) {
      const s = lines[i].start;
      const e = lines[i].end;
      const n = out.length;
      if (n && s <= out[n - 1]) {
        if (e > out[n - 1]) out[n - 1] = e;
      } else out.push(s, e);
    }
    return Float64Array.from(out);
  }

  function totalLength(iv) {
    let t = 0;
    for (let i = 0; i < iv.length; i += 2) t += iv[i + 1] - iv[i];
    return t;
  }

  // ---------- overlap as a function of the shift ----------

  // Exact samples of f(x) = |(sub + x) ∩ ref| at x = lo + g * step. f is piecewise linear, so we
  // accumulate its second derivative (four unit impulses per interval pair), split linearly
  // between neighbouring samples; the double running sum is then exact at every sample.
  function overlapProfile(ref, sub, lo, hi, step) {
    const G = Math.max(1, Math.floor((hi - lo) / step) + 1);
    const imp = new Float64Array(G + 1);
    let slope0 = 0;
    let value0 = 0;
    const add = (x, w) => {
      const u = (x - lo) / step;
      if (u <= 0) {
        slope0 += w;
        value0 += w * (lo - x);
      } else if (u < G - 1) {
        const j = Math.floor(u);
        const a = u - j;
        imp[j] += w * (1 - a);
        imp[j + 1] += w * a;
      }
    };
    const nr = ref.length >> 1;
    const ns = sub.length >> 1;
    let first = 0;
    for (let i = 0; i < ns; i++) {
      const s = sub[2 * i];
      const e = sub[2 * i + 1];
      // A pair only matters when its support [a - e, b - s] meets [lo, hi].
      while (first < nr && ref[2 * first + 1] - s < lo) first++;
      for (let j = first; j < nr; j++) {
        const a = ref[2 * j];
        if (a - e > hi) break;
        const b = ref[2 * j + 1];
        add(a - e, 1);
        add(a - s, -1);
        add(b - e, -1);
        add(b - s, 1);
      }
    }
    const out = new Float64Array(G);
    let slope = slope0;
    let val = value0;
    for (let g = 0; g < G; g++) {
      out[g] = val;
      slope += imp[g];
      val += slope * step;
    }
    return out;
  }

  // Highest sample; on a plateau, its centre.
  function bestPeak(values, lo, step) {
    let b = 0;
    for (let i = 1; i < values.length; i++) if (values[i] > values[b]) b = i;
    const tol = Math.max(1e-6, values[b] * 1e-6);
    let l = b;
    let r = b;
    while (l > 0 && values[l - 1] >= values[b] - tol) l--;
    while (r < values.length - 1 && values[r + 1] >= values[b] - tol) r++;
    return { x: lo + ((l + r) / 2) * step, value: values[b] };
  }

  function localPeaks(values, lo, step, count, minSep) {
    const idx = [];
    for (let g = 0; g < values.length; g++) {
      const v = values[g];
      if (v > 0 && (g === 0 || v >= values[g - 1]) && (g === values.length - 1 || v > values[g + 1])) {
        idx.push(g);
      }
    }
    idx.sort((a, b) => values[b] - values[a]);
    const sep = Math.ceil(minSep / step);
    const picked = [];
    for (const g of idx) {
      if (picked.every((p) => Math.abs(p - g) >= sep)) {
        picked.push(g);
        if (picked.length === count) break;
      }
    }
    return picked.map((g) => ({ x: lo + g * step, value: values[g] }));
  }

  // Returns overlap(s, e) = covered length of [s, e] by the reference union.
  function coverage(ref) {
    const n = ref.length >> 1;
    const cum = new Float64Array(n + 1);
    for (let j = 0; j < n; j++) cum[j + 1] = cum[j] + ref[2 * j + 1] - ref[2 * j];
    const upTo = (t) => {
      let lo = 0;
      let hi = n - 1;
      let j = -1;
      while (lo <= hi) {
        const mid = (lo + hi) >> 1;
        if (ref[2 * mid] <= t) {
          j = mid;
          lo = mid + 1;
        } else hi = mid - 1;
      }
      return j < 0 ? 0 : cum[j] + Math.min(t, ref[2 * j + 1]) - ref[2 * j];
    };
    return (s, e) => upTo(e) - upTo(s);
  }

  function nearest(sorted, x) {
    let lo = 0;
    let hi = sorted.length - 1;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (sorted[mid] < x) lo = mid + 1;
      else hi = mid;
    }
    return lo > 0 && Math.abs(sorted[lo - 1] - x) <= Math.abs(sorted[lo] - x) ? lo - 1 : lo;
  }

  function median(values) {
    const a = Float64Array.from(values).sort();
    const m = a.length >> 1;
    return a.length % 2 ? a[m] : (a[m - 1] + a[m]) / 2;
  }

  // Moves `shift` so line starts coincide with reference starts: median of the nearest-start
  // differences, with a shrinking window so unrelated neighbours stop pulling the estimate.
  function snapToStarts(refStarts, lines, from, to, shift, windows) {
    for (const win of windows) {
      const deltas = [];
      for (let i = from; i < to; i++) {
        const s = lines[i].at + shift;
        const delta = refStarts[nearest(refStarts, s)] - s;
        if (Math.abs(delta) <= win) deltas.push(delta);
      }
      if (deltas.length < Math.max(4, (to - from) * 0.2)) break;
      shift += median(deltas);
    }
    return shift;
  }

  // A line matches when it mostly overlaps reference speech and its start or end lands next to
  // a reference start or end. Overlap alone is too lenient: in dialogue-heavy films a random
  // offset still overlaps speech about half of the time.
  function matcher(cov, refStarts, refEnds, threshold, tolerance) {
    return (s, e) => {
      const len = e - s;
      if (!(len > 0) || cov(s, e) < threshold * len) return false;
      return (
        Math.abs(refStarts[nearest(refStarts, s)] - s) <= tolerance ||
        Math.abs(refEnds[nearest(refEnds, e)] - e) <= tolerance
      );
    };
  }

  function countMatches(lines, isMatch, shiftOf, dropped, from, to) {
    let m = 0;
    for (let i = from || 0, n = to === undefined ? lines.length : to; i < n; i++) {
      if (dropped && dropped[i]) continue;
      const sh = shiftOf(i);
      if (isMatch(lines[i].start + sh, lines[i].end + sh)) m++;
    }
    return m;
  }

  // ---------- stage 1: global scale + offset ----------

  function globalSearch(ref, refStarts, sub, opts) {
    let best = null;
    let unity = null;
    for (const sc of SCALES) {
      const lines = transform(sub, sc.ratio, 0);
      const iv = unionOf(lines, 0, lines.length);
      const total = totalLength(iv);
      const lo = -opts.maxOffset;
      const prof = overlapProfile(ref, iv, lo, opts.maxOffset, opts.coarseStep);
      const pk = bestPeak(prof, lo, opts.coarseStep);
      const score = total > 0 ? pk.value / total : 0;
      const cand = { scale: sc.ratio, label: sc.label, offset: pk.x, score, lines };
      if (sc.ratio === 1) unity = cand;
      if (!best || score > best.score) best = cand;
    }
    // Frame-rate conversions are the exception, so they have to win clearly.
    if (best.score < unity.score * 1.03) best = unity;
    const refined = refineScale(ref, sub, best);
    if (refined) best = Object.assign(refined, { label: scaleLabel(refined.scale) });
    best.offset = snapToStarts(refStarts, best.lines, 0, best.lines.length, best.offset, opts.snapWindows);
    return best;
  }

  // Ratios outside the list show up as drift: search nearby ratios while keeping the
  // subtitle's midpoint in place, and accept one only if it clearly fits better.
  function refineScale(ref, sub, best) {
    const mid = (sub[0].start + sub[sub.length - 1].start) / 2;
    const anchor = best.scale * mid + best.offset;
    const evaluate = (k) => {
      const lines = transform(sub, k, 0);
      const iv = unionOf(lines, 0, lines.length);
      const lo = anchor - k * mid - 3000;
      const pk = bestPeak(overlapProfile(ref, iv, lo, lo + 6000, 20), lo, 20);
      return { scale: k, offset: pk.x, score: pk.value / totalLength(iv), lines };
    };
    const base = evaluate(best.scale);
    let top = base;
    for (const [steps, step] of [[15, 1e-4], [10, 1e-5]]) {
      const k0 = top.scale;
      for (let i = -steps; i <= steps; i++) {
        if (i === 0) continue;
        const r = evaluate(k0 * (1 + i * step));
        if (r.score > top.score) top = r;
      }
    }
    return top.score > base.score * 1.02 ? top : null;
  }

  // ---------- stage 2: piecewise offsets ----------

  // Offsets (relative to the global one) that some window of ~40 lines clearly prefers.
  function candidateShifts(ref, g, opts) {
    const R = opts.windowRange;
    const found = [];
    for (let w0 = 0; w0 < g.length; w0 += opts.windowStride) {
      const w1 = Math.min(g.length, w0 + opts.windowLines);
      if (w0 > 0 && w1 - w0 < opts.windowLines / 2) break;
      const iv = unionOf(g, w0, w1);
      const total = totalLength(iv);
      const prof = overlapProfile(ref, iv, -R, R, opts.windowStep);
      for (const p of localPeaks(prof, -R, opts.windowStep, 3, 1000)) {
        if (p.value >= opts.candidateShare * total) found.push(p);
      }
      if (w1 === g.length) break;
    }
    found.sort((a, b) => a.x - b.x);
    const groups = [];
    for (const f of found) {
      const last = groups[groups.length - 1];
      if (last && f.x - last.end <= 200) {
        last.end = f.x;
        if (f.value > last.value) Object.assign(last, { x: f.x, value: f.value });
      } else groups.push({ x: f.x, value: f.value, end: f.x });
    }
    const shifts = groups
      .filter((gr) => Math.abs(gr.x) > 200)
      .sort((a, b) => b.value - a.value)
      .slice(0, 80)
      .map((gr) => gr.x);
    return [0].concat(shifts);
  }

  // Per-line choice among `shifts`, maximising overlap minus `penalty` per change of shift.
  function chooseShifts(cov, g, shifts, penalty) {
    const n = g.length;
    const C = shifts.length;
    const o = new Float64Array(n * C);
    for (let i = 0; i < n; i++) {
      for (let c = 0; c < C; c++) o[i * C + c] = cov(g[i].start + shifts[c], g[i].end + shifts[c]);
    }
    const jumped = new Uint8Array(n * C);
    const bestPrev = new Int32Array(n);
    let prev = new Float64Array(C);
    let cur = new Float64Array(C);
    for (let c = 0; c < C; c++) prev[c] = o[c];
    for (let i = 1; i < n; i++) {
      let b = 0;
      for (let c = 1; c < C; c++) if (prev[c] > prev[b]) b = c;
      bestPrev[i] = b;
      const jump = prev[b] - penalty;
      for (let c = 0; c < C; c++) {
        if (prev[c] >= jump) cur[c] = prev[c] + o[i * C + c];
        else {
          cur[c] = jump + o[i * C + c];
          jumped[i * C + c] = 1;
        }
      }
      const t = prev;
      prev = cur;
      cur = t;
    }
    let c = 0;
    for (let k = 1; k < C; k++) if (prev[k] > prev[c]) c = k;
    const assign = new Int32Array(n);
    for (let i = n - 1; i >= 0; i--) {
      assign[i] = c;
      if (i > 0 && jumped[i * C + c]) c = bestPrev[i];
    }
    return { assign, o, C };
  }

  function mergeRuns(runs) {
    const out = [];
    for (const r of runs) {
      const last = out[out.length - 1];
      if (last && last.c === r.c) last.i1 = r.i1;
      else out.push({ c: r.c, i0: r.i0, i1: r.i1 });
    }
    return out;
  }

  // Short runs are noise (or lines without a counterpart): give them to the better neighbour.
  function absorbShortRuns(runs, score, minLines) {
    const len = (r) => r.i1 - r.i0 + 1;
    while (runs.length > 1) {
      let k = -1;
      for (let j = 0; j < runs.length; j++) {
        if (len(runs[j]) < minLines && (k < 0 || len(runs[j]) < len(runs[k]))) k = j;
      }
      if (k < 0) break;
      const r = runs[k];
      const prev = runs[k - 1];
      const next = runs[k + 1];
      const target = !prev ? next : !next ? prev : score(r, prev.c) >= score(r, next.c) ? prev : next;
      r.c = target.c;
      runs = mergeRuns(runs);
    }
    return runs;
  }

  function refineSegment(ref, refStarts, g, seg, approx, windows) {
    const iv = unionOf(g, seg.i0, seg.i1 + 1);
    const lo = approx - 300;
    const pk = bestPeak(overlapProfile(ref, iv, lo, approx + 300, 10), lo, 10);
    return snapToStarts(refStarts, g, seg.i0, seg.i1 + 1, pk.x, windows);
  }

  // When a segment is pulled back over the previous one (the subtitle contains footage the
  // reference lacks), choose a cut time and drop the lines on the wrong side of it.
  function resolveOverlaps(segs, g, cov, dropped) {
    const slack = 500;
    for (let k = 1; k < segs.length; k++) {
      const A = segs[k - 1];
      const B = segs[k];
      const bStart = g[B.i0].start + B.shift;
      let aEnd = -Infinity;
      for (let i = A.i0; i <= A.i1; i++) aEnd = Math.max(aEnd, g[i].end + A.shift);
      if (aEnd <= bStart + slack) continue;
      const za = [];
      const zb = [];
      for (let i = A.i1; i >= A.i0 && g[i].end + A.shift > bStart; i--) za.push(i);
      for (let i = B.i0; i <= B.i1 && g[i].start + B.shift < aEnd; i++) zb.push(i);
      // Positive only for lines that mostly sit on reference speech, so keeping a line that
      // matches nothing (footage missing from the reference) is never free.
      const fit = (i, sh) => cov(g[i].start + sh, g[i].end + sh) - 0.5 * (g[i].end - g[i].start);
      const cuts = [bStart, aEnd]
        .concat(za.map((i) => g[i].end + A.shift))
        .concat(zb.map((i) => g[i].start + B.shift));
      let best = -Infinity;
      let cut = bStart;
      for (const T of cuts) {
        let s = 0;
        for (const i of za) if (g[i].end + A.shift <= T + slack) s += fit(i, A.shift);
        for (const i of zb) if (g[i].start + B.shift >= T - slack) s += fit(i, B.shift);
        if (s > best) {
          best = s;
          cut = T;
        }
      }
      for (const i of za) if (g[i].end + A.shift > cut + slack) dropped[i] = 1;
      for (const i of zb) if (g[i].start + B.shift < cut - slack) dropped[i] = 1;
      // Lines on either side of the cut that still match nothing belong to that footage too.
      for (let i = A.i1; i >= A.i0 && (dropped[i] || fit(i, A.shift) < 0); i--) dropped[i] = 1;
      for (let i = B.i0; i <= B.i1 && (dropped[i] || fit(i, B.shift) < 0); i++) dropped[i] = 1;
    }
  }

  function piecewise(ref, refStarts, cov, isMatch, g, opts) {
    const shifts = candidateShifts(ref, g, opts);
    if (shifts.length < 2) return null;
    const { assign, o, C } = chooseShifts(cov, g, shifts, opts.penalty);
    const runScore = (r, c) => {
      let s = 0;
      for (let i = r.i0; i <= r.i1; i++) s += o[i * C + c];
      return s;
    };
    const runs = absorbShortRuns(mergeRuns(
      Array.from(assign, (c, i) => ({ c, i0: i, i1: i }))
    ), runScore, opts.minSegmentLines);
    if (runs.length < 2) return null;

    let segs = runs.map((r) => ({ i0: r.i0, i1: r.i1, shift: 0 }));
    const refine = (seg, approx) => refineSegment(ref, refStarts, g, seg, approx, opts.snapWindows);
    segs.forEach((s, k) => (s.shift = refine(s, shifts[runs[k].c])));

    const segMatches = (s, sh) => countMatches(g, isMatch, () => sh, null, s.i0, s.i1 + 1);
    // Merge neighbours that ended up with (almost) the same offset, and segments that do not
    // fit the reference on their own.
    for (let changed = true; changed && segs.length > 1; ) {
      changed = false;
      for (let k = 1; k < segs.length; k++) {
        if (Math.abs(segs[k].shift - segs[k - 1].shift) < 150) {
          const m = { i0: segs[k - 1].i0, i1: segs[k].i1 };
          m.shift = refine(m, segs[k - 1].shift);
          segs.splice(k - 1, 2, m);
          changed = true;
          break;
        }
      }
      if (changed) continue;
      for (let k = 0; k < segs.length; k++) {
        const s = segs[k];
        if (segMatches(s, s.shift) >= opts.minSegmentRatio * (s.i1 - s.i0 + 1)) continue;
        const prev = segs[k - 1];
        const next = segs[k + 1];
        const target =
          !prev ? next : !next ? prev : segMatches(s, prev.shift) >= segMatches(s, next.shift) ? prev : next;
        const m = { i0: Math.min(s.i0, target.i0), i1: Math.max(s.i1, target.i1) };
        m.shift = refine(m, target.shift);
        segs.splice(Math.min(k, segs.indexOf(target)), 2, m);
        changed = true;
        break;
      }
    }
    if (segs.length < 2) return null;

    const dropped = new Uint8Array(g.length);
    resolveOverlaps(segs, g, cov, dropped);
    segs = segs.filter((s) => dropped.subarray(s.i0, s.i1 + 1).includes(0));
    if (segs.length < 2) return null;
    const segOf = new Int32Array(g.length);
    segs.forEach((s, k) => segOf.fill(k, s.i0, s.i1 + 1));
    const matched = countMatches(g, isMatch, (i) => segs[segOf[i]].shift, dropped);
    return { segs, dropped, matched };
  }

  // ---------- public API ----------

  function scaleLabel(scale) {
    const sc = SCALES.find((s) => Math.abs(s.ratio - scale) < 1e-9);
    return sc ? sc.label : scale === 1 ? null : `× ${scale.toFixed(5)}`;
  }

  /**
   * Aligns `subCues` to `refCues` (both [{ start, end, text }] in ms).
   * Returns { alignment, stats }; feed `alignment` to applyAlignment().
   */
  function align(refCues, subCues, options) {
    const t0 = now();
    const opts = Object.assign({}, DEFAULTS, options);
    // Rounded reference times (e.g. whole seconds) need wider windows when comparing starts.
    const res = opts.refResolution;
    const coarse = res > 0;
    opts.snapWindows = coarse ? [1500, 1000, Math.max(150, 0.7 * res)] : [600, 300, 150];
    opts.penalty = opts.splitPenalty * (coarse ? 0.1 : 1); // start marks score ~10x less than lines
    opts.candidateShare = coarse ? 0.7 : 0.5;
    const ref = prepare(refCues, opts, true);
    const sub = prepare(subCues, opts, false);
    if (ref.length < 10 || sub.length < 10) {
      throw new Error("Each file needs at least 10 dialogue lines to compare.");
    }
    const refIv = unionOf(ref, 0, ref.length);
    const refStarts = Float64Array.from(ref, (l) => l.at).sort();
    const refEnds = Float64Array.from(ref, (l) => l.end).sort();
    const cov = coverage(refIv);
    // In start-only mode the buckets around reference starts already mean "close to a start".
    const isMatch = matcher(cov, refStarts, refEnds, opts.matchThreshold, coarse ? Infinity : opts.matchTolerance);

    const baseline = countMatches(sub, isMatch, () => 0);
    const glob = globalSearch(refIv, refStarts, sub, opts);
    const g = transform(sub, glob.scale, glob.offset);
    let segs = [{ i0: 0, i1: g.length - 1, shift: 0 }];
    let dropped = new Uint8Array(g.length);
    let matched = countMatches(g, isMatch, () => 0);
    // Share of lines that match by pure chance, measured at offsets far from the found one.
    const probes = [-131000, -89000, -53000, 37000, 71000, 113000];
    const chance = probes.reduce((acc, p) => acc + countMatches(g, isMatch, () => p), 0) / probes.length / g.length;
    opts.minSegmentRatio = chance + 0.5 * (1 - chance);

    if (opts.piecewise && g.length >= 3 * opts.minSegmentLines) {
      const pw = piecewise(refIv, refStarts, cov, isMatch, g, opts);
      if (pw && pw.matched - matched >= Math.max(5, 0.02 * g.length)) {
        ({ segs, dropped, matched } = pw);
      }
    }

    const firstKept = (s) => {
      for (let i = s.i0; i <= s.i1; i++) if (!dropped[i]) return i;
      return s.i0;
    };
    const segments = segs.map((s, k) => ({
      from: k === 0 ? null : g[firstKept(s)].raw,
      offset: Math.round(glob.offset + s.shift),
    }));
    const drops = [];
    let droppedLines = 0;
    for (let i = 0; i < g.length; i++) {
      if (!dropped[i]) continue;
      let j = i;
      while (j + 1 < g.length && dropped[j + 1]) j++;
      drops.push([g[i].raw, j + 1 < g.length ? g[j + 1].raw : Infinity]);
      droppedLines += j - i + 1;
      i = j;
    }
    const largest = segs.reduce((a, s, k) => (s.i1 - s.i0 > segs[a].i1 - segs[a].i0 ? k : a), 0);
    const matchRatio = matched / sub.length;
    const confidence = Math.max(0, (matchRatio - chance) / (1 - chance));
    return {
      alignment: { scale: glob.scale, segments, drops },
      stats: {
        scale: glob.scale,
        scaleLabel: glob.label,
        offset: segments[largest].offset,
        segments: segments.map((s) => ({
          at: s.from === null ? 0 : Math.round(s.from * glob.scale + s.offset),
          offset: s.offset,
        })),
        matchRatio,
        chanceRatio: chance,
        confidence,
        baselineRatio: baseline / sub.length,
        matchedLines: matched,
        totalLines: sub.length,
        droppedLines,
        quality: confidence >= 0.6 ? "good" : confidence >= 0.35 ? "fair" : "poor",
        elapsedMs: Math.round(now() - t0),
      },
    };
  }

  // Applies an alignment (plus a manual extra offset) and returns new, sorted cues.
  function applyAlignment(cues, alignment, extraOffset) {
    const a = alignment || IDENTITY;
    const segs = a.segments && a.segments.length ? a.segments : IDENTITY.segments;
    const drops = a.drops || [];
    const k = a.scale || 1;
    const extra = extraOffset || 0;
    const out = [];
    for (const c of cues) {
      if (drops.some((z) => c.start >= z[0] && c.start < (z[1] === null ? Infinity : z[1]))) continue;
      let seg = segs[0];
      for (let j = 1; j < segs.length && c.start >= segs[j].from; j++) seg = segs[j];
      const start = c.start * k + seg.offset + extra;
      const end = c.end * k + seg.offset + extra;
      if (end <= 0) continue;
      out.push(Object.assign({}, c, { start: Math.max(0, Math.round(start)), end: Math.round(end) }));
    }
    return out.sort((x, y) => x.start - y.start);
  }

  return { align, applyAlignment, scaleLabel, IDENTITY, _internals: { overlapProfile, coverage } };
});
