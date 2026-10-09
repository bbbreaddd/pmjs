#!/usr/bin/env python3
"""Create a minimal PortMaster game ZIP from an installed PMJS runtime."""
import argparse
import json
import re
import shutil
import subprocess
import tempfile
import time
import zipfile
from pathlib import Path

from release import checked_manifest, digest, elf, inventory, static_audit


PORTMASTER_LAUNCHER = '''#!/bin/bash
entry_dir=$(cd -- "$(dirname -- "$0")" && pwd) || exit 1
runtime_pid=""
finish() {
  local status=$? child watchdog_pid
  trap - EXIT HUP INT TERM
  if [ -n "$runtime_pid" ]; then
    # A completed child PID may have been reused; signal only a current job.
    for child in $(jobs -p); do
      if [ "$child" = "$runtime_pid" ]; then
        kill -TERM "$child" 2>/dev/null || true
        (
          trap - EXIT HUP INT TERM
          delay_pid=""
          trap '[ -z "$delay_pid" ] || { kill "$delay_pid" 2>/dev/null; wait "$delay_pid" 2>/dev/null; }; exit 0' HUP INT TERM
          sleep 2 &
          delay_pid=$!
          wait "$delay_pid"
          kill -KILL "$child" 2>/dev/null || true
        ) &
        watchdog_pid=$!
        wait "$child" 2>/dev/null || true
        kill -TERM "$watchdog_pid" 2>/dev/null || true
        wait "$watchdog_pid" 2>/dev/null || true
        break
      fi
    done
    wait "$runtime_pid" 2>/dev/null || true
  fi
  if type pm_finish >/dev/null 2>&1 && ! pm_finish; then
    echo 'PortMaster cleanup failed' >&2
    [ "$status" -ne 0 ] || status=1
  fi
  exit "$status"
}
trap finish EXIT
trap 'exit 129' HUP
trap 'exit 130' INT
trap 'exit 143' TERM

controlfolder=${PORTMASTER_CONTROL_DIR:-${controlfolder:-}}
for candidate in "$controlfolder" /PortMaster /opt/system/Tools/PortMaster /opt/tools/PortMaster \\
  "${XDG_DATA_HOME:-$HOME/.local/share}/PortMaster" /mnt/mmc/MUOS/PortMaster \\
  /mnt/SDCARD/Persistent/portmaster/PortMaster /roms/ports/PortMaster /roms2/ports/PortMaster; do
  if [ -f "$candidate/control.txt" ]; then controlfolder=$candidate; break; fi
done
[ -f "$controlfolder/control.txt" ] || { echo 'PortMaster control.txt not found' >&2; exit 1; }
source "$controlfolder/control.txt"
setup_status=$?
if [ "$setup_status" -eq 0 ] && [ -f "$controlfolder/mod_${CFW_NAME:-}.txt" ]; then
  source "$controlfolder/mod_${CFW_NAME}.txt"
  setup_status=$?
fi
# PortMaster replaces EXIT traps while loading its helpers.
trap finish EXIT
trap 'exit 129' HUP
trap 'exit 130' INT
trap 'exit 143' TERM
[ "$setup_status" -eq 0 ] || exit "$setup_status"
get_controls || exit 1

port="$entry_dir/@ID@"
[ -z "${directory:-}" ] || port="/${directory#/}/ports/@ID@"
cd "$port" || exit 1
exec > "$port/log.txt" 2>&1 || exit 1
[ -f gamedata/index.html ] || { echo 'Missing gamedata/index.html'; exit 1; }
mkdir -p saves || exit 1
[ -w saves ] || { echo 'Save directory is not writable'; exit 1; }
export SDL_GAMECONTROLLERCONFIG="${SDL_GAMECONTROLLERCONFIG:-${sdl_controllerconfig:-}}"
if [ "${PMJS_EXIT_HOTKEY+x}" != x ]; then
  case "${HOTKEY:-}" in
    l3) export PMJS_EXIT_HOTKEY=leftstick ;;
    r3) export PMJS_EXIT_HOTKEY=rightstick ;;
    select|back) export PMJS_EXIT_HOTKEY=back ;;
    guide) export PMJS_EXIT_HOTKEY=guide ;;
  esac
fi
if type pm_platform_helper >/dev/null 2>&1; then
  pm_platform_helper "$port/runtime/bin/node" || exit 1
fi
args=(--addon "$port/runtime/lib/pmjs_native.node" --game-root "$port/gamedata"
      --save-root "$port/saves" --bootstrap "$port/bootstrap.js" --asset-cache-root "$port/.cache")
[ ! -f config.json ] || args+=(--config "$port/config.json")
(
  export LD_LIBRARY_PATH="$port/runtime/lib${LD_LIBRARY_PATH:+:$LD_LIBRARY_PATH}"
  exec "$port/runtime/bin/node" --expose-gc "$port/runtime/share/pmjs/runner/cli.cjs" "${args[@]}"
) &
runtime_pid=$!
wait "$runtime_pid"
status=$?
runtime_pid=""
exit "$status"
'''


