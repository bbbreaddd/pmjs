# PMJS: Native Runtime for RPG Maker MV/MZ

Run RPG Maker MV/MZ games natively on Linux handhelds without NW.js or a browser. PMJS runs the game's original JavaScript through Node/V8 while native C++ handles rendering, audio, input, canvas operations, and storage.

RPG Maker MV games are essentially web-games, which means to run it, you have to run an entire browser. Low-end handhelds like the RG35XX Plus have a lot of limitations like 1GB of RAM, a really slow CPU, and an SD card for I/O. Not a great combination.
PMJS replaces the browser side with the small set of APIs these games need. There is no DOM layout engine and no JavaScript renderer.


PMJS is experimental and still has a lot of work to be done before I consider it usable. Currently, I'm focusing on getting it to work properly with OMORI on the RG35XX Plus.


## Requirements

- CMake 3.20 or newer
- A C++20 compiler
- Node.js and Node API headers
- pkg-config
- Git and Python 3
- Default x64 Skia65 build: Clang/LLVM 20.1.2 (`clang-20`, `clang++-20`, `llvm-ar-20`, `llvm-strip-20`)
- ARM64 Skia65 build: `PMJS_SKIA65_ARM64_SDK` pointing to the prepared Zig 0.15.2 SDK, plus `llvm-strip-20` 20.1.2
- SDL2, EGL, and OpenGL ES 3.0 or newer
- libpng, zlib, libjpeg, FreeType, and HarfBuzz
- FFmpeg libraries: avformat, avcodec, avutil, swresample, and swscale

> [!NOTE]
> I do use AI for this project. No, I am not proud of it. It's still very early in development so it's likely going to be a mess. Don't expect much right now.

### Third-party software

PMJS uses the following software

- [Node.js](https://nodejs.org/) and [V8](https://v8.dev/) to execute game JavaScript
- [SDL2](https://www.libsdl.org/) for windows, input, and platform integration
- [EGL and OpenGL ES](https://www.khronos.org/opengles/) for native rendering
- [libpng](http://www.libpng.org/pub/png/libpng.html) and zlib for PNG images
- [libjpeg](https://ijg.org/) for JPEG images
- [FreeType](https://freetype.org/) for glyph rasterization
- [HarfBuzz](https://harfbuzz.github.io/) for text shaping
- [FFmpeg](https://ffmpeg.org/) for audio and video decoding
- [Effekseer](https://effekseer.github.io/) for RPG Maker MZ animation effects
- [Skia](https://skia.org/) and [ICU](https://icu.unicode.org/), with private FreeType/HarfBuzz builds, for the Skia65 text component

The build and test workflow uses CMake, pkg-config, ESLint, and Xvfb.

## Images and preparation caches

PNG, JPEG and flattened PSD images are decoded by content through file and byte
loading. FFmpeg must include its PSD decoder. Encoded inputs are limited to
64 MiB; logical RGBA allocations to 128 MiB and 8,192 pixels per dimension.
PNG recovery requires valid chunk checksums and complete bounded pixel data;
it repairs a fixed prefix or zlib checksum without accepting truncated streams.

Released path-backed images use a budgeted warm cache only after their last
reference, pin and in-flight use ends. It also limits retention to 256 entries
and 128 unique captured files; a zero-byte budget evicts lazy entries as well.
Prepared map views share page and snapshot owners independently of the catalog,
so replacing a catalog does not invalidate retained images. Unsupported regions
use ordinary pixels. Temporary CPU snapshots expire after 60 unused frames.
Tile preparation has a 64 MiB working-buffer budget and admits at most 8,192
regions; unsupported or oversized demand uses ordinary loading.

Map preparation is enabled by default; disable it with `--map-preparation off`
or `assetPreparation.maps: false`. Cache manifests validate content hashes,
layouts and page headers; locks and leases protect publication and live users.
An atomic `verified-files.json` receipt reuses hashes and validated JSON when
file device, inode, size and timestamps are unchanged. Compiled map demand is
reused only when its engine, enabled plugins, map definitions, system settings,
tileset data, viewport and compiler/processor versions still match.
Damaged caches regenerate without changing saves.

`assetPreparation.verifyHashes: true` forces every source and output to be
hashed again. The default is `false`: metadata reuse can miss silent corruption
or same-size edits that preserve timestamps, particularly on FAT/exFAT.
Validation statistics separate hashed files/bytes, reused hashes and reused JSON;
map results additionally expose compilation hits.

Measure preparation without starting guest JavaScript:

```sh
SDL_VIDEODRIVER=offscreen SDL_AUDIODRIVER=dummy node tools/benchmark-asset-preparation.cjs \
  build/pmjs_native.node /path/to/game /path/to/cache /path/to/report.json /path/to/config.json
```

Use normal SDL drivers on a handheld. A fresh cache measures generation; repeat
with the same cache for validation/reuse. Enable `assetPreparation.maps` in the
configuration to include maps, and compare `verifyHashes` settings with identical
inputs. Reports separate image/map time and include CPU, memory, source hashes,
layouts and warnings. Native initialization, progress display and guest startup
are outside the measured interval. Disposable entry manifests need no individual
flush; locks, leases and published indexes retain their filesystem flushes.

## Rendering controls and reference fixtures

`mz.menu-background-cache` reuses the filtered result of an eligible static,
full-screen menu snapshot. It defaults to enabled, preserves the original bitmap,
sprite and filters, and owns only its derived premultiplied image. Pixel revisions,
texture, opacity and blur changes invalidate it. Unsupported state and snapshot
allocation failure use ordinary rendering; offscreen rendering bypasses it.
Renderer destruction or leaving an eligible menu releases the derived image.
Include its name in `disableOptimizations` to compare ordinary rendering.

Detailed graphics and tile-use counters require `PMJS_GRAPHICS_DIAGNOSTICS=1`.
Allocation accounting remains active regardless of this setting.

The Canvas regression fixture is generated from byte-pinned NW.js 0.29.0 /
Chromium 65.0.3325.146. Its generator accepts an executable, a driver module
exporting `launchMvReference(options)` and an output file. The driver supplies
`page.evaluate`, `page.addScriptTag` and `close`, and honors
`PMJS_MV_REFERENCE_EXECUTABLE` and the requested CPU Canvas backend.

```sh
xvfb-run -a node tools/generate-canvas-regressions-reference.cjs \
  /path/to/nw /path/to/driver.cjs /path/to/reference.json.gz
```

Generation checks pinned runtime files and versions, uses the bundled test font,
and requires identical frozen captures in two fresh processes. The artifact
records runtime, driver, generator, scenario/readback, font and capture identities;
regression tests reject stale provenance.
