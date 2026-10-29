#!/usr/bin/env python3
"""Pack EB's required_abi_min_size as the ABI prefix it needs.

The SDK bridge bakes GW_CORE_BUILT_ABI_SIZE = sizeof(gw_firmware_abi_t) into
the payload, and pack_homebrew.py copies it into the GWHB header. Every SDK
sync that appends ABI fields therefore raises the minimum firmware, even for
fields EB never calls: synced from external_cores 1b025902, EB asked for 916
bytes and the v2.0.0-rc1 release (908, no rg_storage_rename/free_space) refused
it.

src/main_earthbound.c defines EB_REQUIRED_ABI_SIZE = offsetof(first field EB
may lack). This script writes that value over GW_CORE_BUILT_ABI_SIZE in the
flat .bin before packing, after checking that every field from the cutoff on
is read only inside a CORE_ABI_HAS(field) guard in the bridge, and nowhere in
the bridge header or EB's own sources. When a later sync adds a field EB has
to call unguarded, this fails, and the cutoff in main_earthbound.c moves.

Usage: set_eb_abi_min_size.py <tool-prefix> <elf> <bin>
"""

import re
import struct
import subprocess
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
ABI_HEADER = ROOT / "sdk/include/Core/Inc/retro-go/gw_firmware_abi.h"
BRIDGE_C = ROOT / "sdk/src/gw_core_bridge.c"
BRIDGE_H = ROOT / "sdk/src/gw_core_bridge.h"
CUTOFF_RE = re.compile(r"EB_REQUIRED_ABI_SIZE\s*=\s*offsetof\(\s*gw_firmware_abi_t\s*,\s*(\w+)\s*\)")


def strip_comments(text: str) -> str:
    text = re.sub(r"/\*.*?\*/", lambda m: re.sub(r"[^\n]", " ", m.group(0)), text, flags=re.S)
    return re.sub(r"//[^\n]*", "", text)


def fields_from(cutoff: str) -> list[str]:
    """Names of the gw_firmware_abi_t fields declared from `cutoff` to the end."""
    text = strip_comments(ABI_HEADER.read_text())
    end = text.index("} gw_firmware_abi_t;")
    start = text.rfind(f"(*{cutoff})", 0, end)
    if start < 0:
        sys.exit(f"error: {cutoff} is not a function-pointer field of gw_firmware_abi_t")
    names = []
    for decl in text[start - 1:end].split(";"):
        m = re.search(r"\(\s*\*\s*(\w+)\s*\)", decl) or re.search(r"(\w+)\s*(?:\[[^\]]*\])?\s*$", decl)
        if m:
            names.append(m.group(1))
    return names


def unguarded_uses(field: str) -> list[str]:
    problems = []
    use = re.compile(rf"->\s*{field}\b")
    guard = f"CORE_ABI_HAS({field})"

    text = strip_comments(BRIDGE_C.read_text())
    for m in use.finditer(text):
        # The guard must come earlier in the same top-level function.
        fn_start = text.rfind("\n}", 0, m.start())
        if guard not in text[fn_start:m.start()]:
            line = text.count("\n", 0, m.start()) + 1
            problems.append(f"{BRIDGE_C.relative_to(ROOT)}:{line}: {field} read without {guard}")

    others = [BRIDGE_H, *sorted((ROOT / "src").rglob("*.[ch]"))]
    for path in others:
        for m in use.finditer(strip_comments(path.read_text(errors="replace"))):
            problems.append(f"{path.relative_to(ROOT)}: reads {field} directly")
    return problems


def symbols(prefix: str, elf: Path) -> dict[str, int]:
    out = subprocess.run([f"{prefix}nm", str(elf)], check=True, capture_output=True, text=True).stdout
    syms = {}
    for line in out.splitlines():
        parts = line.split()
        if len(parts) == 3:
            syms[parts[2]] = int(parts[0], 16)
    return syms


def main() -> None:
    if len(sys.argv) != 4:
        sys.exit(__doc__.strip().splitlines()[-1])
    prefix, elf, bin_path = sys.argv[1], Path(sys.argv[2]), Path(sys.argv[3])

    src = (ROOT / "src/main_earthbound.c").read_text()
    m = CUTOFF_RE.search(src)
    if not m:
        sys.exit("error: EB_REQUIRED_ABI_SIZE = offsetof(gw_firmware_abi_t, <field>) not found in src/main_earthbound.c")
    cutoff = m.group(1)

    problems = [p for f in fields_from(cutoff) for p in unguarded_uses(f)]
    if problems:
        sys.exit("error: ABI fields past the EB_REQUIRED_ABI_SIZE cutoff "
                 f"({cutoff}) are used unguarded; move the cutoff:\n  " + "\n  ".join(problems))

    syms = symbols(prefix, elf)
    base = syms["__RAM_EMU_START__"]
    built_off = syms["GW_CORE_BUILT_ABI_SIZE"] - base
    need_off = syms["EB_REQUIRED_ABI_SIZE"] - base

    data = bytearray(bin_path.read_bytes())
    (need,) = struct.unpack_from("<I", data, need_off)
    (current,) = struct.unpack_from("<I", data, built_off)
    # A freshly linked .bin holds the bridge's sizeof; one patched by an
    # earlier run already holds `need`.
    if current != need:
        if not 0 < need < current:
            sys.exit(f"error: EB_REQUIRED_ABI_SIZE {need} is not below the built ABI size {current}")
        struct.pack_into("<I", data, built_off, need)
        bin_path.write_bytes(data)
    print(f"required_abi_min_size {need} (the ABI up to {cutoff})")


if __name__ == "__main__":
    main()
