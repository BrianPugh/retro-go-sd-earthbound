// Checks an assembled site the way the page loads it, without a browser.
//
// test-page.mjs drives the real page in Chromium and catches browser-only
// failures, but it needs playwright. This covers the other half -- that the
// site's wiring is coherent -- with nothing but node, so CI can run it on every
// build and a missing file cannot reach a deploy.
//
// It walks the exact sequence app.js walks: read config.json, fetch the
// manifest it names, resolve the module beside that manifest, check size and
// hash, then verify the binary. If this passes, the page's fetch path is sound
// and only its DOM can still be wrong.
//
//   node test-site.mjs <site-dir>

import { readFileSync, existsSync } from "node:fs";
import { createHash } from "node:crypto";
import { join, dirname, resolve } from "node:path";
// EarthBound edit: verify.mjs is the converter's, in tools/converter.
import { verify } from "../converter/verify.mjs";

const site = process.argv[2];
if (!site) {
  console.error("usage: test-site.mjs <site-dir>");
  process.exit(2);
}

let failures = 0;
const check = (name, cond, detail = "") => {
  if (cond) console.log(`  ok   ${name}`);
  else { console.log(`  FAIL ${name}${detail ? ` -- ${detail}` : ""}`); failures++; }
};

// --- the files the page itself is made of -----------------------------------

for (const f of ["index.html", "app.js", "worker.js", "i18n.js", "style.css",
                 "verify.mjs", "extract.mjs", "zip.mjs", "config.json"]) {
  check(`site has ${f}`, existsSync(join(site, f)));
}

// Jekyll would swallow anything it does not recognise, including dist/.
check("site has .nojekyll", existsSync(join(site, ".nojekyll")));

// --- config.json points somewhere real --------------------------------------

const cfgPath = join(site, "config.json");
if (!existsSync(cfgPath)) {
  console.log("\ncannot continue without config.json");
  process.exit(1);
}
const cfg = JSON.parse(readFileSync(cfgPath, "utf8"));
const entry = cfg.versionsUrl ?? cfg.manifestUrl;
check("config.json names a starting point", typeof entry === "string" && Boolean(entry),
  JSON.stringify(cfg));

