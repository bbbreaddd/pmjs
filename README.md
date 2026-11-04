# PMJS

A native runtime for RPG Maker MV/MZ games

This project started because I wanted to run In Stars and Time on my RG35XX Plus, but there didn't seem to be any easy way to do it. I started trying to get Electron working on it, but Electron sucked so I just made my own runtime that runs it natively, without a browser.

PMJS runs the game's original JavaScript through Node.js, including its engine and plugins. Native code handles rendering, audio, input, and other work that would normally go through the browser. Compatibility layers connect the two, with patches where a game needs them. The aim is to preserve the game's logic and behavior while making it practical to run on low-end hardware.

[Building](docs/BUILDING.md) · [Releases](https://github.com/bbbreaddd/pmjs/releases)

## Run a game

On the target device, run from the copied runtime directory:

```sh
./bin/pmjs /path/to/game
```

## Contribution

The native host lives in `src/`. JavaScript compatibility layers live in `js/`. Startup and process management live in `runner/`.

Run the JavaScript tests with:

```sh
npm test
```

For native and rendering tests, use a local Linux development build. You need a C++20 compiler, Node.js with Node-API 8 or newer headers, Xvfb, and development libraries for SDL2, EGL, OpenGL ES, libpng, libwebp, zlib, libjpeg, FreeType, HarfBuzz, and FFmpeg (avformat, avcodec, avutil, swresample, and swscale).

```sh
cmake --preset dev
cmake --build --preset dev
ctest --preset dev
```

## Compatibility

The MV reference is stock RPG Maker MV 1.6.2, PixiJS 4.5.4 and NW.js 0.29.0, which includes Chromium 65.0.3325.146 and Node.js 9.7.1.

The MZ reference is stock RPG Maker MZ 1.10.0, PixiJS 5.3.12 and NW.js 0.48.4, which includes Chromium 85.0.4183.121 and Node.js 14.12.0.

These references guide compatibility work. Some RPG Maker MV/MZ games use different versions so behavior might not be exactly the same, but a majority of the time, it's *very* tiny differences that don't affect the experience.

## License

See [LICENSE](LICENSE) and [third-party notices](THIRD_PARTY_NOTICES.md).

AI is used to develop this project
