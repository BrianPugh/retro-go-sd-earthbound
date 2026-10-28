//! HALLZ2 codec, a byte-exact port of ebtools/hallz (compress.py, decompress.py).
//!
//! `compress` reproduces the Python greedy match-finder exactly, including its
//! hash-chain order, chain limits and tie-breaks, so the output matches the
//! asset pack the reference build produces.

use std::vec::Vec;

const BIT_REVERSE: [u8; 256] = {
    let mut t = [0u8; 256];
    let mut i = 0;
    while i < 256 {
        t[i] = (i as u8).reverse_bits();
        i += 1;
    }
    t
};

const NONE: u32 = u32::MAX;
const MAX_LEN: usize = 1024;
const MAX_CHAIN: u32 = 512;
const MAX_CHAIN_REV: u32 = 256;

fn push_header(out: &mut Vec<u8>, cmd: u8, len: usize) {
    if len <= 32 {
        out.push((cmd << 5) | (len - 1) as u8);
    } else {
        let e = len - 1;
        out.push(0xE0 | (cmd << 2) | (e >> 8) as u8);
        out.push(e as u8);
    }
}

/// Hash chains over already-consumed positions. The forward chain is keyed on
/// (data[p], data[p+1]); the backward one on (data[p], data[p-1]), the first
/// 2 bytes a backward copy from p reads.
struct MatchFinder<'a> {
    data: &'a [u8],
    head: Vec<u32>,
    chain: Vec<u32>,
    bwd_head: Vec<u32>,
    bwd_chain: Vec<u32>,
}

impl<'a> MatchFinder<'a> {
    fn new(data: &'a [u8]) -> Self {
        let n = data.len();
        MatchFinder {
            data,
            head: vec![NONE; 1 << 16],
            chain: vec![NONE; n],
            bwd_head: vec![NONE; 1 << 16],
            bwd_chain: vec![NONE; n],
        }
    }

    fn advance(&mut self, pos: usize) {
        let d = self.data;
        if pos + 1 < d.len() {
            let h = ((d[pos] as usize) << 8) | d[pos + 1] as usize;
            self.chain[pos] = self.head[h];
            self.head[h] = pos as u32;
        }
        if pos > 0 {
            let h = ((d[pos] as usize) << 8) | d[pos - 1] as usize;
            self.bwd_chain[pos] = self.bwd_head[h];
            self.bwd_head[h] = pos as u32;
        }
    }

    // A candidate with an offset past 0xFFFF is skipped (`ok` is false for
    // it): Python raises OverflowError there, so any choice is parity-safe.

    fn find_forward(&self, pos: usize) -> (usize, usize) {
        let d = self.data;
        let n = d.len();
        if pos + 1 >= n {
            return (0, 0);
        }
        let max_len = (n - pos).min(MAX_LEN);
        let (mut best_len, mut best_off) = (0, 0);
        let mut off = self.head[((d[pos] as usize) << 8) | d[pos + 1] as usize];
        let mut left = MAX_CHAIN;
        while off != NONE && left > 0 {
            let o = off as usize;
            let mut len = 0;
            while len < max_len && d[o + len] == d[pos + len] {
                len += 1;
            }
            if len > best_len {
                best_len = len;
                best_off = o;
                if len == max_len {
                    break;
                }
            }
            off = self.chain[o];
            left -= 1;
        }
        (best_len, best_off)
    }

    fn find_reversed(&self, pos: usize) -> (usize, usize) {
        let d = self.data;
        let n = d.len();
        if pos + 1 >= n {
            return (0, 0);
        }
        let max_len = (n - pos).min(MAX_LEN);
        let (mut best_len, mut best_off) = (0, 0);
        let h = ((BIT_REVERSE[d[pos] as usize] as usize) << 8) | BIT_REVERSE[d[pos + 1] as usize] as usize;
        let mut off = self.head[h];
        let mut left = MAX_CHAIN_REV;
        while off != NONE && left > 0 {
            let o = off as usize;
            // Source must end before pos (no overlap)
            if o + 1 < pos {
                let avail = max_len.min(pos - o);
                let mut len = 0;
                while len < avail && BIT_REVERSE[d[o + len] as usize] == d[pos + len] {
                    len += 1;
                }
                if len > best_len {
                    best_len = len;
                    best_off = o;
                    if len == max_len {
                        break;
                    }
                }
            }
            off = self.chain[o];
            left -= 1;
        }
        (best_len, best_off)
    }

