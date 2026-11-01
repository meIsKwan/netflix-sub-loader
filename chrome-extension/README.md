# Netflix Sub Loader — Chrome extension

Shows your own subtitles (any language) on Netflix, **syncs their timing automatically** against Netflix's own
subtitle track (millisecond accurate) and **finds subtitles** on SubSource, SubDL and OpenSubtitles. No build step,
no external libraries, no dependency on Language Reactor.

## Install (development build)

1. Open `chrome://extensions` and turn on **Developer mode**.
2. Click **Load unpacked** and choose this `chrome-extension` folder.
3. Pin the Netflix Sub Loader icon to the toolbar (puzzle-piece menu → pin) so it is one click away.
4. Open (or reload with F5) a Netflix tab.

After changing the code, click ↻ on the extension in `chrome://extensions`, then reload Netflix.
Publishing to the Chrome Web Store: see [`../store/README.md`](../store/README.md).

## How to use

Open a title on Netflix, then open the panel in any of these ways:

- **click the Netflix Sub Loader icon** in the toolbar,
- the round button at the top right of the video (appears when the mouse moves, also in fullscreen),
- press **Alt+Shift+S** (change it at `chrome://extensions/shortcuts`).

On other sites the icon shows a popup with instructions, a button to open Netflix and a link to the settings.

The panel has a status bar (in sync or not, by how much) and three tabs:

| Tab | What it does |
|---|---|
| **Subtitles** | Drop or choose a file (`.srt` `.vtt` `.ass` `.ssa` `.xml/.dfxp` `.xlsx` `.csv`). Or **search online**: title, season and episode are filled in from Netflix → **Search** → **Use**: downloads, picks the episode's file from season packs and syncs it. |
| **Sync** | The sync result (offset, frame rate, parts with different offsets). Choose which Netflix track is the reference, or a reference file. Manual ±0.1 s / ±1 s offset and a "quick check" comparing the reference line with the line shown. |
| **Display** | Font style (*Netflix style* or *Black outline*), size, position, background, color; download the synced subtitles as `.srt`. |

Subtitles, references and results are remembered per episode (last 40 episodes).
When an automatic sync does not fit (usually a different episode or version), the file's own timing is kept and a
warning is shown.

### Finding subtitles online

Needs a **free API key** from at least one site — open the extension's settings ("Add API key…"):

| Site | Get a key | Notes |
|---|---|---|
| SubSource | <https://subsource.net/api> | The former Subscene collection, the most Vietnamese subtitles |
| SubDL | <https://subdl.com/panel/api> | Large collection, fast downloads |
| OpenSubtitles | <https://www.opensubtitles.com/consumers> | Daily download limit |

Keys stay on the computer and are only sent to their own site. `.rar`/`.7z` archives are not supported — pick
another upload.

### Shortcuts while watching

| Key | Action |
|---|---|
| **A** or **Shift+←** | Previous line. If the current line has played for more than 1.5 s, it is replayed instead; keep pressing to go further back |
| **D** or **Shift+→** | Next line |
| **G** / **H** | Subtitles 0.1 s earlier / later (hold **Shift** for 1 s) |
| **Alt+Shift+S** | Open/close the panel |

While playing, line jumps land 0.3 s early so the start of the line is not cut; while paused they land exactly on
the line. A/D also work with Unikey in Telex mode. When the episode has subtitles from this extension, A/D are
handled here and not passed on to Language Reactor (so they do not jump twice). Netflix's own keys (← → 10 s,
Space, F…) are unchanged.

### Where the reference comes from

- **Automatically from Netflix** (default): the extension reads the subtitle list Netflix's player loads (read-only,
  nothing of Netflix is changed), picks a text track — plain English first, then English (CC) — and downloads it.
  Image-based subtitles (common for Japanese, Chinese, Korean) cannot be used and are skipped.
- **A Language Reactor Excel export**: it only has start times rounded to the second, so the result can be off by
  about ±0.25 s.
- **A .vtt/.xml file downloaded from Netflix**, or any Excel/CSV with a time column and a text column.

## How the automatic sync works

Only the **moments when someone speaks** are compared, so the two files can be in different languages:

1. Compute the exact overlap between the two timelines for every offset within ±30 minutes, also trying the
   common frame-rate ratios (25 ↔ 23.976 fps, 24 ↔ 23.976, 25 ↔ 24) and unusual ratios close to 1.
2. Snap line starts onto the reference's line starts.
3. Find parts with different offsets (a different cut) with dynamic programming, and hide lines from scenes Netflix
   does not have.
4. Rate the match against chance level to warn when the files are not the same episode or version.

On simulated data — constant offsets, wrong frame rates, one or two cuts, different line splits — the median error
is under 15 ms, and a sync takes about 0.1–0.2 s.

## Donate link

The PayPal donate link is `donateUrl` in [`src/config.js`](src/config.js). It is shown in the panel (Display tab),
the popup and the settings page; set it to `""` to hide those links.

## Layout

```
manifest.json            Manifest V3
src/config.js            Publisher settings (donate link)
src/netflix-hook.js      Runs inside the Netflix page: records the subtitle list, seeks through Netflix's player
src/netflix-tracks.js    Picks and downloads a Netflix track as the reference
src/navigation.js        Previous / next line for A / D, Shift+← / Shift+→
src/providers.js         Searches and downloads subtitles through the SubSource, SubDL and OpenSubtitles APIs
src/subtitle-parser.js   Reads SRT, WebVTT, ASS/SSA, TTML/DFXP; writes SRT
src/table-import.js      Reads Excel .xlsx and zip archives (own unzip, no library), CSV/TSV
src/aligner.js           Automatic sync
src/content.js           Subtitle overlay, panel, shortcuts and storage on netflix.com
src/background.js        Service worker: toolbar button, requests to the subtitle sites
pages/popup.*            Popup shown when the icon is clicked outside Netflix
pages/options.*          Settings: API keys, shortcuts, saved data, donate link
tests/                   Tests: run `node --test` in this folder (Node 22+)
```

## Limitations

- Reading subtitles and episode titles and seeking rely on internals of Netflix's player; if Netflix changes them,
  the panel shows the matching error — reference files keep working.
- The SubSource, SubDL and OpenSubtitles API formats follow the open-source Bazarr subtitle downloader and are
  tested against simulated responses, not with real keys yet.
- Requires Chrome 111 or later.
