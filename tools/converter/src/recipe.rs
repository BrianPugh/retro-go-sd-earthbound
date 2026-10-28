//! The recipe interpreter (FORMAT.md): ROM in, `earthbound_assets.dat` out.
//!
//! The work is split into named stages that a host steps through one call at
//! a time; the long ones (decompression, the program walk) return after a
//! work budget so the host gets control back often.

use crate::{hallz, hash};

pub const MAGIC: u32 = 0x4352_4245; // "EBRC"
pub const VERSION: u32 = 1;
pub const HEADER_SIZE: usize = 76;
pub const ROM_SIZE: usize = 3 * 1024 * 1024;
pub const DICT_WORDS: usize = 768;

pub const DAT_MAGIC: u32 = 0x3141_4245; // "EBA1"
pub const DAT_HEADER_SIZE: usize = 16;
pub const DAT_ALIGN: usize = 16;

/// Opcodes.
pub mod op {
    pub const END: u8 = 0x00;
    pub const COPY: u8 = 0x01;
    pub const SEQ: u8 = 0x02;
    pub const LIT: u8 = 0x03;
    pub const U32: u8 = 0x04;
    pub const BEGIN: u8 = 0x05;
    pub const COMPRESS: u8 = 0x06;
    pub const ASSET: u8 = 0x07;
}

pub const STAGES: [&str; 5] = [
    "Checking ROM",
    "Expanding text",
    "Decompressing",
    "Building assets",
    "Verifying output",
];

/// Work units (output bytes, or input bytes for decompression) per step.
/// A real run takes a few dozen steps, each well under 100 ms.
const STEP_BUDGET: usize = 256 * 1024;
/// HAL compression costs far more per byte than a copy.
const COMPRESS_WEIGHT: usize = 16;
/// Guards the container's table allocation against a garbage header.
const MAX_ASSETS: u32 = 1 << 20;

#[derive(Default, Debug, Clone)]
pub struct Header {
    pub rom_sha1: [u8; 20],
    pub dat_sha256: [u8; 32],
    pub dat_len: u32,
    pub layout_crc: u32,
    pub asset_count: u32,
    pub dict_ptrs: u32,
    pub streams: Vec<u32>,
    /// Offset of the first program byte.
    pub program: usize,
}

fn u32le(b: &[u8], at: usize) -> u32 {
    u32::from_le_bytes(b[at..at + 4].try_into().unwrap())
}

/// Unsigned LEB128, at most 5 bytes, value within u32, canonical (no
/// redundant trailing zero groups). Returns (value, bytes consumed).
pub fn read_varint(b: &[u8], at: usize) -> Result<(u32, usize), String> {
    let mut v: u64 = 0;
    for i in 0..5 {
        let Some(&byte) = b.get(at + i) else {
            return Err("varint runs past the end of the recipe".into());
        };
        v |= ((byte & 0x7F) as u64) << (7 * i);
        if byte & 0x80 == 0 {
            if i > 0 && byte == 0 {
                return Err("non-canonical varint".into());
            }
            if v > u32::MAX as u64 {
                return Err("varint exceeds 32 bits".into());
            }
            return Ok((v as u32, i + 1));
        }
    }
    Err("varint longer than 5 bytes".into())
}

pub fn parse_header(r: &[u8]) -> Result<Header, String> {
    if r.is_empty() {
        return Err("this converter was built without a recipe (recipe/eb_recipe.bin was missing)".into());
    }
    if r.len() < HEADER_SIZE + 1 {
        return Err(format!("recipe is truncated ({} bytes)", r.len()));
    }
    if u32le(r, 0) != MAGIC {
        return Err("recipe has a bad magic number".into());
    }
    let version = u32le(r, 4);
    if version != VERSION {
        return Err(format!("recipe version {version}, this converter reads version {VERSION}"));
    }
    let mut h = Header {
        rom_sha1: r[8..28].try_into().unwrap(),
        dat_sha256: r[28..60].try_into().unwrap(),
        dat_len: u32le(r, 60),
        layout_crc: u32le(r, 64),
        asset_count: u32le(r, 68),
        dict_ptrs: u32le(r, 72),
        ..Default::default()
    };
    if h.asset_count > MAX_ASSETS {
        return Err(format!("recipe header claims {} assets", h.asset_count));
    }
    let mut at = HEADER_SIZE;
    let (count, n) = read_varint(r, at).map_err(|e| format!("recipe header: {e}"))?;
    at += n;
    for _ in 0..count {
        let (off, n) = read_varint(r, at).map_err(|e| format!("recipe header: {e}"))?;
        at += n;
        h.streams.push(off);
    }
    h.program = at;
    Ok(h)
}

