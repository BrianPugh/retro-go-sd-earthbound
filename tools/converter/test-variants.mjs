// The ROM gwrg.json offers is the ROM the converter accepts.
//
// gwrg.json lists a sha1 per variant so a host can recognise a file before
// spending a run. The recipe header (FORMAT.md, offset 8) holds the sha1 the
// module actually checks, since the module embeds that recipe. Only the
// module's copy is enforced at runtime, so the manifest's copy is the one that
// can rot silently. Modelled on zelda3-retro-go-sd's test-variants.mjs; this
// invariant is EarthBound's, so it lives here and not in the vendored
// scripts/make_manifest.py.
//
// Also checks the output ceiling covers the length the recipe must produce,
// and that the page's reference run (tools/page/reference.json) agrees with
// the recipe.
//
//   node test-variants.mjs

import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const repo = join(here, "..", "..");

let failures = 0;
const check = (name, cond, detail = "") => {
  if (cond) console.log(`  ok   ${name}`);
  else { console.log(`  FAIL ${name}${detail ? ` -- ${detail}` : ""}`); failures++; }
};

// --- what the module accepts ------------------------------------------------

const recipePath = join(here, "recipe", "eb_recipe.bin");
check("recipe/eb_recipe.bin exists", existsSync(recipePath), recipePath);
if (!existsSync(recipePath)) process.exit(1);

const recipe = readFileSync(recipePath);
check("recipe is long enough for its header", recipe.length >= 76, `${recipe.length} bytes`);
if (recipe.length < 76) process.exit(1);

const hex = (b) => [...b].map((x) => x.toString(16).padStart(2, "0")).join("");
check("recipe magic is EBRC", recipe.readUInt32LE(0) === 0x43524245,
  `0x${recipe.readUInt32LE(0).toString(16)}`);
check("recipe version is 1", recipe.readUInt32LE(4) === 1, String(recipe.readUInt32LE(4)));
const romSha1 = hex(recipe.subarray(8, 28)).toUpperCase();
const datSha256 = hex(recipe.subarray(28, 60));
const datLength = recipe.readUInt32LE(60);
console.log(`  note recipe expects ROM sha1 ${romSha1}, produces ${datLength} bytes`);

// --- what the manifest offers -----------------------------------------------

const declared = JSON.parse(readFileSync(join(repo, "gwrg.json"), "utf8"));
const inputs = declared.tool?.inputs ?? [];
const variants = inputs.flatMap((input) =>
  (input.variants ?? []).map((v) => ({ input: input.id, ...v })),
);
check("gwrg.json declares variants", variants.length > 0, `${variants.length} found`);

// A hash the manifest offers but the module refuses is a manifest that lies:
// the page says the ROM is fine and the run then fails.
for (const v of variants) {
  const sha1 = (v.sha1 ?? "").toUpperCase();
  check(`${v.input}/${v.id}: accepted by the module`, sha1 === romSha1,
    `gwrg.json ${sha1 || "(none)"} vs recipe ${romSha1}`);
}

const output = (declared.tool?.outputs ?? []).find((o) => o.id === "assets");
check("gwrg.json declares the assets output", Boolean(output));
if (output) {
  check("assets maxBytes covers the recipe's output", output.maxBytes >= datLength,
    `maxBytes ${output.maxBytes} < ${datLength}`);
  check("maxOutputBytes covers the recipe's output",
    declared.tool.maxOutputBytes >= datLength,
    `${declared.tool.maxOutputBytes} < ${datLength}`);
}

// The module labels its output with the manifest's id (spec 04-processor), and
// the page must expect that id. zelda3's page, which ours is vendored from,
// expects filenames because zelda3's module emits one; v0.1.0 shipped that.
const moduleId = /pub const OUTPUT_ID: &str = "([^"]*)"/
  .exec(readFileSync(join(here, "src", "lib.rs"), "utf8"))?.[1];
check("module's output id is the one gwrg.json declares", moduleId === output?.id,
  `lib.rs ${moduleId} vs gwrg.json ${output?.id}`);
const app = readFileSync(join(repo, "tools", "page", "page", "app.js"), "utf8");
check("page expects output ids, not filenames",
  app.includes("expectedOutputs: state.tool.outputs.map((o) => o.id)"));

// --- the page's reference run -----------------------------------------------

const refPath = join(repo, "tools", "page", "reference.json");
if (existsSync(refPath)) {
  const ref = JSON.parse(readFileSync(refPath, "utf8"));
  const refIn = (ref.inputs ?? [])[0];
  const refOut = (ref.outputs ?? []).find((o) => o.name === output?.filename);
  check("reference input is the recipe's ROM",
    (refIn?.sha1 ?? "").toUpperCase() === romSha1, refIn?.sha1);
  check("reference output hash is the recipe's", refOut?.sha256 === datSha256,
    `reference ${refOut?.sha256} vs recipe ${datSha256}`);
  check("reference output length is the recipe's", refOut?.bytes === datLength,
    `reference ${refOut?.bytes} vs recipe ${datLength}`);
}

console.log(failures ? `\n${failures} failed` : "\nall passed");
process.exit(failures ? 1 : 0);
