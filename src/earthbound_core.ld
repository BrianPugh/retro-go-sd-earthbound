/*
 * EarthBound GWHB linker script. Adapted from slash-proc/zelda3-retro-go-sd's
 * src/zelda3_core.ld (itself a fork of sdk/ld/core_ram_emu.ld — read that
 * file for the general contract: segment 0 = RAM_EMU with .core_entry at
 * offset 0, __CORE_CODE_END__ / __CORE_BSS_END__, no ALIGN between loaded
 * sections).
 *
 * Three destinations:
 *
 *   RAM_EMU  (segment 0)  entry, all code, .data/.noreloc, the port's own
 *                         rodata, then .bss. Above __CORE_BSS_END__ the
 *                         firmware seeds the ram_malloc bump heap, which
 *                         lakesnes needs ~70 KB of (asserted below).
 *   ITCM     (segment 1)  .bss only: the cold entity/map_loader tables and
 *                         the audio stereo scratch, ~35 KB. They don't fit in
 *                         RAM_EMU alongside the triple buffer and the audio
 *                         heap, and the SDK forbids AHB segments. All are
 *                         CPU-only (no DMA). The loader zeroes the span.
 *   RODATA   (sidecar)    the decomp's .rodata*, linked at a sentinel VMA
 *                         and extracted to earthbound.ro. (The ROM assets
 *                         are a separate file, earthbound_assets.dat, which
 *                         main_earthbound.c indexes at boot.) At boot main_earthbound.c caches it
 *                         into QSPI and PatchCodeRodataOffset rewrites every
 *                         RAM_EMU word inside the sentinel range to the
 *                         runtime address, skipping the main_earthbound.o
 *                         window (its rodata stays in RAM_EMU). Pointers
 *                         stored *inside* the sidecar are never patched, so
 *                         such tables must be EB_NORELOC (→ .noreloc, RAM);
 *                         scripts/check_eb_rodata_relocs.py enforces that.
 */

INCLUDE gnw_ram_emu.ld
INCLUDE gnw_itcm_core.ld

/* Minimum RAM_EMU left free after static .bss for the runtime bump heap.
 * lakesnes ram_malloc()s ~70 KB at audio_init (Apu + 64 KB SPC ARAM +
 * Spc/Dsp/statehandler; see src/eb_alloc.h) plus a little flash-cache
 * metadata. The ARAM must stay in cached RAM_EMU (uncached AHB ran at
 * ~266 ms/frame), so static .bss growth is what has to give. */
__EARTHBOUND_MIN_RAM_HEAP__ = 74 * 1024;

/* Bytes skipped at the start of the ITCM segment so no object lands at
 * address 0: a pointer to the first entity-table element would compare
 * equal to NULL. */
__EARTHBOUND_ITCM_NULL_PAD__ = 64;

MEMORY
{
  RAM_EMU (xrw) : ORIGIN = __RAM_EMU_START__,   LENGTH = __RAM_EMU_LENGTH__
  ITCM    (xrw) : ORIGIN = __ITCM_CORE_START__, LENGTH = __ITCM_CORE_LENGTH__
  RODATA  (r)   : ORIGIN = 0xCAFE0000,          LENGTH = 0x10000000
}

PHDRS
{
  text   PT_LOAD FLAGS(5); /* PF_R | PF_X */
  data   PT_LOAD FLAGS(6); /* PF_R | PF_W */
  itcm   PT_LOAD FLAGS(6); /* PF_R | PF_W */
  rodata PT_LOAD FLAGS(4); /* PF_R */
}

SECTIONS
{
  .core_entry __RAM_EMU_START__ :
  {
    KEEP(*(.core_entry))
    KEEP(*(.gw_core_bridge_probe))
    . = ALIGN(4);

    /* PatchCodeRodataOffset skips this window: main_earthbound.o's own
     * rodata lives here, and its code must not be "patched" by a literal
     * that happens to fall in the sentinel range. */
    _EARTHBOUND_MAIN_CODE_START = .;
    *main_earthbound.o (.data .data* .text .text* .rodata .rodata*)
    . = ALIGN(4);
    _EARTHBOUND_MAIN_CODE_END = .;

    *(.text*)
    *(.glue_7)
    *(.glue_7t)
    *(.noreloc)
    *(.data*)

    /* SDK bridge/entry and libgcc keep their rodata in RAM_EMU; everything
     * else's goes to .rodata_earthbound below. */
    *gw_core_bridge.o (.rodata .rodata*)
    *gw_core_i18n.o (.rodata .rodata*)
    *gw_core_entry.o (.rodata .rodata*)
    *libgcc.a: (.rodata .rodata*)

    . = ALIGN(4);
    __CORE_INIT_ARRAY_START__ = .;
    KEEP(*(SORT(.init_array.*)))
    KEEP(*(.init_array*))
    __CORE_INIT_ARRAY_END__ = .;
  } >RAM_EMU :text

  /* May be empty — data claimed above. No leading ALIGN (see core_ram_emu.ld). */
  .data :
  {
  } >RAM_EMU :data

  __CORE_CODE_END__ = .;

  /* Segment 1: ITCM, .bss only (code_size 0). Must precede the RAM_EMU .bss
   * catch-all so ld assigns these input sections here. */
  .core_itcm (NOLOAD) :
  {
    __CORE_ITCM_CODE_END__ = .;
    . = . + __EARTHBOUND_ITCM_NULL_PAD__;
    . = ALIGN(8);
    *entity.o (.bss .bss* COMMON)
    *map_loader.o (.bss .bss* COMMON)
    *gw_audio.o (.bss.eb_stereo_scratch)
    . = ALIGN(8);
    __CORE_ITCM_BSS_END__ = .;
  } >ITCM :itcm

  ASSERT(__CORE_ITCM_CODE_END__ == __ITCM_CORE_START__,
         "EARTHBOUND: ITCM segment must be .bss-only")
  ASSERT(__CORE_ITCM_BSS_END__ <= __ITCM_CORE_START__ + __ITCM_CORE_LENGTH__,
         "EARTHBOUND: ITCM .bss overflows ITCM")

  .bss __CORE_CODE_END__ (NOLOAD) :
  {
    . = ALIGN(8);
    *(.bss*)
    *(COMMON)
    . = ALIGN(8);
  } >RAM_EMU :data

  __CORE_BSS_END__ = .;

  ASSERT(__CORE_BSS_END__ <= __RAM_EMU_END__,
         "EARTHBOUND: code+data+bss overflows RAM_EMU")

  .rodata_earthbound :
  {
    . = ALIGN(4);
    __rodata_earthbound_start__ = .;
    *(.rodata .rodata*)
    __rodata_earthbound_end__ = .;
  } >RODATA :rodata

  __exidx_start = .;
  __exidx_end = .;

  /DISCARD/ :
  {
    *(.fini_array*)
    *(.preinit_array*)
    *(.ARM.exidx*)
    *(.ARM.extab*)
    *(.comment)
    *(.ARM.attributes)
  }
}

/* Top level (not in-section) so it sees the FINAL __CORE_BSS_END__. The
 * RAM_EMU-end assert above only proves static .bss fits; it can't see the
 * ~70 KB lakesnes bump-allocates at runtime, which is how an earlier +80 KB
 * .bss change linked green and starved audio_init to a NULL malloc. */
ASSERT(__CORE_BSS_END__ + __EARTHBOUND_MIN_RAM_HEAP__ <= __RAM_EMU_END__,
       "EARTHBOUND: static .bss leaves < 74 KB of RAM_EMU for the runtime audio heap (lakesnes Apu + 64 KB SPC ARAM). Shrink static state.")
