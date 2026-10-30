#!/usr/bin/env python3
"""Prepare the pinned ARM64 compiler, libraries, Node and Skia65 independently."""
import argparse
import json
import os
from pathlib import Path
import shutil
import subprocess
import sys
import urllib.request

from runtime_artifact import digest

ROOT = Path(__file__).resolve().parent.parent


def run(*args, env=None):
    subprocess.run([str(arg) for arg in args], cwd=ROOT, env=env, check=True)


def arm64_environment():
    paths = {"PMJS_SDK_ROOT": ".cache/linux-arm64/sdk", "PMJS_NODE_ROOT": ".cache/linux-arm64/node",
             "PMJS_SKIA65_COMPONENT_DIR": ".cache/components/arm64",
             "PMJS_EFFEKSEER_ARCHIVE": ".cache/effekseer/source.tar.gz",
             "PMJS_LZ4_ARCHIVE": ".cache/lz4/source.tar.gz",
             "PMJS_ASTCENC_ARCHIVE": ".cache/astcenc/source.tar.gz"}
    return {**os.environ, **{name: str(Path(os.environ.get(name) or ROOT / path).resolve())
                            for name, path in paths.items()}}


def sources(sdk, output):
    spec = json.loads((ROOT / 'tools/linux-arm64/sdk-recipes.json').read_text())
    cache = Path(os.environ.get('PMJS_DOWNLOAD_CACHE', ROOT / '.cache/linux-arm64/downloads'))
    output.mkdir(parents=True, exist_ok=True)
    source = spec['sources']['ffmpeg']
    archive = cache / source['url'].rsplit('/', 1)[-1]
    if not archive.is_file() or digest(archive) != source['sha256']:
        raise ValueError('Missing verified dependency source archive: ' + str(archive))
    materials = {archive: output / ('ffmpeg-' + archive.name)}
    packages = json.loads((ROOT / 'tools/linux-arm64/sdk-packages.json').read_text())
    for source_package in packages.get('sources', []):
        source_file = cache / Path(source_package['Filename']).name
        if not source_file.is_file() or digest(source_file) != source_package['SHA256']:
            raise ValueError('Missing verified dependency source archive: ' + str(source_file))
        materials[source_file] = output / 'libatomic' / source_file.name
    for relative in [Path('tools/linux-arm64') / name for name in
                     ('sdk-recipes.json', 'sdk-packages.json', 'prepare-sdk.py')]:
        materials[ROOT / relative] = output / relative
    relative = Path('cmake/toolchains/portable-arm64.cmake')
    materials[ROOT / relative] = output / relative
    materials.update({file: output / 'build-records' / file.relative_to(sdk / 'records')
                      for file in (sdk / 'records' / (name + '.json') for name in ('ffmpeg', 'toolchain', 'sysroot'))})
    for original, destination in materials.items():
        checksum = source['sha256'] if original == archive else digest(original)
        if not destination.is_file() or digest(destination) != checksum:
            destination.parent.mkdir(parents=True, exist_ok=True)
            shutil.copyfile(original, destination)


def prepare_arm64(jobs):
    env = arm64_environment()

    sdk = Path(env["PMJS_SDK_ROOT"])
    node = Path(env["PMJS_NODE_ROOT"])
    component = Path(env["PMJS_SKIA65_COMPONENT_DIR"])
    run(sys.executable, ROOT / "tools/linux-arm64/prepare-sdk.py",
        "--sdk", sdk, "--jobs", jobs)
    run(sys.executable, ROOT / "tools/linux-arm64/prepare-node.py", "--output", node)
    for dependency in ("effekseer", "lz4", "astcenc"):
        archive = Path(env["PMJS_" + dependency.upper() + "_ARCHIVE"])
        lock = json.loads((ROOT / f"tools/{dependency}.lock.json").read_text())
        if not archive.is_file() or digest(archive) != lock["sha256"]:
            archive.parent.mkdir(parents=True, exist_ok=True)
            download = archive.with_suffix(".download")
            try:
                with urllib.request.urlopen(lock["url"]) as source, download.open("wb") as target:
                    shutil.copyfileobj(source, target)
                if digest(download) != lock["sha256"]:
                    raise ValueError(f"Downloaded {dependency} archive did not match its pinned SHA-256")
                download.replace(archive)
            finally:
                download.unlink(missing_ok=True)
    run(sys.executable, ROOT / "tools/skia65/build.py", "--arch", "arm64",
        "--sdk", sdk, "--output", component, "--reuse")


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--jobs', type=int, default=min(os.cpu_count() or 1, 4))
    args = parser.parse_args()
    try:
        if args.jobs < 1:
            raise ValueError('--jobs must be positive')
        missing = [name for name in ('cmake', 'ninja', 'git', 'pkg-config', 'make', 'dpkg-deb', 'readelf',
                   'clang-20', 'clang++-20', 'llvm-ar-20', 'llvm-strip-20') if not shutil.which(name)]
        if missing:
            raise ValueError('Missing dependency preparation tools: ' + ', '.join(missing))
        prepare_arm64(args.jobs)
        print('ARM64 dependencies ready; run ./build.sh --target arm64')
    except (ValueError, OSError, subprocess.CalledProcessError) as error:
        parser.exit(1, str(error) + '\n')
