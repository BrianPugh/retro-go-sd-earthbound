#!/usr/bin/env python3
"""EarthBound converter recipe: rebuild earthbound_assets.dat from a ROM.

The format is specified in tools/converter/FORMAT.md.

  generate  ROM + ebtools outputs -> recipe. Runs `run` on the result and
            fails unless it reproduces `eb_assets.py pack`'s .dat exactly.
  run       ROM + recipe -> .dat. The reference interpreter (the oracle the
            Rust/wasm converter is tested against).
  report    recipe stats, and every literal run that looks like game text,
            for review (the literals are the only ROM bytes the recipe holds).

Needs ebtools (external/earthbound) for the HAL codec: run it with the
submodule's .venv python, or with --eb-dir on a python that has its deps.
"""

import argparse
import bisect
import collections
import hashlib
import re
import struct
import sys
import time
import zlib
from array import array
from collections.abc import Callable
from pathlib import Path

import eb_assets

MAGIC = 0x43524245  # "EBRC"
VERSION = 1
ROM_SIZE = 0x300000
HEADER_FIXED = 76

END, COPY, SEQ, LIT, U32, BEGIN, COMPRESS, ASSET = range(8)
OP_NAMES = ["END", "COPY", "SEQ", "LIT", "U32", "BEGIN", "COMPRESS", "ASSET"]

SRC_ROM = 0
SRC_TEXT = 1
SRC_STREAM0 = 2

# Matching parameters (picked by measuring the recipe size).
K = 5             # index granularity: minimum COPY length found through the index
CHAIN = 256       # index candidates tried per position
SEQ_WINDOW = 256  # max SEQ gap tried when continuing the cursor
SEQ_MIN = 2       # min SEQ length
DIALOGUE_BASE = 0x100000  # dialogue-blob offsets (text_refs.h) start here

TEXT_RUN = re.compile(rb"[\x50-\xaf]{4,}")


def load_hallz(eb_dir: Path):
    sys.path.insert(0, str(eb_dir))
    from ebtools.hallz import compress, decompress
    return compress, decompress


# ---------------------------------------------------------------- encoding

def varint(v: int) -> bytes:
    out = bytearray()
    while True:
        b = v & 0x7F
        v >>= 7
        if v:
            out.append(b | 0x80)
        else:
            out.append(b)
            return bytes(out)


def read_varint(buf: bytes, pos: int) -> tuple[int, int]:
    v = shift = 0
    while True:
        if pos >= len(buf):
            raise ValueError("truncated varint")
        b = buf[pos]
        pos += 1
        v |= (b & 0x7F) << shift
        shift += 7
        if not b & 0x80:
            return v, pos


def expand_text(rom: bytes, dict_ptrs: int) -> bytes:
    """Source 1: the ROM with every 0x15..0x17 dictionary code expanded."""
    words = []
    for k in range(768):
        a = struct.unpack_from("<I", rom, dict_ptrs + 4 * k)[0] & 0x3FFFFF
        words.append(rom[a:rom.index(b"\0", a)])
    out = bytearray()
    i, n = 0, len(rom)
    while i < n:
        j = i
        # copy plain bytes in bulk up to the next dictionary code
        while j < n and not 0x15 <= rom[j] <= 0x17:
            j += 1
        out += rom[i:j]
        if j >= n:
            break
        if j + 1 < n:
            out += words[(rom[j] - 0x15) * 256 + rom[j + 1]]
            i = j + 2
        else:
            out.append(rom[j])
            i = j + 1
    return bytes(out)


# ---------------------------------------------------------------- interpreter

