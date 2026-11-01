// Synthetic subtitle pairs with a known ground truth, for testing the aligner.

function rng(seed) {
  // mulberry32
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// Reference track (the "original" Netflix sub): scenes of dialogue separated by pauses,
// with some SDH-only cues such as "[door slams]".
function makeReference(seed, minutes = 95, { sdh = true } = {}) {
  const r = rng(seed);
  const cues = [];
  let t = 4000 + r() * 30000;
  const end = minutes * 60000;
  while (t < end) {
    const lines = 2 + Math.floor(r() * 30);
    for (let k = 0; k < lines && t < end; k++) {
      const dur = 800 + r() * 3600;
      cues.push({ start: Math.round(t), end: Math.round(t + dur), text: `Line ${cues.length}` });
      if (sdh && r() < 0.06) {
        const s = t + dur + 200;
        cues.push({ start: Math.round(s), end: Math.round(s + 1200), text: "[door slams]" });
      }
      t += dur + 60 + (r() < 0.75 ? r() * 1000 : 1000 + r() * 5000);
    }
    t += 2000 + r() * 45000;
  }
  return cues.sort((a, b) => a.start - b.start);
}

/**
 * A "downloaded" subtitle derived from `ref`: re-segmented (splits/merges), jittered, with
 * missing and extra lines, then put on its own timeline so that refTime = scale * subTime + offset.
 * edits (ref time): { at, len > 0 } = the reference has `len` ms of footage the sub lacks;
 *                   { at, len < 0 } = the sub has |len| ms of extra footage inserted at `at`.
 * Every cue carries `truth` (its ideal ref start) and `ideal` (its ideal sub start), or `extra`.
 */
function derive(ref, seed, opts = {}) {
  const {
    offset = 0, scale = 1, jitter = 120, splitP = 0.08, mergeP = 0.1, dropP = 0.05,
    extraP = 0.02, edits = [], startBias = 0, endBias = 0,
  } = opts;
  const r = rng(seed);
  const noise = () => (r() + r() + r() - 1.5) * jitter;
  const dialog = ref.filter((c) => !c.text.startsWith("["));
  const removed = (t) => edits.some((e) => e.len > 0 && t >= e.at && t < e.at + e.len);
  // ref time -> sub timeline before offset/scale
  const shiftAt = (t) =>
    edits.reduce((acc, e) => {
      if (e.len > 0 && t >= e.at + e.len) return acc - e.len;
      if (e.len < 0 && t >= e.at) return acc - e.len;
      return acc;
    }, 0);
  const toSub = (t) => (t + shiftAt(t) - offset) / scale;

  const parts = [];
  for (let i = 0; i < dialog.length; i++) {
    const c = dialog[i];
    if (r() < dropP) continue;
    if (r() < mergeP && i + 1 < dialog.length && dialog[i + 1].start - c.end < 1500) {
      const nx = dialog[++i];
      parts.push({ s: c.start, e: nx.end, text: `Sub ${c.text} + ${nx.text}` });
    } else if (r() < splitP && c.end - c.start > 2000) {
      const mid = (c.start + c.end) / 2;
      parts.push({ s: c.start, e: mid - 40, text: `Sub ${c.text} (1)` });
      parts.push({ s: mid, e: c.end, text: `Sub ${c.text} (2)` });
    } else parts.push({ s: c.start, e: c.end, text: `Sub ${c.text}` });
  }
  const cues = [];
  for (const p of parts) {
    if (removed(p.s)) continue;
    const ideal = toSub(p.s);
    const idealEnd = (p.e + shiftAt(p.s) - offset) / scale; // same cut as the start
    const s = ideal + (startBias + noise()) / scale;
    const e = idealEnd + (endBias + noise()) / scale;
    cues.push({ start: Math.round(s), end: Math.round(Math.max(e, s + 300)), text: p.text, truth: p.s, ideal });
    if (r() < extraP) {
      const xs = idealEnd + 400;
      cues.push({ start: Math.round(xs), end: Math.round(xs + 2500), text: "Subtitles by the XYZ team", extra: true });
    }
  }
  // Extra footage in the sub gets its own dialogue that does not exist in the reference.
  for (const e of edits.filter((x) => x.len < 0)) {
    let t = (e.at - offset + shiftAt(e.at - 1)) / scale + 1500 / scale;
    const stop = (e.at - offset + shiftAt(e.at - 1) - e.len) / scale - 800;
    while (t < stop) {
      const dur = (900 + r() * 2500) / scale;
      cues.push({ start: Math.round(t), end: Math.round(Math.min(t + dur, stop)), text: "Extra scene", extra: true });
      t += dur + (100 + r() * 900) / scale;
    }
  }
  return cues.sort((a, b) => a.start - b.start);
}

module.exports = { rng, makeReference, derive };