/// The text-expansion walk (FORMAT.md, source 1), handing each emitted piece
/// to `emit`.
fn expand_walk(rom: &[u8], words: &[core::ops::Range<usize>], mut emit: impl FnMut(&[u8])) {
    let mut i = 0;
    while i < rom.len() {
        let c = rom[i];
        if (0x15..=0x17).contains(&c) && i + 1 < rom.len() {
            emit(&rom[words[(c - 0x15) as usize * 256 + rom[i + 1] as usize].clone()]);
            i += 2;
        } else {
            emit(&rom[i..i + 1]);
            i += 1;
        }
    }
}

pub struct Converter<'r> {
    recipe: &'r [u8],
    header: Header,
    inputs: Vec<Vec<u8>>,
    /// Off only for generating test recipes: skips the ROM and output checks.
    verify: bool,
    stage: usize,
    /// 0 = ROM, 1 = text-expanded ROM, 2 + i = stream i.
    sources: Vec<Vec<u8>>,
    pc: usize,
    stack: Vec<Vec<u8>>,
    cursor: Option<(usize, usize)>,
    /// The container, filled as each ASSET completes.
    out: Vec<u8>,
    assets: u32,
    warnings: Vec<String>,
}

impl<'r> Converter<'r> {
    pub fn new(recipe: &'r [u8], inputs: Vec<Vec<u8>>) -> Result<Self, String> {
        if inputs.is_empty() {
            return Err("no input files were registered".into());
        }
        Ok(Converter {
            recipe,
            header: Header::default(),
            inputs,
            verify: true,
            stage: 0,
            sources: Vec::new(),
            pc: 0,
            stack: Vec::new(),
            cursor: None,
            out: Vec::new(),
            assets: 0,
            warnings: Vec::new(),
        })
    }

    /// Runs `recipe` over `rom` without checking the ROM hash or the output's
    /// length and hash, so a test can build a recipe and then fill those in.
    pub fn new_unverified(recipe: &'r [u8], rom: Vec<u8>) -> Self {
        let mut c = Self::new(recipe, vec![rom]).unwrap();
        c.verify = false;
        c
    }

    /// Stages completed so far; `STAGES.len()` once done.
    pub fn stage_index(&self) -> usize {
        self.stage
    }

    /// One slice of work. `Ok(true)` once the output is ready for `finish`.
    pub fn step(&mut self) -> Result<bool, String> {
        match self.stage {
            0 => self.check_rom()?,
            1 => self.expand_text()?,
            2 => {
                if !self.decompress_some()? {
                    return Ok(false);
                }
            }
            3 => {
                if !self.run_some()? {
                    return Ok(false);
                }
            }
            4 => self.verify_output()?,
            _ => return Err("the run has already finished".into()),
        }
        self.stage += 1;
        Ok(self.stage == STAGES.len())
    }

    /// The `.dat` and any warnings. Call after `step` returned `Ok(true)`.
    pub fn finish(self) -> (Vec<u8>, Vec<String>) {
        (self.out, self.warnings)
    }

    fn check_rom(&mut self) -> Result<(), String> {
        self.header = parse_header(self.recipe)?;
        let want = self.header.rom_sha1;
        let inputs = core::mem::take(&mut self.inputs);
        let hashes: Vec<[u8; 20]> = inputs.iter().map(|f| hash::sha1(f)).collect();
        let pick = match hashes.iter().position(|h| *h == want) {
            Some(i) => i,
            None if !self.verify => 0,
            None => {
                let f = &inputs[0];
                let why = if f.len() == ROM_SIZE + 512 {
                    "it has a 512-byte copier header; remove it and try again".to_string()
                } else if f.len() != ROM_SIZE {
                    format!("it is {} bytes, the US EarthBound ROM is {ROM_SIZE}", f.len())
                } else {
                    format!("its SHA-1 is {}, expected {}", hash::hex(&hashes[0]), hash::hex(&want))
                };
                return Err(format!("not the US EarthBound ROM this converter expects: {why}"));
            }
        };
        for (i, h) in hashes.iter().enumerate() {
            if i != pick {
                self.warnings.push(format!(
                    "ignored input {i} (SHA-1 {}): only the US EarthBound ROM is used",
                    hash::hex(h)
                ));
            }
        }
        let rom = inputs.into_iter().nth(pick).unwrap();
        self.sources = vec![rom];

        let table = DAT_HEADER_SIZE + 8 * self.header.asset_count as usize;
        self.out = Vec::with_capacity(table.max(self.header.dat_len as usize));
        self.out.resize(table, 0);
        self.stack = vec![Vec::new()];
        self.pc = self.header.program;
        Ok(())
    }