def parse(recipe: bytes) -> tuple[dict, list[tuple]]:
    """Recipe -> (header fields, ops). Ops are (opcode, *operands)."""
    if len(recipe) < HEADER_FIXED:
        raise ValueError("recipe too short")
    magic, version = struct.unpack_from("<II", recipe, 0)
    if magic != MAGIC or version != VERSION:
        raise ValueError(f"bad recipe magic/version {magic:#x}/{version}")
    hdr = {
        "rom_sha1": recipe[8:28],
        "dat_sha256": recipe[28:60],
    }
    hdr["dat_len"], hdr["layout_crc"], hdr["asset_count"], hdr["dict_ptrs"] = \
        struct.unpack_from("<IIII", recipe, 60)
    count, pos = read_varint(recipe, HEADER_FIXED)
    streams = []
    for _ in range(count):
        off, pos = read_varint(recipe, pos)
        streams.append(off)
    hdr["streams"] = streams
    hdr["program_start"] = pos

    ops = []
    while True:
        if pos >= len(recipe):
            raise ValueError("program has no END")
        op = recipe[pos]
        pos += 1
        if op == END:
            ops.append((END,))
            break
        if op == COPY:
            src, pos = read_varint(recipe, pos)
            off, pos = read_varint(recipe, pos)
            n, pos = read_varint(recipe, pos)
            ops.append((COPY, src, off, n))
        elif op == SEQ:
            gap, pos = read_varint(recipe, pos)
            n, pos = read_varint(recipe, pos)
            ops.append((SEQ, gap, n))
        elif op == LIT:
            n, pos = read_varint(recipe, pos)
            if pos + n > len(recipe):
                raise ValueError("truncated LIT")
            ops.append((LIT, recipe[pos:pos + n]))
            pos += n
        elif op == U32:
            v, pos = read_varint(recipe, pos)
            if v > 0xFFFFFFFF:
                raise ValueError("U32 out of range")
            ops.append((U32, v))
        elif op in (BEGIN, COMPRESS, ASSET):
            ops.append((op,))
        else:
            raise ValueError(f"unknown opcode {op:#x} at {pos - 1}")
    if pos != len(recipe):
        raise ValueError("trailing bytes after END")
    return hdr, ops


def run(recipe: bytes, rom: bytes, compress: Callable, decompress: Callable) -> bytes:
    """The reference interpreter: recipe + ROM -> earthbound_assets.dat."""
    hdr, ops = parse(recipe)
    if len(rom) != ROM_SIZE or hashlib.sha1(rom).digest() != hdr["rom_sha1"]:
        raise ValueError("ROM does not match the recipe (sha1)")
    sources: list[bytes | None] = [rom, None] + [None] * len(hdr["streams"])

    def source(i: int) -> bytes:
        if i >= len(sources):
            raise ValueError(f"source {i} out of range")
        if sources[i] is None:
            if i == SRC_TEXT:
                sources[i] = expand_text(rom, hdr["dict_ptrs"])
            else:
                sources[i] = decompress(memoryview(rom)[hdr["streams"][i - SRC_STREAM0]:])
        return sources[i]

    def read(src: int, off: int, n: int) -> bytes:
        s = source(src)
        if off + n > len(s):
            raise ValueError(f"read past end of source {src}")
        return s[off:off + n]

    stack = [bytearray()]
    assets = []
    cursor = None
    for op in ops:
        code = op[0]
        if code == COPY:
            _, src, off, n = op
            stack[-1] += read(src, off, n)
            cursor = (src, off + n)
        elif code == SEQ:
            if cursor is None:
                raise ValueError("SEQ without a cursor")
            _, gap, n = op
            src, off = cursor[0], cursor[1] + gap
            stack[-1] += read(src, off, n)
            cursor = (src, off + n)
        elif code == LIT:
            stack[-1] += op[1]
        elif code == U32:
            stack[-1] += struct.pack("<I", op[1])
        elif code == BEGIN:
            stack.append(bytearray())
        elif code == COMPRESS:
            if len(stack) < 2:
                raise ValueError("COMPRESS without BEGIN")
            buf = stack.pop()
            stack[-1] += compress(bytes(buf))
        elif code == ASSET:
            if len(stack) != 1:
                raise ValueError("ASSET inside BEGIN")
            assets.append(bytes(stack[0]))
            stack = [bytearray()]
        elif code == END:
            if len(stack) != 1 or stack[0]:
                raise ValueError("END with a pending buffer")
    if len(assets) != hdr["asset_count"]:
        raise ValueError(f"recipe made {len(assets)} assets, header says {hdr['asset_count']}")
    dat = eb_assets.pack_dat(assets, hdr["layout_crc"])
    if len(dat) != hdr["dat_len"] or hashlib.sha256(dat).digest() != hdr["dat_sha256"]:
        raise ValueError("output does not match the recipe's .dat checksum")
    return dat


# ---------------------------------------------------------------- generator

class Corpus:
    """Every source concatenated, with a K-gram hash-chain index."""

    def __init__(self, sources: list[bytes]):
        self.sources = sources
        self.starts = []
        pos = 0
        for s in sources:
            self.starts.append(pos)
            pos += len(s)
        data = b"".join(sources)
        n = len(data) - K + 1
        head: dict[bytes, int] = {}
        nxt = array("i", bytes(4 * n))
        for j in range(n - 1, -1, -1):
            key = data[j:j + K]
            nxt[j] = head.get(key, -1)
            head[key] = j
        self.head, self.nxt = head, nxt

    def locate(self, p: int) -> tuple[int, int]:
        src = bisect.bisect_right(self.starts, p) - 1
        return src, p - self.starts[src]

    def candidates(self, key: bytes):
        p = self.head.get(key, -1)
        for _ in range(CHAIN):
            if p < 0:
                return
            yield self.locate(p)
            p = self.nxt[p]


