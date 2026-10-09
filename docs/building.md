# Building PMJS

Build on Linux. Run the commands below from the repository root.

## Requirements

- A C++20 compiler
- CMake 3.20+, Ninja and pkg-config
- Node.js with Node-API 8+ and its development headers
- Git and Python 3.12+

On Ubuntu 24.04:

```sh
sudo apt-get install build-essential cmake ninja-build pkg-config git python3 \
  libnode-dev libsdl2-dev libegl1-mesa-dev libgles2-mesa-dev libpng-dev \
  zlib1g-dev libjpeg-dev libfreetype-dev libharfbuzz-dev \
  libavformat-dev libavcodec-dev libavutil-dev libswresample-dev libswscale-dev
```

## Get the source

```sh
git clone https://github.com/bbbreaddd/pmjs.git
cd pmjs
```

## Build

The development build uses FreeType for text rendering.

```sh
cmake --preset dev -DBUILD_TESTING=OFF
cmake --build --preset dev --target pmjs_native --parallel 4
```

The addon is written to `build/dev/pmjs_native.node`.

## Tests

Native tests need Xvfb. Enable tests and build their executables:

```sh
sudo apt-get install xvfb xauth
cmake --preset dev
cmake --build --preset dev --parallel 4
ctest --preset dev --output-on-failure
```

Run the JavaScript checks separately:

```sh
npm ci
npm run lint
npm run licensing
npm test
```

## x64 release build

Release builds use Skia65. Install Clang/LLVM 20.1.2, including `clang-20`,
`clang++-20`, `llvm-ar-20` and `llvm-strip-20`, then build the component:

```sh
export PMJS_SKIA65_COMPONENT_DIR="$PWD/.cache/components/x64"
python3 tools/skia65/build.py --arch x64 --output "$PMJS_SKIA65_COMPONENT_DIR" --reuse
cmake --preset release-x64
cmake --build --preset release-x64 --target pmjs_native --parallel 4
```

Skia65 is reused on later builds.

## Cross-compile for Linux ARM64

Use an x86-64 Linux host with curl, Make, `dpkg-deb`, `readelf` and LLVM strip 20.1.2.
The target needs glibc 2.28 or newer and its own SDL2, EGL and GLES 3 libraries.

Prepare the SDK, Node, Effekseer and Skia65, then build:

```sh
export PMJS_SDK_ROOT="$PWD/.cache/linux-arm64/sdk"
export PMJS_NODE_ROOT="$PWD/.cache/linux-arm64/node"
export PMJS_EFFEKSEER_ARCHIVE="$PWD/.cache/effekseer/source.tar.gz"
export PMJS_SKIA65_COMPONENT_DIR="$PWD/.cache/components/arm64"

python3 tools/linux-arm64/prepare-sdk.py --sdk "$PMJS_SDK_ROOT" --jobs 4
python3 tools/linux-arm64/prepare-node.py --output "$PMJS_NODE_ROOT"
mkdir -p .cache/effekseer
curl --fail --location "$(python3 -c 'import json; print(json.load(open("tools/effekseer.lock.json"))["url"])')" \
  --output "$PMJS_EFFEKSEER_ARCHIVE"
python3 tools/skia65/build.py --arch arm64 --sdk "$PMJS_SDK_ROOT" \
  --output "$PMJS_SKIA65_COMPONENT_DIR" --reuse

cmake --preset release-linux-arm64
cmake --build --preset release-linux-arm64 --target pmjs_native --parallel 4
```

Preparation downloads pinned dependencies. Later builds reuse them.
CMake verifies the Effekseer archive, extracts it and applies the patch for both
online and offline builds.
Keep `.cache/linux-arm64/downloads`; installation includes dependency sources.
If you change SDK build behavior, increase `revision` in
`tools/linux-arm64/sdk-recipes.json`.

## Install

Install a release build into an empty directory:

```sh
python3 tools/release.py stage --build build/release-linux-arm64 --output dist/pmjs
```

For x64, use `--build build/release-x64`.
See [using PMJS](using.md) to run a game and [releases](releases.md) to verify
or package an installation.
