#!/usr/bin/env python3
"""Audit an ARM64 runtime's loader contract without executing its binaries."""

import argparse
import hashlib
import json
import os
import re
import subprocess
from pathlib import Path


PLATFORM_LIBRARIES = {"libSDL2-2.0.so.0", "libEGL.so.1", "libGLESv2.so.2"}
SYSTEM_LIBRARIES = {
    "libc.so.6", "libm.so.6", "libdl.so.2", "libpthread.so.0", "librt.so.1",
    "libgcc_s.so.1", "libstdc++.so.6", "ld-linux-aarch64.so.1",
}
GRAPHICS_NAME = re.compile(r"^(lib(SDL2|EGL|GLES|GL|gbm|Mali|mali|drm|wayland)|.*_dri\.so)")


def version(value):
    return tuple(map(int, value.split(".")))


def readelf(file, option):
    return subprocess.run(["readelf", option, "--wide", str(file)], check=True,
                          capture_output=True, text=True,
                          env={**os.environ, "LC_ALL": "C"}).stdout


def inspect(file):
    header = readelf(file, "--file-header")
    if not re.search(r"Machine:\s+AArch64\b", header):
        raise ValueError(f"{file}: expected AArch64 ELF")
    if not re.search(r"Class:\s+ELF64\b", header) or "little endian" not in header:
        raise ValueError(f"{file}: expected 64-bit little-endian ELF")
    dynamic = readelf(file, "--dynamic")
    if re.search(r"\((RELR|RELRSZ|RELRENT)\)", dynamic):
        raise ValueError(f"{file}: packed RELR relocations require a newer loader than glibc 2.28")
    search_paths = re.findall(r"\((?:RPATH|RUNPATH)\).*\[(.*?)\]", dynamic)
    for paths in search_paths:
        if any(entry not in ("$ORIGIN", "$ORIGIN/lib") for entry in paths.split(":")):
            raise ValueError(f"{file}: nonportable runtime search path: {paths}")
    needs = readelf(file, "--version-info").partition("Version needs section")[2]
    required_versions = set(re.findall(r"Name:\s+(\S+)", needs))
    if "GLIBC_PRIVATE" in required_versions:
        raise ValueError(f"{file}: depends on private glibc symbols")
    requirements = {}
    for namespace in ("GLIBC", "GLIBCXX", "CXXABI", "GCC"):
        values = set()
        for name in required_versions:
            if not name.startswith(namespace + "_"):
                continue
            value = name[len(namespace) + 1:]
            if not re.fullmatch(r"[0-9]+(?:\.[0-9]+)*", value):
                raise ValueError(f"{file}: unsupported ABI requirement {name}")
            values.add(value)
        requirements[namespace] = sorted(values, key=version)
    with file.open("rb") as stream:
        checksum = hashlib.file_digest(stream, "sha256").hexdigest()
    return {
        "path": str(file), "sha256": checksum,
        "needed": re.findall(r"\(NEEDED\).*\[(.*?)\]", dynamic),
        "searchPaths": search_paths,
        "requirements": requirements,
    }


def audit(node, addon, lib_dir, max_glibc="2.28", max_glibcxx="3.4.25"):
    if not lib_dir.is_dir():
        raise ValueError(f"library directory missing: {lib_dir}")
    libraries = {}
    for file in sorted(lib_dir.glob("*.so*")):
        if GRAPHICS_NAME.match(file.name):
            raise ValueError(f"firmware graphics/window library must not be bundled: {file.name}")
        resolved = file.resolve(strict=True)
        if not resolved.is_relative_to(lib_dir.resolve()):
            raise ValueError(f"library symlink escapes bundle: {file}")
        libraries[file.name] = resolved
    files = list(dict.fromkeys([node.resolve(), addon.resolve(), *libraries.values()]))
    artifacts = [inspect(file) for file in files]
    external = set()
    for artifact in artifacts:
        for namespace, ceiling in (("GLIBC", max_glibc), ("GLIBCXX", max_glibcxx),
                                   ("CXXABI", "1.3.11"), ("GCC", "7.0.0")):
            for required in artifact["requirements"][namespace]:
                if version(required) > version(ceiling):
                    raise ValueError(f"{artifact['path']}: requires {namespace}_{required}; maximum is {ceiling}")
        for needed in artifact["needed"]:
            if needed in libraries:
                continue
            if needed not in PLATFORM_LIBRARIES | SYSTEM_LIBRARIES:
                raise ValueError(f"{artifact['path']}: missing bundled dependency {needed}")
            external.add(needed)
    return {
        "schema": 1, "architecture": "aarch64", "maxGlibc": max_glibc,
        "maxGlibcxx": max_glibcxx, "maxGcc": "7.0.0", "nodeSupportedKernel": "4.18",
        "artifacts": artifacts,
        "firmwareLibraries": sorted(external & PLATFORM_LIBRARIES),
        "systemLibraries": sorted(external & SYSTEM_LIBRARIES),
        "hardwareAcceptance": "unverified",
    }


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--node", type=Path, required=True)
    parser.add_argument("--addon", type=Path, required=True)
    parser.add_argument("--lib-dir", type=Path, required=True)
    parser.add_argument("--output", type=Path)
    args = parser.parse_args()
    try:
        report = audit(args.node, args.addon, args.lib_dir)
    except (ValueError, OSError, subprocess.CalledProcessError) as error:
        parser.exit(1, f"PMJS ABI audit failed: {error}\n")
    payload = json.dumps(report, indent=2) + "\n"
    if args.output:
        args.output.write_text(payload)
    else:
        print(payload, end="")


if __name__ == "__main__":
    main()
