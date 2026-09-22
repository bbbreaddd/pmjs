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

`PMJS_DEPENDENCY_PREFIX` points CMake at a reviewed target dependency prefix
for cross-compilation. When set, pkg-config resolves only from that prefix's
`lib/pkgconfig` and `share/pkgconfig` directories; missing target dependencies
fail configuration instead of falling back to host libraries. Prefix builds
also require `PMJS_DEPENDENCY_LOCK`, a CMake file declaring exact versions as
`set(PMJS_LOCK_SDL2 2.30.0)`, `set(PMJS_LOCK_EGL 1.5)`, and corresponding
`PMJS_LOCK_*` values for GLES, PNG, JPEG, FREETYPE, AVFORMAT, AVCODEC,
AVUTIL, SWRESAMPLE, and SWSCALE. CMake prints the resolved versions and
rejects a mismatch. Keep the reviewed prefix contents fixed across builds
whose results you compare, and use a fresh CMake build directory when changing
prefixes. `build-node-addon.sh` runs the same configure,
build, and test flow.

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
