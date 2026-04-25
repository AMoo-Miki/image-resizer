# Image Resizer

A tiny single-page web app that resizes and compresses images entirely in your browser. Nothing is uploaded — the file never leaves your machine.

Live: https://resizer.barahmand.com

## Features

- Resize by **percentage**, **exact pixel dimensions**, or **physical size + DPI** (e.g. `4 × 6 in @ 300 DPI` → `1200 × 1800 px`).
- Aspect ratio is always locked to the source image — change one dimension, the other follows.
- Output as **WebP**, **JPEG**, or **PNG**.
- Manual quality slider, or "find the best quality that fits under N KB" (binary search).
- Live preview, before/after size with savings percentage.
- Drag and drop or click to choose. Keyboard accessible.
- Dark zinc/violet theme.

## How to use

Open `index.html` directly in any modern browser, or visit the deployed URL above. Drop an image, pick your settings, click Download.

The "physical size + DPI" mode just drives the **pixel** dimensions — it does not write a DPI tag into the file. If you take the resulting file into Word/InDesign, those apps will still display it at 96 DPI by default. (If this becomes a problem, we can add JPEG JFIF / PNG `pHYs` density stamping later.)

## Project layout

```
index.html              app markup
styles.css              all styling (zinc/violet tokens, fade animations)
app.js                  all behavior (vanilla JS, single IIFE)
CNAME                   custom domain for GitHub Pages
.github/workflows/
  pages.yml             auto-deploy on push to main
test/
  index.html            in-browser test harness
  run.js                test runner (~200 assertions)
  fixtures/
    sample.jpg          real Canon JPEG for end-to-end pipeline tests
```

No build step. No dependencies. No framework.

## Development

Serve the repo over HTTP from any directory (the app uses absolute fixture paths, so `file://` won't load the JPEG):

```bash
python3 -m http.server 8765
```

Then open `http://127.0.0.1:8765/` for the app, or `http://127.0.0.1:8765/test/` for the test harness. The harness grafts the live app's DOM into a results page, runs the full suite, and renders pass/fail at the bottom.

## Deployment

Pushes to `main` auto-deploy via `.github/workflows/pages.yml`. Configure a custom domain per [GitHub's standard guide](https://docs.github.com/pages/configuring-a-custom-domain-for-your-github-pages-site).

## Limitations

- HEIC / HEIF inputs only decode in Safari (Chrome and Firefox don't ship a HEIC decoder).
- EXIF orientation is honored by modern browsers when loading via `<img>`, but EXIF data and ICC color profiles are stripped on re-encode (wide-gamut images get clamped to sRGB).
- Very large images (above ~16 MP on Safari, ~32k pixels per side on Chrome) may fail to encode.
- Single file at a time, no batch.
