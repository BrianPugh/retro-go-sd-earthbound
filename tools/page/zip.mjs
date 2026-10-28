// A zip writer, small enough to read in one sitting.
//
// The page hands a user everything an install needs in one file: the artifacts
// the project published plus the file the converter just produced. That is a
// zip, and pulling a zip library from a CDN would undo the property this whole
// project is built on -- what runs here is settled at build time and verified
// before it runs. So: no dependencies, and short enough to audit.
//
// Only what is needed is implemented. No directories, no zip64, no encryption,
// no multi-disk. Entries are stored or deflated, whichever is smaller, and the
// archive is a plain sequence of local headers followed by a central directory.
//
// Names may contain spaces, because the device's filenames do ("Zelda 3.bin").
// They are written UTF-8 with the language-encoding flag set, which is what
// every modern unzip expects and what makes a non-ASCII name survive.

const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let i = 0; i < 256; i++) {
    let c = i;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[i] = c >>> 0;
  }
  return t;
})();

function crc32(bytes) {
  let c = 0xffffffff;
  for (let i = 0; i < bytes.length; i++) c = CRC_TABLE[(c ^ bytes[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

/**
 * Raw deflate, or null when this browser cannot do it. A stored entry is a
 * perfectly valid zip entry, so a missing CompressionStream costs size and
 * nothing else -- never correctness, and never the download.
 */
async function deflateRaw(bytes) {
  if (typeof CompressionStream === "undefined") return null;
  try {
    const cs = new CompressionStream("deflate-raw");
    const stream = new Blob([bytes]).stream().pipeThrough(cs);
    return new Uint8Array(await new Response(stream).arrayBuffer());
  } catch {
    return null;                       // treat any failure as "store it"
  }
}

/** DOS date and time. Before 1980 is unrepresentable; clamp rather than throw. */
function dosStamp(date) {
  const year = Math.max(1980, date.getFullYear());
  return {
    time: (date.getHours() << 11) | (date.getMinutes() << 5) | (date.getSeconds() >> 1),
    date: ((year - 1980) << 9) | ((date.getMonth() + 1) << 5) | date.getDate(),
  };
}

const LOCAL_SIG = 0x04034b50;
const CENTRAL_SIG = 0x02014b50;
const EOCD_SIG = 0x06054b50;
// Bit 11: the name is UTF-8. Bit 3 (data descriptor) is deliberately not used;
// sizes are known before writing because everything is already in memory.
const FLAG_UTF8 = 0x0800;
const METHOD_STORE = 0;
const METHOD_DEFLATE = 8;

class Writer {
  constructor() {
    this.parts = [];
    this.length = 0;
  }
  push(bytes) {
    this.parts.push(bytes);
    this.length += bytes.length;
  }
  u16(v) {
    const b = new Uint8Array(2);
    new DataView(b.buffer).setUint16(0, v, true);
    this.push(b);
  }
  u32(v) {
    const b = new Uint8Array(4);
    new DataView(b.buffer).setUint32(0, v >>> 0, true);
    this.push(b);
  }
}

/**
 * Builds a zip from `[{ name, data }]` and returns it as a Blob.
 *
 * Entries are written in the order given: the caller decides what a reader
 * sees first, and for an install set that is the binary before the data it
 * needs. A duplicate name is refused rather than written twice, because a zip
 * with two entries of one name unpacks differently depending on the tool.
 */
export async function makeZip(entries, { date = new Date() } = {}) {
  const seen = new Set();
  for (const e of entries) {
    if (!e.name) throw new Error("zip entry has no name");
    if (e.name.includes("/") || e.name.includes("\\")) {
      // Flat by design. A path would also be the one place a crafted manifest
      // could aim a write somewhere unexpected, so it is refused outright.
      throw new Error(`zip entry name must not contain a path: ${e.name}`);
    }
    if (seen.has(e.name)) throw new Error(`duplicate zip entry: ${e.name}`);
    seen.add(e.name);
  }

  const { time, date: dosDate } = dosStamp(date);
  const encoder = new TextEncoder();
  const out = new Writer();
  const central = [];

  for (const entry of entries) {
    const data = entry.data instanceof Uint8Array ? entry.data : new Uint8Array(entry.data);
    const name = encoder.encode(entry.name);
    const crc = crc32(data);

    // Compress only if it actually helps. Already-compressed payloads (a packed
    // binary, a compressed asset pack) can come back larger, and a stored entry
    // is both smaller and faster to unpack in that case.
    const deflated = await deflateRaw(data);
    const useDeflate = deflated !== null && deflated.length < data.length;
    const payload = useDeflate ? deflated : data;
    const method = useDeflate ? METHOD_DEFLATE : METHOD_STORE;

    const offset = out.length;
    out.u32(LOCAL_SIG);
    out.u16(20);                       // version needed: 2.0, deflate
    out.u16(FLAG_UTF8);
    out.u16(method);
    out.u16(time);
    out.u16(dosDate);
    out.u32(crc);
    out.u32(payload.length);
    out.u32(data.length);
    out.u16(name.length);
    out.u16(0);                        // no extra field
    out.push(name);
    out.push(payload);

    central.push({ name, crc, compressed: payload.length, size: data.length, method, offset });
  }

  const centralStart = out.length;
  for (const e of central) {
    out.u32(CENTRAL_SIG);
    out.u16(20);                       // version made by
    out.u16(20);                       // version needed
    out.u16(FLAG_UTF8);
    out.u16(e.method);
    out.u16(time);
    out.u16(dosDate);
    out.u32(e.crc);
    out.u32(e.compressed);
    out.u32(e.size);
    out.u16(e.name.length);
    out.u16(0);                        // extra
    out.u16(0);                        // comment
    out.u16(0);                        // disk number
    out.u16(0);                        // internal attributes
    out.u32(0);                        // external attributes
    out.u32(e.offset);
    out.push(e.name);
  }
  const centralSize = out.length - centralStart;

  out.u32(EOCD_SIG);
  out.u16(0);                          // this disk
  out.u16(0);                          // disk with central directory
  out.u16(central.length);
  out.u16(central.length);
  out.u32(centralSize);
  out.u32(centralStart);
  out.u16(0);                          // no archive comment

  return new Blob(out.parts, { type: "application/zip" });
}
