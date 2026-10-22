# Building PMJS
(Written by AI. Not finalized yet)


On Linux, from the PMJS source directory:

```sh
./build.sh
```

This builds a local development runtime in `build/local` and installs it at
`dist/pmjs`. The last line prints the path to `bin/pmjs`. Try it with a game:

```sh
dist/pmjs/bin/pmjs /path/to/game
```

PMJS accepts either the game's engine directory or an installation containing
`www/`. The local build uses FreeType and your system Node. The command checks
an existing installation before replacing it and keeps it if a build fails.

## Requirements

You need Linux, a C++20 compiler, CMake 3.20 or newer, Ninja, pkg-config,
Node.js with Node-API 8 or newer and development headers, Git, and Python 3.12
or newer. The native libraries are SDL2, EGL, OpenGL ES, libpng, libwebp, zlib,
libjpeg, FreeType, HarfBuzz, and FFmpeg's avformat, avcodec, avutil, swresample,
and swscale libraries.

On Ubuntu 24.04, install the system packages first:

```sh
sudo apt-get install build-essential cmake ninja-build pkg-config git python3 \
  nodejs libnode-dev libsdl2-dev libegl1-mesa-dev libgles2-mesa-dev \
  libpng-dev libwebp-dev zlib1g-dev libjpeg-dev libfreetype-dev libharfbuzz-dev \
  libavformat-dev libavcodec-dev libavutil-dev libswresample-dev libswscale-dev
```

`build.sh` reports missing build tools but does not install system packages.
Prepare ARM64 dependencies separately as shown below.

## x64 release build

The public `./build.sh` command makes a FreeType development installation.
For an x64 release candidate with Skia65, install Clang/LLVM 20.1.2
(`clang-20`, `clang++-20`, `llvm-ar-20`, and `llvm-strip-20`), then:

```sh
export PMJS_SKIA65_COMPONENT_DIR="$PWD/.cache/components/x64"
python3 tools/skia65/build.py --arch x64 --output "$PMJS_SKIA65_COMPONENT_DIR" --reuse
cmake --preset release-x64
cmake --build --preset release-x64 --target pmjs_native --parallel 4
python3 tools/release.py stage --build build/release-x64 --output dist/stage-x64
```

Use an empty destination for `release.py stage`. Skia65 is checked and
reused on later builds.

## ARM64 handheld build

On an x86-64 Linux host:

```sh
python3 tools/dependencies.py --jobs 4
./build.sh --target arm64
```

The installation goes to `dist/pmjs-arm64`. Dependency preparation provides the
pinned SDK, Node, Effekseer, LZ4 and Skia65, reusing verified caches. The build
command builds only ARM64; run `./build.sh` separately for the local host runtime
used to make game bundles.

LZ4 1.10.0 is built statically from the archive pinned in `tools/lz4.lock.json`.
Only the standard block codec is compiled. For offline CMake builds, set
`PMJS_LZ4_ARCHIVE` to the matching archive; `tools/dependencies.py` prepares it
for ARM64. Local online builds can fetch the pinned archive during configuration.

The ASTC encoder is built statically from version 4.7.0 pinned in
`tools/astcenc.lock.json`, using SSE2 on x64 and NEON on ARM64. Offline builds
accept `PMJS_ASTCENC_ARCHIVE`; dependency preparation downloads and verifies
this archive for ARM64. No encoder command-line executable is required at runtime.

The host also needs Make, `dpkg-deb`, `readelf`, and Clang/LLVM 20.1.2:
`clang-20`, `clang++-20`, `llvm-ar-20`, and `llvm-strip-20`.
The target needs glibc 2.28 or newer and working SDL2, EGL, and GLES 3
libraries from its firmware.
Keep `.cache/linux-arm64/downloads` for the separate dependency source archive.
ARM64 installations exclude documentation, source materials and host tools.

Use `--jobs N` to set parallel build jobs and `--output DIR` to choose an
installation directory. An existing output must have PMJS metadata and essential
entry points; unrelated directories are rejected.

## Tests and release work

For native tests, install Xvfb and xauth, then run:

```sh
cmake --preset dev
cmake --build --preset dev --parallel 4
ctest --preset dev --output-on-failure
```

The JavaScript checks run separately:

```sh
npm ci
npm run lint
npm run licensing
npm test
python3 test/portmaster-package.py
```

`./build.sh` makes a runnable installation. A public release also needs
the verification and device checks in [Releases](releases.md).
See [Using PMJS](using.md) to run a game and [Porting a game](porting.md) to
make a bundle or PortMaster ZIP.
