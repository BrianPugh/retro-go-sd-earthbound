//! EarthBound asset conversion as a zero-import wasm module: the US ROM in,
//! `earthbound_assets.dat` out, by running the recipe embedded at build time
//! (see FORMAT.md and `recipe.rs`).
//!
//! gwrg-dist-spec processor ABI `wasm`/1 (spec/04-processor.md), all exports,
//! no imports:
//!
//! ```text
//!   memory                                 the module's linear memory
//!   abi_version() -> u32                   1
//!   alloc(len: u32) -> u32                 reserve len bytes, returns offset
//!   input_clear()                          discard registered inputs
//!   input_add(ptr: u32, len: u32) -> u32   register one input, returns index
//!   run(flags: u32) -> u32                 0 = ok, else an error code
//!   run_begin(flags: u32) -> u32           start a stepped run
//!   run_step() -> u32                      0 = done, 1 = more work, else error
//!   stage_count() / stage_index()          stages total / completed
//!   stage_name_ptr(i) / stage_name_len(i)  UTF-8 name of stage i
//!   output_count()                         1 after a successful run
//!   output_name_ptr(i) / _len(i)           output id: "assets"
//!   output_ptr(i) / output_len(i)          bytes of output i
//!   error_ptr() / error_len()              message, empty after success
//!   warnings_ptr() / warnings_len()        newline-separated, may be empty
//! ```
//!
//! The manifest declares `options: []`, so `flags` must be 0. The one input
//! is the US ROM; the module picks it out by SHA-1 (the recipe header records
//! it), warns about any other input and refuses to run without it, since the
//! recipe only reproduces the `.dat` from that exact ROM.
//!
//! Progress works by returning control: `run_step` does one slice of a stage
//! and returns, and a host that stops calling it has cancelled the run.
//! `run` is exactly that loop.

pub mod hallz;
pub mod hash;
pub mod recipe;
#[doc(hidden)]
pub mod synth;

pub const ABI_VERSION: u32 = 1;

/// The recipe this module runs (build.rs picks the file).
pub static RECIPE: &[u8] = include_bytes!(env!("EB_RECIPE_PATH"));

/// The output id, from the manifest's `tools[].outputs[]`.
pub const OUTPUT_ID: &str = "assets";

/// `run` / `run_begin` / `run_step` status codes. 0 is success; the rest
/// leave a message in `error_ptr`/`error_len`.
pub const ERR_CONVERT: u32 = 2;
pub const ERR_BAD_FLAGS: u32 = 3;
pub const ERR_NO_SESSION: u32 = 4;
pub const ERR_INPUTS: u32 = 5;

/// `run_step` returns this while there is work left.
pub const STEP_MORE: u32 = 1;

/// Native entry point: the same code the stepped ABI runs.
pub fn convert(inputs: Vec<Vec<u8>>, flags: u32) -> Result<(Vec<u8>, Vec<String>), String> {
    if flags != 0 {
        return Err("unrecognised flag bits set".into());
    }
    recipe::convert(RECIPE, inputs)
}

// ---------------------------------------------------------------------------
// wasm ABI. Single-threaded by construction (wasm32-unknown-unknown without
// shared memory), so the statics are only ever touched by one caller.
// ---------------------------------------------------------------------------

static mut INPUTS: Vec<Vec<u8>> = Vec::new();
static mut OUTPUT: Option<Vec<u8>> = None;
static mut ERROR: Vec<u8> = Vec::new();
static mut WARNINGS: Vec<u8> = Vec::new();
static mut SESSION: Option<recipe::Converter<'static>> = None;

const EMPTY: &[u8] = &[];

fn output(i: u32) -> Option<&'static Vec<u8>> {
    if i != 0 {
        return None;
    }
    unsafe { (*core::ptr::addr_of!(OUTPUT)).as_ref() }
}

fn session() -> Option<&'static mut recipe::Converter<'static>> {
    unsafe { (*core::ptr::addr_of_mut!(SESSION)).as_mut() }
}

fn fail(code: u32, msg: String) -> u32 {
    unsafe {
        ERROR = msg.into_bytes();
        SESSION = None;
    }
    code
}

#[no_mangle]
pub extern "C" fn abi_version() -> u32 {
    ABI_VERSION
}

#[no_mangle]
pub extern "C" fn alloc(len: u32) -> *mut u8 {
    let mut buf = Vec::<u8>::with_capacity(len as usize);
    let ptr = buf.as_mut_ptr();
    core::mem::forget(buf);
    ptr
}

#[no_mangle]
pub extern "C" fn input_clear() {
    unsafe { INPUTS = Vec::new() };
}

