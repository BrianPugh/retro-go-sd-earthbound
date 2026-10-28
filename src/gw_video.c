/*
 * G&W video platform — scanline-based render into a private back buffer.
 *
 * The EB src/ build (Makefile.common: C_DEFS_EARTHBOUND) sets:
 *   - EB_VIEWPORT_WIDTH=320 EB_VIEWPORT_HEIGHT=240 — PPU outputs scanlines sized
 *     to the LCD; the 256x224 SNES content is centered by EB itself, with
 *     the margins filled by BG fill color / black.
 *   - EB_PIXEL_RGB565=1 — pixel_t is built as RGB565 instead of the default
 *     BGR565, matching the LTDC layer format (main.c:831). The swap happens
 *     once per palette entry per frame (256 ops) inside ppu_prepare_palette,
 *     not per pixel — so this file is a plain memcpy.
 *
 * Present: render into eb_fb3, then copy it into the launcher's free buffer
 * and lcd_swap(). Drawing straight into the launcher's buffer has to wait for
 * the previous swap to latch first, which quantizes the frame rate to the
 * 60 Hz refresh (a ~35 ms frame rounds to 50 ms, ~20 fps). With eb_fb3 as a
 * private back buffer the CPU renders while the swap is pending, and the only
 * added cost is one 150 KiB memcpy per frame (well under 1 ms on hardware; a
 * DMA2D copy measured no faster).
 *
 * The copy needs the previous swap to have latched (until then the launcher's
 * "active" buffer is still on screen). When it hasn't, the frame is parked in
 * fb3_queued and copied from eb_video_service(), which the audio pump's wait
 * loop polls, so the vblank wait overlaps the audio wait instead of summing
 * with it. eb_fb3 is never handed to the LTDC, so it needs no cache
 * maintenance and is safe to lend as the savestate scratch once drained.
 */

#include <string.h>
#include <stdio.h>

#include "platform/platform.h"
#include "snes/ppu.h"
#include "gw_lcd.h"
#include "common.h"

/* Private back buffer — cacheable, in EB's overlay BSS (RAM_EMU). Rendering
 * into it is a touch faster than into the uncached fb1/fb2. */
static uint16_t eb_fb3[GW_LCD_WIDTH * GW_LCD_HEIGHT] __attribute__((aligned(32)));

static bool fb3_queued;

void eb_video_service(void)
{
    if (fb3_queued && !lcd_is_swap_pending()) {
        memcpy(lcd_get_active_buffer(), eb_fb3, sizeof(eb_fb3));
        common_ingame_overlay();
        lcd_swap();
        fb3_queued = false;
    }
}

static void fb3_drain(void)
{
    while (fb3_queued) {
        eb_video_service();
        if (fb3_queued) {
            wdog_refresh();
            __WFI();
        }
    }
}

bool platform_video_init(void)
{
    return true;
}

void platform_video_shutdown(void) {}

void platform_video_begin_frame(void)
{
    /* eb_fb3 is free to draw once the queued frame has been copied out. */
    fb3_drain();
}

void platform_video_send_scanline(int y, const pixel_t *pixels)
{
    if (y < 0 || y >= EB_VIEWPORT_HEIGHT) {
        return;
    }
    memcpy(&eb_fb3[y * GW_LCD_WIDTH], pixels, EB_VIEWPORT_WIDTH * sizeof(pixel_t));
}

pixel_t *platform_video_get_framebuffer(void)
{
    return (pixel_t *)eb_fb3;
}

void platform_video_end_frame(void)
{
    fb3_queued = true;
    eb_video_service();
}

void platform_video_set_vsync(bool enabled)
{
    (void)enabled;
}

/* platform_render_frame() is provided by src/platform/platform_render.c
 * (the upstream single-core default). It calls begin_frame, ppu_render_frame
 * with platform_video_send_scanline as the scanline callback, and end_frame.
 * The G&W is single-core so we use that default verbatim. */

/* Scanline sink that writes into the launcher's *active* framebuffer rather
 * than EB's private back buffer. fb1/fb2 are non-cacheable (RAM_UC),
 * so no cache maintenance is needed after the copy. */
static void eb_scanline_to_active(int y, const pixel_t *pixels)
{
    if (y < 0 || y >= EB_VIEWPORT_HEIGHT) {
        return;
    }
    uint16_t *fb = (uint16_t *)lcd_get_active_buffer();
    memcpy(&fb[y * GW_LCD_WIDTH], pixels, EB_VIEWPORT_WIDTH * sizeof(pixel_t));
}

/* Re-render the current PPU frame into the launcher's active framebuffer, for
 * the retro-go pause-menu background. The overlay code clears the active buffer,
 * calls this via the repaint hook, then darkens it and draws the dialog on top
 * (see odroid_overlay.c). This mirrors zelda3's DrawPpuFrame repaint: EB
 * renders into eb_fb3 and only touches the launcher's buffers when presenting,
 * so without an on-demand re-render the menu would show the just-cleared
 * black background. The game loop is frozen inside the
 * modal menu so the PPU state is stable, and ppu_render_frame only reads it —
 * safe to call on every menu redraw. */
void eb_video_repaint_active(void)
{
    ppu_render_frame(eb_scanline_to_active);
}

/* Savestate (de)compressor scratch — lend the idle back buffer.
 *
 * Saves/loads run at the root boundary while the game is paused: rendering is
 * stopped and the pause UI presents through the launcher's fb1/fb2, so eb_fb3
 * (EB's private back buffer, never scanned out) holds a stale game frame
 * nobody is reading. state_dump.c borrows it as the tamp LZ
 * window + working struct + compressed-I/O staging for the duration of the op;
 * the next normal end_frame repaints it on resume. It's cacheable (RAM_EMU) and
 * CPU-only during compression (no DMA), so no cache maintenance is needed while
 * it's on loan. 150 KiB — vastly more than the few hundred bytes tamp needs at
 * window_bits=8, with the slack going to chunkier SD staging. */
void *platform_savestate_scratch(size_t *out_bytes)
{
    /* A parked frame still has to be copied out of eb_fb3. */
    fb3_drain();

    if (out_bytes)
        *out_bytes = sizeof(eb_fb3);
    return eb_fb3;
}
