//! Interpreter tests over the synthetic ROM: the full program against the
//! builder's model, stepping, and every error path.

use eb_converter::recipe::{self, op, Converter, STAGES};
use eb_converter::synth::{self, Synth};
use eb_converter::{hallz, hash};

fn run(recipe: &[u8], rom: &[u8]) -> Result<Vec<u8>, String> {
    recipe::convert(recipe, vec![rom.to_vec()]).map(|(d, _)| d)
}

fn new_synth() -> Synth {
    Synth::new(synth::synthetic_rom())
}

/// The program's recipe with a correct ROM hash and asset count, but a
/// placeholder output hash: for programs that must fail before the end.
fn recipe_for(s: &Synth, asset_count: u32) -> Vec<u8> {
    s.recipe_with(hash::sha1(&s.rom), [0; 32], 0, asset_count)
}

fn expect_err(recipe: &[u8], rom: &[u8], needle: &str) {
    match run(recipe, rom) {
        Ok(_) => panic!("expected an error containing {needle:?}, the run succeeded"),
        Err(e) => assert!(e.contains(needle), "error {e:?} does not contain {needle:?}"),
    }
}

fn program_err(build: impl FnOnce(&mut Synth), asset_count: u32, needle: &str) {
    let mut s = new_synth();
    build(&mut s);
    expect_err(&recipe_for(&s, asset_count), &s.rom.clone(), needle);
}

#[test]
fn hal_decompress_hand_stream() {
    assert_eq!(hallz::decompress(synth::HAND_STREAM).unwrap(), synth::HAND_STREAM_OUT);
}

#[test]
fn hal_round_trip() {
    for data in [vec![], vec![7u8], (0..5000u32).map(|i| (i * 31 % 251) as u8).collect(), vec![0; 4096]] {
        assert_eq!(hallz::decompress(&hallz::compress(&data)).unwrap(), data);
    }
}

#[test]
fn full_program_matches_model() {
    let mut s = new_synth();
    synth::full_program(&mut s);
    let expected = s.expected_dat();
    let got = run(&s.recipe(), &s.rom).unwrap();
    assert_eq!(got.len(), expected.len());
    assert!(got == expected, "output differs from the model");

    // Container shape, checked directly.
    let u = |at: usize| u32::from_le_bytes(got[at..at + 4].try_into().unwrap());
    assert_eq!(u(0), recipe::DAT_MAGIC);
    assert_eq!(u(4) as usize, s.assets.len());
    assert_eq!(u(8), synth::LAYOUT_CRC);
    assert_eq!(u(12) as usize, got.len());
    for (i, a) in s.assets.iter().enumerate() {
        let (off, len) = (u(16 + 8 * i) as usize, u(20 + 8 * i) as usize);
        assert_eq!(off % 16, 0, "asset {i} is unaligned");
        assert_eq!(&got[off..off + len], &a[..], "asset {i}");
    }
}

#[test]
fn stepping_returns_often_and_matches_one_shot() {
    let (rom, r) = synth::synthetic();
    let one_shot = run(&r, &rom).unwrap();
    let mut c = Converter::new(&r, vec![rom.clone()]).unwrap();
    let mut steps = 0;
    let mut seen = vec![];
    loop {
        seen.push(c.stage_index());
        steps += 1;
        if c.step().unwrap() {
            break;
        }
    }
    assert_eq!(c.stage_index(), STAGES.len());
    assert!(seen.windows(2).all(|w| w[0] <= w[1]), "stage index went backwards");
    // The bulk asset is 1.5 MB: the program walk must have yielded mid-stage.
    let in_build = seen.iter().filter(|&&s| s == 3).count();
    assert!(in_build >= 4, "build stage took {in_build} steps");
    assert!(steps > STAGES.len());
    assert!(c.step().is_err(), "stepping a finished run must fail");
    assert_eq!(c.finish().0, one_shot);
}

#[test]
fn empty_program() {
    let mut s = new_synth();
    s.end();
    let got = run(&s.recipe(), &s.rom).unwrap();
    assert_eq!(got, s.expected_dat());
    assert_eq!(got.len(), 16);
}

#[test]
fn input_selection() {
    let (rom, r) = synth::synthetic();
    let expected = run(&r, &rom).unwrap();
    let (got, warnings) = recipe::convert(&r, vec![vec![1, 2, 3], rom.clone()]).unwrap();
    assert_eq!(got, expected);
    assert_eq!(warnings.len(), 1);
    assert!(warnings[0].contains("ignored input 0"), "{warnings:?}");

    assert!(recipe::convert(&r, vec![]).unwrap_err().contains("no input"));
    expect_err(&r, &rom[..1000], "not the US EarthBound ROM");
    let mut bad = rom.clone();
    bad[5] ^= 1;
    expect_err(&r, &bad, "65536 bytes");
    expect_err(&r, &vec![0u8; recipe::ROM_SIZE], "its SHA-1 is");
    let mut headered = vec![0u8; 512];
    headered.extend(vec![0u8; recipe::ROM_SIZE]);
    expect_err(&r, &headered, "copier header");
}

