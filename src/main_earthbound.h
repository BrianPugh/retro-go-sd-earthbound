#pragma once

#include <stdbool.h>
#include <stdint.h>

int app_main_earthbound(uint8_t load_state, uint8_t start_paused, int8_t save_slot);

/* Point the platform_savestate_* backend (gw_savestate.c) at the base path for
 * the next capture/load. The two crash-safe ping-pong slot files derive from it
 * ("<base>" and "<base>.1"). Call before host_request_capture()/host_request_load(). */
void eb_savestate_set_base(const char *path);

/* Call each frame with the raw POWER state before common_emu_input_loop().
 * Starts the slot -1 safety save on the press; returns true while it is still
 * unwinding, meaning POWER must be reported as held so the firmware doesn't
 * sleep yet. */
bool eb_power_hold(bool power_down);
