# EarthBound converter: recipe format and module contract

The browser converter turns a user's US EarthBound ROM into
`earthbound_assets.dat` (format: `scripts/eb_assets.py` docstring) without
the repo shipping any ROM data. It does this by running a **recipe**:
a list of operations over the ROM that reproduces the `.dat` byte for byte.

- `scripts/eb_recipe.py` (needs the ROM + a ROM build's ebtools outputs)
  generates the recipe from the real `.dat`, then runs its own Python
  reference interpreter and checks the output against
  `scripts/eb_assets.py pack` byte for byte.
- `tools/converter/` is a Rust crate building a zero-import wasm module
  (gwrg-dist-spec `wasm`/`1` processor ABI) that embeds the recipe
  (`include_bytes!`) and interprets it.
- The recipe is committed at `tools/converter/recipe/eb_recipe.bin`.
  Regenerate it on every submodule bump, alongside `make gen-headers`.

## Sources

The interpreter derives every source from the ROM (3,145,728 bytes, no
copier header, HiROM: SNES address `a` -> file offset `a & 0x3FFFFF`).

| id | Source |
|---|---|
| 0 | The ROM |
| 1 | The ROM with text-dictionary codes expanded (below) |
| 2 + i | `hal_decompress(rom[stream_offsets[i]..])` |

**Text expansion** (source 1): walk the ROM from byte 0. A byte `c` in
`0x15..=0x17` with a following byte `b` emits `words[(c - 0x15) * 256 + b]`
and advances 2; every other byte (including a `0x15..=0x17` at the very last
position) is emitted as-is and advances 1. `words[k]` is the NUL-terminated
string at file offset `u32le(rom[dict_ptrs + 4k..]) & 0x3FFFFF`, NUL
excluded, for k in 0..768. The walk is deliberately naive (it also expands
non-text bytes); it only has to be deterministic.

## Encoding

Little-endian. `varint` is unsigned LEB128 (7 bits per byte, low first).

### Header

| Offset | Field |
|---|---|
| 0 | `u32` magic `0x43524245` ("EBRC") |
| 4 | `u32` recipe version = 1 |
| 8 | `[u8; 20]` SHA-1 of the ROM this recipe expects |
| 28 | `[u8; 32]` SHA-256 of the `.dat` it must produce |
| 60 | `u32` expected `.dat` length |
| 64 | `u32` layout CRC (`EB_ASSET_LAYOUT_CRC`, the `.dat` header field) |
| 68 | `u32` asset count |
| 72 | `u32` `dict_ptrs`: file offset of the 768 x u32 dictionary pointer table |
| 76 | `varint` stream count `S`, then `S` x `varint` stream file offsets |
| … | program |

### Program

A byte opcode stream. The interpreter keeps a **stack of byte buffers**
(bottom = the current asset) and a **cursor** `(src, pos)` set by the last
`COPY` / `SEQ`.

| Op | Byte | Operands | Effect |
|---|---|---|---|
| `END` | `0x00` | | End of program. Must follow exactly `asset count` `ASSET`s, with an empty stack |
| `COPY` | `0x01` | `varint src, varint off, varint len` | append `source[src][off..off+len]`; cursor = `(src, off+len)` |
| `SEQ` | `0x02` | `varint gap, varint len` | `off = cursor.pos + gap`; append `source[cursor.src][off..off+len]`; cursor = `(cursor.src, off+len)` |
| `LIT` | `0x03` | `varint len, len bytes` | append the bytes |
| `U32` | `0x04` | `varint value` | append `u32le(value)` |
| `BEGIN` | `0x05` | | push an empty buffer |
| `COMPRESS` | `0x06` | | pop a buffer, append `hal_compress(it)` to the new top |
| `ASSET` | `0x07` | | the stack must hold exactly the asset buffer; it becomes the next asset (in `src/gen/eb_asset_list.txt` order); start a new empty asset buffer |

Any out-of-range source read, unknown opcode, stack misuse, or trailing
bytes after `END` is an error.

**What the recipe stores.** `COPY`/`SEQ` operands are offsets and lengths
into the user's ROM-derived sources. The only payload bytes are `LIT` data
(control codes, remapped table numbers, `.bundled` headers; about 1.9 KB)
and `U32` values (about 40 KB), which are offsets into the dialogue blob:
the same numbers upstream publishes as `MSG_*` in `src/data/text_refs.h`.
Run `scripts/eb_recipe.py report` on a regenerated recipe and review any
text-like `LIT` run before committing it.

### Output

After `END` the interpreter writes the `.dat` container itself (the
`EBA1` layout in `scripts/eb_assets.py`, 16-byte aligned asset starts,
`layout CRC` from the header) and checks its length and SHA-256 against the
header. A mismatch is an error, never a silently wrong file.

## HAL codec contract

`hal_compress` / `hal_decompress` are ebtools' `ebtools/hallz/compress.py`
`compress()` and `decompress.py` `decompress()`, ported byte-exact. Rust
signatures in `tools/converter/src/hallz.rs`:

```rust
pub fn compress(data: &[u8]) -> Vec<u8>;
pub fn decompress(data: &[u8]) -> Result<Vec<u8>, &'static str>;
```

`decompress` reads one stream from the start of `data` and ignores bytes
after its terminator.

## Module ABI

gwrg-dist-spec `spec/04-processor.md`, `wasm`/`1`: no imports, stepped run
with named stages, one input (the ROM, `base`, sha1 checked by the host
against the manifest; the module checks it against the recipe header too
and reports a mismatch as an error), one output id `assets` ->
`earthbound_assets.dat`. `options: []`.
