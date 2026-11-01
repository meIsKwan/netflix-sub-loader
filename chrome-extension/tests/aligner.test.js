// Run from chrome-extension/: node --test
const test = require("node:test");
const assert = require("node:assert/strict");
const A = require("../src/aligner.js");
const { makeReference, derive } = require("./synthetic.js");

// Timing error of every real line after alignment (Infinity when the line was dropped),
// and how many lines without a counterpart in the reference are still shown.
function evaluate(sub, alignment, scale) {
  const errors = [];
  let extraShown = 0;
  for (const c of sub) {
    const [m] = A.applyAlignment([c], alignment);
    if (c.extra) {
      if (m && c.text === "Extra scene") extraShown++;
      continue;
    }
    errors.push(m ? Math.abs(m.start - (c.truth + (c.start - c.ideal) * scale)) : Infinity);
  }
  errors.sort((a, b) => a - b);
  const q = (p) => errors[Math.min(errors.length - 1, Math.floor(p * errors.length))];
  return { median: q(0.5), p90: q(0.9), p98: q(0.98), extraShown };
}

const CASES = [
  { name: "constant offset +3.2 s", seed: 1, opts: { offset: 3200 } },
  { name: "constant offset -47.3 s", seed: 2, opts: { offset: -47300 } },
  { name: "already in sync", seed: 3, opts: { offset: 0 } },
  { name: "25 fps (PAL) subtitles on 23.976 fps video + 2 s", seed: 4, opts: { scale: 25 / 23.976, offset: 2000 } },
  { name: "23.976 → 24 fps + 10 s", seed: 5, opts: { scale: 23.976 / 24, offset: 10000 } },
  {
    name: "Netflix has 42 s of extra footage",
    seed: 6,
    opts: { offset: 1500, edits: [{ at: 30 * 60000, len: 42000 }] },
    segments: 2,
  },
  {
    name: "subtitles have 35 s of extra footage",
    seed: 7,
    opts: { offset: -800, edits: [{ at: 50 * 60000, len: -35000 }] },
    segments: 2,
  },
  {
    name: "very different line splits + large edge jitter",
    seed: 8,
    opts: { offset: 5400, splitP: 0.25, mergeP: 0.25, jitter: 250, dropP: 0.1 },
    p90: 200,
  },
  {
    name: "2 cuts + PAL",
    seed: 9,
    opts: {
      scale: 25 / 23.976,
      offset: -12000,
      edits: [
        { at: 20 * 60000, len: 65000 },
        { at: 70 * 60000, len: -20000 },
      ],
    },
    segments: 3,
  },
  {
    // Snapping to line starts moves the sub 180 ms later than its author intended; both are fine.
    name: "subtitles start 180 ms early, end 350 ms late",
    seed: 10,
    opts: { offset: 7700, startBias: -180, endBias: 350 },
    median: 220,
    p90: 260,
  },
  { name: "odd ratio × 1.0005 (not a standard fps)", seed: 13, opts: { scale: 1.0005, offset: 4000 }, scaleTol: 2e-5 },
  { name: "22-minute episode", seed: 11, minutes: 22, opts: { offset: -2600 } },
  { name: "170-minute film", seed: 12, minutes: 170, opts: { offset: 31000 } },
];

const rows = [];

for (const tc of CASES) {
  test(tc.name, () => {
    const ref = makeReference(100 + tc.seed, tc.minutes);
    const sub = derive(ref, tc.seed, tc.opts);
    const { alignment, stats } = A.align(ref, sub);
    const ev = evaluate(sub, alignment, alignment.scale);
    rows.push({
      case: tc.name,
      "offsets found (s)": stats.segments.map((s) => (s.offset / 1000).toFixed(3)).join(" | "),
      fps: stats.scaleLabel || "-",
      "match before→after": `${(stats.baselineRatio * 100).toFixed(0)}% → ${(stats.matchRatio * 100).toFixed(0)}%`,
      "median/p90 error (ms)": `${ev.median.toFixed(0)} / ${ev.p90.toFixed(0)}`,
      "extra lines shown": ev.extraShown,
      "time (ms)": stats.elapsedMs,
    });
    assert.ok(Math.abs(alignment.scale - (tc.opts.scale || 1)) < (tc.scaleTol || 1e-9), `scale ${alignment.scale}`);
    assert.equal(alignment.segments.length, tc.segments || 1, JSON.stringify(stats.segments));
    assert.ok(ev.median < (tc.median || 40), `median error ${ev.median}`);
    assert.ok(ev.p90 < (tc.p90 || 120), `p90 error ${ev.p90}`);
    assert.ok(ev.extraShown <= 3, `extra footage lines shown: ${ev.extraShown}`);
    assert.equal(stats.quality, "good");
  });
}

test("unrelated files get a poor rating", () => {
  const ref = makeReference(500);
  const other = derive(makeReference(501), 1, { offset: 0 });
  const { stats } = A.align(ref, other);
  rows.push({
    case: "2 different films",
    "match before→after": `${(stats.baselineRatio * 100).toFixed(0)}% → ${(stats.matchRatio * 100).toFixed(0)}%`,
    "time (ms)": stats.elapsedMs,
  });
  assert.notEqual(stats.quality, "good");
});

test("reference with start times rounded to the second (Language Reactor export)", () => {
  const T = require("../src/table-import.js");
  const fmt = (s) => (s < 60 ? `${s}s` : `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`);
  const truth = makeReference(321, 24);
  // What the export keeps: start times truncated to whole seconds, no end times.
  const lr = T.cuesFromRows([["Time", "Subtitle"], ...truth.map((c) => [fmt(Math.floor(c.start / 1000)), c.text])], "ref");
  assert.equal(lr.resolution, 1000);
  const sub = derive(truth, 9, { offset: -4200, edits: [{ at: 12 * 60000, len: 20000 }] });
  const { alignment, stats } = A.align(lr.cues, sub, { refResolution: lr.resolution });
  const ev = evaluate(sub, alignment, alignment.scale);
  rows.push({
    case: "Language Reactor reference + 1 cut",
    "offsets found (s)": stats.segments.map((s) => (s.offset / 1000).toFixed(3)).join(" | "),
    "match before→after": `${(stats.baselineRatio * 100).toFixed(0)}% → ${(stats.matchRatio * 100).toFixed(0)}%`,
    "median/p90 error (ms)": `${ev.median.toFixed(0)} / ${ev.p90.toFixed(0)}`,
    "time (ms)": stats.elapsedMs,
  });
  assert.equal(alignment.segments.length, 2, JSON.stringify(stats.segments));
  // Rounding to whole seconds leaves up to ~0.25 s of unavoidable error.
  assert.ok(ev.median < 320, `median error ${ev.median}`);
  assert.equal(stats.quality, "good");

  const other = derive(makeReference(322, 24), 1, {});
  assert.equal(A.align(lr.cues, other, { refResolution: 1000 }).stats.quality, "poor");
});

test("applyAlignment adds the manual offset and drops negative lines", () => {
  const cues = [
    { start: 500, end: 1500, text: "a" },
    { start: 10000, end: 11000, text: "b" },
  ];
  const al = { scale: 1, segments: [{ from: null, offset: -1000 }, { from: 5000, offset: 2000 }], drops: [] };
  assert.deepEqual(A.applyAlignment(cues, al, 100), [
    { start: 0, end: 600, text: "a" },
    { start: 12100, end: 13100, text: "b" },
  ]);
});

test.after(() => console.table(rows));
