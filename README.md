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

First build a bootstrap bundle from a manifest

```sh
# Standard RPG Maker MV runtime bundle:
node tools/build-js-runtime.mjs \
  --profile mv \
  --output build-js/mv-core-bootstrap.js

# Or minimal renderer smoke test:
node tools/build-js-runtime.mjs \
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

## Porting an RPG Maker MV Game

In PMJS, **capabilities belong to the runtime and policy belongs to the port**.
The supported native runtime handles physical frame pacing, FreeType font
rendering, WebGL/Pixi rendering, audio playback, storage persistence, and
two-pass plugin initialization.

> A port must not enumerate internal runtime modules.
> Runtime module composition belongs to PMJS profiles (`profiles/mv.json`).

Most RPG Maker MV games require **zero custom runtime JavaScript**. A port
consists of:

1. **Game Configuration (`config.json`)** — Declarative game policy (title, display, fonts).
2. **Platform Launcher (`run.sh`)** — Packaging script that builds the profile bundle and starts the runner.
3. *(Optional)* **Game Compatibility (`compat.js`)** — Only needed if the game relies on engine-specific quirks that PMJS does not yet provide generically.

### 1. Game Configuration (`config.json`)

Declare game-specific metadata and font mappings before the runtime initializes.
Configuration is pure data. See [`example/config.json`](example/config.json) for the template:

```json
{
  "title": "My Game",
  "display": {
    "width": 816,
    "height": 624
  },
  "fonts": {
    "GameFont": "fonts/mplus-1m-regular.ttf"
  }
}
```

All other runtime knobs (texture cache budgets, title scenes, NW.js version emulation)
provide sensible defaults and can be omitted unless tuning for specific constraints.

### 2. Platform Launcher (`run.sh`)

Assemble the standard MV runtime bundle using `--profile mv` and launch the native runner:

```sh
#!/usr/bin/env bash
set -euo pipefail

PORT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
RUNTIME_DIR="${PORT_DIR}/../native-runtime" # Path to PMJS runtime

BOOTSTRAP_OUTPUT="${PORT_DIR}/build/bootstrap.js"
mkdir -p "$(dirname "$BOOTSTRAP_OUTPUT")" "${PORT_DIR}/saves"

# 1. Build the bootstrap bundle from the canonical MV profile + declarative config
node "$RUNTIME_DIR/tools/build-js-runtime.mjs" \
  --profile mv \
  --config "$PORT_DIR/config.json" \
  --output "$BOOTSTRAP_OUTPUT"

# 2. Launch the native engine (resolution and title resolve from config.json or package.json)
node "$RUNTIME_DIR/runner/cli.cjs" \
  --addon "$RUNTIME_DIR/build/pmjs_native.node" \
  --game-root "${PORT_DIR}/gamedata" \
  --bootstrap "$BOOTSTRAP_OUTPUT" \
  --save-root "${PORT_DIR}/saves" \
  --config "$PORT_DIR/config.json"
```

See [`example/run-game.sh`](example/run-game.sh) for the reference launcher.

### 3. Optional Compatibility Code (`compat.js`)

If a game requires custom patches, pass `--compat "$PORT_DIR/compat.js"` to the builder.
Instead of relying on fragile file ordering, `compat.js` registers explicit lifecycle hooks:

```js
globalThis.PMJS_PORT_HOOKS = {
  beforePlugins() {
    // Executes before game plugins are evaluated
  },
  afterPlugins() {
    // Executes after game plugins have loaded (e.g. patch plugin constructors)
  },
  beforeBoot() {
    // Executes in window.onload immediately before SceneManager.run(Scene_Boot)
  }
};
```

---

## Runtime Profiles & Architecture

PMJS defines canonical module orderings in `profiles/`:
- `profiles/mv.json`: Standard RPG Maker MV runtime composition (`pmjs-web`, `pmjs-pixi4`, `pmjs-mv`).

When extending the runtime for a new engine family or custom bundle, manifests can extend a base profile:

```json
{
  "extends": "mv",
  "prepend": ["my-early-init.js"],
  "append": ["my-custom-addon.js"]
}
```

### Per-optimization controls

PMJS optimizations are enabled by default. Ports may disable specific
optimizations when needed for compatibility:

```json
{
  "disableOptimizations": [
    "scene.graphics-cache"
  ]
}
```

> [!NOTE]
> I do use AI for this project. No, I am not proud of it. It's still very early in development so it's likely going to be a mess. Don't expect much right now.

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
