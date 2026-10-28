/*
 * EarthBound retro-go entry point.
 *
 * Unlike zelda3's main_zelda3.c, this file does NOT drive the per-frame
 * game loop. earthbound_main() (eb_main.c) contains the entire game loop and
 * calls platform_*() hooks each frame. Those hooks are implemented in
 * sibling gw_*.c files.
 *
 * Responsibilities here:
 *   1. Cache the rodata sidecar (earthbound.ro, next to this .bin) from SD
 *      into the extflash cache.
 *   2. Run PatchCodeRodataOffset to fix up pointer tables (which the build
 *      placed in .noreloc → RAM via EB_NORELOC and EBASSET_TABLE_ATTR).
 *   3. Initialize odroid_system (appid, audio sample rate, savestate hooks).
 *   4. Hand control to upstream.
 */

#include <odroid_system.h>
#include <stdint.h>
#include <stdbool.h>
#include <string.h>
#include <assert.h>

#include "main.h"
#include "gw_lcd.h"
#include "gw_buttons.h"
#include "gw_malloc.h"
#include "gw_ofw.h"

#include "common.h"
#include "rom_manager.h"
#include "rg_utils.h"
#include "appid.h"

#include "main_earthbound.h"

#include "game_main.h"   /* host_request_capture/load/status — native savestate engine */

#include "gw_core_bridge.h"   /* last — rewrites ACTIVE_FILE / common_emu_state */

#pragma GCC optimize("Ofast")

/* Matches the SPC700/DSP native rate. eb_audio_pump produces 534
 * stereo samples per game frame, which is the half-buffer SAI consumes
 * per 16.69 ms at 32 kHz mono — frame and DMA cadence stay aligned. */
#define EB_AUDIO_SAMPLE_RATE   (32000)

/* Shared with gw_input.c — the platform layer reads from this each frame. */
odroid_gamepad_state_t eb_joystick;

/* Defined by src/earthbound_core.ld. __rodata_earthbound_start__ is the
 * sentinel link VMA of the rodata sidecar (the patcher's base). */
extern uint32_t __RAM_EMU_START__;
extern void *__rodata_earthbound_start__[];
extern void *__rodata_earthbound_end__[];

/* The sidecar sits next to the launched .bin (/homebrews/ today). */
#define EB_RODATA_FILENAME "earthbound.ro"

/* PatchCodeRodataOffset — rewrites every RAM_EMU pointer into
 * .rodata_earthbound from its sentinel link VMA to the runtime address where
 * odroid_overlay_cache_file_in_flash placed the rodata blob.
 *
 * The words to patch come from the relocation table that
 * scripts/append_eb_reloc_table.py appends to earthbound.ro (exact
 * R_ARM_ABS32 sites from --emit-relocs). Do NOT go back to scanning RAM_EMU
 * for values in the rodata range: Thumb-2 instructions can encode to such a
 * value (`ldrb.w ip, [r1], #1` = 0xcb01f811 broke the bridge memcpy into an
 * endless copy that ran off the end of RAM_EMU).
 *
 * The table leaves out main_earthbound.o's code window (between
 * _EARTHBOUND_MAIN_CODE_*), which holds this function's own
 * __rodata_earthbound_* base literals. Code moved OUT of RAM_EMU (e.g. into
 * ITCM) isn't covered: the build script fails on ABS32 sites outside
 * .core_entry. */
#define EB_RELOC_MAGIC 0x31524245u /* "EBR1" */

static void PatchCodeRodataOffset(uint8_t *rodata, uint32_t file_length)
{
    uint32_t rodata_base = (uint32_t)__rodata_earthbound_start__;
    uint32_t rodata_length = (uint32_t)__rodata_earthbound_end__ - rodata_base;
    uint32_t table_pos = (rodata_length + 3) & ~3u;
    int32_t offset = (uint32_t)rodata - rodata_base;

    printf("eb rodata = %p base = 0x%08lX offset = 0x%08lX length = %lu\n",
           rodata, rodata_base, offset, (unsigned long)rodata_length);

    /* A stale earthbound.ro (older build, or one without the trailer) would
     * leave pointers at the sentinel VMA or patch the wrong words. */
    const uint32_t *table = (const uint32_t *)(rodata + table_pos);
    assert(file_length >= table_pos + 8 && table[0] == EB_RELOC_MAGIC &&
           "earthbound.ro has no reloc table: push the .ro from the same build");
    uint32_t count = table[1];
    assert(file_length >= table_pos + 8 + count * 4 &&
           "earthbound.ro reloc table truncated");

    uint8_t *ram_emu = (uint8_t *)&__RAM_EMU_START__;
    for (uint32_t i = 0; i < count; i++) {
        *(uint32_t *)(ram_emu + table[2 + i]) += offset;
        if ((i & 1023) == 0)
            wdog_refresh();
    }
}

