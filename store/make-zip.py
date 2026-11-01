"""Packs Netflix Sub Loader for the Chrome Web Store.

Run from anywhere:  python store/make-zip.py
Creates store/netflix-sub-loader-<version>.zip with manifest.json, src/, pages/ and icons/ only
(no tests or notes). Paths inside the zip use "/" as the store expects.
"""
import json
import pathlib
import zipfile

root = pathlib.Path(__file__).resolve().parent.parent
ext = root / "chrome-extension"
version = json.loads((ext / "manifest.json").read_text(encoding="utf-8"))["version"]
out = root / "store" / f"netflix-sub-loader-{version}.zip"

files = [ext / "manifest.json"]
for folder in ("src", "pages", "icons"):
    files += sorted(p for p in (ext / folder).rglob("*") if p.is_file())

with zipfile.ZipFile(out, "w", zipfile.ZIP_DEFLATED) as z:
    for f in files:
        z.write(f, f.relative_to(ext).as_posix())

print(f"{out.name}: {len(files)} files, {out.stat().st_size // 1024} KB")
