// Run from chrome-extension/: node --test
const test = require("node:test");
const assert = require("node:assert/strict");
const P = require("../src/subtitle-parser.js");

const simple = (cues) => cues.map((c) => [c.start, c.end, c.text]);

test("SRT, including a missing blank line and markup", () => {
  const src = `1
00:00:12,480 --> 00:00:15,020
<font color="#ffff00">Where were you last night?</font>

2
00:00:15,900 --> 00:00:17,350
<i>Nowhere</i> special.
3
00:00:18,010 --> 00:00:20,775
{\\an8}Keep your voice down.
`;
  const { format, cues } = P.parse(src);
  assert.equal(format, "srt");
  assert.deepEqual(simple(cues), [
    [12480, 15020, "Where were you last night?"],
    [15900, 17350, "<i>Nowhere</i> special."],
    [18010, 20775, "Keep your voice down."],
  ]);
  assert.equal(cues[2].top, true);
});

test("Netflix style WebVTT", () => {
  const src = `WEBVTT

NOTE Netflix
NOTE Profile: webvtt-lssdh-ios8

1
00:03:07.340 --> 00:03:09.508 position:50.00%,middle align:middle size:80.00% line:84.67%
<c.bg_transparent><i>Previously on Moonlit Harbor</i></c.bg_transparent>

2
00:03:10.093 --> 00:03:11.552 position:50.00%,middle align:middle size:80.00% line:5.33%
<c.bg_transparent>Salt &amp; Pepper</c.bg_transparent>

00:07.250 --> 00:10.500
Xin chào
こんにちは
`;
  const { format, cues } = P.parse(src);
  assert.equal(format, "vtt");
  assert.deepEqual(simple(cues), [
    [7250, 10500, "Xin chào\nこんにちは"],
    [187340, 189508, "<i>Previously on Moonlit Harbor</i>"],
    [190093, 191552, "Salt & Pepper"],
  ]);
  assert.equal(cues[2].top, true);
  assert.equal(cues[1].top, undefined);
});

test("ASS with commas in text, overrides and drawings", () => {
  const src = `[Script Info]
Title: test

[V4+ Styles]
Format: Name, Fontname, Fontsize
Style: Default,Arial,20

[Events]
Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text
Dialogue: 0,0:00:01.50,0:00:04.00,Default,,0,0,0,,Xin chào, thế giới!\\NDòng hai
Dialogue: 0,0:00:05.00,0:00:06.25,Default,,0,0,0,,{\\an8\\i1}Biển hiệu{\\i0}
Comment: 0,0:00:07.00,0:00:08.00,Default,,0,0,0,,bỏ qua
Dialogue: 0,0:00:07.00,0:00:08.00,Sign,,0,0,0,,{\\p1}m 0 0 l 100 0 100 100{\\p0}
`;
  const { format, cues } = P.parse(src);
  assert.equal(format, "ass");
  assert.deepEqual(simple(cues), [
    [1500, 4000, "Xin chào, thế giới!\nDòng hai"],
    [5000, 6250, "<i>Biển hiệu</i>"],
  ]);
  assert.equal(cues[1].top, true);
});

test("Netflix DFXP/TTML with ticks and italic styles", () => {
  const src = `<?xml version="1.0" encoding="utf-8"?>
<tt xmlns="http://www.w3.org/ns/ttml" xmlns:tts="http://www.w3.org/ns/ttml#styling"
    xmlns:ttp="http://www.w3.org/ns/ttml#parameter" ttp:tickRate="10000000">
  <head>
    <styling>
      <style xml:id="s1" tts:fontStyle="normal"/>
      <style xml:id="s2" tts:fontStyle="italic"/>
    </styling>
    <layout>
      <region xml:id="bottom" tts:origin="10% 10%" tts:extent="80% 80%" tts:displayAlign="after"/>
      <region xml:id="top" tts:origin="10% 10%" tts:extent="80% 80%" tts:displayAlign="before"/>
    </layout>
  </head>
  <body><div>
    <p begin="20000000t" end="45000000t" region="bottom" style="s1">Hello<br/>
      world</p>
    <p begin="60000000t" end="70000000t" region="top"><span style="s2">Whispering</span> &amp; more</p>
    <p begin="00:00:08.000" dur="1.5s" region="bottom">Clock time</p>
  </div></body>
</tt>`;
  const { format, cues } = P.parse(src);
  assert.equal(format, "ttml");
  assert.deepEqual(simple(cues), [
    [2000, 4500, "Hello\nworld"],
    [6000, 7000, "<i>Whispering</i> & more"],
    [8000, 9500, "Clock time"],
  ]);
  assert.equal(cues[0].top, undefined);
  assert.equal(cues[1].top, true);
});

test("decodeBuffer handles UTF-8 BOM, UTF-16LE and legacy bytes", () => {
  const text = "1\n00:00:01,000 --> 00:00:02,000\nTiếng Việt\n";
  const utf8 = Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from(text, "utf8")]);
  assert.equal(P.decodeBuffer(utf8), text);
  const utf16 = Buffer.from(text, "utf16le"); // no BOM
  assert.equal(P.decodeBuffer(utf16), text);
  const legacy = Buffer.from([0x43, 0x61, 0x66, 0xe9]); // "Café" in a single-byte code page
  assert.equal(P.decodeBuffer(legacy), "Café");
});

test("toSrt round-trips", () => {
  const cues = [
    { start: 1234, end: 5678, text: "<i>một</i>\nhai" },
    { start: 3723004, end: 3725000, text: "trên", top: true },
  ];
  const back = P.parse(P.toSrt(cues)).cues;
  assert.deepEqual(back, cues);
});