/* Defined in gw_video.c: re-render the current (frozen) PPU frame into the
 * launcher's active framebuffer. Used for the pause-menu background and here. */
extern void eb_video_repaint_active(void);

static void *Screenshot(void)
{
    /* Render the live (frozen) PPU frame into the launcher's active buffer so
     * retro-go's cover/menu capture sees the running game rather than black.
     * Same read-only path the pause-menu background uses; the caller has the
     * game paused, so the PPU state is stable. */
    lcd_wait_for_vblank();
    lcd_clear_active_buffer();
    eb_video_repaint_active();
    return lcd_get_active_buffer();
}

/* retro-go savestate slots now ride the upstream native savestate engine
 * (state_dump.c): a structured snapshot of the game-state structs, written/read
 * through our platform_savestate_* backend (gw_savestate.c). Both hooks run from
 * deep inside common_emu_input_loop() — one level below the root-loop boundary —
 * so they REQUEST the action rather than perform it: host_request_capture/load()
 * set a pending flag, the loop free-runs any in-flight blocking helper to the
 * root, and host_root_boundary() (game_main.c) does the torn-safe save / in-place
 * load. No reboot, no per-frame stack anchor. We point the backend at the
 * launcher's chosen slot path first via eb_savestate_set_base(). */
static bool eb_LoadState(const char *savePathName)
{
    eb_savestate_set_base(savePathName);
    host_request_load();   /* serviced in-place at the next root boundary */
    return true;
}

/* TODO(eb-gwhb): the firmware's POWER path calls this with slot -1 and then
 * enters STOP2 immediately, so the requested capture only lands after wake.
 * Phase 3: make the slot -1 save synchronous (free-run to the root boundary
 * inside this callback). */
static bool eb_SaveState(const char *savePathName)
{
    eb_savestate_set_base(savePathName);
    host_request_capture();  /* torn-safe write at the next root boundary */
    return true;
}

/* EarthBound writes its 7680-byte save buffer straight to SD whenever the
 * player saves in-game (save_game() -> platform_save_write; see gw_save.c), so
 * there is no battery-backed SRAM image held in RAM to flush. retro-go calls
 * this hook on exit/sleep; for EB it is intentionally a no-op. */
static void eb_SramSave(void)
{
}

extern int earthbound_main(void);

/* ---- Resume -----------------------------------------------------------------
 *
 * POWER sleep is the firmware's own (STOP2 with RAM retained, resume in place,
 * slot -1 safety save via eb_SaveState). What's left here is the launcher's
 * "load slot at startup": a native in-process load queued in
 * app_main_earthbound and applied at earthbound_main()'s root boundary via
 * platform_root_boundary().
 */

/* Set in app_main_earthbound when a power-on resume must start in the in-game
 * retro-go menu. Unlike zelda3/smw — which load their state synchronously before
 * the frame loop — EB's load is queued (host_request_load) and only applied at
 * earthbound_main()'s first root boundary. Arming pause_after_frames up front
 * would trip the pause menu (decremented in common_emu_input_loop, ~twice per
 * game_logic_entry) BEFORE that boundary services the load, opening the menu over
 * the fresh-boot force-blank frame and stranding the load behind the blocking
 * pause loop (black screen). So we defer arming the pause until platform_root_
 * boundary() observes the load resolve. */
static bool s_pause_after_load;

/* Set in app_main_earthbound for a power-on resume; the savestate-load REQUEST is
 * deferred to the first platform_root_boundary() rather than issued before
 * earthbound_main(). Why: host_request_load() sets g_pending_root_action, and while
 * that is pending host_process_frame() free-runs with rendering skipped. Requesting
 * it before earthbound_main() therefore runs the WHOLE of game_init() + the boot
 * intro in render-skipped free-run, which crashes the boot (watchdog reset loop).
 * The submodule's resume contract is to request the load AFTER game_init(); the
 * first root boundary is exactly that point (game_init + one boot frame have run
 * normally), after which only a single free-run frame precedes the in-place apply.
 * The slot base path is set via eb_savestate_set_base() in app_main and persists. */
static bool s_resume_load_pending;

void platform_root_boundary(void)
{
    /* Power-on resume, step 1: now that game_init() + one boot frame have run with
     * full rendering, issue the deferred savestate-load request. Applied at the NEXT
     * root boundary (one free-run frame later). Doing this here instead of before
     * earthbound_main() keeps the boot sequence out of render-skipped free-run, which
     * otherwise crashes it (watchdog reset loop). */
    if (s_resume_load_pending) {
        host_request_load();
        s_resume_load_pending = false;
        return;
    }

    /* Power-on resume, step 2: the queued load is applied by host_root_boundary()
     * just before main.c calls us here. Once it has resolved (no longer PENDING), arm
     * the pause so the menu darkens the LOADED frame a couple frames later —
     * matching zelda3/smw, which pause over their already-loaded frame. Done even
     * on a FAILED load so a missing/invalid slot still lands in the menu rather
     * than silently fresh-starting unpaused. */
    if (s_pause_after_load && host_capture_status() != HOST_CAPTURE_PENDING) {
        common_emu_state.pause_after_frames = 2;
        s_pause_after_load = false;
    }
}

