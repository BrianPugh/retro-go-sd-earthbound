// ABI behaviour tests: error paths, flag handling, cancellation, instance
// reuse and stepped/one-shot equivalence. Adapted from zelda3-retro-go-sd
// tools/extractor (MIT).
//
//   node test-abi.mjs <module.wasm> <rom.sfc> [expected.dat]
//
// check.sh runs it on a module built around the synthetic ROM (no real ROM
// needed), and on the real module when given the ROM. With expected.dat the
// output must match it byte for byte.

import { extract } from "./extract.mjs";
import { readFileSync } from "node:fs";

const [wasmPath, romPath, expectedPath] = process.argv.slice(2);
if (!romPath) {
  console.error("usage: test-abi.mjs <module.wasm> <rom.sfc> [expected.dat]");
  process.exit(2);
}
const wasm = new Uint8Array(readFileSync(wasmPath));
const rom = new Uint8Array(readFileSync(romPath));
let bad = 0;
const check = (n, c, d = "") => { console.log(c ? `  ok   ${n}` : `  FAIL ${n} ${d}`); if (!c) bad++; };
const same = (a, b) => a.length === b.length && Buffer.compare(Buffer.from(a), Buffer.from(b)) === 0;

// Direct ABI access, for what extract() deliberately refuses to do.
async function raw() {
  const { instance } = await WebAssembly.instantiate(wasm);
  const x = instance.exports;
  const text = (p, n) => new TextDecoder().decode(new Uint8Array(x.memory.buffer, p >>> 0, n >>> 0).slice());
  return {
    x,
    add(f) {
      const p = x.alloc(f.length);
      new Uint8Array(x.memory.buffer, p, f.length).set(f);
      return x.input_add(p, f.length) >>> 0;
    },
    error: () => text(x.error_ptr(), x.error_len()),
    warnings: () => text(x.warnings_ptr(), x.warnings_len()),
    output: () => new Uint8Array(x.memory.buffer, x.output_ptr(0) >>> 0, x.output_len(0) >>> 0).slice(),
    outputName: () => text(x.output_name_ptr(0), x.output_name_len(0)),
  };
}

// garbage input must be refused, not crash
try {
  await extract(wasm, new Uint8Array(1024));
  check("rejects a non-EarthBound file", false, "-> it accepted it");
} catch (e) { check("rejects a non-EarthBound file", /not the US EarthBound ROM/.test(e.message), `-> ${e.message}`); }

// a modified ROM fails the recipe's ROM check
const hacked = rom.slice(); hacked[0x100] ^= 0xff;
try {
  await extract(wasm, hacked);
  check("refuses a modified ROM", false, "-> accepted");
} catch (e) { check("refuses a modified ROM", /SHA-1|bytes/.test(e.message), `-> ${e.message}`); }

// an empty input list, past the host's own check
{
  const m = await raw();
  m.x.input_clear();
  const status = m.x.run_begin(0) >>> 0;
  check("run_begin with no inputs is refused", status !== 0 && /no input/.test(m.error()), `-> ${status} ${m.error()}`);
}

// the converter has no options: every flag bit is reserved
for (const flags of [1, 1 << 1, 1 << 31]) {
  try {
    await extract(wasm, rom, { flags });
    check(`rejects flags 0x${(flags >>> 0).toString(16)}`, false, "-> accepted");
  } catch (e) { check(`rejects flags 0x${(flags >>> 0).toString(16)}`, /flag/i.test(e.message), `-> ${e.message}`); }
}

// the stepped run: progress, stage names, output id
const seen = [];
const stepped = await extract(wasm, rom, { onProgress: (p) => seen.push(p) });
const stageCount = seen[0]?.stages ?? 0;
check("progress reported every stage",
  new Set(seen.filter((p) => p.stage < p.stages).map((p) => p.stage)).size === stageCount, `-> ${JSON.stringify(seen.slice(0, 8))}`);
