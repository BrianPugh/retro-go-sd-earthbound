"""Second pass: what's left of earthbound_assets.dat after modelling
  COPY      from ROM, from decompressed ROM HAL streams, or from the ROM with
            text-dictionary codes (0x15-0x17) expanded
  COPY_SEQ  a short copy (>= 2 bytes) continuing from the previous copy's
            source position (+ a small gap) -- struct re-layouts
  COMPRESS  HAL-compress of a covered buffer (.lzhal round-trip, .bundled)
  PTR       a u32 in [0x100000, 0x200000): an offset into the dialogue blob
            (same kind of number as upstream's committed text_refs.h)
  LIT       everything else
"""
import collections, re, struct, sys, pickle
from pathlib import Path

ROOT = Path("/Users/brianpugh/projects/retro-go-sd-earthbound")
EB = ROOT / "external/earthbound"
OUT = Path(__file__).parent
sys.path.insert(0, str(EB))
from ebtools.hallz import compress, decompress  # noqa: E402

K = 8
rom = (ROOT / "earthbound.sfc").read_bytes()
layout = (ROOT / "src/gen/eb_asset_list.txt").read_text().splitlines()
packed = ROOT / "build/earthbound_gen/packed_assets"
asmbin = EB / "asm/bin"

streams = {}
for p in asmbin.rglob("*.lzhal"):
    c = p.read_bytes()
    off = rom.find(c)
    if off >= 0 and off not in streams:
        streams[off] = decompress(c)
dec_set = {d for d in streams.values()}

ptrs = (asmbin / "data/compressed_text_ptrs.bin").read_bytes()
words = []
for i in range(768):
    a = int.from_bytes(ptrs[4 * i:4 * i + 4], "little") & 0x3FFFFF
    words.append(rom[a:rom.index(b"\0", a)])
exp = bytearray(); i = 0
while i < len(rom):
    c = rom[i]
    if 0x15 <= c <= 0x17 and i + 1 < len(rom):
        exp += words[(c - 0x15) * 256 + rom[i + 1]]; i += 2
    else:
        exp.append(c); i += 1

corpus = bytes(rom) + b"".join(streams[o] for o in sorted(streams)) + bytes(exp)
idx_path = OUT / "eb_idx2.pkl"
if idx_path.exists():
    index = pickle.loads(idx_path.read_bytes())
else:
    index = {}
    for j in range(len(corpus) - K + 1):
        index.setdefault(corpus[j:j + K], j)
    idx_path.write_bytes(pickle.dumps(index))


def cover(data):
    """Returns Counter of bytes per op kind, plus literal runs."""
    c = collections.Counter(); runs = []; rs = None
    i, n, prev = 0, len(data), None
    def lit_end():
        nonlocal rs
        if rs is not None:
            runs.append((rs, i)); rs = None
    while i < n:
        # long copy via the index
        p = index.get(data[i:i + K]) if i + K <= n else None
        if p is not None:
            L = K
            while i + L < n and p + L < len(corpus) and corpus[p + L] == data[i + L]:
                L += 1
            lit_end(); c["copy"] += L; c["ops"] += 1; i += L; prev = p + L; continue
        # pointer into the dialogue blob
        if i + 4 <= n and 0x100000 <= struct.unpack_from("<I", data, i)[0] < 0x200000:
            lit_end(); c["ptr"] += 4; c["ops"] += 1; i += 4; continue
        # short copy continuing near the previous source position
        if prev is not None:
            best = 0
            for gap in range(0, 33):
                q = prev + gap
                L = 0
                while i + L < n and q + L < len(corpus) and corpus[q + L] == data[i + L]:
                    L += 1
                if L > best:
                    best, bq = L, q
            if best >= 2:
                lit_end(); c["copy_seq"] += best; c["ops"] += 1; i += best; prev = bq + best; continue
        if rs is None:
            rs = i
        c["lit"] += 1; i += 1
    lit_end()
    return c, runs


tot = collections.Counter(); per = []
for entry in layout:
    kind, rel = entry.split("/", 1)
    d = ((packed if kind == "packed" else asmbin) / rel).read_bytes()
    tot["bytes"] += len(d)
    if not d or rom.find(d) >= 0 or d in dec_set:
        tot["whole_copy"] += len(d); continue
    targets = [d]
    if rel.endswith(".lzhal"):
        raw = decompress(d)
        if compress(raw) == d:
            targets = [raw]; tot["compress_lzhal"] += len(d)
    elif rel.endswith(".bundled"):
        fpb, frames, nb = struct.unpack_from("<BBH", d)
        offs = struct.unpack_from(f"<{nb + 1}H", d, 4)
        base = 4 + 2 * (nb + 1)
        bundles = [d[base + offs[k]:base + offs[k + 1]] for k in range(nb)]
        raws = [decompress(b) for b in bundles]
        if all(compress(r) == b for r, b in zip(raws, bundles)):
            tot["bundled_header_numbers"] += base
            targets = [b"".join(raws)]
            tot["compress_bundled"] += len(d) - base
    for t in targets:
        c, runs = cover(t)
        tot.update(c)
        if c["lit"]:
            per.append((c["lit"], len(t), entry, runs, t))

print("totals:", dict(tot))
print(f"literal bytes: {tot['lit']} of {tot['bytes']} ({tot['lit'] / tot['bytes'] * 100:.2f}%)")
per.sort(key=lambda x: -x[0])
textish = 0
for lit, n, entry, runs, t in per:
    for a, b in runs:
        textish += sum(len(m.group()) for m in re.finditer(rb"[\x50-\xaf]{4,}", t[a:b]))
print(f"literal bytes inside text-like runs (>=4 charset chars): {textish}")
for lit, n, entry, runs, t in per[:15]:
    longest = max(b - a for a, b in runs)
    print(f"  {lit:6} / {n:7} runs={len(runs):5} longest={longest:4} {entry}")
pickle.dump([(l, n, e, r) for l, n, e, r, _ in per], open(OUT / "eb_residue2.pkl", "wb"))
