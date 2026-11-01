// Run from chrome-extension/: node --test
const test = require("node:test");
const assert = require("node:assert/strict");
const T = require("../src/table-import.js");
const P = require("../src/subtitle-parser.js");
const { xlsx } = require("./xlsx-writer.js");

const simple = (cues) => cues.map((c) => [c.start, c.end, c.text]);
const fromCsv = (text, role) => T.cuesFromFile("x.csv", Buffer.from(text, "utf8"), role, P.decodeBuffer);

test("CSV with Vietnamese headers: skips the index column, picks the text column by role", async () => {
  const csv = [
    "STT;Bắt đầu;Kết thúc;Tiếng Anh;Tiếng Việt",
    '1;00:00:01,000;00:00:02,500;Hello;"Xin chào; bạn"',
    "2;00:00:03,250;00:00:05,000;Bye;Tạm biệt",
    "3;00:01:00,000;00:01:02,000;Again;Lại nữa",
  ].join("\r\n");
  const ref = await fromCsv(csv, "ref");
  assert.deepEqual(simple(ref.cues), [
    [1000, 2500, "Hello"],
    [3250, 5000, "Bye"],
    [60000, 62000, "Again"],
  ]);
  assert.deepEqual(ref.columns, { time: "Bắt đầu", end: "Kết thúc", duration: null, text: "Tiếng Anh" });
  assert.equal(ref.resolution, 0);
  const sub = await fromCsv(csv, "sub");
  assert.equal(sub.cues[0].text, "Xin chào; bạn");
  assert.equal(sub.columns.text, "Tiếng Việt");
});

test("CSV with one 'start --> end' column and no header", async () => {
  const csv = '00:00:01,000 --> 00:00:02,000,"One, two"\n00:00:04.500 --> 00:00:06.000,Three\n00:00:07,000 --> 00:00:08,000,Four\n';
  const { cues } = await fromCsv(csv, "sub");
  assert.deepEqual(simple(cues), [
    [1000, 2000, "One, two"],
    [4500, 6000, "Three"],
    [7000, 8000, "Four"],
  ]);
});

test("Language Reactor Excel: start times only, rounded to the second", async () => {
  const buf = xlsx([
    ["Time", "Subtitle", "Romaji", "Hiragana"],
    ["6s", ["♪", "～"], "♪ ～", "♪ ～"],
    ["1:37", ["-", "（", "アレン", "）", "ねえ", " ", "パパ", "\n", "-", "（ロダン）ん？"], "- ( aren ) nee papa", "x"],
    ["1:38", "鑑定の儀って_x000D_\nどんなものなの？", "kantei", "かんてい"],
    ["1:02:03", "最後", "saigo", "さいご"],
  ]);
  assert.ok(T.isZip(buf));
  const r = await T.cuesFromFile("lr.xlsx", buf, "ref", P.decodeBuffer);
  assert.equal(r.resolution, 1000);
  assert.deepEqual(r.columns, { time: "Time", end: null, duration: null, text: "Subtitle" });
  assert.deepEqual(r.cues.map((c) => [c.start, c.text]), [
    [6250, "♪～"],
    [97250, "-（アレン）ねえ パパ\n-（ロダン）ん？"],
    [98250, "鑑定の儀って\r\nどんなものなの？".replace("\r", "")],
    [3723250, "最後"],
  ]);
  // end times are estimated and never run into the next line
  assert.equal(r.cues[1].end, 98250 - 80);
  assert.ok(r.cues[3].end > r.cues[3].start);
});

test("Excel with numeric time cells (fractions of a day) and Start/End columns", async () => {
  const day = 86400000;
  const buf = xlsx([
    ["Start", "End", "Text"],
    [61500 / day, 63000 / day, "One"],
    [70250 / day, 72000 / day, "Two"],
    [3600000 / day, 3602500 / day, "Three"],
  ]);
  const r = await T.cuesFromFile("t.xlsx", buf, "sub", P.decodeBuffer);
  assert.deepEqual(simple(r.cues), [
    [61500, 63000, "One"],
    [70250, 72000, "Two"],
    [3600000, 3602500, "Three"],
  ]);
  assert.equal(r.resolution, 0);
});

test("no time column means no cues", async () => {
  const r = await fromCsv("Tên,Ghi chú\nAn,abc\nBình,def\n", "ref");
  assert.equal(r.cues.length, 0);
});

test("timeOf understands the usual time formats", () => {
  assert.equal(T.timeOf("6s").ms, 6000);
  assert.equal(T.timeOf("1m30s").ms, 90000);
  assert.equal(T.timeOf("1500ms").ms, 1500);
  assert.equal(T.timeOf("01:02:03.5").ms, 3723500);
  assert.equal(T.timeOf("00:00:01:12").ms, 1480);
  assert.equal(T.timeOf("62.5").num, 62.5);
  assert.equal(T.timeOf("hello"), null);
});
