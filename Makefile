# EarthBound — Retro-Go SD GWHB homebrew.
#
#   make                  — build + pack EarthBound.bin (+ earthbound.ro sidecar),
#                           and earthbound_assets.dat when the ROM is present
#   make sdpush           — push all three to /homebrews/ on the device (gnwmanager)
#   make gen-headers      — regenerate the committed src/gen/ asset headers
#                           (after a submodule bump; needs the ROM)
#   make recipe           — regenerate the committed converter recipe
#                           (tools/converter/recipe/eb_recipe.bin; same rule)
#   make docker           — same build inside Docker (no host toolchain)
#   make docker_shell     — interactive shell in the builder image
#
# EarthBound.bin and earthbound.ro build without the ROM. The asset pack
# needs the donor ROM (US EarthBound) at ./earthbound.sfc, or pass
# EARTHBOUND_SFC=/path/to/earthbound.sfc. Neither the ROM nor the asset pack
# is committed; src/gen/ holds only the asset ids the code compiles against.
#
# Sidecars on SD (not in the GWHB), all written next to PACKED_BIN:
#   /homebrews/earthbound.ro           — rodata: compiled const tables
#   /homebrews/earthbound_assets.dat   — ROM assets (scripts/eb_assets.py)
#
# Verbose compiler lines: make V=

#######################################
# Project identity
#######################################
PROJECT_KIND := homebrew

CORE_NAME  := earthbound
CORE_ENTRY := app_main_earthbound

PACKED_BIN := EarthBound.bin
# The .ro must always ship with the .bin it was built with (see the $(RO_BIN)
# rule), so it's written next to PACKED_BIN: a second build config with its own
# PACKED_BIN=build/x/EarthBound.bin gets its own build/x/earthbound.ro.
RO_BIN     := $(patsubst ./%,%,$(dir $(PACKED_BIN))earthbound.ro)
# SIDECARS are published beside the .bin; the asset pack is ROM-derived, so
# it never is (a user builds it from their own ROM).
SIDECARS   := $(RO_BIN)
ASSETS_DAT := $(patsubst ./%,%,$(dir $(PACKED_BIN))earthbound_assets.dat)
HB_NAME    := EarthBound

# Relative path so Docker bind-mounts work (do NOT use $(abspath)).
GNW_CORE_SDK ?= sdk
BUILD_DIR ?= build

CORE_EARTHBOUND    := external/earthbound
EARTHBOUND_GEN_DIR := $(BUILD_DIR)/earthbound_gen

