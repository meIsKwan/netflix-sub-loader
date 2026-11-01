/*
 * Netflix Sub Loader - jumping between subtitle lines (previous / next line hotkeys).
 */
(function (root, factory) {
  const api = factory();
  if (typeof module === "object" && module.exports) module.exports = api;
  else root.NSLNavigation = api;
})(typeof globalThis !== "undefined" ? globalThis : this, function () {
  "use strict";

  // Sorted start times of `cues` (sorted by start); lines that start together are one stop.
  function lineStarts(cues) {
    const out = [];
    for (const c of cues) if (!out.length || c.start - out[out.length - 1] > 1) out.push(c.start);
    return out;
  }

  /**
   * Index in `starts` to jump to from time `t` (ms), or -1 / starts.length when there is
   * nowhere to go. Jumps land `lead` ms before a line, so a line whose landing point is within
   * `slack` ms of `t` counts as the current one.
   *   dir +1: the next line.
   *   dir -1: the start of the current line when it has been playing for over `replay` ms,
   *           otherwise the previous line - so pressing repeatedly keeps going back.
   */
  function lineTarget(starts, t, dir, opts) {
    const { lead = 300, replay = 1500, slack = 250 } = opts || {};
    // k = last line whose landing point has been reached
    let lo = 0;
    let hi = starts.length - 1;
    let k = -1;
    while (lo <= hi) {
      const mid = (lo + hi) >> 1;
      if (starts[mid] - lead <= t + slack) {
        k = mid;
        lo = mid + 1;
      } else hi = mid - 1;
    }
    if (dir > 0) return k + 1;
    if (k < 0) return -1;
    return t - (starts[k] - lead) > replay ? k : k - 1;
  }

  /**
   * Jump direction for a key event, or 0: A / D (as in Language Reactor) and Shift+← / Shift+→.
   * Unikey in Telex mode turns a quick second A or D into a typed "â" / "đ", sent without a
   * physical key code, so those count as well.
   */
  function lineKey(e) {
    if (e.code === "ArrowLeft" || e.code === "ArrowRight") return e.shiftKey ? (e.code === "ArrowLeft" ? -1 : 1) : 0;
    if (e.code === "KeyA" || e.code === "KeyD") return e.shiftKey ? 0 : e.code === "KeyA" ? -1 : 1;
    if (!e.code || e.code === "Unidentified") {
      const k = String(e.key || "").toLowerCase();
      if (k === "a" || k === "â") return -1;
      if (k === "d" || k === "đ") return 1;
    }
    return 0;
  }

  return { lineStarts, lineTarget, lineKey };
});