def match_len(src: bytes, off: int, data: bytes, i: int) -> int:
    n = min(len(src) - off, len(data) - i)
    length = 0
    step = 256
    while length + step <= n and src[off + length:off + length + step] == data[i + length:i + length + step]:
        length += step
    while length < n and src[off + length] == data[i + length]:
        length += 1
    return length


class Encoder:
    def __init__(self, corpus: Corpus, dialogue_len: int):
        self.corpus = corpus
        self.sources = corpus.sources
        self.ptr_end = DIALOGUE_BASE + dialogue_len
        self.ops: list[tuple] = []
        self.cursor: tuple[int, int] | None = None

    def emit_copy(self, src: int, off: int, n: int) -> None:
        cur = self.cursor
        if cur is not None and cur[0] == src and off >= cur[1]:
            self.ops.append((SEQ, off - cur[1], n))
        else:
            self.ops.append((COPY, src, off, n))
        self.cursor = (src, off + n)

    def emit_lit(self, b: bytes) -> None:
        if self.ops and self.ops[-1][0] == LIT:
            self.ops[-1] = (LIT, self.ops[-1][1] + b)
        else:
            self.ops.append((LIT, b))

    def copy_cost(self, src: int, off: int, n: int) -> int:
        cur = self.cursor
        if cur is not None and cur[0] == src and off >= cur[1]:
            return 1 + len(varint(off - cur[1])) + len(varint(n))
        return 1 + len(varint(src)) + len(varint(off)) + len(varint(n))

    def find_whole(self, data: bytes) -> tuple[int, int] | None:
        """A source holding all of data, the cursor's source first."""
        cur = self.cursor
        if cur is not None:
            off = self.sources[cur[0]].find(data, cur[1])
            if off >= 0:
                return cur[0], off
        for src, s in enumerate(self.sources):
            off = s.find(data)
            if off >= 0:
                return src, off
        return None

    def cover(self, data: bytes) -> None:
        """Ops that append data, as few literal bytes as possible."""
        if not data:
            return
        whole = self.find_whole(data)
        if whole is not None:
            self.emit_copy(whole[0], whole[1], len(data))
            return
        i, n = 0, len(data)
        while i < n:
            best = None  # (score, length, src, off)
            cur = self.cursor
            if cur is not None:
                s = self.sources[cur[0]]
                lo = cur[1]
                hi = min(len(s), lo + SEQ_WINDOW + SEQ_MIN)
                probe = data[i:i + SEQ_MIN]
                if len(probe) == SEQ_MIN:
                    q = s.find(probe, lo, hi)
                    while q >= 0:
                        length = match_len(s, q, data, i)
                        score = length - self.copy_cost(cur[0], q, length)
                        if best is None or score > best[0]:
                            best = (score, length, cur[0], q)
                        q = s.find(probe, q + 1, hi)
            if i + K <= n:
                for src, off in self.corpus.candidates(data[i:i + K]):
                    length = match_len(self.sources[src], off, data, i)
                    if length < K:
                        continue
                    score = length - self.copy_cost(src, off, length)
                    if best is None or score > best[0]:
                        best = (score, length, src, off)
            if best is not None and best[1] >= 4:
                self.emit_copy(best[2], best[3], best[1])
                i += best[1]
                continue
            if i + 4 <= n:
                v = struct.unpack_from("<I", data, i)[0]
                if DIALOGUE_BASE <= v < self.ptr_end:
                    self.ops.append((U32, v))
                    i += 4
                    continue
            if best is not None:
                self.emit_copy(best[2], best[3], best[1])
                i += best[1]
                continue
            self.emit_lit(data[i:i + 1])
            i += 1


def split_bundled(d: bytes) -> tuple[bytes, list[bytes]] | None:
    """A .bundled file -> (header + offset table, compressed bundles)."""
    if len(d) < 4:
        return None
    nb = struct.unpack_from("<H", d, 2)[0]
    base = 4 + 2 * (nb + 1)
    if len(d) < base:
        return None
    offs = struct.unpack_from(f"<{nb + 1}H", d, 4)
    if offs[0] != 0 or base + offs[-1] != len(d) or list(offs) != sorted(offs):
        return None
    return d[:base], [d[base + offs[k]:base + offs[k + 1]] for k in range(nb)]


