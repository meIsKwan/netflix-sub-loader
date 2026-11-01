# Publishing Netflix Sub Loader on the Chrome Web Store

Everything needed for the submission is in this folder:

| File | Used for |
|---|---|
| `netflix-sub-loader-1.0.zip` | The package to upload |
| `make-zip.py` | Rebuilds the zip after code changes: `python store/make-zip.py` |
| `listing.md` | Name, descriptions, category, list of images |
| `privacy.md` | Answers for the Privacy practices tab: single purpose, permission justifications, data usage |
| `../docs/privacy-policy.html` | Privacy policy, published at <https://meiskwan.github.io/netflix-sub-loader/privacy-policy.html> |
| `images/` | 5 screenshots (1280×800), the small promo tile (440×280) and the marquee promo tile (1400×560) |

## Steps

1. **Create a developer account** at <https://chrome.google.com/webstore/devconsole> with your Google account,
   pay the one-time registration fee (US$5) and verify your email.
2. **Donate link:** already set to `https://www.paypal.com/paypalme/meiskwan` — to change it, see "PayPal donate
   link" below.
3. **Privacy policy:** already published with GitHub Pages at
   <https://meiskwan.github.io/netflix-sub-loader/privacy-policy.html> (source: `docs/privacy-policy.html`).
4. **Upload the package:** in the Dashboard click **New item** and choose `netflix-sub-loader-1.0.zip`.
5. **Store listing tab:** paste the description from `listing.md`, choose the category and language, upload the
   images from `images/` (5 screenshots, small promo tile, marquee promo tile) and fill in the Homepage and Support
   URLs (also in `listing.md`).
6. **Privacy practices tab:** fill it in from `privacy.md` and paste the privacy policy link.
7. **Distribution tab:** choose **Public** or **Unlisted** (only people with the link can install), and the regions.
8. Click **Submit for review**. It usually takes a few days; extensions with access to several sites can take longer.

## PayPal donate link

The extension uses `https://www.paypal.com/paypalme/meiskwan`, set as `donateUrl` in
`chrome-extension/src/config.js`. The "♥ Support" links show up in the panel (Display tab), the popup and the
settings page; an empty `donateUrl` hides them.

To use a different link:

1. Get the link: a PayPal.Me link (create one at <https://www.paypal.me>), or with a business account a Donate
   button link from <https://www.paypal.com/donate/buttons>.
2. Put it in `chrome-extension/src/config.js`:
   ```js
   donateUrl: "https://paypal.me/yourname",
   ```
3. Change the SUPPORT line of the store description in `listing.md` to match.
4. Rebuild the zip with `python store/make-zip.py` and upload it as an update (see below).

## Releasing an update

1. Raise `"version"` in `chrome-extension/manifest.json` (for example 1.0 → 1.0.1).
2. Run `python store/make-zip.py` to build the new zip.
3. In the Dashboard open the item → **Package** → **Upload new package**, then submit for review again.
4. Commit and push the changes (`git push`) so the code on GitHub and the website stay current.

After the first approval, put the store link in `docs/index.html` (the "coming soon" button) and in
`.github/README.md` (the Install section), then push.

## Notes

- **The name contains "Netflix".** The store's policy on third-party trademarks can lead to a rejection or removal
  request. The listing and the extension say clearly that it is not affiliated with Netflix, and the icon does not
  use Netflix's logo, which lowers that risk. If it is rejected for this reason, change `"name"` in `manifest.json`
  (for example "Sub Loader for Netflix") and resubmit.
- **Subtitle search API keys:** every user signs up for free keys at SubSource / SubDL / OpenSubtitles and pastes
  them into the extension's settings. Do not ship your own key in a public extension — all users would share its quota.
- Not yet tested on real Netflix or with real subtitle-site keys. Try the unpacked build ("Load unpacked") on a few
  episodes before submitting.
