// Run from chrome-extension/: node --test
const test = require("node:test");
const assert = require("node:assert/strict");
const { lineStarts, lineTarget } = require("../src/navigation.js");

const starts = lineStarts([
  { start: 10000 },
  { start: 13000 },
  { start: 13000 }, // two speakers at once: one stop
  { start: 14000 },
  { start: 30000 },
]);
const opts = { lead: 300, replay: 1500, slack: 250 };
const next = (t) => lineTarget(starts, t, 1, opts);
const prev = (t) => lineTarget(starts, t, -1, opts);

test("lines starting together are one stop", () => {
  assert.deepEqual(starts, [10000, 13000, 14000, 30000]);
});

test("next: the following line, also right after a jump", () => {
  assert.equal(next(0), 0);
  assert.equal(next(11000), 1); // in the middle of line 0
  assert.equal(next(13000 - 300), 2); // just jumped to line 1 (landed 0.3 s early)
  assert.equal(next(13000 - 300 - 120), 2); // a seek landing a bit early still counts as line 1
  assert.equal(next(20000), 3); // silence
  assert.equal(next(31000), 4); // past the last line (= starts.length)
});

test("previous: replays the current line after 1.5 s, pressing again keeps going back", () => {
  assert.equal(prev(12000), 0); // 2.3 s into line 0 → replay line 0
  assert.equal(prev(10000 - 300), -1); // at the first line → nowhere to go
  assert.equal(prev(14500), 1); // 0.8 s into line 2 → back to line 1
  assert.equal(prev(13000 - 300), 0); // just jumped to line 1 → on to line 0
  assert.equal(prev(25000), 2); // silence after line 2 → replay line 2
  assert.equal(prev(5000), -1); // before the first line
});

test("keys: A/D, Shift+arrows and letters typed by Unikey (Telex)", () => {
  const { lineKey } = require("../src/navigation.js");
  assert.equal(lineKey({ code: "KeyA", key: "a" }), -1);
  assert.equal(lineKey({ code: "KeyD", key: "d" }), 1);
  assert.equal(lineKey({ code: "KeyD", key: "D", shiftKey: true }), 0); // Shift+D is left for other uses
  assert.equal(lineKey({ code: "ArrowLeft", shiftKey: true }), -1);
  assert.equal(lineKey({ code: "ArrowRight", shiftKey: true }), 1);
  assert.equal(lineKey({ code: "ArrowLeft" }), 0); // Netflix's ← (10 s back)
  assert.equal(lineKey({ code: "", key: "â" }), -1); // Unikey: "aa" → "â"
  assert.equal(lineKey({ code: "", key: "Đ" }), 1); // Unikey: "dd" → "đ" (Caps Lock)
  assert.equal(lineKey({ code: "Unidentified", key: "a" }), -1);
  assert.equal(lineKey({ code: "", key: "x" }), 0);
  assert.equal(lineKey({ code: "KeyG", key: "g" }), 0);
  assert.equal(lineKey({ code: "KeyS", key: "s" }), 0); // Netflix's S (skip intro)
});

test("empty list", () => {
  assert.equal(lineTarget([], 1000, 1), 0);
  assert.equal(lineTarget([], 1000, -1), -1);
});