    fn expand_text(&mut self) -> Result<(), String> {
        let rom = &self.sources[0];
        let base = self.header.dict_ptrs as usize;
        if base.checked_add(4 * DICT_WORDS).is_none_or(|end| end > rom.len()) {
            return Err(format!("recipe: dictionary table at 0x{base:X} is outside the ROM"));
        }
        let mut words = Vec::with_capacity(DICT_WORDS);
        for k in 0..DICT_WORDS {
            let start = (u32le(rom, base + 4 * k) & 0x3F_FFFF) as usize;
            let len = rom
                .get(start..)
                .and_then(|s| s.iter().position(|&b| b == 0))
                .ok_or_else(|| format!("dictionary word {k} at 0x{start:X} has no terminator in the ROM"))?;
            words.push(start..start + len);
        }
        // Size first, so the buffer is allocated once.
        let mut size = 0usize;
        expand_walk(rom, &words, |s| size += s.len());
        let mut exp = Vec::with_capacity(size);
        expand_walk(rom, &words, |s| exp.extend_from_slice(s));
        self.sources.push(exp);
        Ok(())
    }

    /// Decompresses streams until the budget runs out. `Ok(true)` when all are done.
    fn decompress_some(&mut self) -> Result<bool, String> {
        let mut work = 0;
        while work < STEP_BUDGET {
            let i = self.sources.len() - 2;
            let Some(&off) = self.header.streams.get(i) else {
                return Ok(true);
            };
            let rom = &self.sources[0];
            let off = off as usize;
            if off >= rom.len() {
                return Err(format!("recipe: stream {i} starts at 0x{off:X}, outside the ROM"));
            }
            let mut d = hallz::decompress(&rom[off..]).map_err(|e| format!("stream {i} at 0x{off:X}: {e}"))?;
            d.shrink_to_fit();
            work += d.len() + 1;
            self.sources.push(d);
        }
        Ok(self.sources.len() - 2 == self.header.streams.len())
    }

    fn varint(&mut self) -> Result<usize, String> {
        let (v, n) = read_varint(self.recipe, self.pc)?;
        self.pc += n;
        Ok(v as usize)
    }

    /// Walks the program until the budget runs out. `Ok(true)` after END.
    fn run_some(&mut self) -> Result<bool, String> {
        let mut work = 0;
        while work < STEP_BUDGET {
            let at = self.pc;
            match self.exec() {
                Ok(None) => return Ok(true),
                Ok(Some(w)) => work += w + 1,
                Err(e) => return Err(format!("recipe op at byte {at}: {e}")),
            }
        }
        Ok(false)
    }

