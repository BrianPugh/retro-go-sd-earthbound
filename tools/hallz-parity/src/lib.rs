//! Tiny wrapper proving hallz.rs builds for wasm with no imports:
//! `cargo build --release --lib --target wasm32-unknown-unknown`

#[path = "../../converter/src/hallz.rs"]
pub mod hallz;

/// Compressed length of `len` bytes at `ptr`, or usize::MAX if the round
/// trip fails (keeps both functions linked).
///
/// # Safety
/// `ptr` must point to `len` readable bytes.
#[no_mangle]
pub unsafe extern "C" fn hallz_roundtrip_len(ptr: *const u8, len: usize) -> usize {
    let data = core::slice::from_raw_parts(ptr, len);
    let c = hallz::compress(data);
    match hallz::decompress(&c) {
        Ok(d) if d == data => c.len(),
        _ => usize::MAX,
    }
}
