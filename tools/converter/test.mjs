#!/usr/bin/env node
// Verifier tests (from zelda3-retro-go-sd tools/extractor, MIT). Hand-builds non-conformant modules and asserts each is
// rejected, so the PASS on the real module means something.

import { verify, DEFAULT_POLICY } from "./verify.mjs";
import { readFileSync } from "node:fs";

let failures = 0;
function check(name, cond, detail = "") {
  if (cond) console.log(`  ok   ${name}`);
  else { console.log(`  FAIL ${name} ${detail}`); failures++; }
}

// --- minimal wasm builders -------------------------------------------------
const leb = (n) => { const o = []; do { let b = n & 0x7f; n >>>= 7; if (n) b |= 0x80; o.push(b); } while (n); return o; };
const str = (s) => { const b = [...new TextEncoder().encode(s)]; return [...leb(b.length), ...b]; };
const section = (id, payload) => [id, ...leb(payload.length), ...payload];
const HEADER = [0x00, 0x61, 0x73, 0x6d, 0x01, 0x00, 0x00, 0x00];
const mod = (...sections) => new Uint8Array([...HEADER, ...sections.flat()]);

const TYPE_SEC = section(1, [0x01, 0x60, 0x00, 0x00]);            // one () -> ()
const MEM_SEC = section(5, [0x01, 0x01, ...leb(1), ...leb(16)]);  // min 1, max 16
const MEM_UNBOUNDED = section(5, [0x01, 0x00, ...leb(1)]);
const exportSec = (entries) =>
  section(7, [...leb(entries.length), ...entries.flatMap(([n, k, i]) => [...str(n), k, ...leb(i)])]);
// The conformant export set is derived from the policy rather than restated, so
// an ABI change updates every fixture below at once instead of leaving some of
// them quietly testing an export set no real module has.
const KIND = { func: 0x00, table: 0x01, memory: 0x02, global: 0x03 };
const ABI = Object.entries(DEFAULT_POLICY.requiredExports);
const abiEntries = () => ABI.map(([n, k], i) => [n, KIND[k], i]);
const GOOD_EXPORTS = exportSec(abiEntries());

console.log("negative cases (each MUST be rejected):");

const rejects = (name, bytes, needle) => {
  const r = verify(bytes);
  check(name, !r.ok && r.errors.some((e) => e.includes(needle)),
    `-> ok=${r.ok} errors=${JSON.stringify(r.errors)}`);
};

rejects("bad magic", new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8]), "bad magic");

rejects("any import at all", mod(
  TYPE_SEC,
  section(2, [0x01, ...str("env"), ...str("read_file"), 0x00, ...leb(0)]),
  MEM_SEC, GOOD_EXPORTS,
), "imports env.read_file");

rejects("wasi import", mod(
  TYPE_SEC,
  section(2, [0x01, ...str("wasi_snapshot_preview1"), ...str("path_open"), 0x00, ...leb(0)]),
  MEM_SEC, GOOD_EXPORTS,
), "imports are not permitted");

rejects("imported memory (host-controlled)", mod(
  TYPE_SEC,
  section(2, [0x01, ...str("env"), ...str("memory"), 0x02, 0x00, ...leb(1)]),
  MEM_SEC, GOOD_EXPORTS,
), "imports are not permitted");

rejects("missing export", mod(TYPE_SEC, MEM_SEC,
  exportSec(abiEntries().filter(([n]) => n !== "output_ptr")),
), 'missing required export "output_ptr"');

rejects("extra undeclared export", mod(TYPE_SEC, MEM_SEC,
  exportSec([...abiEntries(), ["__secret_backdoor", 0x00, ABI.length]]),
), 'unexpected export "__secret_backdoor"');

// The linker globals are tolerated, but only as globals: a function smuggled
// in under one of those names is still unreviewed surface.
rejects("linker-global name used for a function", mod(TYPE_SEC, MEM_SEC,
  exportSec([...abiEntries(), ["__heap_base", KIND.func, ABI.length]]),
), 'export "__heap_base" is a func, expected a global');

