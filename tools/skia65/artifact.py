import json
import pathlib

from provision import ROOT, LOCK, digest


def source_hashes():
    files = [LOCK, ROOT / "third_party/skia65-mask-tail.patch", ROOT / "third_party/skia65-arm-parity.patch"]
    files += [pathlib.Path(__file__).with_name(name) for name in
        ["build.py", "provision.py", "artifact.py", "component_sources.py"]]
    files += sorted(file for file in (ROOT / "src/skia65").iterdir() if file.is_file())
    files += [ROOT / "src" / name for name in
        ["text_layout.cpp", "text_layout.hpp", "unicode_default_ignorables.hpp"]]
    return {str(file.relative_to(ROOT)): digest(file) for file in files}


def configuration(arch, ar):
    definitions = ["-DSK_IGNORE_LINEONLY_AA_CONVEX_PATH_OPTS", "-DSK_GAMMA_EXPONENT=1.2",
        "-DSK_GAMMA_CONTRAST=0.2", "-DSK_DEFAULT_FONT_CACHE_LIMIT=20971520",
        "-DSK_USE_FREETYPE_EMBOLDEN", "-DSK_SUPPORT_LEGACY_DELTA_AA",
        "-DSK_SUPPORT_LEGACY_X86_BLITS", "-DSK_SUPPORT_LEGACY_DASH_CULL_PATH",
        "-DSK_SUPPORT_LEGACY_SVG_ARC_TO"]
    flags = ["-fvisibility=hidden", "-Wno-error", "-w", "-USK_GAMMA_APPLY_TO_A8"] + definitions
    if arch == "arm64":
        flags.append("-ffp-contract=off")
    return {"is_official_build": True, "is_debug": False, "cc": "clang", "cxx": "clang++",
        "ar": ar, "target_cpu": "arm64" if arch == "arm64" else "x64",
        "skia_enable_gpu": False, "skia_enable_pdf": False, "skia_enable_tools": False,
        "skia_use_fontconfig": False, "skia_use_expat": False, "skia_use_icu": False,
        "skia_use_libjpeg_turbo": False, "skia_use_libpng": False, "skia_use_libwebp": False,
        "skia_use_piex": False, "skia_use_zlib": False,
        "extra_cflags": flags, "extra_cflags_cc": ["-fvisibility-inlines-hidden"]}


def validate(directory, arch, toolchain=None):
    try:
        manifest = json.loads((directory / "manifest.json").read_text())
        lock = json.loads(LOCK.read_text())
        if manifest["arch"] != arch:
            raise RuntimeError("architecture changed")
        if manifest["dependencies"] != lock or manifest["sources"] != source_hashes():
            raise RuntimeError("pinned dependencies or component sources changed")
        if manifest["configuration"] != configuration(arch, manifest["configuration"]["ar"]):
            raise RuntimeError("raster configuration changed")
        if toolchain is not None and manifest["toolchain"] != toolchain:
            raise RuntimeError("compiler or SDK changed")
        expected_version = "0.15.2" if arch == "arm64" else "clang version " + lock["clangVersion"] + " "
        if (arch == "arm64" and manifest["compilerVersion"] != expected_version) or (
            arch == "x64" and expected_version not in manifest["compilerVersion"]):
            raise RuntimeError("compiler version is not pinned")
        if manifest["strip"]["version"] != lock["clangVersion"]:
            raise RuntimeError("strip version is not pinned")
        library = directory / "libpmjs-skia65.so"
        if digest(library) != manifest["librarySha256"] or library.stat().st_size != manifest["libraryBytes"]:
            raise RuntimeError("library checksum or size changed")
        with library.open("rb") as stream:
            header = stream.read(20)
        if header[:6] != b"\x7fELF\x02\x01" or int.from_bytes(header[18:20], "little") != (
            183 if arch == "arm64" else 62):
            raise RuntimeError("library ELF architecture is incompatible")
        return manifest
    except (OSError, KeyError, TypeError, ValueError, RuntimeError) as error:
        raise RuntimeError(f"Invalid Skia65 component at {directory}: {error}") from error