def write_zip(directory, output, epoch):
    timestamp = time.gmtime(max(315532800, epoch))[:6]
    with zipfile.ZipFile(output, 'w', compression=zipfile.ZIP_DEFLATED, compresslevel=9) as bundle:
        for file in sorted(directory.rglob('*')):
            name = file.relative_to(directory).as_posix()
            if file.is_dir() and any(file.iterdir()):
                continue
            entry = zipfile.ZipInfo(name + ('/' if file.is_dir() else ''), timestamp)
            entry.create_system = 3
            entry.external_attr = ((0o40755 if file.is_dir() else file.stat().st_mode) << 16)
            bundle.writestr(entry, b'' if file.is_dir() else file.read_bytes(),
                            compress_type=zipfile.ZIP_DEFLATED, compresslevel=9)


def portmaster(stage, game, output, name=None, config=None, adapters=(), strip=None):
    info = checked_manifest(stage)
    if not (stage / 'bin/node').is_file():
        raise ValueError('PortMaster packaging requires a runtime with bundled target Node')
    if output.is_relative_to(stage) or output.is_relative_to(game):
        raise ValueError('Package output must be outside the runtime and game directories')
    if name is None:
        name = json.loads((game / 'data/System.json').read_text())['gameTitle']
    if not isinstance(name, str) or not name.strip() or re.search(r'[/\\\x00-\x1f]', name) or name.strip() in ('.', '..'):
        raise ValueError('Use a nonempty game name without path separators or control characters')
    name = name.strip()
    identifier = re.sub(r'[^a-z0-9]+', '-', name.lower()).strip('-')
    if not identifier:
        raise ValueError('Game name must contain an ASCII letter or number')
    strip = strip or next((tool for tool in ('llvm-strip-20', 'llvm-strip', 'aarch64-linux-gnu-strip')
                           if shutil.which(tool)), None)
    if not strip:
        raise ValueError('Install llvm-strip or specify --strip; package binaries must be stripped')
    output.parent.mkdir(parents=True, exist_ok=True)
    with tempfile.TemporaryDirectory(prefix='pmjs-portmaster-', dir=output.parent) as temporary:
        workspace = Path(temporary)
        payload = workspace / 'payload'
        port = payload / identifier
        runtime = port / 'runtime'
        runtime.mkdir(parents=True)
        (port / 'gamedata').mkdir()
        if config:
            shutil.copyfile(config, port / 'config.json')
        bootstrap = port / 'bootstrap.js'
        command = ['node', stage / 'share/pmjs/tools/build-js-runtime.mjs', '--game', game, '--output', bootstrap]
        if config:
            command.extend(['--config', port / 'config.json'])
        for adapter in adapters:
            command.extend(['--adapter', adapter])
        subprocess.run(command, check=True)
        subprocess.run(['node', '--check', bootstrap], check=True)

        # Follow the installed dependency closure; firmware providers stay external.
        pending = [stage / 'bin/node', stage / 'lib/pmjs_native.node']
        copied = set()
        while pending:
            file = pending.pop()
            if file in copied:
                continue
            copied.add(file)
            target = runtime / file.relative_to(stage)
            target.parent.mkdir(parents=True, exist_ok=True)
            shutil.copy2(file, target)
            symbols = subprocess.check_output(['readelf', '--dyn-syms', '--wide', file])
            dynamic = subprocess.check_output(['readelf', '-d', '--wide', file])
            subprocess.run([strip, '--strip-unneeded', target], check=True)
            if (symbols != subprocess.check_output(['readelf', '--dyn-syms', '--wide', target]) or
                    dynamic != subprocess.check_output(['readelf', '-d', '--wide', target])):
                raise ValueError('Stripping changed dynamic symbols or loader information: ' + file.name)
            sections = subprocess.check_output(['readelf', '-S', '--wide', target], text=True)
            if re.search(r'\.(?:debug\w*|zdebug\w*|symtab)\b', sections):
                raise ValueError('Strip tool left debug information: ' + file.name)
            pending.extend(stage / 'lib' / dependency for dependency in elf(file)['needed']
                           if (stage / 'lib' / dependency).is_file())
        static_audit(runtime, info)
        shutil.copytree(stage / 'share/pmjs/runner', runtime / 'share/pmjs/runner')
        notices = [stage / 'LICENSE', stage / 'THIRD_PARTY_NOTICES.md',
                   *sorted(file for file in (stage / 'share/pmjs/notices').rglob('*') if file.is_file())]
        with (runtime / 'LICENSES.txt').open('w') as licenses:
            for notice in notices:
                licenses.write(f'===== {notice.relative_to(stage)} =====\n\n{notice.read_text().rstrip()}\n\n')
        # Only the bundled LGPL media libraries require matching source here.
        if any(file.name.startswith('libav') for file in copied):
            sources = stage / 'share/pmjs/sources'
            record = sources / 'build-records/ffmpeg.json'
            recipe = json.loads(record.read_text())['recipe']['source']
            archive = sources / ('ffmpeg-' + recipe['url'].rsplit('/', 1)[-1])
            if digest(archive) != recipe['sha256']:
                raise ValueError('Matching FFmpeg source archive is required')
            preparation = sources / 'tools/linux-arm64'
            toolchain = sources / 'cmake/toolchains/portable-arm64.cmake'
            materials = [archive, record, sources / 'build-records/toolchain.json',
                         sources / 'build-records/sysroot.json', preparation / 'prepare-sdk.py',
                         preparation / 'sdk-recipes.json', preparation / 'sdk-packages.json', toolchain]
            for file in materials:
                target = runtime / 'sources' / file.relative_to(sources)
                target.parent.mkdir(parents=True, exist_ok=True)
                shutil.copy2(file, target)
        launcher = payload / (name + '.sh')
        launcher.write_text(PORTMASTER_LAUNCHER.replace('@ID@', identifier))
        launcher.chmod(0o755)
        subprocess.run(['bash', '-n', launcher], check=True)
        epoch = info['source']['sourceDateEpoch']
        package = workspace / 'game.zip'
        write_zip(payload, package, epoch)
        if inventory(stage) != info['files']:
            raise ValueError('Installed runtime changed during packaging')
        package.replace(output)
        print(f'{output} ({output.stat().st_size / 1024**2:.1f} MiB)')


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    for name in ('stage', 'game', 'output'):
        parser.add_argument('--' + name, type=Path, required=True)
    parser.add_argument('--name', help='Launcher name; defaults to the game title')
    parser.add_argument('--config', type=Path)
    parser.add_argument('--adapter', type=Path, action='append', default=[], help='Register a port adapter before engine boot')
    parser.add_argument('--strip', help='Target-capable strip executable')
    args = parser.parse_args()
    try:
        portmaster(args.stage.resolve(), args.game.resolve(), args.output.resolve(), args.name,
                   args.config.resolve() if args.config else None, [file.resolve() for file in args.adapter], args.strip)
    except (OSError, ValueError, KeyError, subprocess.SubprocessError) as error:
        parser.exit(1, str(error) + '\n')


if __name__ == '__main__':
    main()
