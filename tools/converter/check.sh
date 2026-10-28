#!/usr/bin/env bash
# Full local check of the converter.
#
#   ./check.sh                        tests, plus a wasm module built around
#                                     the synthetic ROM (no real ROM needed)
#   ./check.sh rom.sfc [oracle.dat]   also runs the real module on the ROM and
#                                     compares with the Python-packed .dat
#
# The oracle defaults to ../../earthbound_assets.dat, which `make` writes with
# scripts/eb_assets.py pack (the ROM build).
set -euo pipefail
cd "$(dirname "$0")"

ROM="${1:-}"
ORACLE="${2:-../../earthbound_assets.dat}"
WASM=target/wasm32-unknown-unknown/release/eb_converter.wasm
SYNTH=target/synth-data
SYNTH_WASM=target/synth/wasm32-unknown-unknown/release/eb_converter.wasm

echo "== cargo test =="
cargo test --locked

echo; echo "== synthetic module =="
cargo run -q --locked --example synth -- "$SYNTH"
EB_RECIPE="$SYNTH/recipe.bin" cargo build --release --locked \
  --target wasm32-unknown-unknown --lib --target-dir target/synth
node test.mjs "$SYNTH_WASM"
node test-abi.mjs "$SYNTH_WASM" "$SYNTH/rom.sfc" "$SYNTH/expected.dat"

if [[ ! -f recipe/eb_recipe.bin ]]; then
  echo; echo "No recipe/eb_recipe.bin - skipping the real module."
  exit 0
fi

echo; echo "== real module =="
cargo build --release --locked --target wasm32-unknown-unknown --lib
node verify.mjs "$WASM"
node test.mjs "$WASM"

if [[ -z "$ROM" ]]; then
  echo; echo "No ROM given - skipping output parity."
  echo "Run './check.sh /path/to/earthbound.sfc' to compare against the Python reference."
  exit 0
fi
if [[ ! -f "$ORACLE" ]]; then
  echo "error: no oracle .dat at $ORACLE (run make in the repo root, or pass one)" >&2
  exit 1
fi

tmp="$(mktemp -d)"
trap 'rm -rf "$tmp"' EXIT
echo; echo "== parity =="
node extract.mjs "$WASM" "$tmp/wasm.dat" "$ROM"
cargo run -q --release --locked --bin eb-converter -- "$ROM" "$tmp/native.dat"
cmp "$ORACLE" "$tmp/wasm.dat"
cmp "$ORACLE" "$tmp/native.dat"
echo "PASS - wasm and native output are byte-identical to $ORACLE."

echo; echo "== ABI behaviour (real ROM) =="
node test-abi.mjs "$WASM" "$ROM" "$ORACLE"