    fn find_backward(&self, pos: usize) -> (usize, usize) {
        let d = self.data;
        let n = d.len();
        if pos + 1 >= n {
            return (0, 0);
        }
        let max_len = (n - pos).min(MAX_LEN);
        let (mut best_len, mut best_off) = (0, 0);
        let mut off = self.bwd_head[((d[pos] as usize) << 8) | d[pos + 1] as usize];
        let mut left = MAX_CHAIN;
        while off != NONE && left > 0 {
            let o = off as usize;
            if o < pos {
                // The read pointer sticks at 0 once it gets there
                let mut len = 0;
                let mut r = o;
                while len < max_len && d[r] == d[pos + len] {
                    len += 1;
                    r = r.saturating_sub(1);
                }
                if len > best_len {
                    best_len = len;
                    best_off = o;
                    if len == max_len {
                        break;
                    }
                }
            }
            off = self.bwd_chain[o];
            left -= 1;
        }
        (best_len, best_off)
    }
}

fn flush_literals(out: &mut Vec<u8>, lit: &[u8]) {
    for chunk in lit.chunks(MAX_LEN) {
        push_header(out, 0, chunk.len());
        out.extend_from_slice(chunk);
    }
}

#[derive(Clone, Copy)]
struct Cmd {
    id: u8,
    len: usize,
    arg: [u8; 2],
    arg_len: usize,
    consumed: usize,
}

/// Greedy HALLZ2 compressor: at each position take the command with the most
/// savings (first found wins ties, in the order byte fill, incrementing fill,
/// word fill, forward, bit-reversed, backward copy), else a literal byte.
pub fn compress(data: &[u8]) -> Vec<u8> {
    let n = data.len();
    let mut out = Vec::with_capacity(n / 2 + 16);
    if n == 0 {
        out.push(0xFF);
        return out;
    }
    let mut mf = MatchFinder::new(data);
    let mut pos = 0;
    let mut lit_start = 0;

    while pos < n {
        let mut best_sav = 0usize;
        let mut best: Option<Cmd> = None;
        let mut consider = |sav: usize, c: Cmd, best_sav: &mut usize| {
            if sav > *best_sav {
                *best_sav = sav;
                best = Some(c);
            }
        };
        let cost = |len: usize, base: usize| if len <= 32 { base } else { base + 1 };
        let b0 = data[pos];

        // Byte fill (cmd 1)
        let limit = n.min(pos + MAX_LEN);
        let mut i = pos + 1;
        while i < limit && data[i] == b0 {
            i += 1;
        }
        let run = i - pos;
        if run >= 3 {
            consider(run - cost(run, 2), Cmd { id: 1, len: run, arg: [b0, 0], arg_len: 1, consumed: run }, &mut best_sav);
        }

        // Incrementing fill (cmd 3)
        let mut i = pos + 1;
        while i < limit && data[i] == b0.wrapping_add((i - pos) as u8) {
            i += 1;
        }
        let run = i - pos;
        if run >= 3 {
            consider(run - cost(run, 2), Cmd { id: 3, len: run, arg: [b0, 0], arg_len: 1, consumed: run }, &mut best_sav);
        }

        // Word fill (cmd 2), counted in words
        if pos + 3 < n {
            let (lo, hi) = (data[pos], data[pos + 1]);
            let limit = (n - 1).min(pos + 2 * MAX_LEN);
            let mut count = 1;
            let mut i = pos + 2;
            while i < limit && data[i] == lo && data[i + 1] == hi {
                count += 1;
                i += 2;
            }
            if count >= 2 {
                let consumed = count * 2;
                consider(consumed - cost(count, 3), Cmd { id: 2, len: count, arg: [lo, hi], arg_len: 2, consumed }, &mut best_sav);
            }
        }

        let mut copy = |id: u8, (len, off): (usize, usize), best_sav: &mut usize| {
            if len >= 4 && off <= 0xFFFF {
                let c = Cmd { id, len, arg: (off as u16).to_be_bytes(), arg_len: 2, consumed: len };
                if len - cost(len, 3) > *best_sav {
                    *best_sav = len - cost(len, 3);
                    best = Some(c);
                }
            }
        };
        if pos > 0 {
            copy(4, mf.find_forward(pos), &mut best_sav);
            // Reversed/backward only when forward saved little
            if best_sav < 8 {
                copy(5, mf.find_reversed(pos), &mut best_sav);
                copy(6, mf.find_backward(pos), &mut best_sav);
            }
        }

        match best {
            Some(c) => {
                if pos > lit_start {
                    flush_literals(&mut out, &data[lit_start..pos]);
                }
                push_header(&mut out, c.id, c.len);
                out.extend_from_slice(&c.arg[..c.arg_len]);
                for p in pos..pos + c.consumed {
                    mf.advance(p);
                }
                pos += c.consumed;
                lit_start = pos;
            }
            None => {
                mf.advance(pos);
                pos += 1;
                if pos - lit_start >= MAX_LEN {
                    flush_literals(&mut out, &data[lit_start..pos]);
                    lit_start = pos;
                }
            }
        }
    }
    if pos > lit_start {
        flush_literals(&mut out, &data[lit_start..pos]);
    }
    out.push(0xFF);
    out
}