rejects("export of wrong kind", mod(TYPE_SEC, MEM_SEC,
  exportSec(abiEntries().map((e) => (e[0] === "alloc" ? [e[0], KIND.global, e[2]] : e))),
), 'export "alloc" is a global');

rejects("start section runs code at load", mod(
  TYPE_SEC, MEM_SEC, GOOD_EXPORTS, section(8, [...leb(0)]),
), "start section");

rejects("unbounded memory growth", mod(TYPE_SEC, MEM_UNBOUNDED, GOOD_EXPORTS), `over the ${DEFAULT_POLICY.maxMemoryPages}-page limit`);

rejects("shared memory", mod(
  TYPE_SEC, section(5, [0x01, 0x03, ...leb(1), ...leb(16)]), GOOD_EXPORTS,
), "shared memory");

rejects("no memory declared", mod(TYPE_SEC, GOOD_EXPORTS), "declares no memory");

rejects("over-long LEB128 encoding", mod(
  TYPE_SEC, MEM_SEC,
  // export count encoded as 6 continuation bytes: malformed, and a classic
  // way to make two parsers disagree about the same bytes.
  section(7, [0x80, 0x80, 0x80, 0x80, 0x80, 0x80, 0x00]),
), "parse error");

rejects("duplicated section", mod(TYPE_SEC, MEM_SEC, GOOD_EXPORTS, GOOD_EXPORTS),
  "out of order or duplicated");

rejects("sections out of order", mod(TYPE_SEC, GOOD_EXPORTS, MEM_SEC),
  "out of order or duplicated");

rejects("truncated module", mod(TYPE_SEC, [5, 40, 0x01, 0x01]), "past end of module");

// --- positive case ---------------------------------------------------------
console.log("\npositive case:");
const real = process.argv[2] ?? "target/wasm32-unknown-unknown/release/eb_converter.wasm";
try {
  const bytes = new Uint8Array(readFileSync(real));
  const r = verify(bytes);
  check("real module passes", r.ok, `-> ${JSON.stringify(r.errors)}`);
  check("real module imports nothing", r.info?.imports.length === 0);
  check("no export outside the ABI and the tolerated linker globals",
    r.info.exports.every((e) => e.name in DEFAULT_POLICY.requiredExports
      || e.name in DEFAULT_POLICY.optionalExports),
    `-> ${JSON.stringify(r.info.exports.map((e) => e.name))}`);

  // Instantiating with no import object is the runtime half of the claim the
  // verifier makes statically: a module that wanted anything would throw here.
  const { instance } = await WebAssembly.instantiate(bytes);
  const x = instance.exports;
  check("instantiates with no imports supplied", true);
  check("declares ABI version 1", x.abi_version() === 1, `-> ${x.abi_version()}`);

  // Stages are what a host shows while stepping. Names must be present and
  // distinct, or a progress display is worse than none.
  const stages = x.stage_count() >>> 0;
  const names = Array.from({ length: stages }, (_, i) => {
    const p = x.stage_name_ptr(i), n = x.stage_name_len(i) >>> 0;
    return new TextDecoder().decode(new Uint8Array(x.memory.buffer, p, n));
  });
  check("declares at least one stage", stages > 0, `-> ${stages}`);
  check("every stage is named", names.every((n) => n.length > 0), `-> ${JSON.stringify(names)}`);
  check("stage names are distinct", new Set(names).size === stages);
  check("stage_index starts at zero", (x.stage_index() >>> 0) === 0);

  // run_step without run_begin must be refused rather than doing something
  // undefined with a session that does not exist.
  const step = x.run_step() >>> 0;
  check("run_step without run_begin is refused", step !== 0 && step !== 1, `-> ${step}`);
  check("refusal leaves an error message", (x.error_len() >>> 0) > 0);
} catch (e) {
  check("real module readable", false, `-> ${e.message} (build it first)`);
}

console.log(failures === 0 ? "\nAll verifier tests passed." : `\n${failures} test(s) failed.`);
process.exit(failures === 0 ? 0 : 1);
