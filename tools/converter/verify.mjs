// Conformance verifier for gwrg-dist-spec processor (wasm/1) modules.
// Copied from zelda3-retro-go-sd tools/extractor (MIT); only maxMemoryPages
// is per-project.
//
// The security claim this enforces is structural, not behavioural: a module
// with an EMPTY import section has no way to reach the outside world. It has
// no host functions to call -- no filesystem, no network, no clock, no
// randomness, no JS bridge. The only things it can touch are its own linear
// memory and the arguments it is given. So rather than auditing what a module
// *does*, we check what it *can* do, which is decidable by reading the binary.
//
// Everything below parses the wasm module format directly (no dependencies),
// so this file can be dropped into a browser, a CI job, or a code review.

export const DEFAULT_POLICY = {
  // The exact export surface an extractor must present. Anything missing is a
  // broken module; anything extra is unreviewed surface area, so both fail.
  requiredExports: {
    memory: "memory",
    abi_version: "func",
    alloc: "func",
    input_clear: "func",
    input_add: "func",
    run: "func",
    run_begin: "func",
    run_step: "func",
    stage_count: "func",
    stage_index: "func",
    stage_name_ptr: "func",
    stage_name_len: "func",
    output_count: "func",
    output_name_ptr: "func",
    output_name_len: "func",
    output_ptr: "func",
    output_len: "func",
    error_ptr: "func",
    error_len: "func",
    warnings_ptr: "func",
    warnings_len: "func",
  },
  // The ABI revision this verifier implements. A module declares the same
  // number from its abi_version() export; a host that finds a mismatch after
  // instantiating should refuse to drive it.
  abiVersion: 1,
  // Immutable globals the wasm linker emits on its own. Rust up to 1.90
  // exports these from a cdylib and later versions do not, so requiring their
  // absence would make conformance depend on which toolchain built the module.
  // Permitting them costs nothing: a global export is a constant the host can
  // read, not something it can call, so it conveys no capability -- at most it
  // reveals the module's own memory layout. Every other export must still be
  // exactly the declared ABI, and a *function* by these names is not permitted.
  optionalExports: {
    __data_end: "global",
    __heap_base: "global",
  },
  allowImports: false,       // must import nothing at all
  allowStartSection: false,  // no code runs at instantiation time
  // Per-project, and deliberately not shared. This must be at least what
  // .cargo/config.toml lets the module declare, and no more than the project
  // is willing to let it grow to. The other projects vendoring this file set
  // their own number; converging them would either reject a module that is
  // fine or wave through one that is not. make_manifest.py publishes this as
  // limits.maxMemoryPages, so it is also what the manifest promises.
  maxMemoryPages: 1024,      // 64 MiB ceiling on declared memory growth;
                             // see .cargo/config.toml for the measured peak
  maxModuleBytes: 8 * 1024 * 1024,
};

const SECTION = {
  1: "type", 2: "import", 3: "function", 4: "table", 5: "memory", 6: "global",
  7: "export", 8: "start", 9: "element", 10: "code", 11: "data", 12: "datacount",
};
const EXTERNAL_KIND = ["func", "table", "memory", "global"];

class Cursor {
  constructor(bytes) { this.b = bytes; this.i = 0; }
  byte() {
    if (this.i >= this.b.length) throw new Error("unexpected end of module");
    return this.b[this.i++];
  }
  // LEB128 unsigned. Capped at 5 bytes: a longer encoding is malformed and is
  // a classic way to smuggle differing interpretations past two parsers.
  u32() {
    let result = 0, shift = 0;
    for (let n = 0; n < 5; n++) {
      const byte = this.byte();
      result |= (byte & 0x7f) << shift;
      if ((byte & 0x80) === 0) return result >>> 0;
      shift += 7;
    }
    throw new Error("malformed LEB128 (over-long encoding)");
  }
  bytes(n) {
    if (this.i + n > this.b.length) throw new Error("unexpected end of module");
    const s = this.b.subarray(this.i, this.i + n);
    this.i += n;
    return s;
  }
  name() { return new TextDecoder("utf-8", { fatal: true }).decode(this.bytes(this.u32())); }
}

