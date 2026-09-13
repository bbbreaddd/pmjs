# PMJS: Native Runtime for RPG Maker MV/MZ

Run RPG Maker MV/MZ games natively on Linux handhelds without without NW.js or a browser. PMJS runs the game's original JavaScript through Node/V8 while native C++ handles rendering, audio, input, canvas operations, and storage.

RPG Maker MV games are essentially web-games, which means to run it, you have to run an entire browser. Low-end handhelds like the RG35XX Plus have a lot of limitations like 1GB of RAM, a really slow CPU, and an SD card for I/O. Not a great combination.
PMJS replaces the browser side with the small set of APIs these games need. There is no DOM layout engine and no JavaScript renderer.


PMJS is experimental and still has a lot of work to be done before I consider it usable. Currently, I'm focusing on getting it to work properly with OMORI on the RG35XX Plus.


## Requirements

PMJS supports Linux x64 and ARM64. Building it requires:

- CMake 3.20 or newer
- A C++20 compiler
- Node.js and Node API headers
- pkg-config
- SDL2, EGL, and OpenGL ES 2
- libpng, libjpeg, and FreeType
- FFmpeg libraries: avformat, avcodec, avutil, swresample, and swscale

## Building

```sh
cmake -S . -B build -DCMAKE_BUILD_TYPE=Release
cmake --build build --parallel
ctest --test-dir build --output-on-failure
```

`PMJS_DEPENDENCY_PREFIX` may point CMake at a target dependency prefix for
cross-compilation. `build-node-addon.sh` runs the same configure, build, and
test flow.

## Running PMJS

First build a bootstrap bundle from a manifest:

```sh
node tools/build-js-runtime.mjs --root . \
  --manifest example/runtime-bundle.json \
  --output build-js/smoke.js
```

Then start the runner:

```sh
node runner/cli.cjs \
  --addon build/pmjs_native.node \
  --game-root /path/to/game \
  --bootstrap build-js/smoke.js \
  --save-root /path/to/saves \
  --width 640 \
  --height 480 \
  --title "My game"
```

`--asset-root PATH` is optional. Programs may also import `run(options,
{ afterBootstrap })` from `runner/index.cjs`.

Runtime settings use the `PMJS_*` prefix. Renderer statistics, operation
tracing, GPU profiling, and verbose compatibility diagnostics are opt-in and
silent by default.

JavaScript bundles load `pmjs-web`, then `pmjs-pixi4`, then `pmjs-mv`. Ports
provide `PMJS_GAME_CONFIG` before these layers and load game-specific adapters
afterward. Manifest order is part of the bundle interface.

Reusable integrations for third-party RPG Maker plugin families live under
`js/pmjs-plugins/<family>/`. Ports include only the families used by their game,
after both the plugin scripts and the relevant PMJS compatibility layer have
loaded. Game-specific configuration and assets remain in the port adapter.

Platform provisioning and game-specific adapters live outside this reusable
source tree.

### Third-party software

PMJS uses the following software

- [Node.js](https://nodejs.org/) and [V8](https://v8.dev/) to execute game JavaScript
- [SDL2](https://www.libsdl.org/) for windows, input, and platform integration
- [EGL and OpenGL ES](https://www.khronos.org/opengles/) for native rendering
- [libpng](http://www.libpng.org/pub/png/libpng.html) for PNG images
- [libjpeg](https://ijg.org/) for JPEG images
- [FreeType](https://freetype.org/) for font rendering
- [FFmpeg](https://ffmpeg.org/) for audio and video decoding

The build and test workflow uses CMake, pkg-config, ESLint, and Xvfb.