    /// One op. `Some(work)` to continue, `None` after END.
    fn exec(&mut self) -> Result<Option<usize>, String> {
        let Some(&code) = self.recipe.get(self.pc) else {
            return Err("program ends without END".into());
        };
        self.pc += 1;
        let work = match code {
            op::END => {
                let count = self.header.asset_count;
                if self.assets != count {
                    return Err(format!("END after {} ASSETs, the header declares {count}", self.assets));
                }
                if self.stack.len() != 1 {
                    return Err(format!("END with {} unclosed BEGIN(s)", self.stack.len() - 1));
                }
                if !self.stack[0].is_empty() {
                    return Err(format!("END with {} bytes not closed by ASSET", self.stack[0].len()));
                }
                let trailing = self.recipe.len() - self.pc;
                if trailing != 0 {
                    return Err(format!("{trailing} trailing bytes after END"));
                }
                self.stack.clear();
                return Ok(None);
            }
            op::COPY => {
                let src = self.varint()?;
                let off = self.varint()?;
                let len = self.varint()?;
                self.append_source(src, off, len)?
            }
            op::SEQ => {
                let gap = self.varint()?;
                let len = self.varint()?;
                let (src, pos) = self.cursor.ok_or("SEQ before any COPY")?;
                let off = pos.checked_add(gap).ok_or("SEQ offset overflows")?;
                self.append_source(src, off, len)?
            }
            op::LIT => {
                let len = self.varint()?;
                let end = self.pc.checked_add(len).filter(|&e| e <= self.recipe.len());
                let end = end.ok_or("LIT runs past the end of the recipe")?;
                let bytes = &self.recipe[self.pc..end];
                self.stack.last_mut().unwrap().extend_from_slice(bytes);
                self.pc = end;
                len
            }
            op::U32 => {
                let v = self.varint()? as u32;
                self.top().extend_from_slice(&v.to_le_bytes());
                4
            }
            op::BEGIN => {
                self.stack.push(Vec::new());
                0
            }
            op::COMPRESS => {
                if self.stack.len() < 2 {
                    return Err("COMPRESS without a matching BEGIN".into());
                }
                let buf = self.stack.pop().unwrap();
                let packed = hallz::compress(&buf);
                self.top().extend_from_slice(&packed);
                buf.len() * COMPRESS_WEIGHT
            }
            op::ASSET => {
                if self.stack.len() != 1 {
                    return Err(format!("ASSET with {} unclosed BEGIN(s)", self.stack.len() - 1));
                }
                if self.assets >= self.header.asset_count {
                    return Err(format!("more ASSETs than the {} the header declares", self.header.asset_count));
                }
                let buf = core::mem::take(&mut self.stack[0]);
                self.push_asset(&buf)?;
                0
            }
            other => return Err(format!("unknown opcode 0x{other:02X}")),
        };
        Ok(Some(work))
    }

    fn top(&mut self) -> &mut Vec<u8> {
        self.stack.last_mut().unwrap()
    }

    fn append_source(&mut self, src: usize, off: usize, len: usize) -> Result<usize, String> {
        let source = self.sources.get(src).ok_or_else(|| {
            format!("source {src} does not exist (have {})", self.sources.len())
        })?;
        let end = off.checked_add(len).filter(|&e| e <= source.len()).ok_or_else(|| {
            format!("source {src} read [{off}, +{len}) is past its end ({} bytes)", source.len())
        })?;
        self.stack.last_mut().unwrap().extend_from_slice(&source[off..end]);
        self.cursor = Some((src, end));
        Ok(len)
    }

    /// Appends one asset to the container, 16-byte aligned, and fills its
    /// table entry (scripts/eb_assets.py `pack`).
    fn push_asset(&mut self, data: &[u8]) -> Result<(), String> {
        let pad = self.out.len().wrapping_neg() % DAT_ALIGN;
        self.out.resize(self.out.len() + pad, 0);
        let offset = self.out.len();
        if offset + data.len() > u32::MAX as usize {
            return Err("output exceeds 4 GiB".into());
        }
        let entry = DAT_HEADER_SIZE + 8 * self.assets as usize;
        self.out[entry..entry + 4].copy_from_slice(&(offset as u32).to_le_bytes());
        self.out[entry + 4..entry + 8].copy_from_slice(&(data.len() as u32).to_le_bytes());
        self.out.extend_from_slice(data);
        self.assets += 1;
        Ok(())
    }

    fn verify_output(&mut self) -> Result<(), String> {
        let total = self.out.len() as u32;
        let h = &self.header;
        for (i, v) in [DAT_MAGIC, h.asset_count, h.layout_crc, total].into_iter().enumerate() {
            self.out[4 * i..4 * i + 4].copy_from_slice(&v.to_le_bytes());
        }
        // The sources are no longer needed; free them before hashing.
        self.sources = Vec::new();
        if !self.verify {
            return Ok(());
        }
        if total != h.dat_len {
            return Err(format!(
                "output is {total} bytes, the recipe expects {}: the converter is broken, nothing was written",
                h.dat_len
            ));
        }
        let got = hash::sha256(&self.out);
        if got != h.dat_sha256 {
            return Err(format!(
                "output SHA-256 {} does not match the recipe's {}: the converter is broken, nothing was written",
                hash::hex(&got),
                hash::hex(&h.dat_sha256)
            ));
        }
        Ok(())
    }
}

/// The whole conversion in one call: what the stepped ABI does, for native
/// callers.
pub fn convert(recipe: &[u8], inputs: Vec<Vec<u8>>) -> Result<(Vec<u8>, Vec<String>), String> {
    let mut c = Converter::new(recipe, inputs)?;
    while !c.step()? {}
    Ok(c.finish())
}
