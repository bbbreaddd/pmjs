"""Provision and build the private upstream raster archive independently of its bridge."""
import json
import os
import pathlib
import shlex
import subprocess
import sys

from provision import ROOT, LOCK, digest, provision


def run(arguments, **kwargs):
    subprocess.run([str(value) for value in arguments], check=True, **kwargs)


def write_changed(file, text):
    if not file.exists() or file.read_text() != text:
        file.write_text(text)


def replace(filename, before, after):
    source = filename.read_text()
    if source.count(before) != 1:
        raise RuntimeError(f"Pinned adaptation no longer matches: {filename}: {before}")
    write_changed(filename, source.replace(before, after))


def inputs(cache):
    return {str(file.relative_to(cache)): digest(file)
            for directory in ["skia", "freetype", "icu", "chromium", "tools"]
            for file in sorted((cache / directory).rglob("*")) if file.is_file()}


def recipe(toolchain, args):
    return {"toolchain": {key: value for key, value in toolchain.items() if key != "stripSha256"}, "configuration": args, "lock": digest(LOCK),
            "builder": digest(pathlib.Path(__file__)), "provision": digest(ROOT / "tools/skia65/provision.py"),
            "patches": [digest(ROOT / "third_party" / name) for name in
                        ["skia65-mask-tail.patch", "skia65-arm-parity.patch"]]}


def reusable(cache, output, expected):
    try:
        record = json.loads((output / "raster.json").read_text())
        if record["recipe"] != expected:
            return "upstream recipe changed"
        if digest(output / "libskia.a") != record["archive"]:
            return "upstream archive changed"
        if inputs(cache) != record["inputs"]:
            return "provisioned raster sources changed"
        return None
    except (OSError, KeyError, ValueError):
        return "no verified upstream completion record"


def build_raster(options, cache, output, toolchain, args, sdk, c_compiler, compiler):
    expected = recipe(toolchain, args)
    reason = reusable(cache, output, expected)
    if reason is None:
        print("Skia65: upstream raster unchanged", flush=True)
        return json.loads((output / "raster.json").read_text())["adaptations"]
    print("Skia65: upstream raster rebuild (" + reason + ")", flush=True)
    output.mkdir(parents=True, exist_ok=True)
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
        write_changed(wrapper, "#!/bin/sh\nexec " + shlex.join(command) + ' "$@"\n')
        wrapper.chmod(0o755)
    python = tools / "python"
    write_changed(python, '#!/bin/sh\nexec ' + shlex.quote(sys.executable) + ' "$@"\n')
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
    write_changed(skia / "src/ports/SkFontMgr_custom_empty_factory.cpp",
        '#include "SkFontMgr.h"\n#include "SkFontMgr_empty.h"\n'
        'sk_sp<SkFontMgr> SkFontMgr::Factory() { return SkFontMgr_New_Custom_Empty(); }\n')
    # The private component compiles FreeType and HarfBuzz together. GN only
    # needs their headers; no system font library may enter libskia.a.
    write_changed(skia / "third_party/freetype2/BUILD.gn",
        'import("../third_party.gni")\nsystem("freetype2") {\n'
        ' include_dirs = ' + json.dumps([str(cache / "freetype/include"),
            str(cache / "chromium/third_party/freetype/include")]) + '\n}\n')
    write_changed(output / "args.gn", "\n".join(key + " = " + json.dumps(value) for key, value in args.items()) + "\n")
    environment = {**os.environ, "PATH": str(tools) + os.pathsep + os.environ["PATH"]}
    run([tools / "gn", "gen", output, "--root=" + str(skia)], env=environment)
    run([tools / "ninja", "-C", output, "skia", "-j", options.jobs], env=environment)
    adaptations = {"maskTail": {"patchSha256": digest(mask_patch),
        "originalSha256": mask_original_sha256, "adaptedSha256": digest(mask_source)},
        "armParity": {"patchSha256": digest(arm_patch), "originalSha256": arm_original_sha256,
            "adaptedSha256": {str(file.relative_to(skia)): digest(file) for file in arm_sources}}}
    temporary = output / "raster.json.tmp"
    temporary.write_text(json.dumps({"recipe": expected, "archive": digest(output / "libskia.a"),
                                    "inputs": inputs(cache), "adaptations": adaptations}, indent=2) + "\n")
    temporary.replace(output / "raster.json")
    return adaptations