check("progress never goes backwards", seen.every((p, i) => i === 0 || p.stage >= seen[i - 1].stage));
check("long stages return control mid-stage", seen.length > stageCount + 2, `-> ${seen.length} callbacks for ${stageCount} stages`);
check("one output, id \"assets\"", stepped.outputs.length === 1 && stepped.outputs[0].name === "assets",
  `-> ${JSON.stringify(stepped.outputs.map((o) => o.name))}`);
check("no warnings for a lone ROM", stepped.warnings.length === 0, `-> ${JSON.stringify(stepped.warnings)}`);
const dat = stepped.outputs[0].data;
check("output is an EBA1 container", dat[0] === 0x45 && dat[1] === 0x42 && dat[2] === 0x41 && dat[3] === 0x31);
if (expectedPath) {
  check("output equals expected.dat", same(dat, new Uint8Array(readFileSync(expectedPath))));
}

// manifest-declared output ids are enforced by the host
try {
  await extract(wasm, rom, { expectedOutputs: ["assets"] });
  check("accepts the manifest's output list", true);
} catch (e) { check("accepts the manifest's output list", false, `-> ${e.message}`); }
try {
  await extract(wasm, rom, { expectedOutputs: ["something_else"] });
  check("enforces the manifest's output list", false, "-> accepted");
} catch (e) { check("enforces the manifest's output list", /manifest declares/.test(e.message)); }

// an extra input is ignored with a warning, whatever its position
const withJunk = await extract(wasm, [new Uint8Array(4096), rom]);
check("extra input: same output", same(withJunk.outputs[0].data, dat));
check("extra input: one warning", withJunk.warnings.length === 1 && /ignored input 0/.test(withJunk.warnings[0]),
  `-> ${JSON.stringify(withJunk.warnings)}`);

// one-shot run() equals the stepped route, and an instance can be reused
{
  const m = await raw();
  m.add(rom);
  const s1 = m.x.run(0) >>> 0;
  check("one-shot run succeeds", s1 === 0, `-> ${s1} ${m.error()}`);
  check("one-shot output equals stepped output", same(m.output(), dat));
  check("stage_index is complete after a run", (m.x.stage_index() >>> 0) === (m.x.stage_count() >>> 0));
  check("output id via the raw ABI", m.outputName() === "assets");
  console.log(`  info peak memory ${m.x.memory.buffer.byteLength / 65536} pages after one run`);

  const stray = m.x.run_step() >>> 0;
  check("run_step after completion is refused", stray !== 0 && stray !== 1, `-> ${stray}`);

  m.x.input_clear();
  m.add(new Uint8Array(16));
  const s2 = m.x.run(0) >>> 0;
  check("a failed second run reports an error", s2 !== 0 && m.error().length > 0 && (m.x.output_count() >>> 0) === 0,
    `-> ${s2} count=${m.x.output_count()}`);

  m.x.input_clear();
  m.add(rom);
  const s3 = m.x.run(0) >>> 0;
  check("a reused instance converts again", s3 === 0 && same(m.output(), dat) && m.error() === "", `-> ${s3} ${m.error()}`);
  check("a reused instance has no stale warnings", m.warnings() === "");
  console.log(`  info peak memory ${m.x.memory.buffer.byteLength / 65536} pages after three runs`);
}

// out-of-range accessors return nothing rather than trapping
{
  const m = await raw();
  check("output_len(5) is 0 before any run", (m.x.output_len(5) >>> 0) === 0 && (m.x.output_count() >>> 0) === 0);
  check("stage_name_len past the end is 0", (m.x.stage_name_len(99) >>> 0) === 0);
}

// cancellation: stop asking for steps
try {
  let n = 0;
  await extract(wasm, rom, { shouldCancel: () => ++n > 3 });
  check("cancellation stops the run", false, "-> ran to completion");
} catch (e) { check("cancellation stops the run", /cancel/i.test(e.message), `-> ${e.message}`); }

console.log(bad === 0 ? "\nAll edge-case tests passed." : `\n${bad} failed.`);
process.exit(bad ? 1 : 0);
