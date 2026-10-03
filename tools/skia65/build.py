#!/usr/bin/env python3
"""Build the checksum-pinned CPU-only Skia65 text component."""
import argparse
import json
import os
import pathlib
import shutil
import subprocess

from provision import ROOT, LOCK, digest, provision


def run(arguments, **kwargs):
    subprocess.run([str(value) for value in arguments], check=True, **kwargs)


def replace(filename, before, after):
    source = filename.read_text()
    if source.count(before) != 1:
        raise RuntimeError(f"Pinned adaptation no longer matches: {filename}: {before}")
    filename.write_text(source.replace(before, after))


def build(options):
    cache = (options.cache or ROOT / (".cache/skia65" if options.arch == "x64" else ".cache/skia65-arm64")).resolve()
    lock = provision(cache)
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
        if not resolved:
            raise RuntimeError("Skia65 requires Clang " + lock["clangVersion"])
        compiler = pathlib.Path(resolved)
        compiler_version = subprocess.check_output([compiler, "--version"], text=True)
        if "clang version " + lock["clangVersion"] + " " not in compiler_version:
            raise RuntimeError("Skia65 requires Clang " + lock["clangVersion"])
    tools = cache / "tools"
    for tool in lock["tools"]:
        if subprocess.check_output([tools / tool["name"], "--version"], text=True).strip() != tool["version"]:
            raise RuntimeError("Unexpected build tool version: " + tool["name"])
    skia = cache / "skia"
    # Both literal compiler names avoid the release's Python 2 is_clang.py.
    for name in ["clang", "clang++"]:
        command = [str(sdk / "bin" / ("cc" if name == "clang" else "c++"))] if sdk else ["/usr/bin/" + name + "-20"]
        wrapper = tools / name
        import shlex
        wrapper.write_text("#!/bin/sh\nexec " + shlex.join(command) + ' "$@"\n')
        wrapper.chmod(0o755)
    python = tools / "python"
    python.write_text('#!/bin/sh\nexec /usr/bin/python3 "$@"\n')
    python.chmod(0o755)
    replace(skia / "BUILD.gn", '"src/ports/SkFontMgr_custom_directory_factory.cpp",',
            '"src/ports/SkFontMgr_custom_empty_factory.cpp",')
    if options.arch == "arm64":
        replace(skia / "BUILD.gn", '"-march=armv8-a+crc"', '"-mcpu=generic+crc"')
    (skia / "src/ports/SkFontMgr_custom_empty_factory.cpp").write_text(
        '#include "SkFontMgr.h"\n#include "SkFontMgr_empty.h"\n'
        'sk_sp<SkFontMgr> SkFontMgr::Factory() { return SkFontMgr_New_Custom_Empty(); }\n')
    # The private component compiles FreeType and HarfBuzz together. GN only
    # needs their headers; no system font library may enter libskia.a.
    (skia / "third_party/freetype2/BUILD.gn").write_text(
        'import("../third_party.gni")\nsystem("freetype2") {\n'
        ' include_dirs = ' + json.dumps([str(cache / "freetype/include"),
            str(cache / "chromium/third_party/freetype/include")]) + '\n}\n')
    definitions = ["-DSK_IGNORE_LINEONLY_AA_CONVEX_PATH_OPTS", "-DSK_GAMMA_EXPONENT=1.2",
                   "-DSK_GAMMA_CONTRAST=0.2", "-DSK_DEFAULT_FONT_CACHE_LIMIT=20971520",
                   "-DSK_USE_FREETYPE_EMBOLDEN", "-DSK_SUPPORT_LEGACY_DELTA_AA",
                   "-DSK_SUPPORT_LEGACY_X86_BLITS", "-DSK_SUPPORT_LEGACY_DASH_CULL_PATH",
                   "-DSK_SUPPORT_LEGACY_SVG_ARC_TO"]
    flags = ["-fvisibility=hidden", "-Wno-error", "-w", "-USK_GAMMA_APPLY_TO_A8"] + definitions
    args = {"is_official_build": True, "is_debug": False, "cc": "clang", "cxx": "clang++",
            "ar": str(sdk / "bin/ar") if sdk else "llvm-ar-20", "target_cpu": "arm64" if options.arch == "arm64" else "x64",
            "skia_enable_gpu": False, "skia_enable_pdf": False, "skia_enable_tools": False,
            "skia_use_fontconfig": False, "skia_use_expat": False, "skia_use_icu": False,
            "skia_use_libjpeg_turbo": False, "skia_use_libpng": False, "skia_use_libwebp": False,
            "skia_use_piex": False, "skia_use_zlib": False,
            "extra_cflags": flags, "extra_cflags_cc": ["-fvisibility-inlines-hidden"]}
    output = skia / "out" / ("pmjs-" + options.arch)
    output.mkdir(parents=True, exist_ok=True)
    (output / "args.gn").write_text("\n".join(key + " = " + json.dumps(value) for key, value in args.items()) + "\n")
    environment = {**os.environ, "PATH": str(tools) + os.pathsep + os.environ["PATH"]}
    run([tools / "gn", "gen", output, "--root=" + str(skia)], env=environment)
    run([tools / "ninja", "-C", output, "skia", "-j", options.jobs], env=environment)
    component = ROOT / "build-skia65" / options.arch
    configure = ["cmake", "-S", ROOT / "src/skia65", "-B", component, "-G", "Ninja",
                 "-DCMAKE_BUILD_TYPE=Release", "-DCMAKE_C_COMPILER=" + str(tools / "clang"),
                 "-DCMAKE_CXX_COMPILER=" + str(tools / "clang++"),
                 "-DCMAKE_MAKE_PROGRAM=" + str(tools / "ninja"),
                 "-DPMJS_SKIA65_SOURCE_ROOT=" + str(cache),
                 "-DPMJS_SKIA65_ARCHIVE=" + str(output / "libskia.a")]
    if options.arch == "arm64":
        configure += ["-DCMAKE_SYSTEM_NAME=Linux", "-DCMAKE_SYSTEM_PROCESSOR=aarch64"]
    run(configure, env=environment)
    run(["cmake", "--build", component, "--parallel", options.jobs], env=environment)
    library = component / "libpmjs-skia65.so"
    strip = pathlib.Path(shutil.which("llvm-strip-20") or "")
    if not strip.is_file() or "LLVM version " + lock["clangVersion"] not in subprocess.check_output([strip, "--version"], text=True):
        raise RuntimeError("Skia65 requires LLVM strip " + lock["clangVersion"])
    run([strip, "--strip-debug", library])
    sources = [LOCK, pathlib.Path(__file__), pathlib.Path(__file__).with_name("provision.py")]
    sources += sorted((ROOT / "src/skia65").iterdir())
    sources += [ROOT / "src/text_layout.cpp", ROOT / "src/text_layout.hpp", ROOT / "src/unicode_default_ignorables.hpp"]
    manifest = {"arch": options.arch, "scope": "shared text backend",
        "dependencies": lock, "compilerVersion": compiler_version,
        "compilerSha256": digest(compiler.resolve()), "configuration": args,
        "strip": {"version": lock["clangVersion"], "sha256": digest(strip.resolve()), "arguments": ["--strip-debug"]},
        "sources": {str(file.relative_to(ROOT)): digest(file) for file in sources},
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
    (component / "manifest.json").write_text(json.dumps(manifest, indent=2) + "\n")
    print(library)


if __name__ == "__main__":
    parser = argparse.ArgumentParser()
    parser.add_argument("--cache", type=pathlib.Path)
    parser.add_argument("--arch", choices=["x64", "arm64"], default="x64")
    parser.add_argument("--sdk", type=pathlib.Path)
    parser.add_argument("--jobs", type=int, default=4)
    build(parser.parse_args())