#######################################
# Sources
#######################################
EARTHBOUND_C_SOURCES := \
$(wildcard $(CORE_EARTHBOUND)/src/core/*.c) \
$(CORE_EARTHBOUND)/src/vendor/tamp/tamp/_c_src/tamp/common.c \
$(CORE_EARTHBOUND)/src/vendor/tamp/tamp/_c_src/tamp/compressor.c \
$(CORE_EARTHBOUND)/src/vendor/tamp/tamp/_c_src/tamp/decompressor.c \
$(wildcard $(CORE_EARTHBOUND)/src/entity/*.c) \
$(wildcard $(CORE_EARTHBOUND)/src/game/*.c) \
$(wildcard $(CORE_EARTHBOUND)/src/intro/*.c) \
$(wildcard $(CORE_EARTHBOUND)/src/platform/*.c) \
$(wildcard $(CORE_EARTHBOUND)/src/snes/*.c) \
$(wildcard $(CORE_EARTHBOUND)/src/data/*.c) \
$(CORE_EARTHBOUND)/src/vendor/lakesnes/snes/apu.c \
$(CORE_EARTHBOUND)/src/vendor/lakesnes/snes/spc.c \
$(CORE_EARTHBOUND)/src/vendor/lakesnes/snes/dsp.c \
$(CORE_EARTHBOUND)/src/vendor/lakesnes/snes/statehandler.c \
$(CORE_EARTHBOUND)/src/game_main.c

PORT_C_SOURCES := \
src/eb_main.c \
src/main_earthbound.c \
src/gw_video.c \
src/gw_input.c \
src/gw_audio.c \
src/gw_timer.c \
src/gw_debug.c \
src/gw_save.c \
src/gw_savestate.c

CORE_C_SOURCES := $(EARTHBOUND_C_SOURCES) $(PORT_C_SOURCES)

CORE_C_INCLUDES := \
-Isrc \
-Isrc/gen \
-I$(CORE_EARTHBOUND)/src \
-I$(CORE_EARTHBOUND)/src/vendor/tamp/tamp/_c_src \
-I$(CORE_EARTHBOUND)/src/include \
-I$(CORE_EARTHBOUND)/src/vendor/incbin \
-I$(CORE_EARTHBOUND)/src/vendor/lakesnes/snes

#######################################
# Build knobs
#######################################
# EB_EMBEDDED gates printf/stderr/state_dump fallbacks; EB_NORELOC_REQUIRED
# places pointer tables into .noreloc (RAM) so PatchCodeRodataOffset can fix
# them up. USA selects the US retail flavor. EB_VIEWPORT_{WIDTH,HEIGHT}=320x240
# pads each scanline to the LCD's native width (SNES content stays centered).
# Add -DEB_PPU_PROFILE=1 to re-enable PPU/BGPROF/audio/video diagnostics.
# Every upstream knob carries an EB_ prefix (submodule 2e7968d8+); a stale
# un-prefixed -D is silently ignored, so re-grep after every submodule bump.
# EB_HAVE_SAVESTATE_BACKEND drops src/platform/savestate_backend_stub.c so
# src/gw_savestate.c links instead. TAMP_EXTENDED must stay on (tamp's
# default): state_dump compresses with .extended = 1.
CORE_C_DEFS := \
-DPROJECT_KIND_HOMEBREW=1 \
-D_GNU_SOURCE \
-DEB_EMBEDDED=1 \
-DEB_NORELOC_REQUIRED=1 \
-DEB_B_OPENS_MAIN_MENU=1 \
-DUSA=1 \
-DEB_VIEWPORT_WIDTH=320 \
-DEB_VIEWPORT_HEIGHT=240 \
-DEB_PIXEL_RGB565=1 \
-DEB_ENABLE_AUDIO=1 \
-DEB_HOST_PACED_FRAMESKIP=1 \
-DEB_PPU_FORCE_SPEED_OPT=1 \
-DEB_HAVE_SAVESTATE_BACKEND=1 \
-DTAMP_STREAM=0

# Extra -D flags from the command line, e.g.
#   make EB_EXTRA_DEFS="-DEB_PPU_PROFILE=1"
EB_EXTRA_DEFS ?=
CORE_C_DEFS += $(EB_EXTRA_DEFS)

# -O3 BSODs entering the overworld (latent UB exposed by codegen), so the
# default stays -O2. ppu_render.c raises itself with a pragma.
OPT ?= -O2

CORE_LDSCRIPT := src/earthbound_core.ld

include $(GNW_CORE_SDK)/Makefile

# Firmware-matching codegen flags for the EB objects, plus the bump-allocator
# override (force-included only into EB/port objects: the SDK bridge defines
# malloc itself).
EB_OBJECTS := $(addprefix $(BUILD_DIR)/,$(notdir $(CORE_C_SOURCES:.c=.o)))
EB_CFLAGS := \
-falign-functions -falign-jumps -fmerge-all-constants \
-include src/eb_alloc.h \
-Wno-parentheses -Wno-unknown-pragmas -Wno-incompatible-pointer-types \
-Wno-unused-const-variable -Wno-strict-aliasing -Wno-comment \
-Wno-unused-function -Wno-int-in-bool-context -Wno-unused-variable \
-Wno-unused-but-set-variable -Wno-implicit-function-declaration
$(EB_OBJECTS): CFLAGS += $(EB_CFLAGS)

# tamp + the savestate engine run once per save/load, not per frame: build for
# size to keep RAM_EMU headroom for the audio heap.
$(BUILD_DIR)/common.o \
$(BUILD_DIR)/compressor.o \
$(BUILD_DIR)/decompressor.o \
$(BUILD_DIR)/state_dump.o: OPT := -Os

# NB: -O3 on the lakesnes APU files doesn't fit: ~+4.5 KB of .text overflows
# the RAM_EMU audio-heap margin and trips the link assert in the .ld.

# Keep resolved relocations in the ELF so scripts/check_eb_rodata_relocs.py
# can find pointers inside .rodata_earthbound that target it (not relocated
# at runtime; such tables must be EB_NORELOC). Doesn't change the .bin.
LDFLAGS += -Wl,--emit-relocs

#######################################
# Asset generation (donor ROM → earthbound_assets.dat)
#######################################
EARTHBOUND_SFC ?= earthbound.sfc

# Committed, ROM-free: the asset ids, item/music enums, and the asset list
# that fixes the .dat layout (scripts/eb_assets.py).
EB_GEN_HEADERS := $(wildcard src/gen/*.h)
$(EB_OBJECTS): $(EB_GEN_HEADERS)

EARTHBOUND_GEN_HEADERS := \
	$(EARTHBOUND_GEN_DIR)/embedded_assets.h \
	$(EARTHBOUND_GEN_DIR)/asset_ids.h \
	$(EARTHBOUND_GEN_DIR)/embedded_assets_array.c \
	$(EARTHBOUND_GEN_DIR)/embedded_assets.inc.c \
	$(EARTHBOUND_GEN_DIR)/embedded_assets_decl.h
EARTHBOUND_HEADERS_EXTRA := \
	$(EARTHBOUND_GEN_DIR)/items_generated.h \
	$(EARTHBOUND_GEN_DIR)/music_generated.h

$(EARTHBOUND_GEN_DIR):
	$(V)mkdir -p $@

# Three-stage upstream asset pipeline:
#   1. ebtools extract        — donor ROM → asm/bin/{US,JP}/* + assets.manifest
#   2. ebtools pack-all       — src/assets JSON → packed_assets/ binary
#   3. ebtools embed-registry — packed + raw → embedded_assets_*.{c,h}
# Stage 1 is the submodule's `make unix-extract` (also sets up its .venv).
EARTHBOUND_ASSETS_MANIFEST := $(CORE_EARTHBOUND)/asm/bin/assets.manifest
EARTHBOUND_PACKED_DIR := $(EARTHBOUND_GEN_DIR)/packed_assets

$(EARTHBOUND_GEN_DIR)/items_generated.h: $(EARTHBOUND_ASSETS_MANIFEST) | $(EARTHBOUND_GEN_DIR)
	@echo "[ ebtools generate items-header ]"
	@cd $(CORE_EARTHBOUND) && . .venv/bin/activate && ebtools generate items-header \
		src/assets/items/items.json $(abspath $@)

$(EARTHBOUND_GEN_DIR)/music_generated.h: $(EARTHBOUND_ASSETS_MANIFEST) | $(EARTHBOUND_GEN_DIR)
	@echo "[ ebtools generate music-header ]"
	@cd $(CORE_EARTHBOUND) && . .venv/bin/activate && ebtools generate music-header \
		src/assets/music_tracks.json $(abspath $@)

# Upstream's unix-extract / unix-check-rom look for ./earthbound.sfc in the
# submodule root.
$(CORE_EARTHBOUND)/earthbound.sfc: $(EARTHBOUND_SFC)
	@ln -sf $(abspath $<) $@

# Families pack-all writes as decompressed .raw copies the C port reads in
# place; their .lzhal originals are excluded from the registry (mirrors
# external/earthbound/src/CMakeLists.txt).
EARTHBOUND_RAW_FAMILIES := maps/arrangements maps/gfx maps/anim_gfx maps/anim_pal battle_sprites

# Re-extract when earthbound.yml changes (a submodule bump can add assets);
# unix-extract skips extraction while the manifest exists, so drop it first.
$(EARTHBOUND_ASSETS_MANIFEST): $(CORE_EARTHBOUND)/earthbound.sfc $(CORE_EARTHBOUND)/earthbound.yml
	@echo "[ ebtools extract ] from $(EARTHBOUND_SFC)"
	@rm -f $@
	@$(MAKE) -C $(CORE_EARTHBOUND) unix-venv unix-extract

# A packer change can add or reshape packed files, so ebtools itself is a
# prerequisite too.
EARTHBOUND_EBTOOLS_PY := $(shell find $(CORE_EARTHBOUND)/ebtools -name '*.py' 2>/dev/null)

# Mirrors external/earthbound/src/CMakeLists.txt. pack-all also writes
# text_refs.h, the dialogue offsets the code compiles in; upstream commits it
# in src/data/, so it goes to the gen dir and `eb_assets.py check` compares
# the two (writing src/data/ would also race the compile under -j).
$(EARTHBOUND_GEN_HEADERS) &: $(EARTHBOUND_ASSETS_MANIFEST) $(CORE_EARTHBOUND)/commondefs.yml $(EARTHBOUND_EBTOOLS_PY) $(wildcard $(CORE_EARTHBOUND)/src/custom_assets/maps/*.json) Makefile | $(EARTHBOUND_GEN_DIR)
	@echo "[ ebtools pack-all ]"
	@cd $(CORE_EARTHBOUND) && . .venv/bin/activate && ebtools pack-all \
		src/assets $(abspath $(EARTHBOUND_PACKED_DIR)) \
		-b asm/bin -y earthbound.yml -c commondefs.yml \
		--text-refs-dir $(abspath $(EARTHBOUND_GEN_DIR)) \
		--custom-dir src/custom_assets
	@echo "[ ebtools embed-registry ]"
	@cd $(CORE_EARTHBOUND) && . .venv/bin/activate && ebtools embed-registry \
		asm/bin/assets.manifest asm/bin $(abspath $(EARTHBOUND_GEN_DIR)) src/vendor/incbin \
		--custom-dir $(abspath $(EARTHBOUND_PACKED_DIR)) \
		--locale US \
		--exclude "overworld_sprites/gfx/*" \
		--exclude "US/overworld_sprites/gfx/*" \
		--exclude "psianims/arrangements/*.arr.lzhal" \
		--exclude "data/EEVENT*.bin" \
		--exclude "data/EBATTLE*.bin" \
		--exclude "data/EGOODS*.bin" \
		--exclude "data/ESYSTEM.bin" \
		--exclude "data/EGLOBAL.bin" \
		--exclude "data/EHINT.bin" \
		--exclude "data/ENEWS.bin" \
		--exclude "data/ESHOP*.bin" \
		--exclude "data/EEXPL*.bin" \
		--exclude "data/EBGMESS.bin" \
		--exclude "data/EDEBUG.bin" \
		--exclude "data/KEYBOARD.bin" \
		--exclude "data/DEBUG_TEXT.bin" \
		--exclude "data/DOOR_SCRIPTS.bin" \
		--exclude "data/UNKNOWN_EFA2FA.bin" \
		--exclude "data/E0[1-9]*.bin" \
		--exclude "data/E1[0-9]*.bin" \
		--exclude "dialogue/addr_remap.bin" \
		--exclude "data/compressed_text_data.bin" \
		--exclude "data/compressed_text_ptrs.bin" \
		$(foreach f,$(EARTHBOUND_RAW_FAMILIES),--exclude "$(f)/*.lzhal" --exclude "US/$(f)/*.lzhal")

# The asset pack: ebtools' packed files in src/gen/eb_asset_list.txt order.
# `check` fails when the committed list no longer matches this submodule.
EB_ASSET_LIST := src/gen/eb_asset_list.txt
$(ASSETS_DAT): $(EARTHBOUND_GEN_HEADERS) $(EARTHBOUND_HEADERS_EXTRA) $(EB_ASSET_LIST) scripts/eb_assets.py
	$(V)$(ECHO) [ ASSETS ] $(ASSETS_DAT)
	$(V)python3 scripts/eb_assets.py check --gen-dir $(EARTHBOUND_GEN_DIR) \
		--eb-dir $(CORE_EARTHBOUND) --out-dir src/gen
	$(V)mkdir -p $(dir $@)
	$(V)python3 scripts/eb_assets.py pack --list $(EB_ASSET_LIST) \
		--packed-dir $(EARTHBOUND_PACKED_DIR) --bin-dir $(CORE_EARTHBOUND)/asm/bin \
		--out $@

# The browser converter's recipe (tools/converter/FORMAT.md): rebuilds the same
# .dat from a user's ROM. `generate` verifies it against eb_assets.py pack.
EB_RECIPE := tools/converter/recipe/eb_recipe.bin

.PHONY: assets gen-headers recipe
assets: $(ASSETS_DAT)

recipe: $(EARTHBOUND_GEN_HEADERS) $(EARTHBOUND_HEADERS_EXTRA) $(EB_ASSET_LIST)
	$(V)python3 scripts/eb_assets.py check --gen-dir $(EARTHBOUND_GEN_DIR) \
		--eb-dir $(CORE_EARTHBOUND) --out-dir src/gen
	$(V)$(CORE_EARTHBOUND)/.venv/bin/python scripts/eb_recipe.py generate \
		--rom $(EARTHBOUND_SFC) --list $(EB_ASSET_LIST) \
		--packed-dir $(EARTHBOUND_PACKED_DIR) --bin-dir $(CORE_EARTHBOUND)/asm/bin \
		--out $(EB_RECIPE)

gen-headers: $(EARTHBOUND_GEN_HEADERS) $(EARTHBOUND_HEADERS_EXTRA)
	$(V)python3 scripts/eb_assets.py gen-headers --gen-dir $(EARTHBOUND_GEN_DIR) \
		--eb-dir $(CORE_EARTHBOUND) --out-dir src/gen

#######################################
# Pack (+ extract .rodata_earthbound sidecar)
#######################################
PACK_HOMEBREW := $(GNW_CORE_SDK)/tools/pack_homebrew.py
TOOL_PREFIX := $(if $(GCC_PATH),$(GCC_PATH)/)$(PREFIX)

# gnw_core_meta_t / gwhb_meta_t store major.minor.patch; the packer extracts
# the leading vX.Y.Z from git describe (NOTAG → 0.0.0).
CORE_VERSION ?= $(shell git describe --tags --dirty 2>/dev/null || echo NOTAG)

COVER_JPG := $(BUILD_DIR)/cover.jpg
GEN_COVER := scripts/gen_homebrew_cover.py

# Stamp: the ELF has no rodata→rodata pointers (they aren't patched at
# runtime and fault on device; such tables must be EB_NORELOC).
RELOC_CHECK := $(BUILD_DIR)/rodata_relocs.ok

.PHONY: pack cover sdpush
cover: $(COVER_JPG)

# Must stay ≤ COVER_MAX (186x100) and COVER_SIZE (10 KiB).
$(COVER_JPG): $(GEN_COVER) | $(BUILD_DIR)
	$(V)$(ECHO) "[ COVER ] $(COVER_JPG)"
	$(V)python3 $(GEN_COVER) --out $(COVER_JPG) --title "$(HB_NAME)" --width 128 --height 96

$(RELOC_CHECK): $(TARGET_ELF) scripts/check_eb_rodata_relocs.py
	$(V)$(ECHO) [ CHECK ] rodata relocs
	$(V)python3 scripts/check_eb_rodata_relocs.py $(TOOL_PREFIX) $< || (rm -f $<; exit 1)
	$(V)touch $@

# The .ro carries a trailer listing every RAM_EMU word to relocate at boot
# (see scripts/append_eb_reloc_table.py), so it must always match the .bin.
$(RO_BIN): $(TARGET_ELF) $(RELOC_CHECK) scripts/append_eb_reloc_table.py
	$(V)$(ECHO) [ RO ] $(RO_BIN)
	$(V)mkdir -p $(dir $@)
	$(V)$(CP) -O binary --only-section=.rodata_earthbound $< $@
	$(V)python3 scripts/append_eb_reloc_table.py $(TOOL_PREFIX) $< $@ || (rm -f $@; exit 1)

pack: $(TARGET_BIN) $(RO_BIN) $(COVER_JPG) $(RELOC_CHECK)
	$(V)$(ECHO) [ PACK GWHB ] "$(PACKED_BIN)" version=$(CORE_VERSION)
	$(V)python3 $(PACK_HOMEBREW) \
		--elf $(TARGET_ELF) --bin $(TARGET_BIN) \
		--nm $(TOOL_PREFIX)nm \
		--name "$(HB_NAME)" --version "$(CORE_VERSION)" \
		--cover $(COVER_JPG) \
		--out "$(PACKED_BIN)"

all: pack

# The asset pack only when there's a ROM to build it from (CI has none).
ifneq ($(wildcard $(EARTHBOUND_SFC)),)
all: assets
endif

# Push the packed binary and its sidecars to the device's SD card.
GNWMANAGER ?= gnwmanager
sdpush: pack assets
	$(GNWMANAGER) \
		sdpush --file "$(PACKED_BIN)" --dest-path "/homebrews/" \
		-- sdpush --file "$(RO_BIN)" --dest-path "/homebrews/" \
		-- sdpush --file "$(ASSETS_DAT)" --dest-path "/homebrews/"

.PHONY: print-PROJECT_KIND print-PACKED_BIN print-SIDECARS print-ASSETS_DAT print-RO_BIN print-CORE_NAME \
	print-DOCKER_IMAGE print-TARGET_ELF print-TARGET_MAP print-CORE_VERSION
print-PROJECT_KIND:
	@echo $(PROJECT_KIND)
print-PACKED_BIN:
	@echo $(PACKED_BIN)
print-SIDECARS:
	@echo $(SIDECARS)
print-ASSETS_DAT:
	@echo $(ASSETS_DAT)
print-RO_BIN:
	@echo $(RO_BIN)
print-CORE_NAME:
	@echo $(CORE_NAME)
print-DOCKER_IMAGE:
	@echo $(DOCKER_IMAGE)
print-TARGET_ELF:
	@echo $(TARGET_ELF)
print-TARGET_MAP:
	@echo $(BUILD_DIR)/$(CORE_NAME)_core.map
print-CORE_VERSION:
	@echo $(CORE_VERSION)

clean::
	$(V)rm -f "$(PACKED_BIN)" $(RO_BIN) $(ASSETS_DAT)

#######################################
# Docker (same image as firmware repo)
#######################################
.PHONY: docker docker_pull docker_shell

RELEASE_VERSION ?= v1.5
DOCKER_REPOSITORY ?= sylverb/retro-go-sd-builder
DOCKER_IMAGE ?= $(DOCKER_REPOSITORY):$(RELEASE_VERSION)

DOCKER_TTY_FLAG := $(shell if [ -t 0 ]; then echo -it; else echo; fi)
# Host UID so build/ artifacts are not root-owned on the bind mount.
DOCKER_USER := $(shell id -u):$(shell id -g)
DOCKER_RUN := docker run --rm $(DOCKER_TTY_FLAG) \
	--user $(DOCKER_USER) \
	-v "$(CURDIR):/opt/workdir" \
	-w /opt/workdir \
	$(DOCKER_IMAGE)

docker:
	$(V)$(ECHO) "[ DOCKER ]" $(DOCKER_IMAGE)
	$(V)$(DOCKER_RUN) make --no-print-directory -j$$(nproc)

docker_pull:
	$(V)$(ECHO) "[ PULL ]" $(DOCKER_IMAGE)
	$(V)docker pull $(DOCKER_IMAGE)

docker_shell:
	$(DOCKER_RUN) bash
