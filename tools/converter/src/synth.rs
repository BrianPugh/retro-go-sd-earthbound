//! A synthetic ROM and recipe that exercise every opcode, for tests and for
//! building a test wasm module (`examples/synth.rs`) without the real ROM.
//!
//! `Synth` emits ops and, in step, models what each one should produce from
//! its own copy of the sources, so the expected `.dat` (and the SHA-256 in the
//! recipe header) comes from this model and not from the interpreter under
//! test.

use crate::{hallz, hash, recipe};
use recipe::op;

pub fn varint(mut v: u64, out: &mut Vec<u8>) {
    loop {
        let b = (v & 0x7F) as u8;
        v >>= 7;
        if v == 0 {
            out.push(b);
            return;
        }
        out.push(b | 0x80);
    }
}

/// A HAL stream using every command, and what it decompresses to.
pub const HAND_STREAM: &[u8] = &[
    0x23, 0xAA, // fill 4 x AA
    0x41, 0x12, 0x34, // 2 words 12 34
    0x62, 0x05, // 05 06 07
    0x01, b'X', b'Y', // literal "XY"
    0x81, 0x00, 0x00, // forward copy 2 from 0
    0xA0, 0x00, 0x04, // bit-reversed copy 1 from 4: 0x12 -> 0x48
    0xC2, 0x00, 0x0C, // backward copy 3 from 12: 'Y' 'X' 07
    0xE4, 0x02, 0x00, // extended byte fill, 3 x 00
    0xFF, 0xEE, // terminator, then junk the decoder must ignore
];
pub const HAND_STREAM_OUT: &[u8] = &[
    0xAA, 0xAA, 0xAA, 0xAA, 0x12, 0x34, 0x12, 0x34, 0x05, 0x06, 0x07, b'X', b'Y', 0xAA, 0xAA, 0x48, b'Y',
    b'X', 0x07, 0x00, 0x00, 0x00,
];

pub const ROM_LEN: usize = 64 * 1024;
const DICT_PTRS: usize = 0x8000;
const WORDS_AT: usize = 0x8C00;
const STREAM_AT: [usize; 3] = [0x9000, 0xA000, 0xB000];
pub const LAYOUT_CRC: u32 = 0x1234_5678;

/// Deterministic filler with plenty of 0x15..=0x17 bytes, a dictionary, 3
/// HAL streams and a dictionary code as the very last byte.
pub fn synthetic_rom() -> Vec<u8> {
    let mut rom = vec![0u8; ROM_LEN];
    let mut x: u32 = 0x2545_F491;
    for b in rom.iter_mut() {
        x ^= x << 13;
        x ^= x >> 17;
        x ^= x << 5;
        // Bias towards the dictionary codes so expansion has work to do.
        *b = if x % 7 == 0 { 0x15 + (x >> 8) as u8 % 3 } else { (x >> 16) as u8 };
    }
    // 768 pointers with SNES bank bits set (the interpreter masks them) to a
    // handful of words, one of them empty.
    let words: [&[u8]; 5] = [b"", b"the ", b"PSI ", b"Ness", b"\x15\x16"];
    let mut at = WORDS_AT;
    let mut addrs = Vec::new();
    for w in words {
        addrs.push(at);
        rom[at..at + w.len()].copy_from_slice(w);
        rom[at + w.len()] = 0;
        at += w.len() + 1;
    }
    for k in 0..recipe::DICT_WORDS {
        let a = (0xC0_0000 | addrs[k % addrs.len()]) as u32;
        rom[DICT_PTRS + 4 * k..DICT_PTRS + 4 * k + 4].copy_from_slice(&a.to_le_bytes());
    }
    let s1 = hallz::compress(&rom[0x100..0x1100]);
    let s2 = hallz::compress(&vec![0x33; 3000]);
    rom[STREAM_AT[0]..STREAM_AT[0] + HAND_STREAM.len()].copy_from_slice(HAND_STREAM);
    rom[STREAM_AT[1]..STREAM_AT[1] + s1.len()].copy_from_slice(&s1);
    rom[STREAM_AT[2]..STREAM_AT[2] + s2.len()].copy_from_slice(&s2);
    *rom.last_mut().unwrap() = 0x16;
    rom
}