// The page resolves it relative to itself, so it must stay inside the site. An
// absolute URL would make the page depend on another origin, which is the
// thing the mirror exists to avoid.
check("the configured url is relative", !/^[a-z]+:\/\//i.test(entry ?? ""), entry);

// A pinned build names one manifest and shows no picker; the normal build
// names the index and offers every version the mirror holds. Both are valid,
// and the page has to arrive at a manifest either way.
let manifestPath;
if (cfg.versionsUrl) {
  const indexPath = resolve(site, cfg.versionsUrl);
  check("the version index exists", existsSync(indexPath), cfg.versionsUrl);
  if (!existsSync(indexPath)) {
    console.log("\nthe page would fail to load: no versions.json at its configured URL");
    process.exit(1);
  }
  const index = JSON.parse(readFileSync(indexPath, "utf8"));
  check("index schemaVersion is 1", index.schemaVersion === 1, String(index.schemaVersion));
  const versions = index.versions ?? [];
  check("index lists at least one version", versions.length > 0, String(versions.length));

  // The page takes versions[0] as the default without sorting, because the
  // spec guarantees newest-first. If that is ever untrue the page silently
  // offers the wrong default, so it is checked here rather than trusted.
  const dates = versions.map((v) => Date.parse(v.publishedAt)).filter((n) => !Number.isNaN(n));
  const ordered = dates.every((d, i) => i === 0 || dates[i - 1] >= d);
  check("index is newest-first", ordered, versions.map((v) => v.tag).join(", "));

  // Every version the picker offers has to be loadable, not just the default:
  // switching to an older one must not land on a 404.
  for (const v of versions) {
    const p = resolve(dirname(indexPath), v.manifest);
    check(`${v.tag}: its manifest is mirrored`, existsSync(p), v.manifest);
  }

  const def = versions.find((v) => !v.prerelease) ?? versions[0];
  check("a non-prerelease default exists", Boolean(def), def?.tag);
  manifestPath = resolve(dirname(indexPath), def.manifest);
} else {
  manifestPath = resolve(site, cfg.manifestUrl);
  check("the manifest it names exists", existsSync(manifestPath), cfg.manifestUrl);
}
if (!existsSync(manifestPath)) {
  console.log("\nthe page would fail to load: no manifest at its configured URL");
  process.exit(1);
}

// --- the manifest is the shape the page reads -------------------------------

const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
check("schemaVersion is 1", manifest.schemaVersion === 1, String(manifest.schemaVersion));

const tool = manifest.tools?.[0];
check("manifest declares a tool", Boolean(tool));
if (!tool) {
  console.log("\nnothing further to check without a tool");
  process.exit(1);
}

check("processor is wasm/1",
  tool.processor?.type === "wasm" && tool.processor?.version === 1,
  `${tool.processor?.type}/${tool.processor?.version}`);
check("tool has a binary block", Boolean(tool.binary?.url && tool.binary?.sha256));
check("tool declares limits", Number.isInteger(tool.limits?.maxOutputBytes));
check("tool declares inputs", Array.isArray(tool.inputs) && tool.inputs.length > 0);
check("tool declares outputs", Array.isArray(tool.outputs) && tool.outputs.length > 0);

// Every option the page asks for by name must actually carry a bit, or the
// page would silently send flags: 0 and get a different run than it showed.
for (const opt of tool.options ?? []) {
  check(`option ${opt.id} declares a bit`, Number.isInteger(opt.bit), String(opt.bit));
}

// A variant id has to be unique within its input: it is what a page uses to
// tell one accepted file from another, and this project has two releases of
// the same script that only their ids separate. JSON Schema cannot say this.
for (const inp of tool.inputs) {
  const ids = (inp.variants ?? []).map((v) => v.id);
  const dupes = ids.filter((id, i) => ids.indexOf(id) !== i);
  check(`input ${inp.id}: variant ids are unique`, dupes.length === 0, dupes.join(", "));
}

// A strict input with nothing to match is a slot no file can ever fill: the
// host refuses anything unrecognised, and every file is unrecognised.
for (const inp of tool.inputs) {
  const strict = inp.strict !== false;
  const known = (inp.variants ?? []).length;
  check(`input ${inp.id}: strict input has variants to match`, !strict || known > 0,
    strict ? `strict with ${known} variant(s)` : "not strict");
}

// --- the module resolves beside the manifest, and is the one described ------

const url = tool.binary.url ?? tool.binary.file;
check("binary url is a plain filename", !url.includes("/") && !url.includes(".."), url);

const wasmPath = join(dirname(manifestPath), url);
check("the module is there", existsSync(wasmPath), wasmPath);
if (!existsSync(wasmPath)) {
  console.log("\nthe page would load its manifest and then fail to fetch the module");
  process.exit(1);
}

const bytes = new Uint8Array(readFileSync(wasmPath));
check("module size matches the manifest", bytes.length === tool.binary.bytes,
  `${bytes.length} vs ${tool.binary.bytes}`);
const sha256 = createHash("sha256").update(bytes).digest("hex");
check("module hash matches the manifest", sha256 === tool.binary.sha256);

// The real gate, and the same call the page makes: decided by reading the
// binary, never by trusting what the manifest says about it.
const result = verify(bytes);
check("module passes the verifier", result.ok, (result.errors ?? []).join("; "));

// The declared ceiling has to cover what the binary actually asks for.
const declared = result.info?.memories?.[0]?.max;
if (Number.isInteger(declared)) {
  check("manifest memory ceiling matches the binary",
    tool.limits.maxMemoryPages === declared,
    `manifest ${tool.limits.maxMemoryPages} vs binary ${declared}`);
}

// --- the artifacts the manifest names are mirrored too ----------------------

for (const target of manifest.targets ?? []) {
  for (const a of target.artifacts ?? []) {
    const p = join(dirname(manifestPath), a.url);
    const there = existsSync(p);
    check(`artifact ${a.filename} is mirrored`, there);
    if (there) {
      const data = readFileSync(p);
      check(`artifact ${a.filename} matches its hash`,
        createHash("sha256").update(data).digest("hex") === a.sha256);
    }
  }
}

// --- the optional reference run ---------------------------------------------

if (existsSync(join(site, "reference.json"))) {
  const ref = JSON.parse(readFileSync(join(site, "reference.json"), "utf8"));
  const outs = ref.outputs ?? [];
  check("reference names outputs the tool declares",
    outs.every((o) => tool.outputs.some((t) => t.filename === o.name)),
    outs.map((o) => o.name).join(", "));
} else {
  console.log("  note no reference.json; results will carry no verified-run verdict");
}

console.log(failures ? `\n${failures} failed` : "\nall passed");
process.exit(failures ? 1 : 0);
