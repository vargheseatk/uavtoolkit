# vendor/

Third-party code, included verbatim rather than pulled from a CDN — this app runs from a
single static folder with no build step and no runtime dependencies, so anything it needs has
to live here.

**`qrcode.js`** — Kazuhiko Arase's [qrcode-generator](https://github.com/kazuhikoarase/qrcode-generator),
MIT licensed (`qrcode-LICENSE.txt`). This is the core encoder (`js/dist/qrcode.js`) plus the
official UTF-8 plugin (`js/dist/qrcode_UTF8.js`) concatenated together, unmodified.

QR encoding leans on Reed-Solomon error correction — exactly the kind of thing that's easy to
get subtly wrong writing from memory, and a subtly-wrong QR encoder produces labels that look
fine and don't scan. Used here rather than writing one, and its output was cross-checked
against an independent decoder (OpenCV) across ASCII, Unicode, and edge-case inputs before
being trusted for the Labels tab.
