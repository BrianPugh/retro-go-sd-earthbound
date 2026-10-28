// Host-side runner. Verifies the module, then drives ABI version 1.
//
// Note the instantiation: no import object is supplied at all. If the module
// asked for anything, this would throw -- which is the same property `verify`
// checks statically, enforced a second time by the engine at load.
//
// Everything the module hands back is treated as untrusted input, because it
// is: lengths, names and messages are all values the module chose. The zero
// import property bounds what a hostile module can reach, but it does not stop
// one from returning a 4 GB length or a file name of "../../etc/passwd", and
// this is the layer that has to care. See docs/host-integration.md.

import { verify } from "./verify.mjs";

// Bit 0 is retired: it meant "skip the ROM hash check", which is the host's
// decision now and is made before a run rather than passed into one.
export const FLAG_NO_INCLUDE_ROM = 1 << 1;

export const ABI_VERSION = 1;

/** Default ceiling on a single output. Callers with a manifest should pass the
 *  value it declares instead of relying on this. */
const DEFAULT_MAX_OUTPUT_BYTES = 64 * 1024 * 1024;
const MAX_OUTPUTS = 64;
const MAX_INPUTS = 16;
const MAX_NAME_BYTES = 255;

// A module-supplied name is only ever used to label or save a file, so it must
// be a plain file name: no separators, no traversal, no control characters.
const SAFE_NAME = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;

function safeName(name) {
  if (!SAFE_NAME.test(name) || name.includes("..")) {
    throw new Error(`module returned an unsafe output name: ${JSON.stringify(name)}`);
  }
  return name;
}

/**
 * @param {Uint8Array} wasmBytes  the extractor module
 * @param {Uint8Array|Uint8Array[]} inputs  the input file(s); a lone
 *        Uint8Array is accepted as shorthand for a one-file list
 * @param {{flags?: number, maxOutputBytes?: number, expectedOutputs?: string[],
 *          onProgress?: (p: {stage: number, stages: number, name: string}) => void,
 *          shouldCancel?: () => boolean}} [opts]
 * @returns {Promise<{outputs: {name: string, data: Uint8Array}[], warnings: string[]}>}
 */
