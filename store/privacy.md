# Answers for the Privacy practices tab

The Developer Dashboard requires these before an item can be submitted.

## Single purpose

> Show external subtitles on Netflix videos and automatically sync their timing to the video.

## Permission justifications

| Permission | Justification |
|---|---|
| `storage` | Stores the subtitles the user chose, sync results, display settings and the user's subtitle-site API keys on the device. |
| `unlimitedStorage` | Subtitles for up to 40 episodes, plus the reference tracks used for syncing, can exceed the default 10 MB quota. |
| `scripting` | When a Netflix tab was already open before the extension was installed or updated, clicking the toolbar icon injects the script into that tab so the panel opens without reloading. |
| Host `www.netflix.com` | Displays subtitles over the video; reads the Netflix player's subtitle list, episode title and playback time to sync subtitles and jump between lines. |
| Hosts `api.subsource.net`, `api.subdl.com`, `dl.subdl.com`, `*.opensubtitles.com`, `*.opensubtitles.org` | Searches and downloads subtitles from these sites through their official APIs, only when the user searches or downloads, using the user's own API key. |

## Remote code

Choose **No, I am not using remote code**. All code is inside the package.

## Data usage

Tick these data types:

- **Website content:** subtitle text and episode titles read from the Netflix page being watched.
- **Authentication information:** subtitle-site API keys entered by the user — stored only on the device and only
  sent to their own site.

And tick all three certifications:

- I do not sell or transfer user data to third parties, outside of the approved use cases.
- I do not use or transfer user data for purposes that are unrelated to my item's single purpose.
- I do not use or transfer user data to determine creditworthiness or for lending purposes.

## Privacy policy URL

Paste this link:

<https://meiskwan.github.io/netflix-sub-loader/privacy-policy.html>

It is published with GitHub Pages from `docs/privacy-policy.html`; edit that file and push to update it.
