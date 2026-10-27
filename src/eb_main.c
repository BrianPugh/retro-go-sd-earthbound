/*
 * Game & Watch (Retro-Go SD) game loop. Called from app_main_earthbound()
 * (main_earthbound.c) after it has cached the rodata blob and patched the
 * rodata pointers. Folded in from external/earthbound/port/gw_retro_go/main.c,
 * which named this main() and relied on the firmware renaming it.
 */

#include "platform/platform.h"
#include "game_main.h"

int earthbound_main(void);

/*
 * Optional host hook, called once per iteration at the root-loop boundary —
 * the port-side counterpart to the engine's host_root_boundary(), and the only
 * quiescent point where deferred / torn-unsafe host work is safe (no mode-step
 * or blocking helper is mid-execution). Declared weak so ports that don't need
 * it (desktop) link without providing one. May not return.
 *
 * Current use (main_earthbound.c): issue the deferred launcher "load slot at
 * startup" request once game_init() has run, then arm the start-paused menu
 * once that load resolves.
 */
void platform_root_boundary(void) __attribute__((weak));

int earthbound_main(void) {
    platform_video_init();
    platform_input_init();
    platform_timer_init();
    platform_audio_init();

    game_init();

    /*
     * game_logic_entry() runs the main game loop. It calls wait_for_vblank()
     * which calls host_process_frame() -> ppu_render_frame() and the
     * platform_video/input/audio/timer hooks each frame, then runs
     * host_root_boundary() — the safe point for deferred host actions.
     *
     * It returns on Game Over → Continue; loop to restart.
     */
    for (;;) {
        game_logic_entry();
        if (platform_root_boundary)
            platform_root_boundary();   /* deferred host work; may not return */
    }

    /* unreachable */
    return 0;
}
