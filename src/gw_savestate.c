/*
 * G&W savestate storage backend — file-backed crash-safe ping-pong slots.
 *
 * Implements the platform_savestate_* contract (src/platform/platform.h): the
 * upstream state_dump engine writes a ~141 KiB suspend/resume snapshot through
 * two SAVESTATE_SLOTS, targeting the inactive slot and reading the newest valid
 * one, so a power loss mid-write leaves the prior slot intact.
 *
 * Unlike the Unix port's fixed "savestate.bin.<slot>" names, a retro-go build
 * has MANY user-visible save slots (and a separate sleep snapshot). We therefore
 * key the two ping-pong files on a caller-supplied *base path* set via
 * eb_savestate_set_base() before each capture/load:
 *   slot 0 -> "<base>"        (the launcher's own slot path, so its existing
 *                              file-exists slot-occupancy check still works)
 *   slot 1 -> "<base>.1"      (the second ping-pong copy)
 *
 * I/O goes through the firmware's newlib stdio (the ABI exports no FatFs file
 * API). On the old firmware-fork build this path (fopen + hundreds of buffered
 * fseek+fwrite + a final fflush) failed for the large streaming snapshot: every
 * fwrite reported success but the closing fflush() returned -1. On stock
 * external_cores it works on hardware (in-game, pause-menu and POWER
 * savestates). If that failure ever comes back, it's the stdio layer, not the
 * card.
 */

#include <stdio.h>
#include <string.h>

#include "ff.h"
#include "platform/platform.h"
#include "main_earthbound.h"
#include "odroid_audio.h"

/* Base path for the current logical savestate; the two ping-pong files derive
 * from it. Set by eb_savestate_set_base() before host_request_capture/load. */
static char ss_base[256];
static char ss_slot_path[260];

static void ss_read_close(void);   /* defined below, by the read-handle cache */

void eb_savestate_set_base(const char *path)
{
    /* A new logical capture/load is about to begin — drop any cached read handle
     * from a prior operation so a stale path can't be reused. */
    ss_read_close();
    if (!path) {
        ss_base[0] = '\0';
        return;
    }
    strncpy(ss_base, path, sizeof(ss_base) - 1);
    ss_base[sizeof(ss_base) - 1] = '\0';
}

static const char *slot_path(int slot)
{
    if (ss_base[0] == '\0')
        return NULL;
    if (slot == 0)
        return ss_base;
    snprintf(ss_slot_path, sizeof(ss_slot_path), "%s.%d", ss_base, slot);
    return ss_slot_path;
}

/* One open writer at a time. The engine writes a single slot to completion
 * (begin -> writes -> commit) before touching another; ss_wslot tracks which
 * slot owns it (-1 = none open). One cached read handle is reused across the
 * many small reads a single load makes. */
static FILE *ss_wfile;
static int ss_wslot = -1;

static FILE *ss_rfile;
static char ss_ropen[sizeof ss_slot_path];

static void ss_read_close(void)
{
    if (ss_ropen[0]) {
        fclose(ss_rfile);
        ss_rfile = NULL;
        ss_ropen[0] = '\0';
    }
}

bool platform_savestate_begin(int slot)
{
    if (slot < 0 || slot >= SAVESTATE_SLOTS)
        return false;
    const char *path = slot_path(slot);
    if (!path)
        return false;
    ss_read_close();
    if (ss_wslot >= 0) {            /* a prior capture never committed — drop it */
        fclose(ss_wfile);
        ss_wfile = NULL;
        ss_wslot = -1;
    }
    ss_wfile = fopen(path, "wb");   /* truncate */
    if (!ss_wfile)
        return false;
    ss_wslot = slot;
    return true;
}

bool platform_savestate_write(int slot, size_t offset, const void *src, size_t size)
{
    if (slot != ss_wslot)
        return false;
    if (fseek(ss_wfile, (long)offset, SEEK_SET) != 0)
        return false;
    return fwrite(src, 1, size, ss_wfile) == size;
}

bool platform_savestate_commit(int slot)
{
    if (slot != ss_wslot)
        return false;
    /* fclose flushes; the SDK bridge doesn't route a standalone fflush. */
    int rc = fclose(ss_wfile);
    ss_wfile = NULL;
    ss_wslot = -1;
    return rc == 0;
}

size_t platform_savestate_read(int slot, size_t offset, void *dst, size_t size)
{
    if (slot < 0 || slot >= SAVESTATE_SLOTS)
        return 0;
    const char *path = slot_path(slot);
    if (!path)
        return 0;
    if (strcmp(ss_ropen, path) != 0) {
        ss_read_close();
        ss_rfile = fopen(path, "rb");
        if (!ss_rfile)
            return 0;
        strncpy(ss_ropen, path, sizeof ss_ropen - 1);
        ss_ropen[sizeof ss_ropen - 1] = '\0';
    }
    if (fseek(ss_rfile, (long)offset, SEEK_SET) != 0)
        return 0;
    return fread(dst, 1, size, ss_rfile);
}


/* Silence the SAI across the blocking save/load I/O. state_dump_*_slots() runs
 * at the root boundary with the game loop stalled, so nothing refills the DMA
 * halves and the last one would otherwise drone for the ~0.6-1 s of SD I/O. */
void platform_savestate_freeze_audio(bool freeze)
{
    odroid_audio_mute(freeze);
}