/// HALLZ2 decompressor. Copies that read past the output so far yield 0 and
/// op 7 with a length acts as a forward copy (both as in the Python and the
/// 65816 original). A truncated stream or a missing 0xFF terminator is an
/// error, where Python returns the partial output.
pub fn decompress(src: &[u8]) -> Result<Vec<u8>, &'static str> {
    const TRUNC: &str = "HALLZ2 stream truncated";
    let mut out: Vec<u8> = Vec::new();
    let mut si = 0;
    loop {
        let cmd = *src.get(si).ok_or("HALLZ2 stream missing terminator")?;
        if cmd == 0xFF {
            return Ok(out);
        }
        let (op, len) = if cmd & 0xE0 == 0xE0 {
            let lo = *src.get(si + 1).ok_or(TRUNC)?;
            si += 2;
            (cmd << 3 & 0xE0, (((cmd & 3) as usize) << 8 | lo as usize) + 1)
        } else {
            si += 1;
            (cmd & 0xE0, (cmd & 0x1F) as usize + 1)
        };
        match op {
            0x00 => {
                let lit = src.get(si..si + len).ok_or(TRUNC)?;
                out.extend_from_slice(lit);
                si += len;
            }
            0x20 => {
                let v = *src.get(si).ok_or(TRUNC)?;
                si += 1;
                out.resize(out.len() + len, v);
            }
            0x40 => {
                let w = src.get(si..si + 2).ok_or(TRUNC)?;
                si += 2;
                for _ in 0..len {
                    out.extend_from_slice(w);
                }
            }
            0x60 => {
                let v = *src.get(si).ok_or(TRUNC)?;
                si += 1;
                out.extend((0..len).map(|i| v.wrapping_add(i as u8)));
            }
            _ => {
                let a = src.get(si..si + 2).ok_or(TRUNC)?;
                let mut r = ((a[0] as usize) << 8) | a[1] as usize;
                si += 2;
                for _ in 0..len {
                    let b = out.get(r).copied().unwrap_or(0);
                    match op {
                        0xA0 => {
                            out.push(BIT_REVERSE[b as usize]);
                            r += 1;
                        }
                        0xC0 => {
                            out.push(b);
                            r = r.saturating_sub(1);
                        }
                        _ => {
                            out.push(b);
                            r += 1;
                        }
                    }
                }
            }
        }
    }
}