/// Takes ownership of a buffer from `alloc`.
#[no_mangle]
pub extern "C" fn input_add(ptr: *mut u8, len: u32) -> u32 {
    let buf = unsafe { Vec::from_raw_parts(ptr, len as usize, len as usize) };
    unsafe {
        let inputs = &mut *core::ptr::addr_of_mut!(INPUTS);
        inputs.push(buf);
        (inputs.len() - 1) as u32
    }
}

#[no_mangle]
pub extern "C" fn run(flags: u32) -> u32 {
    let status = run_begin(flags);
    if status != 0 {
        return status;
    }
    loop {
        match run_step() {
            STEP_MORE => continue,
            other => return other,
        }
    }
}

#[no_mangle]
pub extern "C" fn output_count() -> u32 {
    output(0).is_some() as u32
}

#[no_mangle]
pub extern "C" fn output_name_ptr(i: u32) -> *const u8 {
    output(i).map_or(EMPTY.as_ptr(), |_| OUTPUT_ID.as_ptr())
}

#[no_mangle]
pub extern "C" fn output_name_len(i: u32) -> u32 {
    output(i).map_or(0, |_| OUTPUT_ID.len() as u32)
}

#[no_mangle]
pub extern "C" fn output_ptr(i: u32) -> *const u8 {
    output(i).map_or(EMPTY.as_ptr(), |o| o.as_ptr())
}

#[no_mangle]
pub extern "C" fn output_len(i: u32) -> u32 {
    output(i).map_or(0, |o| o.len() as u32)
}

#[no_mangle]
pub extern "C" fn error_ptr() -> *const u8 {
    unsafe { (*core::ptr::addr_of!(ERROR)).as_ptr() }
}

#[no_mangle]
pub extern "C" fn error_len() -> u32 {
    unsafe { (*core::ptr::addr_of!(ERROR)).len() as u32 }
}

#[no_mangle]
pub extern "C" fn warnings_ptr() -> *const u8 {
    unsafe { (*core::ptr::addr_of!(WARNINGS)).as_ptr() }
}

#[no_mangle]
pub extern "C" fn warnings_len() -> u32 {
    unsafe { (*core::ptr::addr_of!(WARNINGS)).len() as u32 }
}

#[no_mangle]
pub extern "C" fn stage_count() -> u32 {
    recipe::STAGES.len() as u32
}

#[no_mangle]
pub extern "C" fn stage_index() -> u32 {
    match session() {
        Some(s) => s.stage_index() as u32,
        // A finished run reports every stage done; before any run, none.
        None if output(0).is_some() => recipe::STAGES.len() as u32,
        None => 0,
    }
}

#[no_mangle]
pub extern "C" fn stage_name_ptr(i: u32) -> *const u8 {
    recipe::STAGES.get(i as usize).map_or(EMPTY.as_ptr(), |n| n.as_ptr())
}

#[no_mangle]
pub extern "C" fn stage_name_len(i: u32) -> u32 {
    recipe::STAGES.get(i as usize).map_or(0, |n| n.len() as u32)
}

/// Starts a stepped run over the registered inputs, consuming them.
#[no_mangle]
pub extern "C" fn run_begin(flags: u32) -> u32 {
    unsafe {
        OUTPUT = None;
        ERROR = Vec::new();
        WARNINGS = Vec::new();
        SESSION = None;
    }
    let inputs = unsafe { core::mem::take(&mut *core::ptr::addr_of_mut!(INPUTS)) };
    if flags != 0 {
        return fail(ERR_BAD_FLAGS, "unrecognised flag bits set (this converter has no options)".into());
    }
    match recipe::Converter::new(RECIPE, inputs) {
        Ok(c) => unsafe { SESSION = Some(c) },
        Err(e) => return fail(ERR_INPUTS, e),
    }
    0
}

/// One slice of work: `STEP_MORE`, 0 when the output is ready, or an error.
#[no_mangle]
pub extern "C" fn run_step() -> u32 {
    let Some(s) = session() else {
        return fail(ERR_NO_SESSION, "run_step called without run_begin".into());
    };
    match s.step() {
        Err(e) => fail(ERR_CONVERT, e),
        Ok(false) => STEP_MORE,
        Ok(true) => {
            let s = unsafe { (*core::ptr::addr_of_mut!(SESSION)).take() }.unwrap();
            let (data, warnings) = s.finish();
            unsafe {
                OUTPUT = Some(data);
                WARNINGS = warnings.join("\n").into_bytes();
            }
            0
        }
    }
}