/** Parse just enough of the module to answer the policy questions. */
export function inspect(bytes) {
  const c = new Cursor(bytes);
  const magic = c.bytes(4);
  if (magic[0] !== 0x00 || magic[1] !== 0x61 || magic[2] !== 0x73 || magic[3] !== 0x6d) {
    throw new Error("not a wasm module (bad magic)");
  }
  const version = new DataView(bytes.buffer, bytes.byteOffset + 4, 4).getUint32(0, true);
  c.i = 8;

  const info = {
    version, imports: [], exports: [], memories: [], hasStart: false,
    sections: [], customSections: [],
  };

  let lastId = 0;
  while (c.i < bytes.length) {
    const id = c.byte();
    const size = c.u32();
    const end = c.i + size;
    if (end > bytes.length) throw new Error(`section ${id} runs past end of module`);

    if (id === 0) {
      const save = c.i;
      info.customSections.push({ name: c.name(), size });
      c.i = save;
    } else {
      // Known sections must appear in ascending order exactly once. Out-of-order
      // or duplicate sections are malformed and can desync verifier vs runtime.
      if (id > 12) throw new Error(`unknown section id ${id}`);
      if (id <= lastId) throw new Error(`section ${SECTION[id] ?? id} out of order or duplicated`);
      lastId = id;
      info.sections.push(SECTION[id] ?? String(id));

      if (id === 2) {
        const n = c.u32();
        for (let k = 0; k < n; k++) {
          const module = c.name(), field = c.name(), kind = EXTERNAL_KIND[c.byte()];
          info.imports.push({ module, field, kind });
          c.i = end; // details of the descriptor don't matter; any import fails
          break;
        }
      } else if (id === 5) {
        const n = c.u32();
        for (let k = 0; k < n; k++) {
          const flags = c.byte();
          const min = c.u32();
          const max = (flags & 1) ? c.u32() : null;
          info.memories.push({ min, max, shared: !!(flags & 2) });
        }
      } else if (id === 7) {
        const n = c.u32();
        for (let k = 0; k < n; k++) {
          const name = c.name(), kind = EXTERNAL_KIND[c.byte()], index = c.u32();
          info.exports.push({ name, kind, index });
        }
      } else if (id === 8) {
        info.hasStart = true;
      }
    }
    c.i = end;
  }
  return info;
}

/** @returns {{ok: boolean, errors: string[], info: object}} */
export function verify(bytes, policy = DEFAULT_POLICY) {
  const errors = [];
  let info;
  try {
    info = inspect(bytes);
  } catch (e) {
    return { ok: false, errors: [`parse error: ${e.message}`], info: null };
  }

  if (bytes.length > policy.maxModuleBytes) {
    errors.push(`module is ${bytes.length} bytes, over the ${policy.maxModuleBytes} limit`);
  }
  if (info.version !== 1) errors.push(`unsupported wasm version ${info.version}`);

  if (!policy.allowImports && info.imports.length > 0) {
    for (const im of info.imports) {
      errors.push(`module imports ${im.module}.${im.field} (${im.kind}); imports are not permitted`);
    }
  }
  if (info.hasStart && !policy.allowStartSection) {
    errors.push("module has a start section (code would run at instantiation)");
  }

  const seen = new Map(info.exports.map((e) => [e.name, e.kind]));
  for (const [name, kind] of Object.entries(policy.requiredExports)) {
    if (!seen.has(name)) errors.push(`missing required export "${name}"`);
    else if (seen.get(name) !== kind) {
      errors.push(`export "${name}" is a ${seen.get(name)}, expected ${kind}`);
    }
  }
  for (const e of info.exports) {
    if (e.name in policy.optionalExports) {
      if (e.kind !== policy.optionalExports[e.name]) {
        errors.push(`export "${e.name}" is a ${e.kind}, expected a ${policy.optionalExports[e.name]}`);
      }
      continue;
    }
    if (!(e.name in policy.requiredExports)) {
      errors.push(`unexpected export "${e.name}" (${e.kind}); the surface must be exactly the declared ABI`);
    }
  }

  if (info.memories.length === 0) {
    errors.push("module declares no memory of its own");
  }
  for (const m of info.memories) {
    if (m.shared) errors.push("shared memory is not permitted");
    const cap = m.max ?? Infinity;
    if (cap > policy.maxMemoryPages) {
      errors.push(
        `memory may grow to ${m.max ?? "unbounded"} pages, over the ${policy.maxMemoryPages}-page limit`
      );
    }
  }

  return { ok: errors.length === 0, errors, info };
}

// --- CLI -------------------------------------------------------------------
// Node CLI entry point. Guarded on `process` because this file is also loaded
// directly by the browser, where evaluating it would otherwise throw at import
// time and take the importing page down with it.
if (typeof process !== "undefined" && import.meta.url === `file://${process.argv[1]}`) {
  const { readFileSync } = await import("node:fs");
  const path = process.argv[2];
  if (!path) {
    console.error("usage: verify.mjs <module.wasm>");
    process.exit(2);
  }
  const bytes = new Uint8Array(readFileSync(path));
  const { ok, errors, info } = verify(bytes);
  if (info) {
    console.log(`module:   ${path} (${bytes.length} bytes)`);
    console.log(`sections: ${info.sections.join(", ")}`);
    console.log(`imports:  ${info.imports.length === 0 ? "(none)" : info.imports.map((i) => `${i.module}.${i.field}`).join(", ")}`);
    console.log(`exports:  ${info.exports.map((e) => `${e.name}:${e.kind}`).join(", ")}`);
    console.log(`memory:   ${info.memories.map((m) => `min=${m.min} max=${m.max ?? "unbounded"}`).join(", ") || "(none)"}`);
  }
  if (ok) {
    console.log("\nPASS - module is conformant and structurally sandboxed.");
  } else {
    console.error("\nFAIL");
    for (const e of errors) console.error(`  - ${e}`);
    process.exit(1);
  }
}