int app_main_earthbound(uint8_t load_state, uint8_t start_paused, int8_t save_slot)
{
    (void)save_slot;

    printf("EarthBound start\n");
    /* ram_start is seeded past __CORE_BSS_END__ by the GWHB loader. */

    /* Wipe the launcher's last frame out of both framebuffers — otherwise
     * the retro-go menu shows through any pixels EB hasn't written yet
     * (force-blank frames, transitions, etc.). */
    lcd_clear_buffers();

    /* Cache the rodata blob (3 MB of INCBIN'd assets + compiled const tables)
     * from SD into the extflash round-robin cache. */
    char eb_rodata_path[256];
    snprintf(eb_rodata_path, sizeof(eb_rodata_path), "%s/" EB_RODATA_FILENAME,
             rg_dirname(ACTIVE_FILE->path));
    uint32_t eb_rodata_length = 0;
    uint8_t *eb_rodata = odroid_overlay_cache_file_in_flash(
        eb_rodata_path, &eb_rodata_length, false);
    if (eb_rodata == NULL) {
        printf("Missing %s file\n", eb_rodata_path);
    }

    /* Fix up RAM pointer tables (.noreloc) to point at the actual extflash
     * location of the rodata blob. Native savestate serializes game-state structs
     * (not raw RAM), and load applies on top of this freshly-patched boot, so no
     * rodata re-stamping is needed on resume — this one pass is sufficient. */
    PatchCodeRodataOffset(eb_rodata, eb_rodata_length);

    odroid_system_init(APPID_HOMEBREW, EB_AUDIO_SAMPLE_RATE);
    odroid_system_emu_init(&eb_LoadState, &eb_SaveState, &Screenshot,
                           NULL, NULL, &eb_SramSave, NULL);

    /* Queue the launcher's "load slot at startup" (ODROID_PATH_SAVE_STATE) to be
     * serviced at earthbound_main()'s first root-loop boundary (it free-runs
     * in-process; no reboot). On a missing/invalid slot the load silently fails
     * at the root boundary and the game falls through to a normal fresh start. */
    bool load_queued = false;
    if (load_state) {
        char *p = odroid_system_get_path(ODROID_PATH_SAVE_STATE, ACTIVE_FILE->path);
        if (p) {
            eb_savestate_set_base(p);
            load_queued = true;
            free(p);
        }
    }
    /* Defer the actual host_request_load() to the first root boundary (see
     * s_resume_load_pending) so the boot sequence runs with full rendering. */
    s_resume_load_pending = load_queued;

    /* Start paused into the in-game retro-go menu (same as zelda3/smw). The
     * launcher requests this on power-on resume (rg_main.c: emulator_start(...,
     * start_paused=true)) so the device comes back paused over the loaded state.
     * pause_after_frames is decremented in common_emu_input_loop() — which
     * gw_input.c's platform_input_poll() calls every frame — and trips
     * pause_pressed, opening the pause menu, which mutes/unmutes audio itself.
     *
     * We deliberately do NOT odroid_audio_mute(true) here (zelda3/smw do). EB's
     * SAI ISR refill stops advancing the ring's consumer tail while muted
     * (gw_audio.c: eb_audio_dma_refill honors audio_mute), which is only safe when
     * the producer is frozen — true inside the modal pause menu, but NOT during
     * these lead-in frames where the game loop (and eb_audio_pump) still runs. A
     * pre-mute there fills the ring and then deadlocks eb_audio_pump in its WFI
     * wait for a slot the muted ISR never frees (a watchdog-refreshing hang). The
     * lead-in is fresh-boot frames (APU silent), so leaving audio unmuted costs no
     * audible blip; the pause menu mutes safely once it opens.
     *
     * Unlike zelda3/smw (which load synchronously above the frame loop and so can
     * arm the pause immediately), EB's load was only QUEUED above and is applied
     * at earthbound_main()'s first root boundary. Arming pause_after_frames here
     * would trip the menu before that boundary, over the fresh-boot black frame,
     * and strand the load behind the blocking pause loop. So when a load is
     * pending we defer arming to platform_root_boundary(), which fires once the
     * load resolves; only the no-load case (no resume slot) pauses immediately. */
    if (start_paused) {
        if (load_queued) {
            s_pause_after_load = true;
            common_emu_state.pause_after_frames = 0;
        } else {
            common_emu_state.pause_after_frames = 2;
        }
    } else {
        common_emu_state.pause_after_frames = 0;
    }

    /* Hand off to upstream — earthbound_main() runs the game loop forever. */
    earthbound_main();
    __builtin_unreachable();
}
