# EarthBound converter

Turns a user's US EarthBound ROM into `earthbound_assets.dat` in the browser,
so releases never ship ROM data. It's a Rust crate that builds a zero-import
wasm module (gwrg-dist-spec processor ABI `wasm`/1) around an embedded recipe:
a list of copy/literal/compress ops over the ROM that reproduces the `.dat`
byte for byte. [FORMAT.md](FORMAT.md) specifies the recipe and the module
contract; `scripts/eb_recipe.py` generates `recipe/eb_recipe.bin`.

| File | |
|---|---|
| `src/lib.rs` | the wasm ABI (stages: check ROM, expand text, decompress, build assets, verify) |
| `src/recipe.rs` | the recipe interpreter and `.dat` container writer |
| `src/hallz.rs` | HAL codec, a byte-exact port of ebtools `hallz` |
| `src/hash.rs` | SHA-1 / SHA-256 |
| `src/synth.rs` | synthetic ROM + recipe exercising every opcode (tests only) |
| `src/bin/cli.rs` | native `eb-converter <rom.sfc> <out.dat> [--recipe FILE]`, for diffing |
| `verify.mjs`, `test.mjs` | conformance verifier and its tests (from zelda3-retro-go-sd) |
| `extract.mjs` | node host: `node extract.mjs <module.wasm> <out.dat> <rom.sfc>` |
| `test-abi.mjs` | ABI behaviour: errors, flags, cancellation, stepped vs one-shot, instance reuse |

## Build and test

```bash
cargo build --release --locked --target wasm32-unknown-unknown --lib
#   -> target/wasm32-unknown-unknown/release/eb_converter.wasm
./check.sh                       # cargo test + a module around the synthetic ROM
./check.sh earthbound.sfc        # + the real module on the ROM, compared with
                                 #   ../../earthbound_assets.dat (from `make`)
```

The wasm build fails without `recipe/eb_recipe.bin`; `EB_RECIPE=<path>` embeds
another recipe (check.sh uses this for the synthetic module). Native builds
embed an empty recipe when it's missing, so `cargo test` works without the ROM.

The memory cap in `.cargo/config.toml` is measured; `test-abi.mjs` prints the
peak page count of a run, so re-measure after a big recipe change.
