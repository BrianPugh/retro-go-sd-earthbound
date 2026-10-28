# Changelog

Each release tag needs a section here with a matching heading (`## [vX.Y.Z] - YYYY-MM-DD`); CI uses its body as the GitHub Release notes.

## [v0.1.1] - 2026-10-28

### Fixed

- The [conversion page](https://brianpugh.github.io/retro-go-sd-earthbound/) failed on every run with "module produced [assets] but the manifest declares [earthbound_assets.dat]". It now produces `earthbound_assets.dat`.

The game itself is unchanged from v0.1.0, and so is `earthbound_assets.dat`: if you already built it with `make`, you don't need to convert again.

## [v0.1.0] - 2026-10-28

First release: EarthBound running natively on the Game & Watch as a Retro-Go SD homebrew, built from the [C reimplementation](https://github.com/BrianPugh/earthbound) (no SNES emulation).

### Requirements

- A Game & Watch with the SD-card mod, running Retro-Go SD firmware from the [`external_cores` branch](https://github.com/sylverb/game-and-watch-retro-go-sd/tree/external_cores).
- Your own US EarthBound ROM (SHA-1 `d67a8ef36ef616bc39306aa1b486e1bd3047815a`, no copier header) to make `earthbound_assets.dat`. No game data is included in this release.

### Installing

Turn your ROM into `earthbound_assets.dat` with the [conversion page](https://brianpugh.github.io/retro-go-sd-earthbound/) (it runs in your browser; the ROM never leaves your computer), or with any installer that follows [gwrg-dist-spec](https://github.com/slash-proc/gwrg-dist-spec). Copy `EarthBound.bin`, `earthbound.ro` and `earthbound_assets.dat` to `/homebrews/` on the SD card. The 3 files must come from the same release.

### Features

- The full game, with in-game saves (call Dad) written straight to the SD card.
- Savestates from the PAUSE/SET menu, and the launcher can start the game from any savestate slot.
- POWER saves a savestate and sleeps; the save is written before sleeping, so it also survives a flat battery.
- Music and sound effects at the correct tempo, even when busy scenes run below 60 fps.
- TIME toggles a frame-rate overlay.

### Known limitations

- Busy scenes (many sprites, large battle backgrounds) run slower than the original.
- A savestate can't be taken while a text box is waiting for a button press ("SAVESTATE FAIL"); press through the text and try again.
