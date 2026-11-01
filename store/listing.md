# Store listing

Paste each part into the **Store listing** tab of the Developer Dashboard.

## Name and summary

Taken from `manifest.json`:

- **Name:** Netflix Sub Loader
- **Summary (≤132 characters):** Load your own subtitles on Netflix, sync them automatically and find subtitles on SubSource, SubDL and OpenSubtitles.

## Category and language

- **Category:** Lifestyle → Entertainment
- **Language:** English

## Detailed description

Written for search: the first sentence says what the extension is, the phrases people type into Google, the Chrome
Web Store or an AI assistant ("add subtitles to Netflix", "out of sync subtitles", "SRT on Netflix", "subtitles in a
language Netflix doesn't have") appear in plain sentences, and the FAQ answers those questions directly, which is the
form AI assistants quote. The short Vietnamese section lets Vietnamese searches find the listing too; delete it for an
English-only listing.

```
Netflix Sub Loader is a free, open-source Chrome extension that adds your own subtitles to Netflix — SRT, ASS, VTT and more, in any language — and syncs them to the video automatically. Netflix doesn't let you upload subtitle files; Netflix Sub Loader shows them over the video right in your browser, timed to the dialogue, without you having to edit the file.

Watch with subtitles in a language Netflix doesn't offer (such as Vietnamese), with a translation you like better, with fan subtitles for anime, or with the subtitles you use to learn a language.

★ KEY FEATURES
• Custom subtitles on Netflix: drag and drop .srt, .ass/.ssa, .vtt, .ttml/.dfxp/.xml, Excel (.xlsx) or .csv/.tsv files.
• Automatic subtitle sync: your file is compared with Netflix's own subtitle track and the delay is fixed for you — including frame-rate differences (25 fps vs 23.976 fps releases) and versions with scenes added or cut. If the file seems to be for a different episode or version, you get a warning.
• Find subtitles without leaving Netflix: search SubSource (home of the old Subscene archive), SubDL and OpenSubtitles for the exact show, season and episode you are watching, in Vietnamese, English, Japanese, Korean, Thai, Indonesian, Spanish or French. One click downloads and syncs; .zip season packs are unpacked and the right episode is picked for you.
• Fine-tune by hand: move subtitles 0.1 s earlier or later with G / H (1 s with Shift) and compare Netflix's line with yours to check the timing.
• Jump between subtitle lines: A / D (or Shift+← / Shift+→) replays the previous line or skips to the next one — handy for language learning.
• Netflix-style look: Netflix Sans font or a black outline, with adjustable size, position, background and color. Works in fullscreen.
• Remembers your subtitles and sync for each episode (last 40 episodes) and exports the synced subtitles as an .srt file.

★ HOW TO ADD SUBTITLES TO NETFLIX
1. Open a movie or episode on Netflix.
2. Click the Netflix Sub Loader icon in the Chrome toolbar (or press Alt+Shift+S).
3. Drop in a subtitle file, or search online and click "Use".
4. The subtitles appear on the video, already in sync. Change their look in the Display tab.

★ FREQUENTLY ASKED QUESTIONS
How do I fix subtitles that are out of sync on Netflix?
Load the subtitle file with Netflix Sub Loader. It uses Netflix's own subtitles as the timing reference and works out the correct offset by itself, so there is no delay to guess. G / H nudge the timing by hand if you want.

Can I watch Netflix with subtitles in a language Netflix doesn't have?
Yes. Load a subtitle file in any language and it is shown over the video. The timing reference can be in another language, for example English.

Which subtitle formats are supported?
SRT, WebVTT, ASS/SSA, TTML/DFXP (XML), Excel (.xlsx) and CSV/TSV, plus .zip archives downloaded from subtitle sites. .rar and .7z archives are not supported.

Do I need an account to find subtitles?
Loading your own files needs nothing. Searching online needs a free API key from SubSource, SubDL or OpenSubtitles — one is enough — entered once in the extension's settings.

Does it work with Language Reactor?
Yes. A Language Reactor Excel export can be used as the timing reference, and the A / D shortcuts don't jump twice when both extensions are installed.

Is Netflix Sub Loader free? What data does it collect?
It is free and open source, with no ads and no tracking. Subtitles, settings and API keys stay on your device. A search only sends the title, season and episode to the subtitle sites you added a key for.

★ TIẾNG VIỆT
Netflix Sub Loader giúp bạn xem Netflix với phụ đề tiếng Việt hoặc bất kỳ ngôn ngữ nào: chỉ cần thả file .srt, .ass hoặc .vtt vào, phụ đề sẽ hiện trên video và được tự động căn khớp thời gian — không còn cảnh sub bị lệch. Tìm phụ đề tiếng Việt trên SubSource, SubDL và OpenSubtitles ngay trong lúc xem Netflix. Miễn phí, mã nguồn mở, không quảng cáo, không thu thập dữ liệu.

★ SUPPORT
Netflix Sub Loader is free. If it helps you, you can support its development on PayPal: https://www.paypal.com/paypalme/meiskwan
Website: https://meiskwan.github.io/netflix-sub-loader/
Source code, help and bug reports: https://github.com/meIsKwan/netflix-sub-loader

Netflix Sub Loader is an independent project and is not affiliated with, endorsed by or sponsored by Netflix, SubSource, SubDL, OpenSubtitles or Language Reactor.
```

The SUPPORT link is the same as `donateUrl` in `chrome-extension/src/config.js`; if you change one, change the other.

Keep it this way when editing: no keyword lists, "tags" lines or repeated phrases — the Chrome Web Store's spam
policy rejects keyword stuffing. Search engines and AI assistants also trust the listing more when the same wording
appears elsewhere: the website (`docs/index.html`) and the GitHub README use it too, so change them together.

## Images (`images/` folder)

| File | Used as | Size |
|---|---|---|
| `01-find-subtitles.jpg` | Screenshot 1 | 1280×800 |
| `02-auto-sync.jpg` | Screenshot 2 | 1280×800 |
| `03-display.jpg` | Screenshot 3 | 1280×800 |
| `04-watching.jpg` | Screenshot 4 | 1280×800 |
| `05-settings.jpg` | Screenshot 5 | 1280×800 |
| `promo-440x280.jpg` | Small promo tile | 440×280 |
| `marquee-1400x560.jpg` | Marquee promo tile (only shown if the item is featured) | 1400×560 |

The 128×128 store icon comes from `chrome-extension/icons/icon128.png` (90×90 artwork inside a transparent border,
as the store guidelines ask). The screenshots and tiles use an illustrative video background, not Netflix images or
content.

## Other fields

- **Global promo video:** leave empty.
- **Official URL:** None (it only lists sites verified in Google Search Console).
- **Homepage URL:** https://meiskwan.github.io/netflix-sub-loader/
- **Support URL:** https://github.com/meIsKwan/netflix-sub-loader/issues
- **Mature content:** off.
- **Item support:** on, so users can send questions and bug reports from the listing's Support tab.
