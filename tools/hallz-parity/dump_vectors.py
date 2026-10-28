"""Dump HALLZ2 test vectors from the reference Python codec (ebtools.hallz).

Vectors are ROM-derived: write them outside the repo and never commit them.

Usage:
    external/earthbound/.venv/bin/python tools/hallz-parity/dump_vectors.py \
        --eb external/earthbound --packed build/earthbound_gen/packed_assets OUT_DIR

OUT_DIR gets NNNNN.in / NNNNN.out pairs plus manifest.txt with one line per
vector: "<id> <kind> <name>". Kind "c": .in is raw data, .out is Python's
compress() of it. Kind "d": .in is a stream, .out is Python's decompress().
Kind "x": compress() raised in Python (.out is empty, the harness skips it).
"""

import argparse
import random
import struct
import sys
from pathlib import Path


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--eb", type=Path, required=True, help="external/earthbound checkout")
    ap.add_argument("--packed", type=Path, required=True, help="build/earthbound_gen/packed_assets")
    ap.add_argument("out", type=Path)
    args = ap.parse_args()

    sys.path.insert(0, str(args.eb.resolve()))
    from ebtools.hallz.compress import compress
    from ebtools.hallz.decompress import decompress, get_compressed_data

    args.out.mkdir(parents=True, exist_ok=True)
    manifest = []
    roundtrip_fail = []
    roundtrip_checked = 0

    def add(kind: str, name: str, inp: bytes, out: bytes) -> None:
        vid = len(manifest)
        (args.out / f"{vid:05d}.in").write_bytes(inp)
        (args.out / f"{vid:05d}.out").write_bytes(out)
        manifest.append(f"{vid} {kind} {name}")

    def add_compress(name: str, raw: bytes) -> bytes | None:
        try:
            comp = compress(raw)
        except OverflowError:
            add("x", name, raw, b"")
            return None
        add("c", name, raw, comp)
        return comp

    def add_stream(name: str, stream: bytes, check_roundtrip: bool) -> None:
        stream = get_compressed_data(stream)
        raw = decompress(stream)
        add("d", name, stream, raw)
        comp = add_compress(name, raw)
        nonlocal roundtrip_checked
        if check_roundtrip:
            roundtrip_checked += 1
            if comp != stream:
                roundtrip_fail.append(name)

    # (a) every .lzhal: the disassembly's (original ROM compressor) and ours
    rom_streams = set()
    for p in sorted((args.eb / "asm" / "bin").rglob("*.lzhal")):
        rom_streams.add(p.read_bytes())
        add_stream(f"asm:{p.relative_to(args.eb)}", p.read_bytes(), False)
    # Packed files identical to one of the disassembly's are copies of ROM
    # data, so only the rest came out of compress() and must round-trip
    for p in sorted(args.packed.rglob("*.lzhal")):
        copied = p.read_bytes() in rom_streams
        add_stream(f"packed:{p.relative_to(args.packed)}", p.read_bytes(), not copied)

    # (b) per-bundle slices of the PSI animation arrangements
    for p in sorted((args.packed / "psianims" / "arrangements").glob("*.arr.bundled")):
        blob = p.read_bytes()
        _fpb, _total, count = struct.unpack_from("<BBH", blob, 0)
        offs = struct.unpack_from(f"<{count + 1}H", blob, 4)
        base = 4 + 2 * (count + 1)
        for i in range(count):
            bundle = blob[base + offs[i] : base + offs[i + 1]]
            add_stream(f"bundle:{p.name}#{i}", bundle, True)

    # (c) synthetic edge cases
    rng = random.Random(1234)
    syn = {
        "empty": b"",
        "one": b"\x42",
        "two": b"\x01\x02",
        "three_same": b"\x07" * 3,
        "four": b"\x01\x02\x01\x02",
        "run32": b"\xaa" * 32,
        "run33": b"\xaa" * 33,
        "run1024": b"\x00" * 1024,
        "run1025": b"\x00" * 1025,
        "run5000": b"\x11" * 5000,
        "word2": b"\x12\x34" * 2,
        "word32": b"\x12\x34" * 32,
        "word33": b"\x12\x34" * 33,
        "word1024": b"\x12\x34" * 1024,
        "word3000": b"\x12\x34" * 3000,
        "inc3": bytes([5, 6, 7]),
        "inc32": bytes(range(32)),
        "inc300": bytes(i & 0xFF for i in range(300)),
        "inc2000": bytes((i + 7) & 0xFF for i in range(2000)),
        "lit1024": bytes(rng.randrange(256) for _ in range(1024)),
        "lit1025": bytes(rng.randrange(256) for _ in range(1025)),
        "lit3000": bytes(rng.randrange(256) for _ in range(3000)),
    }
    # forward, reversed and backward copies of a random block, short and long
    rev = bytes(int(f"{b:08b}"[::-1], 2) for b in range(256))
    for blen in (4, 5, 31, 32, 33, 100, 1024, 1100):
        blk = bytes(rng.randrange(256) for _ in range(blen))
        pad = bytes(rng.randrange(256) for _ in range(7))
        syn[f"fwd{blen}"] = blk + pad + blk
        syn[f"rev{blen}"] = blk + pad + bytes(rev[b] for b in blk)
        syn[f"bwd{blen}"] = blk + pad + blk[::-1]
        syn[f"overlap{blen}"] = blk + blk + blk
    # a mix of every command type
    mix = bytearray()
    for _ in range(400):
        k = rng.randrange(7)
        ln = rng.choice((3, 4, 8, 31, 32, 33, 60, 200))
        if k == 0 or len(mix) < 8:
            mix += bytes(rng.randrange(256) for _ in range(ln))
        elif k == 1:
            mix += bytes([rng.randrange(256)]) * ln
        elif k == 2:
            mix += bytes([rng.randrange(256), rng.randrange(256)]) * ln
        elif k == 3:
            v = rng.randrange(256)
            mix += bytes((v + i) & 0xFF for i in range(ln))
        else:
            o = rng.randrange(len(mix))
            seg = bytes(mix[o : o + ln])
            if k == 5:
                seg = bytes(rev[b] for b in seg)
            elif k == 6:
                seg = bytes(mix[max(0, o - ln) : o + 1][::-1])
            mix += seg
    syn["mix"] = bytes(mix)
    # 64 KB+: low-entropy so copies happen (offsets past 0xFFFF make Python raise)
    lo = bytearray()
    while len(lo) < 70000:
        lo += bytes([rng.randrange(16)]) * rng.randrange(1, 6)
    syn["lowent70k"] = bytes(lo)
    syn["rand70k"] = bytes(rng.randrange(256) for _ in range(70000))
    syn["mix60k"] = (bytes(mix) * 20)[:60000]
    for name, raw in syn.items():
        comp = add_compress(f"syn:{name}", raw)
        if comp is not None:
            add("d", f"syn:{name}", comp, decompress(comp))

    # malformed streams: Python output on truncated / unterminated input
    for name, s in {
        "bad_empty": b"",
        "bad_noterm": b"\x02abc",
        "bad_trunc_lit": b"\x05ab",
        "bad_trunc_ext": b"\xe4",
        "bad_trunc_fill": b"\x20",
        "bad_trunc_copy": b"\x00a\x83\x00",
        "bad_oob_copy": b"\x00a\x83\x12\x34\xff",
        "bad_oob_bwd": b"\x01ab\xc5\x00\x05\xff",
        "bad_op7": b"\x00a\xfc\x03\x00\x00\xff",
    }.items():
        add("d", f"syn:{name}", s, decompress(s))

    (args.out / "manifest.txt").write_text("\n".join(manifest) + "\n")
    kinds = [m.split()[1] for m in manifest]
    print(f"{len(manifest)} vectors: {kinds.count('c')} compress, {kinds.count('d')} decompress, {kinds.count('x')} python-raises")
    print(f"{roundtrip_checked} streams checked for compress(decompress(x)) == x")
    if roundtrip_fail:
        print(f"compress(decompress(x)) != x for {len(roundtrip_fail)}: {roundtrip_fail[:10]}")
        return 1
    return 0


if __name__ == "__main__":
    sys.exit(main())