/// Model of source 1, written independently of the interpreter's.
fn model_expand(rom: &[u8]) -> Vec<u8> {
    let word = |k: usize| {
        let a = (u32::from_le_bytes(rom[DICT_PTRS + 4 * k..][..4].try_into().unwrap()) & 0x3F_FFFF) as usize;
        let n = rom[a..].iter().position(|&b| b == 0).unwrap();
        &rom[a..a + n]
    };
    let mut out = Vec::new();
    let mut i = 0;
    while i < rom.len() {
        match rom[i] {
            c @ 0x15..=0x17 if i + 1 < rom.len() => {
                out.extend_from_slice(word((c as usize - 0x15) * 256 + rom[i + 1] as usize));
                i += 2;
            }
            c => {
                out.push(c);
                i += 1;
            }
        }
    }
    out
}

/// Recipe builder plus a model of what the program produces.
pub struct Synth {
    pub rom: Vec<u8>,
    pub sources: Vec<Vec<u8>>,
    pub streams: Vec<u32>,
    pub dict_ptrs: u32,
    pub layout_crc: u32,
    pub program: Vec<u8>,
    stack: Vec<Vec<u8>>,
    cursor: (usize, usize),
    pub assets: Vec<Vec<u8>>,
}

impl Synth {
    pub fn new(rom: Vec<u8>) -> Self {
        let streams: Vec<u32> = STREAM_AT.iter().map(|&a| a as u32).collect();
        let mut sources = vec![rom.clone(), model_expand(&rom)];
        for &s in &streams {
            sources.push(hallz::decompress(&rom[s as usize..]).unwrap());
        }
        assert_eq!(sources[2], HAND_STREAM_OUT);
        Synth {
            rom,
            sources,
            streams,
            dict_ptrs: DICT_PTRS as u32,
            layout_crc: LAYOUT_CRC,
            program: Vec::new(),
            stack: vec![Vec::new()],
            cursor: (0, 0),
            assets: Vec::new(),
        }
    }

    fn top(&mut self) -> &mut Vec<u8> {
        self.stack.last_mut().unwrap()
    }

    pub fn copy(&mut self, src: usize, off: usize, len: usize) -> &mut Self {
        self.program.push(op::COPY);
        for v in [src, off, len] {
            varint(v as u64, &mut self.program);
        }
        let data = self.sources[src][off..off + len].to_vec();
        self.top().extend_from_slice(&data);
        self.cursor = (src, off + len);
        self
    }

    pub fn seq(&mut self, gap: usize, len: usize) -> &mut Self {
        self.program.push(op::SEQ);
        varint(gap as u64, &mut self.program);
        varint(len as u64, &mut self.program);
        let (src, pos) = self.cursor;
        let data = self.sources[src][pos + gap..pos + gap + len].to_vec();
        self.top().extend_from_slice(&data);
        self.cursor = (src, pos + gap + len);
        self
    }

    pub fn lit(&mut self, bytes: &[u8]) -> &mut Self {
        self.program.push(op::LIT);
        varint(bytes.len() as u64, &mut self.program);
        self.program.extend_from_slice(bytes);
        self.top().extend_from_slice(bytes);
        self
    }

    pub fn u32(&mut self, v: u32) -> &mut Self {
        self.program.push(op::U32);
        varint(v as u64, &mut self.program);
        self.top().extend_from_slice(&v.to_le_bytes());
        self
    }

    pub fn begin(&mut self) -> &mut Self {
        self.program.push(op::BEGIN);
        self.stack.push(Vec::new());
        self
    }

    pub fn compress(&mut self) -> &mut Self {
        self.program.push(op::COMPRESS);
        let b = self.stack.pop().unwrap();
        self.top().extend_from_slice(&hallz::compress(&b));
        self
    }

    pub fn asset(&mut self) -> &mut Self {
        self.program.push(op::ASSET);
        assert_eq!(self.stack.len(), 1);
        let b = core::mem::take(&mut self.stack[0]);
        self.assets.push(b);
        self
    }

    pub fn end(&mut self) -> &mut Self {
        self.program.push(op::END);
        self
    }

