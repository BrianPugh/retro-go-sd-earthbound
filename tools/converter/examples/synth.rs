//! Writes the synthetic ROM, its recipe and the expected `.dat` into a
//! directory, so check.sh can build a wasm module around them
//! (`EB_RECIPE=<dir>/recipe.bin`) and run the ABI tests without the real ROM.
//!
//!   cargo run --example synth -- <dir>

fn main() {
    let dir = std::path::PathBuf::from(std::env::args().nth(1).expect("usage: synth <dir>"));
    std::fs::create_dir_all(&dir).unwrap();
    let mut s = eb_converter::synth::Synth::new(eb_converter::synth::synthetic_rom());
    eb_converter::synth::full_program(&mut s);
    std::fs::write(dir.join("rom.sfc"), &s.rom).unwrap();
    std::fs::write(dir.join("recipe.bin"), s.recipe()).unwrap();
    std::fs::write(dir.join("expected.dat"), s.expected_dat()).unwrap();
    eprintln!("wrote synthetic rom.sfc, recipe.bin, expected.dat to {}", dir.display());
}
