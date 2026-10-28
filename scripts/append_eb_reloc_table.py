#!/usr/bin/env python3
"""Append the RAM_EMU→rodata relocation table to earthbound.ro.

.rodata_earthbound links at a sentinel VMA and is cached at a runtime extflash
address, so every RAM_EMU word holding a pointer into it must be rewritten at
boot (PatchCodeRodataOffset, src/main_earthbound.c). Finding those words by
value is unsafe: Thumb-2 instructions can encode to a word inside the sentinel
range (e.g. `ldrb.w ip, [r1], #1` = 0xcb01f811), and "relocating" one corrupts
the code. The ELF is linked with -Wl,--emit-relocs, so the exact list is the
R_ARM_ABS32 entries in .rel.core_entry whose resolved word targets
.rodata_earthbound.

Trailer layout, appended at the 4-aligned end of the extracted section:
    uint32 magic   = 0x31524245 ("EBR1")
    uint32 count
    uint32 offset[count]   word offsets from __RAM_EMU_START__

Words inside main_earthbound.o's code window (_EARTHBOUND_MAIN_CODE_START..END)
are left out: that window holds the patcher's own __rodata_earthbound_* base
literals, which must keep their link values.

Usage: append_eb_reloc_table.py <tool-prefix> <elf> <ro>
"""

import re
import struct
import subprocess
import sys
import tempfile
from pathlib import Path

SECTION = ".rodata_earthbound"
CODE = ".core_entry"
MAGIC = 0x31524245
# Relocations that could embed an absolute rodata address somewhere other than
# a plain 32-bit word; the patcher only handles ABS32.
UNSUPPORTED = ("R_ARM_THM_MOVW_ABS_NC", "R_ARM_THM_MOVT_ABS", "R_ARM_MOVW_ABS_NC", "R_ARM_MOVT_ABS", "R_ARM_ABS16")


def run(*args):
    return subprocess.run(args, check=True, capture_output=True, text=True).stdout


def section(headers, name):
    m = re.search(r"\s" + re.escape(name) + r"\s+\S+\s+([0-9a-f]+)\s+([0-9a-f]+)\s+([0-9a-f]+)", headers)
    if m is None:
        sys.exit(f"error: no {name} section")
    return int(m.group(1), 16), int(m.group(3), 16)


def main():
    prefix, elf, ro = sys.argv[1], sys.argv[2], Path(sys.argv[3])

    headers = run(prefix + "readelf", "-S", "--wide", elf)
    ro_vma, ro_size = section(headers, SECTION)
    code_vma, _ = section(headers, CODE)

    syms = {}
    for line in run(prefix + "nm", elf).splitlines():
        p = line.split()
        if len(p) == 3:
            syms[p[2]] = int(p[0], 16)
    ram_start = syms["__RAM_EMU_START__"]
    skip_lo, skip_hi = syms["_EARTHBOUND_MAIN_CODE_START"], syms["_EARTHBOUND_MAIN_CODE_END"]

    with tempfile.TemporaryDirectory() as tmp:
        blob = Path(tmp) / "code.bin"
        run(prefix + "objcopy", "-O", "binary", "--only-section=" + CODE, elf, str(blob))
        code = blob.read_bytes()

    relocs = run(prefix + "readelf", "-r", "--wide", elf)
    if "Relocation section" not in relocs:
        sys.exit(f"error: {elf} has no relocations; link it with -Wl,--emit-relocs")

    offsets, errors, sec = [], [], None
    for line in relocs.splitlines():
        m = re.match(r"Relocation section '(\S+)'", line)
        if m:
            sec = m.group(1)
            continue
        p = line.split()
        if len(p) < 3 or not re.fullmatch(r"[0-9a-f]{8}", p[0]):
            continue
        if sec.startswith(".rel.debug") or sec == ".rel" + SECTION:
            continue  # rodata→rodata is check_eb_rodata_relocs.py's job
        addr, rtype = int(p[0], 16), p[2]
        if rtype in UNSUPPORTED:
            target = int(p[3], 16) if len(p) > 3 else 0
            if ro_vma <= target <= ro_vma + ro_size:
                errors.append(f"{sec}+0x{addr:08x}: {rtype} into {SECTION}")
            continue
        if rtype != "R_ARM_ABS32":
            continue
        if sec != ".rel" + CODE:
            errors.append(f"{sec}+0x{addr:08x}: ABS32 outside {CODE} is not patched at runtime")
            continue
        pos = addr - code_vma
        word = struct.unpack_from("<I", code, pos)[0]
        if not ro_vma <= word <= ro_vma + ro_size:
            continue
        if skip_lo <= addr < skip_hi:
            continue
        if addr & 3:
            errors.append(f"0x{addr:08x}: unaligned pointer into {SECTION}")
            continue
        offsets.append(addr - ram_start)

    if errors:
        print("error: pointers into .rodata_earthbound the boot patcher can't relocate:", file=sys.stderr)
        for e in errors:
            print("  " + e, file=sys.stderr)
        sys.exit(1)

    data = ro.read_bytes()
    if len(data) != ro_size:
        sys.exit(f"error: {ro} is {len(data)} bytes, expected {ro_size} (extract {SECTION} first)")
    pad = b"\0" * (-len(data) % 4)
    trailer = struct.pack(f"<II{len(offsets)}I", MAGIC, len(offsets), *sorted(offsets))
    ro.write_bytes(data + pad + trailer)
    print(f"{ro}: {len(offsets)} rodata relocations appended")


if __name__ == "__main__":
    main()