#[test]
fn output_checks() {
    let mut s = new_synth();
    synth::full_program(&mut s);
    let dat = s.expected_dat();
    let sha1 = hash::sha1(&s.rom);
    let count = s.assets.len() as u32;
    let wrong_len = s.recipe_with(sha1, hash::sha256(&dat), dat.len() as u32 + 16, count);
    expect_err(&wrong_len, &s.rom, "bytes, the recipe expects");
    let wrong_sha = s.recipe_with(sha1, [0xAB; 32], dat.len() as u32, count);
    expect_err(&wrong_sha, &s.rom, "SHA-256");
}

#[test]
fn header_errors() {
    let (rom, r) = synth::synthetic();
    expect_err(&[], &rom, "built without a recipe");
    expect_err(&r[..40], &rom, "truncated");
    let mut m = r.clone();
    m[0] ^= 1;
    expect_err(&m, &rom, "bad magic");
    let mut m = r.clone();
    m[4] = 2;
    expect_err(&m, &rom, "version 2");
    let mut m = r.clone();
    m[68..72].copy_from_slice(&u32::MAX.to_le_bytes());
    expect_err(&m, &rom, "claims");

    let mut s = new_synth();
    s.streams.push(rom.len() as u32);
    s.end();
    expect_err(&recipe_for(&s, 0), &rom, "outside the ROM");

    let mut s = new_synth();
    s.dict_ptrs = (rom.len() - 100) as u32;
    s.end();
    expect_err(&recipe_for(&s, 0), &rom, "dictionary table");

    // A dictionary word with no NUL before the end of the ROM.
    let mut rom2 = rom.clone();
    let n = rom2.len();
    rom2[n - 3..].fill(0x41);
    rom2[0x100..0x104].copy_from_slice(&((n - 3) as u32).to_le_bytes());
    let mut s = new_synth();
    s.rom = rom2.clone();
    s.dict_ptrs = 0x100;
    s.end();
    expect_err(&recipe_for(&s, 0), &rom2, "no terminator");
}

#[test]
fn varint_rules() {
    assert_eq!(recipe::read_varint(&[0x00], 0).unwrap(), (0, 1));
    assert_eq!(recipe::read_varint(&[0xAC, 0x02], 0).unwrap(), (300, 2));
    assert_eq!(recipe::read_varint(&[0xFF, 0xFF, 0xFF, 0xFF, 0x0F], 0).unwrap(), (u32::MAX, 5));
    assert!(recipe::read_varint(&[0xFF, 0xFF, 0xFF, 0xFF, 0x1F], 0).unwrap_err().contains("32 bits"));
    assert!(recipe::read_varint(&[0x80, 0x80, 0x80, 0x80, 0x80, 0x00], 0).unwrap_err().contains("5 bytes"));
    assert!(recipe::read_varint(&[0x80, 0x00], 0).unwrap_err().contains("non-canonical"));
    assert!(recipe::read_varint(&[0x80], 0).unwrap_err().contains("past the end"));
}

#[test]
fn program_errors() {
    let r = synth::ROM_LEN;
    program_err(|s| { s.raw(&[0x08]); }, 0, "unknown opcode 0x08");
    program_err(|s| { s.raw(&[0xFF]); }, 0, "unknown opcode 0xFF");
    program_err(|_| {}, 0, "without END");
    program_err(|s| { s.copy(0, 0, 4); }, 1, "without END");
    program_err(|s| { s.raw(&[op::COPY, 5, 0, 1]); }, 0, "source 5 does not exist");
    program_err(|s| { s.raw(&[op::COPY, 0]); }, 0, "past the end of the recipe");
    program_err(|s| { s.copy(0, r - 1, 1).raw(&[op::SEQ, 0, 1]); }, 0, "past its end");
    program_err(|s| {
        s.raw(&[op::COPY, 0]);
        synth::varint(r as u64 - 2, &mut s.program);
        s.raw(&[3]);
    }, 0, "past its end");
    program_err(|s| { s.raw(&[op::SEQ, 0, 1]); }, 0, "SEQ before any COPY");
    program_err(|s| {
        s.copy(0, 0, 1).raw(&[op::SEQ, 0xFF, 0xFF, 0xFF, 0xFF, 0x0F, 0]);
    }, 0, "past its end");
    program_err(|s| { s.raw(&[op::LIT, 10, 1, 2]); }, 0, "LIT runs past");
    program_err(|s| { s.raw(&[op::U32, 0x80, 0x80, 0x80, 0x80, 0x10]); }, 0, "32 bits");
    program_err(|s| { s.raw(&[op::U32, 0x80, 0x00]); }, 0, "non-canonical");
    program_err(|s| { s.raw(&[op::COMPRESS]); }, 0, "COMPRESS without a matching BEGIN");
    program_err(|s| { s.begin().raw(&[op::ASSET]); }, 1, "ASSET with 1 unclosed");
    program_err(|s| { s.asset().asset(); }, 1, "more ASSETs than the 1");
    program_err(|s| { s.asset().end(); }, 2, "END after 1 ASSETs, the header declares 2");
    program_err(|s| { s.begin().end(); }, 0, "END with 1 unclosed");
    program_err(|s| { s.lit(b"x").end(); }, 0, "END with 1 bytes not closed");
    program_err(|s| { s.end().raw(&[0]); }, 0, "1 trailing bytes after END");
    // Errors name the op's position in the recipe.
    let mut s = new_synth();
    s.lit(b"abc").raw(&[0x09]);
    let at = recipe_for(&s, 0).len() - 1;
    expect_err(&recipe_for(&s, 0), &s.rom.clone(), &format!("op at byte {at}"));
}