export async function extract(wasmBytes, inputs, opts = {}) {
  const {
    flags = 0,
    maxOutputBytes = DEFAULT_MAX_OUTPUT_BYTES,
    expectedOutputs = null,
    onProgress = null,
    shouldCancel = null,
  } = typeof opts === "number" ? { flags: opts } : opts;

  const check = verify(wasmBytes);
  if (!check.ok) {
    throw new Error(`module failed verification:\n  ${check.errors.join("\n  ")}`);
  }

  const { instance } = await WebAssembly.instantiate(wasmBytes);
  const x = instance.exports;

  const abi = x.abi_version() >>> 0;
  if (abi !== ABI_VERSION) {
    throw new Error(`module implements ABI version ${abi}, this host drives ${ABI_VERSION}`);
  }

  // Inputs are a list. Which file plays which role is the module's business,
  // decided from content -- this host never labels them, so it cannot get the
  // roles wrong on the module's behalf.
  const files = Array.isArray(inputs) ? inputs : [inputs];
  if (files.length === 0) throw new Error("no input files given");
  if (files.length > MAX_INPUTS) {
    throw new Error(`${files.length} input files given, over the ${MAX_INPUTS} limit`);
  }

  x.input_clear();
  for (const f of files) {
    const ptr = x.alloc(f.length);
    // Re-read memory.buffer per file: alloc can grow it and detach the last view.
    new Uint8Array(x.memory.buffer, ptr, f.length).set(f);
    x.input_add(ptr, f.length);
  }

  // Always drive the stepped path, even when nobody asked for progress: it is
  // what `run` does internally, and exercising it here means the incremental
  // route is the one covered by the parity check rather than a second,
  // less-travelled code path.
  const stages = x.stage_count() >>> 0;
  const stageName = (i) => {
    const p = x.stage_name_ptr(i), n = Math.min(x.stage_name_len(i) >>> 0, 255);
    return new TextDecoder().decode(new Uint8Array(x.memory.buffer, p >>> 0, n).slice());
  };

  let status = x.run_begin(flags) >>> 0;
  if (status === 0) {
    // Between steps the host has control: this is where progress is reported
    // and where a caller can walk away from the run.
    for (;;) {
      const index = x.stage_index() >>> 0;
      if (onProgress && index < stages) {
        onProgress({ stage: index, stages, name: stageName(index) });
      }
      if (shouldCancel && shouldCancel()) {
        throw new Error("extraction cancelled");
      }
      const step = x.run_step() >>> 0;
      if (step === 0) break;
      if (step !== 1) { status = step; break; }
    }
    if (status === 0 && onProgress) {
      onProgress({ stage: stages, stages, name: "done" });
    }
  }

  // memory.buffer must be re-read after every call that can grow memory:
  // growing it detaches any ArrayBuffer captured beforehand.
  const read = (p, n, what) => {
    const len = n >>> 0;
    if (len > maxOutputBytes) {
      throw new Error(`module claims ${len} bytes for ${what}, over the ${maxOutputBytes} limit`);
    }
    const buf = x.memory.buffer;
    if ((p >>> 0) + len > buf.byteLength) {
      throw new Error(`module returned an out-of-bounds range for ${what}`);
    }
    return new Uint8Array(buf, p >>> 0, len).slice();
  };
  const readText = (p, n, what) => new TextDecoder().decode(read(p, n, what));

  if (status !== 0) {
    const msg = readText(x.error_ptr(), Math.min(x.error_len() >>> 0, 4096), "the error message");
    throw new Error(msg || `module failed with status ${status}`);
  }

  const count = x.output_count() >>> 0;
  if (count === 0) throw new Error("module reported success but produced no output");
  if (count > MAX_OUTPUTS) throw new Error(`module reported ${count} outputs, over the limit`);

  const outputs = [];
  for (let i = 0; i < count; i++) {
    const name = safeName(
      readText(x.output_name_ptr(i), Math.min(x.output_name_len(i) >>> 0, MAX_NAME_BYTES), `output ${i} name`),
    );
    outputs.push({ name, data: read(x.output_ptr(i), x.output_len(i), `output ${i}`) });
  }

  // The manifest, not the module, decides what a legitimate run produces.
  if (expectedOutputs) {
    const got = outputs.map((o) => o.name).sort().join(",");
    const want = [...expectedOutputs].sort().join(",");
    if (got !== want) {
      throw new Error(`module produced [${got}] but the manifest declares [${want}]`);
    }
  }

  const warnText = readText(x.warnings_ptr(), Math.min(x.warnings_len() >>> 0, 64 * 1024), "warnings");
  return { outputs, warnings: warnText ? warnText.split("\n") : [] };
}

// Node CLI entry point. Guarded on `process` because this file is also loaded
// directly by the browser, where evaluating it would otherwise throw at import
// time and take the importing page down with it.
if (typeof process !== "undefined" && import.meta.url === `file://${process.argv[1]}`) {
  const { readFileSync, writeFileSync } = await import("node:fs");
  const [wasmPath, outPath, ...inputPaths] = process.argv.slice(2);
  if (!outPath || inputPaths.length === 0) {
    console.error("usage: extract.mjs <module.wasm> <out.dat> <input...>");
    process.exit(2);
  }
  const { outputs, warnings } = await extract(
    new Uint8Array(readFileSync(wasmPath)),
    inputPaths.map((p) => new Uint8Array(readFileSync(p))),
  );
  for (const w of warnings) console.error(`warning: ${w}`);
  // The CLI writes the first output where it was told to; anything further
  // lands beside it under the name the module gave.
  writeFileSync(outPath, outputs[0].data);
  console.log(`wrote ${outPath} (${outputs[0].data.length} bytes, as ${outputs[0].name})`);
  for (const o of outputs.slice(1)) {
    const p = outPath.replace(/[^/]*$/, o.name);
    writeFileSync(p, o.data);
    console.log(`wrote ${p} (${o.data.length} bytes)`);
  }
}