    /// Arbitrary program bytes, for malformed-recipe tests.
    pub fn raw(&mut self, bytes: &[u8]) -> &mut Self {
        self.program.extend_from_slice(bytes);
        self
    }

    /// The `.dat` the model expects, packed like scripts/eb_assets.py.
    pub fn expected_dat(&self) -> Vec<u8> {
        let mut offset = recipe::DAT_HEADER_SIZE + 8 * self.assets.len();
        let mut table = Vec::new();
        let mut body = Vec::new();
        for a in &self.assets {
            while (offset + body.len()) % recipe::DAT_ALIGN != 0 {
                body.push(0);
            }
            table.extend_from_slice(&((offset + body.len()) as u32).to_le_bytes());
            table.extend_from_slice(&(a.len() as u32).to_le_bytes());
            body.extend_from_slice(a);
        }
        offset += body.len();
        let mut out = Vec::new();
        for v in [recipe::DAT_MAGIC, self.assets.len() as u32, self.layout_crc, offset as u32] {
            out.extend_from_slice(&v.to_le_bytes());
        }
        out.extend(table);
        out.extend(body);
        out
    }

    /// The recipe, with header fields given explicitly.
    pub fn recipe_with(&self, rom_sha1: [u8; 20], dat_sha256: [u8; 32], dat_len: u32, asset_count: u32) -> Vec<u8> {
        let mut r = Vec::new();
        r.extend_from_slice(&recipe::MAGIC.to_le_bytes());
        r.extend_from_slice(&recipe::VERSION.to_le_bytes());
        r.extend_from_slice(&rom_sha1);
        r.extend_from_slice(&dat_sha256);
        for v in [dat_len, self.layout_crc, asset_count, self.dict_ptrs] {
            r.extend_from_slice(&v.to_le_bytes());
        }
        varint(self.streams.len() as u64, &mut r);
        for &s in &self.streams {
            varint(s as u64, &mut r);
        }
        r.extend_from_slice(&self.program);
        r
    }

    /// The recipe with a correct header for the program built so far.
    pub fn recipe(&self) -> Vec<u8> {
        let dat = self.expected_dat();
        self.recipe_with(hash::sha1(&self.rom), hash::sha256(&dat), dat.len() as u32, self.assets.len() as u32)
    }
}

/// A program covering every opcode, cursor carry-over across ASSET, empty
/// assets, nested COMPRESS, and enough output to span several steps.
pub fn full_program(s: &mut Synth) {
    let exp_len = s.sources[1].len();
    // 0: plain ROM copies, SEQ with and without a gap, zero-length ops.
    s.copy(0, 0, 100).seq(0, 20).seq(7, 3).seq(0, 0).copy(0, ROM_LEN - 5, 5).copy(0, 10, 0).asset();
    // 1: cursor carries over from the previous asset; then the expanded ROM,
    // including its very end.
    s.seq(1, 4).copy(1, 1000, 300).seq(2, 50).copy(1, exp_len - 9, 9).asset();
    // 2: every stream, literals and u32s (multi-byte varints).
    s.copy(2, 0, HAND_STREAM_OUT.len()).copy(3, 0, 4096).copy(4, 2990, 10).seq(0, 0);
    s.lit(b"").lit(b"hello").lit(&[0xFF; 300]).u32(0).u32(300).u32(0x8000_0000).u32(u32::MAX).asset();
    // 3: empty asset.
    s.asset();
    // 4: nested compression, and compressing an empty buffer.
    s.lit(b"pre").begin().copy(0, 0x200, 2000).begin().lit(b"inner").u32(7).compress();
    s.copy(1, 5, 5).compress().begin().compress().lit(b"post").asset();
    // 5: bulk, so the program walk spans several steps.
    for k in 0..24 {
        s.copy(0, 0, ROM_LEN - k);
    }
    s.asset();
    // 6: odd size, so the next asset needs padding.
    s.lit(&[1, 2, 3]).asset();
    s.lit(&[4]).asset();
    s.end();
}

/// (rom, recipe) for the full synthetic program.
pub fn synthetic() -> (Vec<u8>, Vec<u8>) {
    let mut s = Synth::new(synthetic_rom());
    full_program(&mut s);
    (s.rom.clone(), s.recipe())
}
