//! Native harness: the same code path as the wasm module, so the output can
//! be diffed against the Python reference without a wasm runtime.
//!
//!   eb-converter <rom.sfc> <out.dat> [--recipe <eb_recipe.bin>]
//!
//! `--recipe` runs a recipe file instead of the embedded one.

use std::process::exit;

fn main() {
    let args: Vec<String> = std::env::args().collect();
    let usage = || -> ! {
        eprintln!("usage: {} <rom.sfc> <out.dat> [--recipe <eb_recipe.bin>]", args[0]);
        exit(2)
    };
    let (rom, out, recipe_path) = match &args[1..] {
        [rom, out] => (rom, out, None),
        [rom, out, flag, path] if flag == "--recipe" => (rom, out, Some(path)),
        _ => usage(),
    };
    let rom = std::fs::read(rom).unwrap_or_else(|e| {
        eprintln!("error: reading {rom}: {e}");
        exit(1)
    });
    let file_recipe = recipe_path.map(|p| {
        std::fs::read(p).unwrap_or_else(|e| {
            eprintln!("error: reading {p}: {e}");
            exit(1)
        })
    });
    let recipe = file_recipe.as_deref().unwrap_or(eb_converter::RECIPE);
    match eb_converter::recipe::convert(recipe, vec![rom]) {
        Ok((data, warnings)) => {
            for w in &warnings {
                eprintln!("warning: {w}");
            }
            std::fs::write(out, &data).unwrap_or_else(|e| {
                eprintln!("error: writing {out}: {e}");
                exit(1)
            });
            eprintln!("wrote {out} ({} bytes)", data.len());
        }
        Err(e) => {
            eprintln!("error: {e}");
            exit(1);
        }
    }
}
