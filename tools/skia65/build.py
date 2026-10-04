#!/usr/bin/env python3
"""Build the checksum-pinned CPU-only Skia65 text component."""
import argparse
import fcntl
import hashlib
import json
import os
import pathlib
import shutil
import shlex
import subprocess
import sys

from provision import ROOT, LOCK, digest, provision
from artifact import configuration, source_hashes, validate


def run(arguments, **kwargs):
    subprocess.run([str(value) for value in arguments], check=True, **kwargs)


def replace(filename, before, after):
    source = filename.read_text()
    if source.count(before) != 1:
        raise RuntimeError(f"Pinned adaptation no longer matches: {filename}: {before}")
    filename.write_text(source.replace(before, after))


def build(options):
    if options.verify:
        validate(options.output.resolve(), options.arch)
        return
    cache = (options.cache or ROOT / (".cache/skia65" if options.arch == "x64" else ".cache/skia65-arm64")).resolve()
    cache.parent.mkdir(parents=True, exist_ok=True)
    with cache.with_suffix(".lock").open("a") as guard:
        fcntl.flock(guard, fcntl.LOCK_EX)
        build_locked(options, cache)


def build_locked(options, cache):
    lock = json.loads(LOCK.read_text())
    sdk = options.sdk.resolve() if options.sdk else None
    if sdk and options.arch != "arm64":
        raise RuntimeError("--sdk is only supported for the ARM64 cross-build")
    if options.arch == "arm64":
        if not sdk:
            raise RuntimeError("ARM64 requires --sdk with the prepared portable SDK")
        compiler = sdk / "zig/zig"
        compiler_version = subprocess.check_output([compiler, "version"], text=True).strip()
        if compiler_version != "0.15.2":
            raise RuntimeError("Skia65 ARM64 requires the portable SDK's pinned Zig 0.15.2")
    else:
        resolved = shutil.which("clang++-20")
        c_compiler = shutil.which("clang-20")
        if not resolved or not c_compiler:
            raise RuntimeError("Skia65 requires Clang " + lock["clangVersion"])
        compiler = pathlib.Path(resolved)
        c_version = subprocess.check_output([c_compiler, "--version"], text=True)
        if "clang version " + lock["clangVersion"] + " " not in c_version:
            raise RuntimeError("Skia65 requires Clang " + lock["clangVersion"])
        compiler_version = subprocess.check_output([compiler, "--version"], text=True)
        if "clang version " + lock["clangVersion"] + " " not in compiler_version:
            raise RuntimeError("Skia65 requires Clang " + lock["clangVersion"])
    strip = pathlib.Path(shutil.which("llvm-strip-20") or "")
    if not strip.is_file() or "LLVM version " + lock["clangVersion"] not in subprocess.check_output([strip, "--version"], text=True):
        raise RuntimeError("Skia65 requires LLVM strip " + lock["clangVersion"])
    compiler_commands = [sdk / "bin/cc", sdk / "bin/c++"] if sdk else [pathlib.Path(c_compiler), compiler]
    args = configuration(options.arch, str(sdk / "bin/ar") if sdk else "llvm-ar-20")
    toolchain = {"compilerSha256": digest(compiler.resolve()), "compilerVersion": compiler_version,
        "drivers": [digest(command.resolve()) for command in compiler_commands],
        "sdk": str(sdk) if sdk else None, "configuration": args, "stripSha256": digest(strip.resolve())}
    destination = options.output.resolve()
    if options.reuse:
        try:
            validate(destination, options.arch, toolchain)
            tests = ["pmjs-skia65-mask-test", "pmjs-skia65-raster-test"] if options.mask_test else []
            if all((destination / name).is_file() for name in tests):
                print(destination / "libpmjs-skia65.so")
                return
        except RuntimeError as error:
            print(str(error) + "; rebuilding", flush=True)
    identity = hashlib.sha256(json.dumps(toolchain, sort_keys=True).encode()).hexdigest()[:16]
    destination.mkdir(parents=True, exist_ok=True)
    component = destination / ("component-" + identity)
    output = destination / ("skia-" + identity)
    lock = provision(cache)
    tools = cache / "tools"
    for tool in lock["tools"]:
        if subprocess.check_output([tools / tool["name"], "--version"], text=True).strip() != tool["version"]:
            raise RuntimeError("Unexpected build tool version: " + tool["name"])
    skia = cache / "skia"
    # Both literal compiler names avoid the release's Python 2 is_clang.py.
    for name in ["clang", "clang++"]:
        command = [str(sdk / "bin" / ("cc" if name == "clang" else "c++"))] if sdk else [c_compiler if name == "clang" else str(compiler)]
        wrapper = tools / name
        wrapper.write_text("#!/bin/sh\nexec " + shlex.join(command) + ' "$@"\n')
        wrapper.chmod(0o755)
    python = tools / "python"
    python.write_text('#!/bin/sh\nexec ' + shlex.quote(sys.executable) + ' "$@"\n')
    python.chmod(0o755)
    replace(skia / "BUILD.gn", '"src/ports/SkFontMgr_custom_directory_factory.cpp",',
            '"src/ports/SkFontMgr_custom_empty_factory.cpp",')
    if options.arch == "arm64":
        replace(skia / "BUILD.gn", '"-march=armv8-a+crc"', '"-mcpu=generic+crc"')
    mask_patch = ROOT / "third_party/skia65-mask-tail.patch"
    mask_source = skia / "src/opts/SkBlitMask_opts.h"
    mask_original_sha256 = digest(mask_source)
    patch_environment = {**os.environ, "GIT_CEILING_DIRECTORIES": str(skia.parent)}
    run(["git", "apply", "--check", mask_patch], cwd=skia, env=patch_environment)
    run(["git", "apply", mask_patch], cwd=skia, env=patch_environment)
    arm_patch = ROOT / "third_party/skia65-arm-parity.patch"
    arm_sources = [skia / "src/opts/SkBlitRow_opts.h", skia / "src/opts/SkNx_neon.h"]
    arm_original_sha256 = {str(file.relative_to(skia)): digest(file) for file in arm_sources}
    run(["git", "apply", "--check", arm_patch], cwd=skia, env=patch_environment)
    run(["git", "apply", arm_patch], cwd=skia, env=patch_environment)
    (skia / "src/ports/SkFontMgr_custom_empty_factory.cpp").write_text(
        '#include "SkFontMgr.h"\n#include "SkFontMgr_empty.h"\n'
        'sk_sp<SkFontMgr> SkFontMgr::Factory() { return SkFontMgr_New_Custom_Empty(); }\n')
    # The private component compiles FreeType and HarfBuzz together. GN only
    # needs their headers; no system font library may enter libskia.a.
    (skia / "third_party/freetype2/BUILD.gn").write_text(
        'import("../third_party.gni")\nsystem("freetype2") {\n'
        ' include_dirs = ' + json.dumps([str(cache / "freetype/include"),
            str(cache / "chromium/third_party/freetype/include")]) + '\n}\n')
    output.mkdir(parents=True, exist_ok=True)
    (output / "args.gn").write_text("\n".join(key + " = " + json.dumps(value) for key, value in args.items()) + "\n")
    environment = {**os.environ, "PATH": str(tools) + os.pathsep + os.environ["PATH"]}
    run([tools / "gn", "gen", output, "--root=" + str(skia)], env=environment)
    run([tools / "ninja", "-C", output, "skia", "-j", options.jobs], env=environment)
    configure = ["cmake", "-S", ROOT / "src/skia65", "-B", component, "-G", "Ninja",
                 "-DCMAKE_BUILD_TYPE=Release", "-DCMAKE_C_COMPILER=" + str(tools / "clang"),
                 "-DCMAKE_CXX_COMPILER=" + str(tools / "clang++"),
                 "-DCMAKE_MAKE_PROGRAM=" + str(tools / "ninja"),
                 "-DPMJS_BUILD_SKIA65_MASK_TEST=" + ("ON" if options.mask_test else "OFF"),
                 "-DPMJS_SKIA65_SOURCE_ROOT=" + str(cache),
                 "-DPMJS_SKIA65_ARCHIVE=" + str(output / "libskia.a")]
    if options.arch == "arm64":
        configure += ["-DCMAKE_SYSTEM_NAME=Linux", "-DCMAKE_SYSTEM_PROCESSOR=aarch64"]
    run(configure, env=environment)
    run(["cmake", "--build", component, "--parallel", options.jobs], env=environment)
    library = component / "libpmjs-skia65.so"
    run([strip, "--strip-debug", library])
    manifest = {"arch": options.arch, "scope": "shared text backend",
        "dependencies": lock, "compilerVersion": compiler_version,
        "compilerSha256": digest(compiler.resolve()), "configuration": args, "toolchain": toolchain,
        "strip": {"version": lock["clangVersion"], "sha256": digest(strip.resolve()), "arguments": ["--strip-debug"]},
        "sources": source_hashes(),
        "adaptations": {"maskTail": {"patchSha256": digest(mask_patch),
            "originalSha256": mask_original_sha256, "adaptedSha256": digest(mask_source)},
            "armParity": {"patchSha256": digest(arm_patch), "originalSha256": arm_original_sha256,
                "adaptedSha256": {str(file.relative_to(skia)): digest(file) for file in arm_sources}}},
        "librarySha256": digest(library), "libraryBytes": library.stat().st_size,
        "readelfDynamic": subprocess.check_output(["readelf", "-d", library], text=True),
        "exports": subprocess.check_output(["nm", "-D", "--defined-only", library], text=True)}
    exported = {line.split()[-1].split("@@")[0] for line in manifest["exports"].splitlines()}
    expected = {"pmjs_skia65_identity", "pmjs_skia65_font_open",
                "pmjs_skia65_font_close", "pmjs_skia65_measure", "pmjs_skia65_draw", "pmjs_skia65_draw_bgra",
                "pmjs_skia65_font_open_many", "pmjs_skia65_measure_metrics",
                "pmjs_skia65_get_stats", "pmjs_skia65_cache_limits", "pmjs_skia65_bounds", "pmjs_skia65_set_telemetry", "pmjs_skia65_font_cache_stats"}
    # GNU ld emits an absolute symbol for the version node; LLVM lld does not.
    # Both must export exactly these functions with the same ABI version.
    functions = exported - {"PMJS_SKIA65_2"}
    if functions != expected:
        raise RuntimeError("Incorrect private C ABI exports: extra=" + str(functions - expected) +
                           "; missing=" + str(expected - functions))
    for name in expected:
        if name + "@@PMJS_SKIA65_2" not in manifest["exports"]:
            raise RuntimeError("Unversioned private C ABI export: " + name)
    if any(name in manifest["readelfDynamic"] for name in ["libfreetype", "libharfbuzz", "libfontconfig"]):
        raise RuntimeError("Skia65 unexpectedly links a system font dependency")
    temporary = destination / "libpmjs-skia65.so.tmp"
    shutil.copyfile(library, temporary)
    temporary.replace(destination / "libpmjs-skia65.so")
    temporary = destination / "manifest.json.tmp"
    temporary.write_text(json.dumps(manifest, indent=2) + "\n")
    temporary.replace(destination / "manifest.json")
    for name in ["pmjs-skia65-mask-test", "pmjs-skia65-raster-test"]:
        if options.mask_test:
            shutil.copyfile(component / name, destination / name)
            (destination / name).chmod(0o755)
    print(destination / "libpmjs-skia65.so")


if __name__ == "__main__":
    parser = argparse.ArgumentParser()
    parser.add_argument("--cache", type=pathlib.Path)
    parser.add_argument("--output", type=pathlib.Path, required=True)
    modes = parser.add_mutually_exclusive_group()
    modes.add_argument("--reuse", action="store_true")
    modes.add_argument("--verify", action="store_true")
    parser.add_argument("--arch", choices=["x64", "arm64"], default="x64")
    parser.add_argument("--sdk", type=pathlib.Path)
    parser.add_argument("--jobs", type=int, default=4)
    parser.add_argument("--mask-test", action="store_true")
    try:
        build(parser.parse_args())
    except (RuntimeError, OSError) as error:
        parser.exit(1, str(error) + "\n")
