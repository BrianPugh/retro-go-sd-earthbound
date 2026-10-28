//! Checks hallz.rs against the vectors dump_vectors.py writes.
//! Usage: cargo run --release -- <vector dir>

#[path = "../../converter/src/hallz.rs"]
mod hallz;

use std::time::{Duration, Instant};

fn main() {
    let dir = std::env::args().nth(1).expect("usage: hallz-parity <vector dir>");
    let dir = std::path::Path::new(&dir);
    let manifest = std::fs::read_to_string(dir.join("manifest.txt")).expect("manifest.txt");
    let (mut c_ok, mut c_bad, mut d_ok, mut d_bad, mut rejected, mut skipped) = (0, 0, 0, 0, 0, 0);
    let (mut c_time, mut d_time) = (Duration::ZERO, Duration::ZERO);
    let (mut c_bytes, mut d_bytes) = (0usize, 0usize);
    for line in manifest.lines().filter(|l| !l.is_empty()) {
        let mut it = line.splitn(3, ' ');
        let id: usize = it.next().unwrap().parse().unwrap();
        let kind = it.next().unwrap();
        let name = it.next().unwrap_or("");
        let inp = std::fs::read(dir.join(format!("{id:05}.in"))).unwrap();
        let exp = std::fs::read(dir.join(format!("{id:05}.out"))).unwrap();
        match kind {
            "c" => {
                let t = Instant::now();
                let got = hallz::compress(&inp);
                c_time += t.elapsed();
                c_bytes += inp.len();
                if got == exp {
                    c_ok += 1;
                } else {
                    c_bad += 1;
                    let at = got.iter().zip(&exp).position(|(a, b)| a != b);
                    let at = at.unwrap_or(got.len().min(exp.len()));
                    eprintln!(
                        "COMPRESS MISMATCH {id} {name}: got {} exp {} bytes, first diff at {at}",
                        got.len(),
                        exp.len()
                    );
                }
            }
            "d" => {
                let t = Instant::now();
                let got = hallz::decompress(&inp);
                d_time += t.elapsed();
                d_bytes += exp.len();
                match got {
                    Ok(g) if g == exp => d_ok += 1,
                    // Python returns partial output on malformed streams
                    Err(e) if name.contains("bad_") => {
                        rejected += 1;
                        println!("rejected {name}: {e} (python gave {} bytes)", exp.len());
                    }
                    other => {
                        d_bad += 1;
                        eprintln!("DECOMPRESS MISMATCH {id} {name}: {:?}", other.map(|g| g.len()));
                    }
                }
            }
            _ => {
                // No reference output; the Rust stream must still round-trip
                skipped += 1;
                let ok = hallz::decompress(&hallz::compress(&inp)).ok() == Some(inp);
                println!("skipped {name}: python compress() raised (rust round trip ok: {ok})");
                if !ok {
                    c_bad += 1;
                }
            }
        }
    }
    println!("compress:   {c_ok} match, {c_bad} mismatch ({c_bytes} B in {c_time:?})");
    println!(
        "decompress: {d_ok} match, {d_bad} mismatch, {rejected} malformed rejected ({d_bytes} B in {d_time:?})"
    );
    println!("skipped: {skipped}");
    std::process::exit(if c_bad + d_bad == 0 { 0 } else { 1 });
}
