# Using PMJS

Check the archive checksum, then unpack it:

```sh
sha256sum -c pmjs-linux-arm64.tar.gz.sha256
tar -xzf pmjs-linux-arm64.tar.gz
```

## Run a game

Use a game directory containing its original MV/MZ engine and plugin scripts:

```sh
./pmjs-linux-arm64/bin/pmjs --version
./pmjs-linux-arm64/bin/pmjs self-test
./pmjs-linux-arm64/bin/pmjs prepare --game /path/to/game
./pmjs-linux-arm64/bin/pmjs run --game /path/to/game
```

Preparation creates a bootstrap in your cache and leaves the game files unchanged.
Prepare again after changing game scripts, plugins, configuration or the runtime.
Running uses the prepared bootstrap.

Only run games you trust. Game and plugin scripts have access to Node APIs. PMJS does not sandbox them.

## Configuration and saves

- `prepare --config FILE`: load runtime configuration.
- `prepare --manifest FILE`: select plugin adapters through a manifest.
- `--state DIR`: choose the preparation directory. Use it for both `prepare` and `run`.
- `run --save-root DIR`: choose a save directory, including an existing one.

Prepared files default to `XDG_CACHE_HOME`; saves default to `XDG_DATA_HOME`,
with a separate directory for each game. If unset, these use `~/.cache` and
`~/.local/share`. Back up existing saves before testing PMJS.

## System requirements

ARM64 packages include Node and nongraphics libraries. The system must provide
SDL2, EGL and GLES 3.0 or newer, with glibc 2.28 or newer. The bundled Node 22
targets Linux 4.18 or newer; older kernels need separate testing.
x64 installations use system Node and the native libraries used to build them,
unless Node was explicitly bundled.

The compatibility references are MV 1.6.2/Pixi 4.5.4 and MZ 1.10.0/Pixi 5.3.12.
Game and plugin support is still experimental. Test each device and firmware.

## Troubleshooting

`self-test` checks package files and addon loading. `self-test --graphics` also
checks startup, rendering and shutdown. Run graphics tests in the firmware's
normal display session. Stop its menu through the normal lifecycle before testing,
then restore it afterward. The test needs exclusive use of the display.

For additional logging:

- `PMJS_GRAPHICS_DIAGNOSTICS=1`: graphics diagnostics.
- `PMJS_REQUIRE_HARDWARE_GL=1`: reject software rendering.
- `PMJS_COMPAT_VERBOSE=1`: log unsupported operations.
- `PMJS_STRICT_COMPAT=1`: stop at the first unsupported operation.

When reporting a problem, include `--version`, the log, firmware and kernel
versions, self-test output, and the game's engine and plugin versions.
Missing shared libraries must be supplied by the supported system environment;
keep graphics drivers matched to the firmware.