def serialize(hdr: dict, streams: list[int], ops: list[tuple]) -> bytes:
    out = bytearray(struct.pack("<II", MAGIC, VERSION))
    out += hdr["rom_sha1"] + hdr["dat_sha256"]
    out += struct.pack("<IIII", hdr["dat_len"], hdr["layout_crc"], hdr["asset_count"], hdr["dict_ptrs"])
    out += varint(len(streams))
    for off in streams:
        out += varint(off)
    for op in ops:
        code = op[0]
        out.append(code)
        if code == COPY:
            out += varint(op[1]) + varint(op[2]) + varint(op[3])
        elif code == SEQ:
            out += varint(op[1]) + varint(op[2])
        elif code == LIT:
            out += varint(len(op[1])) + op[1]
        elif code == U32:
            out += varint(op[1])
    return bytes(out)


def memoize(fn: Callable) -> Callable:
    cache: dict[bytes, bytes] = {}

    def wrapped(data: bytes) -> bytes:
        if data not in cache:
            cache[data] = fn(data)
        return cache[data]
    return wrapped


def cmd_generate(args) -> None:
    t0 = time.time()
    compress, decompress = load_hallz(args.eb_dir)
    compress = memoize(compress)
    rom = args.rom.read_bytes()
    if len(rom) != ROM_SIZE:
        sys.exit(f"eb_recipe: {args.rom} is {len(rom)} bytes, expected {ROM_SIZE} (headerless US ROM)")
    layout = args.list.read_text().splitlines()
    roots = {"packed": args.packed_dir, "bin": args.bin_dir}
    blobs = []
    for entry in layout:
        kind, rel = entry.split("/", 1)
        blobs.append((roots[kind] / rel).read_bytes())
    layout_crc = zlib.crc32(args.list.read_bytes())
    dat = eb_assets.pack_dat(blobs, layout_crc)

    dict_ptrs = rom.find((args.bin_dir / "data/compressed_text_ptrs.bin").read_bytes())
    if dict_ptrs < 0:
        sys.exit("eb_recipe: compressed_text_ptrs.bin not found in the ROM")
    dialogue_len = len((args.packed_dir / "dialogue/dialogue.bin").read_bytes())

    # Candidate streams: every ebtools-extracted HAL stream found in the ROM.
    stream_offs = set()
    for p in sorted(args.bin_dir.rglob("*.lzhal")):
        off = rom.find(p.read_bytes())
        if off >= 0:
            stream_offs.add(off)
    stream_offs = sorted(stream_offs)
    sources = [rom, expand_text(rom, dict_ptrs)]
    sources += [decompress(memoryview(rom)[off:]) for off in stream_offs]
    t1 = time.time()
    corpus = Corpus(sources)
    print(f"eb_recipe: {len(stream_offs)} candidate streams, corpus {len(corpus.starts)} sources "
          f"({sum(map(len, sources))} bytes), indexed in {time.time() - t1:.1f}s")

    enc = Encoder(corpus, dialogue_len)
    for entry, d in zip(layout, blobs):
        if d and enc.find_whole(d) is None:
            bundled = split_bundled(d) if entry.endswith(".bundled") else None
            if entry.endswith(".lzhal") and compress(raw := decompress(d)) == d:
                enc.ops.append((BEGIN,))
                enc.cover(raw)
                enc.ops.append((COMPRESS,))
            elif bundled and all(compress(decompress(b)) == b for b in bundled[1]):
                enc.emit_lit(bundled[0])
                for b in bundled[1]:
                    enc.ops.append((BEGIN,))
                    enc.cover(decompress(b))
                    enc.ops.append((COMPRESS,))
            else:
                enc.cover(d)
        else:
            enc.cover(d)
        enc.ops.append((ASSET,))
    enc.ops.append((END,))

    # Keep only the streams the program reads, renumbered in ROM order.
    used = sorted({op[1] for op in enc.ops if op[0] == COPY and op[1] >= SRC_STREAM0})
    remap = {old: SRC_STREAM0 + k for k, old in enumerate(used)}
    ops = [(COPY, remap.get(op[1], op[1]), op[2], op[3]) if op[0] == COPY else op for op in enc.ops]
    hdr = {
        "rom_sha1": hashlib.sha1(rom).digest(),
        "dat_sha256": hashlib.sha256(dat).digest(),
        "dat_len": len(dat),
        "layout_crc": layout_crc,
        "asset_count": len(layout),
        "dict_ptrs": dict_ptrs,
    }
    recipe = serialize(hdr, [stream_offs[s - SRC_STREAM0] for s in used], ops)
    t2 = time.time()
    print(f"eb_recipe: encoded {len(ops)} ops in {t2 - t1:.1f}s, verifying")

    out = run(recipe, rom, compress, decompress)
    if out != dat:
        sys.exit("eb_recipe: the interpreter's output differs from eb_assets.py pack")
    args.out.parent.mkdir(parents=True, exist_ok=True)
    args.out.write_bytes(recipe)
    lit = sum(len(op[1]) for op in ops if op[0] == LIT)
    print(f"eb_recipe: {args.out} ({len(recipe)} bytes, {lit} literal bytes) reproduces the .dat "
          f"(sha256 {hashlib.sha256(out).hexdigest()}) in {time.time() - t0:.1f}s")


