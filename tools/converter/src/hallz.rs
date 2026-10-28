//! PLACEHOLDER: the byte-exact HAL codec is ported in a separate change, which
//! replaces this whole file. The rest of the crate only uses these 2
//! signatures (FORMAT.md, "HAL codec contract").
//!
//! `decompress` is a straight port of ebtools `hallz/decompress.py`.
//! `compress` is a literal-only encoder: it emits valid HAL streams that
//! round-trip, but they don't match ebtools' `compress.py` byte for byte, so a
//! real recipe's COMPRESS ops fail the output SHA-256 check until the real
//! codec lands.

/// Literal-only HAL stream: runs of up to 1024 verbatim bytes, then `0xFF`.
pub fn compress(data: &[u8]) -> Vec<u8> {
    let mut out = Vec::with_capacity(data.len() + data.len() / 1024 * 2 + 3);
    for run in data.chunks(1024) {
        let n = run.len() - 1;
        if n < 32 {
            out.push(n as u8);
        } else {
            out.push(0xE0 | (n >> 8) as u8);
            out.push(n as u8);
        }
        out.extend_from_slice(run);
    }
    out.push(0xFF);
    out
}

/// One HALLZ2 stream from the start of `data`. Like the Python, it stops at
/// the `0xFF` terminator or the end of `data`, and a command truncated by the
/// end of `data` ends the stream without an error.
pub fn decompress(data: &[u8]) -> Result<Vec<u8>, &'static str> {
    let src = data;
    let mut si = 0usize;
    let mut out: Vec<u8> = Vec::new();

    while si < src.len() {
        let cmd = src[si];
        if cmd == 0xFF {
            break;
        }
        let op;
        let length;
        if cmd & 0xE0 == 0xE0 {
            op = (cmd << 3) & 0xE0;
            si += 1;
            if si >= src.len() {
                break;
            }
            length = ((((cmd & 3) as usize) << 8) | src[si] as usize) + 1;
            si += 1;
        } else {
            op = cmd & 0xE0;
            length = (cmd & 0x1F) as usize + 1;
            si += 1;
        }

        match op {
            0x00 => {
                let n = length.min(src.len() - si);
                out.extend_from_slice(&src[si..si + n]);
                si += n;
            }
            0x20 => {
                if si >= src.len() {
                    break;
                }
                let fill = src[si];
                si += 1;
                out.resize(out.len() + length, fill);
            }
            0x40 => {
                if si + 1 >= src.len() {
                    break;
                }
                let (lo, hi) = (src[si], src[si + 1]);
                si += 2;
                for _ in 0..length {
                    out.push(lo);
                    out.push(hi);
                }
            }
            0x60 => {
                if si >= src.len() {
                    break;
                }
                let val = src[si];
                si += 1;
                for k in 0..length {
                    out.push(val.wrapping_add(k as u8));
                }
            }
            _ => {
                // 0x80 forward, 0xA0 bit-reversed, 0xC0 backward; anything
                // else (0xE0 from an extended 0xFC..0xFE) copies forward.
                if si + 1 >= src.len() {
                    break;
                }
                let mut r = ((src[si] as usize) << 8) | src[si + 1] as usize;
                si += 2;
                for _ in 0..length {
                    let b = out.get(r).copied().unwrap_or(0);
                    match op {
                        0xA0 => out.push(b.reverse_bits()),
                        0xC0 => {
                            out.push(b);
                            r = r.saturating_sub(1);
                            continue;
                        }
                        _ => out.push(b),
                    }
                    r += 1;
                }
            }
        }
    }
    Ok(out)
}
