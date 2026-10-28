#!/usr/bin/env bash
# Assembles the GitHub Pages site into site/.
#
# The page is a consumer of the same verify.mjs and extract.mjs the web builder
# uses -- they are copied in, not reimplemented -- so publishing the page from
# the same CI run that builds the module keeps the two in step by construction.
#
# Vendored from zelda3-retro-go-sd's tools/extractor. EarthBound edit: the page
# lives in tools/page and verify.mjs is the converter's own, in tools/converter,
# so the site gets the exact gate the release job ran. extract.mjs imports
# ./verify.mjs, which resolves only in the assembled site/.
set -euo pipefail
cd "$(dirname "$0")"

rm -rf site
mkdir -p site
cp page/index.html page/style.css page/app.js page/worker.js page/i18n.js site/
cp ../converter/verify.mjs extract.mjs zip.mjs site/

# These files are loaded directly by the browser. Node-only constructs in them
# fail at import time and take the whole page down silently, which is a much
# worse failure than a build error -- so make it a build error. Both of these
# have bitten this page already.
for f in site/verify.mjs site/extract.mjs site/zip.mjs site/app.js site/worker.js site/i18n.js; do
  if head -c 2 "$f" | grep -q '#!'; then
    echo "$f starts with a shebang; browsers cannot parse it" >&2
    exit 1
  fi
  if grep -n 'process\.' "$f" | grep -qv 'typeof process'; then
    if ! grep -q 'typeof process !== "undefined"' "$f"; then
      echo "$f uses process.* without a typeof guard; it will throw in a browser" >&2
      exit 1
    fi
  fi
done
# The hashes of a verified reference run, if one has been recorded. Not part of
# the manifest -- a converter's output depends on what the user supplied, so no
# manifest can state it -- but this project can say what one known-good run
# produced, and the page uses it to tell a user whether their extraction matches.
if [[ -f reference.json ]]; then
  cp reference.json site/
else
  echo "note: no reference.json; results will carry no verified-run verdict"
fi

# Where the page starts reading. Normally the version index that build_dist.py
# mirrors into this same site: the page offers every version the mirror holds,
# defaults to the newest, and a new release therefore reaches users without
# redeploying this page. Each version's manifest is the identical file a
# third-party installer fetches, and the module and every other file the
# manifest names resolve beside it.
#
# MANIFEST_URL pins the page to one manifest instead, which is what an offline
# bundle needs: a bundle is one version's files in one directory with no index
# above them. Setting it hides the picker.
#
# Release assets cannot be used directly: they are not CORS-fetchable, which is
# the reason the mirror exists (the spec's spec/01-distribution.md).
VERSIONS_URL="${VERSIONS_URL:-dist/versions.json}"
if [[ -n "${MANIFEST_URL:-}" ]]; then
  printf '{\n  "manifestUrl": "%s"\n}\n' "$MANIFEST_URL" > site/config.json
  echo "page is pinned to: $MANIFEST_URL"
else
  printf '{\n  "versionsUrl": "%s"\n}\n' "$VERSIONS_URL" > site/config.json
  echo "page reads its versions from: $VERSIONS_URL"
fi

# Nothing here is Jekyll, and Jekyll would swallow files it does not recognise.
touch site/.nojekyll

echo "site/ ready ($(du -sh site | cut -f1))"
