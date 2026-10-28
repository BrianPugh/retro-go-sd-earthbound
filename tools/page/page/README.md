# The manual conversion page

A static page that converts a ROM in the browser, published to GitHub Pages by
CI. It serves two purposes:

1. **For users** — a way to produce `earthbound_assets.dat` without a terminal.
2. **For the project** — the reference consumer of the extractor spec. It uses
   the same `verify.mjs` and `extract.mjs` a web builder does, so if the ABI or
   the manifest format drifts, this page breaks in CI first.

It is also the **distribution endpoint**: GitHub release assets are not
CORS-fetchable, so a consuming web tool reads `manifest.json` and the module
from this Pages site. See `spec/01-distribution.md` in
[gwrg-dist-spec](https://github.com/slash-proc/gwrg-dist-spec).

Vendored from zelda3-retro-go-sd's `tools/extractor/page` (MIT). `app.js`,
`i18n.js`, `index.html`, `style.css` and `worker.js` are byte-identical to it;
keep them that way and take fixes from upstream. `verify.mjs` comes from
`tools/converter/`.

## Files

| | |
|---|---|
| `index.html` | markup |
| `style.css` | styles; light and dark |
| `app.js` | fetches and verifies the module, drives the flow |
| `worker.js` | runs the extraction off the main thread |

`../build-page.sh` assembles these with `verify.mjs`, `extract.mjs`, `zip.mjs`
and a `config.json` into `../site/`; CI adds the mirrored `dist/` tree beside
them and checks the result with `../test-site.mjs`.

## Design notes

**Verification is silent.** It has no section of its own. Users cannot act on
the details and saying "verified!" is reassurance, not information. Instead the
info box — which answers *what goes in and what comes out* — renders only once
the module has been hash-matched and verified, so its presence is the result of
the check while its content is something a user wants. On failure the page says
it cannot run, and why.

**No expert controls.** Whether an unrecognised file is admitted is the
manifest's decision, through the input's `strict` flag, not a checkbox.
EarthBound's one input is strict, because the recipe reads fixed offsets out of
the US release: a ROM that matches no listed hash is the wrong file, and saying
so at the picker is kinder than failing after a run.

**Verdicts, not hashes.** The output shows `Hash matches ✓`; the 64 characters
are one click away for anyone who wants to compare them.

## Two failure modes to know about

`verify.mjs` and `extract.mjs` are loaded directly by the browser as well as
run under node. Node-only constructs in them throw at import time and take the
page down **silently** — no error anywhere, just a page where nothing happens.
Both have already bitten this page: a `#!/usr/bin/env node` shebang, and a bare
`process.argv` in a CLI block. `build-page.sh` fails the build on either.
(zelda3 also has a playwright `test-page.mjs` that loads the page in a real
browser; this repo doesn't vendor it.)
