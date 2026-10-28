# EarthBound for the Game & Watch

Play EarthBound on a modded Nintendo Game & Watch running [Retro-Go SD](https://github.com/sylverb/game-and-watch-retro-go-sd).

This is not an emulator running the SNES cartridge. It's a [native C reimplementation of EarthBound](https://github.com/BrianPugh/earthbound), built as a Retro-Go SD **homebrew**: you build 2 files on your computer, copy them to the Game & Watch's SD card, and EarthBound shows up in the launcher's Homebrew tab.

No game data is included in this repository. You need your own copy of the US EarthBound ROM, and the build extracts the graphics, music and text from it.

## What you need

**Hardware**

- A Game & Watch (Mario or Zelda) with the SD-card mod, running Retro-Go SD firmware built from the [`external_cores` branch](https://github.com/sylverb/game-and-watch-retro-go-sd/tree/external_cores). Older firmware can't load homebrews like this one.
- A way to get files onto its SD card: either a card reader, or a debug probe (ST-Link, J-Link or a Raspberry Pi Pico) with [gnwmanager](https://github.com/BrianPugh/gnwmanager).

**A ROM**

- A US EarthBound ROM (`.sfc` or `.smc`, with or without the 512-byte copier header). Dump it from a cartridge you own.

**Software** (macOS or Linux; on Windows, use [WSL](https://learn.microsoft.com/windows/wsl/install))

- `git` and `make`
- Python 3.10 or newer
- The Arm GNU Toolchain (`arm-none-eabi-gcc`). Download the "AArch32 bare-metal target (arm-none-eabi)" build for your system from [Arm's download page](https://developer.arm.com/downloads/-/arm-gnu-toolchain-downloads). Version 15.3.Rel2 is known to work.

You can check the toolchain is installed with:

```bash
arm-none-eabi-gcc --version
```

If that says "command not found", either add the toolchain's `bin` folder to your `PATH`, or pass its location to `make` with `GCC_PATH=...` (shown below).

## Building

### 1. Get the code

```bash
git clone --recurse-submodules https://github.com/BrianPugh/retro-go-sd-earthbound.git
cd retro-go-sd-earthbound
```

`--recurse-submodules` matters: the EarthBound code itself lives in a separate repository under `external/earthbound`. If you already cloned without it, run:

```bash
git submodule update --init --recursive
```

### 2. Install the Python packages

```bash
python3 -m pip install -r requirements.txt
```

### 3. Add your ROM

Copy your ROM into the repository folder and name it `earthbound.sfc`:

```bash
cp /path/to/your/EarthBound.sfc ./earthbound.sfc
```

Or leave it where it is and pass `EARTHBOUND_SFC=/path/to/your/EarthBound.sfc` to every `make` command below.

### 4. Build

```bash
make -j8
```

If `arm-none-eabi-gcc` isn't on your `PATH`, point `make` at it. On macOS with the default install location, that looks like:

```bash
make -j8 GCC_PATH=/Applications/ArmGNUToolchain/15.3.rel2/arm-none-eabi/bin
```

The first build takes a few minutes: it sets up a private Python environment and extracts the game's assets from your ROM. Later builds are much faster.

When it finishes you'll have 2 new files in the repository folder:

| File | Size | What it is |
| --- | --- | --- |
| `EarthBound.bin` | ~370 KB | The game's code |
| `earthbound.ro` | ~3.8 MB | Game data extracted from your ROM, plus data the code needs to start up |

**The 2 files are a matched pair.** Always copy both from the same build. An `EarthBound.bin` paired with an `earthbound.ro` from a different build will crash at launch.

## Installing

Both files go in the `/homebrews/` folder at the root of the SD card.

**With a card reader:** power the Game & Watch off, take out the SD card, put it in your computer, create a `homebrews` folder at the top level if there isn't one, and copy `EarthBound.bin` and `earthbound.ro` into it.

**With a debug probe and gnwmanager:** plug the Game & Watch in and run:

```bash
make sdpush
```

(Add the same `GCC_PATH=...` you used for building.)

Then on the Game & Watch, open the launcher, go to the **Homebrew** tab and pick **EarthBound**.

## Playing

### Controls

| Game & Watch | EarthBound |
| --- | --- |
| D-pad | Move |
| A | Talk / check, confirm, advance text |
| B | Open the command menu (Goods, PSI, Equip, ...); cancel / back |
| GAME | Town map |
| TIME | Show/hide the performance overlay |
| PAUSE/SET | Retro-Go menu (savestates, volume, brightness, quit) |
| POWER | Save and sleep |

### Saving

There are 3 independent ways your progress is kept:

- **In-game saves** (call Dad from a phone, as in the original) are written straight to the SD card.
- **Savestates** from the PAUSE/SET menu snapshot the game at any moment, like an emulator's savestates. Most moments work. While a text box is waiting for you to press a button, a savestate can't be taken, and a "SAVESTATE FAIL" notice appears instead; press through the text and try again.
- **POWER** saves a savestate and puts the Game & Watch to sleep. Press POWER again to wake up right where you were. The save is written to the SD card before the device sleeps, so it also survives the battery running flat: the next time the Game & Watch powers on, it resumes from that save.

### Performance

Quiet scenes run at the original's 60 fps. Busy scenes (lots of sprites, big battle backgrounds) run slower than the original; the game slows down a little there while the music keeps playing at the correct tempo. Press TIME to see the frame rate.

## Troubleshooting

**"EarthBound ROM not found" during the build.** The build couldn't find `earthbound.sfc` in the repository folder. Check the file name (all lowercase, `.sfc`), or pass `EARTHBOUND_SFC=/full/path/to/rom.sfc`.

**"arm-none-eabi-gcc: command not found" or "No such file or directory" mentioning `arm-none-eabi`.** The toolchain isn't installed or isn't on your `PATH`; see step 4.

**`external/earthbound` is empty, or the build complains about missing files in it.** The submodule wasn't downloaded: run `git submodule update --init --recursive`.

**A blue error screen (BSOD) right after launching EarthBound.** Most often `EarthBound.bin` and `earthbound.ro` come from different builds. Copy both again from the same build.

**A blue error screen saying "unable to open logo file" when the Game & Watch starts.** That's the firmware, before EarthBound runs: it was flashed without its SD-card files. Re-flash the firmware with `make flash_sd` (in the firmware repository) instead of `make flash`.

**EarthBound doesn't appear in the Homebrew tab.** Check that both files are in `/homebrews/` (with an `s`), and that your firmware is from the `external_cores` branch.

**The launcher refuses to start EarthBound** (for example with an ABI or version error). EarthBound needs a newer Retro-Go SD build than the one installed. Update the firmware from the `external_cores` branch.

## Sharing

Please don't share `earthbound.ro`, or a ROM. It contains data extracted from the game, which is why each person builds their own from their own ROM. Sharing links to this repository is fine.

## For developers

`CLAUDE.md` has the technical notes: how the build packs the game into the Game & Watch's memory, the rules for the `earthbound.ro` data file, debugging and profiling tips, and how to update the vendored Retro-Go SD SDK under `sdk/`.

## Credits

- [EarthBound C port and disassembly](https://github.com/BrianPugh/earthbound), which does the real work of running the game.
- [Retro-Go SD](https://github.com/sylverb/game-and-watch-retro-go-sd) by sylverb and contributors: the Game & Watch firmware, launcher and homebrew SDK this builds on.
- EarthBound is © Nintendo / APE / HAL Laboratory. This project is not affiliated with or endorsed by Nintendo.