def cmd_run(args) -> None:
    compress, decompress = load_hallz(args.eb_dir)
    dat = run(args.recipe.read_bytes(), args.rom.read_bytes(), compress, decompress)
    args.out.write_bytes(dat)
    print(f"eb_recipe: {args.out} ({len(dat)} bytes, sha256 {hashlib.sha256(dat).hexdigest()})")


def cmd_report(args) -> None:
    recipe = args.recipe.read_bytes()
    hdr, ops = parse(recipe)
    layout = args.list.read_text().splitlines() if args.list.exists() else []
    counts = collections.Counter(OP_NAMES[op[0]] for op in ops)
    bytes_by = collections.Counter()
    per_asset = collections.Counter()
    text_runs = []
    asset = 0
    for op in ops:
        code = op[0]
        name = layout[asset] if asset < len(layout) else f"asset {asset}"
        if code == COPY:
            bytes_by["COPY"] += op[3]
        elif code == SEQ:
            bytes_by["SEQ"] += op[2]
        elif code == U32:
            bytes_by["U32"] += 4
        elif code == LIT:
            bytes_by["LIT"] += len(op[1])
            per_asset[name] += len(op[1])
            for m in TEXT_RUN.finditer(op[1]):
                text_runs.append((name, "".join(chr(b - 0x30) for b in m.group())))
        elif code == ASSET:
            asset += 1
    print(f"recipe: {len(recipe)} bytes ({hdr['program_start']} header), {hdr['asset_count']} assets, "
          f"{len(hdr['streams'])} streams, .dat {hdr['dat_len']} bytes")
    print("ops:")
    for name in OP_NAMES:
        extra = f"  {bytes_by[name]:9} bytes out" if name in bytes_by else ""
        print(f"  {name:9} {counts[name]:7}{extra}")
    print(f"literal bytes: {bytes_by['LIT']} ({bytes_by['LIT'] / hdr['dat_len'] * 100:.3f}% of the .dat)")
    print("literal bytes per asset:")
    for name, n in sorted(per_asset.items(), key=lambda kv: (-kv[1], kv[0])):
        print(f"  {n:6}  {name}")
    print(f"text-like literal runs (>= 4 bytes in 0x50..0xAF, shown as chr(b - 0x30)): {len(text_runs)}")
    for name, text in text_runs:
        print(f"  {name}: {text!r}")


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__.split("\n")[0])
    parser.add_argument("--eb-dir", type=Path, default=Path(__file__).resolve().parent.parent / "external/earthbound",
                        help="external/earthbound (for ebtools.hallz)")
    sub = parser.add_subparsers(dest="cmd", required=True)

    p = sub.add_parser("generate")
    p.add_argument("--rom", type=Path, required=True)
    p.add_argument("--packed-dir", type=Path, required=True)
    p.add_argument("--bin-dir", type=Path, required=True)
    p.add_argument("--list", type=Path, required=True, help="src/gen/eb_asset_list.txt")
    p.add_argument("--out", type=Path, required=True)

    p = sub.add_parser("run")
    p.add_argument("--rom", type=Path, required=True)
    p.add_argument("--recipe", type=Path, required=True)
    p.add_argument("--out", type=Path, required=True)

    p = sub.add_parser("report")
    p.add_argument("--recipe", type=Path, required=True)
    p.add_argument("--list", type=Path, default=Path(__file__).resolve().parent.parent / "src/gen/eb_asset_list.txt",
                   help="asset names for the per-asset listing")

    args = parser.parse_args()
    {"generate": cmd_generate, "run": cmd_run, "report": cmd_report}[args.cmd](args)


if __name__ == "__main__":
    main()
