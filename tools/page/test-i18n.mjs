// Every string the page asks for exists, in every language it offers.
//
// The page is shared verbatim between projects and translated into three
// languages, which makes a renamed key the easiest mistake to ship: the code
// reads `t().input.addFile`, one locale still calls it `addLanguage`, and the
// only symptom is a blank control for the users of that language. Nothing else
// catches it -- the page still loads, the tests still pass, the button is just
// empty.
//
// So: pull every `t().section.key` out of app.js and demand it from each
// locale. Cheap, and it runs without a browser.
//
//   node test-i18n.mjs

import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));

// i18n.js reads localStorage and navigator at import time, both guarded, and
// touches document only inside setLocale. Enough of a shim to import it.
globalThis.localStorage ??= { getItem: () => null, setItem: () => {} };
globalThis.navigator ??= { languages: ["en"], language: "en" };
globalThis.document ??= { documentElement: {}, querySelectorAll: () => [] };

const { SUPPORTED, setLocale, t } = await import("./page/i18n.js");

const source = readFileSync(join(here, "page", "app.js"), "utf8");

// `t().input.choose` and `t().input.choose(...)` both match; the call itself
// does not matter here, only that the key resolves to something.
const used = new Set();
for (const m of source.matchAll(/\bt\(\)\.([A-Za-z]+)\.([A-Za-z]+)/g)) {
  used.add(`${m[1]}.${m[2]}`);
}

// The page also aliases a section once and then reads keys off it -- `const s =
// t().input;` followed by `s.notTheOne`. Missing these would report live
// strings as dead, which is worse than reporting nothing: someone deletes one
// and finds out from a user.
for (const alias of source.matchAll(/\b(?:const|let)\s+(\w+)\s*=\s*t\(\)\.([A-Za-z]+)\s*;/g)) {
  const [, name, section] = alias;
  for (const use of source.matchAll(new RegExp(`\\b${name}\\.([A-Za-z]+)`, "g"))) {
    used.add(`${section}.${use[1]}`);
  }
}

let failures = 0;
const check = (name, cond, detail = "") => {
  if (cond) return;
  console.log(`  FAIL ${name}${detail ? ` -- ${detail}` : ""}`);
  failures++;
};

console.log(`app.js asks for ${used.size} strings across ${SUPPORTED.length} locales`);

for (const { code } of SUPPORTED) {
  setLocale(code);
  const strings = t();
  let missing = 0;
  for (const path of [...used].sort()) {
    const [section, key] = path.split(".");
    const value = strings?.[section]?.[key];
    // A key that resolves to undefined is the bug this test exists for. An
    // empty string is a deliberate choice in at least one place (footer.published
    // is blank in two locales), so it passes.
    if (value === undefined) {
      check(`${code}: ${path}`, false, "not defined in this locale");
      missing++;
    }
  }
  if (missing === 0) console.log(`  ok   ${code}: all ${used.size} strings present`);
}

// The reverse direction: a string no longer used by the page is dead weight in
// three languages. Not a failure -- a project may keep one deliberately -- but
// worth saying out loud.
setLocale("en");
const defined = new Set();
for (const [section, body] of Object.entries(t())) {
  if (body && typeof body === "object") {
    for (const key of Object.keys(body)) defined.add(`${section}.${key}`);
  }
}
// applyStatic() resolves data-i18n attributes out of index.html, so a string
// used only there is still used. Read them rather than reporting them as dead.
const html = readFileSync(join(here, "page", "index.html"), "utf8");
for (const m of html.matchAll(/data-i18n(?:-[a-z-]+)?="([^"]+)"/g)) used.add(m[1]);

const unused = [...defined].filter((k) => !used.has(k)).sort();
if (unused.length) console.log(`  note unused strings: ${unused.join(", ")}`);

console.log(failures ? `\n${failures} failed` : "\nall passed");
process.exit(failures ? 1 : 0);
