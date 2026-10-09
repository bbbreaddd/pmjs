#!/usr/bin/env python3
"""Build the pinned ARM64/glibc-2.28 SDK; firmware SDL/EGL/GLES are link inputs only."""

import argparse
import fcntl
import hashlib
import json
import os
import shlex
import shutil
import subprocess
import tarfile
import time
import urllib.request
from pathlib import Path

ROOT = Path(__file__).resolve().parent
TOOLCHAIN = ROOT.parent.parent / "cmake/toolchains/portable-arm64.cmake"


def digest(file):
    with file.open("rb") as stream:
        return hashlib.file_digest(stream, "sha256").hexdigest()


def identity(value):
    return hashlib.sha256(json.dumps(value, sort_keys=True).encode()).hexdigest()


def write_changed(file, text):
    if file.exists() and file.read_text() == text:
        return
    file.parent.mkdir(parents=True, exist_ok=True)
    temporary = file.with_name(file.name + ".tmp")
    temporary.write_text(text)
    if file.exists():
        temporary.chmod(file.stat().st_mode & 0o777)
    temporary.replace(file)


def download(url, checksum):
    cache = Path(os.environ.get("PMJS_DOWNLOAD_CACHE", ROOT.parent.parent / ".cache/linux-arm64/downloads"))
    cache.mkdir(parents=True, exist_ok=True)
    file = cache / url.rsplit("/", 1)[-1]
    if not file.exists() or digest(file) != checksum:
        print(f"Downloading {url}", flush=True)
        partial = file.with_suffix(file.suffix + ".part")
        with urllib.request.urlopen(url, timeout=120) as source, partial.open("wb") as target:
            shutil.copyfileobj(source, target)
        if digest(partial) != checksum:
            raise ValueError(f"SHA256 mismatch: {url}")
        partial.replace(file)
    return file


def extract(archive, destination):
    checksum = digest(archive)
    marker = destination / '.source-sha256'
    if marker.exists() and marker.read_text() == checksum:
        return next(file for file in destination.iterdir() if file.is_dir())
    stage = destination.with_name(destination.name + '.extract')
    shutil.rmtree(stage, ignore_errors=True)
    stage.mkdir(parents=True)
    with tarfile.open(archive) as source:
        source.extractall(stage, filter="data")
    directories = [file for file in stage.iterdir() if file.is_dir()]
    if len(directories) != 1:
        raise ValueError('Expected one source directory in ' + str(archive))
    (stage / '.source-sha256').write_text(checksum)
    shutil.rmtree(destination, ignore_errors=True)
    stage.rename(destination)
    return destination / directories[0].name


def run(args, **kwargs):
    subprocess.run([str(arg) for arg in args], check=True, **kwargs)


def files_below(directory):
    return sorted(file for file in directory.rglob("*") if file.is_file() or file.is_symlink())


def inventory(sdk, files):
    return {str(file.relative_to(sdk)): {"link": os.readlink(file)} if file.is_symlink()
            else {"sha256": digest(file), "mode": file.stat().st_mode & 0o777} for file in files}


def read_record(sdk, name):
    file = sdk / "records" / (name + ".json")
    return json.loads(file.read_text()) if file.exists() else None


def cache_reason(sdk, record, recipe):
    if not record:
        return "no completed recipe"
    if record["recipe"] != recipe:
        changed = [key for key in recipe if record["recipe"].get(key) != recipe[key]]
        return "changed " + ", ".join(changed)
    for name, expected in record["files"].items():
        file = sdk / name
        if not file.is_file() and not file.is_symlink():
            return "missing " + name
        actual = {"link": os.readlink(file)} if file.is_symlink() else {"sha256": digest(file), "mode": file.stat().st_mode & 0o777}
        if actual != expected:
            return "changed output " + name
    return None


def complete(sdk, name, recipe, files):
    record = {"recipe": recipe, "files": inventory(sdk, files), "builderSha256": digest(Path(__file__))}
    write_changed(sdk / "records" / (name + ".json"), json.dumps(record, indent=2) + "\n")
    return record


def publish(sdk, name, stage):
    incoming = files_below(stage)
    previous = read_record(sdk, name)
    paths = {str(file.relative_to(stage)) for file in incoming}
    for record in (sdk / "records").glob("*.json"):
        if record.stem == name:
            continue
        overlap = paths & json.loads(record.read_text())["files"].keys()
        if overlap:
            raise ValueError(f"SDK installation ownership conflict: {name}: {sorted(overlap)}")
    for file in incoming:
        destination = sdk / file.relative_to(stage)
        destination.parent.mkdir(parents=True, exist_ok=True)
        if file.is_symlink():
            if destination.is_symlink() and os.readlink(file) == os.readlink(destination):
                continue
        elif destination.is_file() and not destination.is_symlink() and digest(file) == digest(destination):
            destination.chmod(file.stat().st_mode & 0o777)
            continue
        temporary = destination.with_name(destination.name + ".tmp")
        temporary.unlink(missing_ok=True)
        if file.is_symlink():
            temporary.symlink_to(os.readlink(file))
        else:
            shutil.copyfile(file, temporary)
            temporary.chmod(file.stat().st_mode)
        temporary.replace(destination)
    if previous:
        for old in previous["files"].keys() - paths:
            (sdk / old).unlink(missing_ok=True)
    return [sdk / path for path in sorted(paths)]


def recipes(sdk, spec):
    # Increment the recipe revision when compiler or build behavior changes.
    toolchain = {"revision": spec["revision"], "source": spec["sources"]["zig"],
                 "target": spec["target"], "cpu": spec["cpu"]}
    sysroot = {"packages": json.loads((ROOT / "sdk-packages.json").read_text()),
               "revision": spec["revision"]}
    result = {"toolchain": toolchain, "sysroot": sysroot}
    for name, component in spec["components"].items():
        result[name] = {"revision": spec["revision"], "source": spec["sources"][name],
                        "component": component, "toolchain": identity(toolchain),
                        "sysroot": identity(sysroot), "cmake": digest(TOOLCHAIN),
                        "prefix": str(sdk / "prefix"),
                        "dependencies": {dep: identity(result[dep]) for dep in component["dependencies"]}}
    return result


def compiler_drivers(sdk, spec):
    result = {}
    for name, command in (("cc", "cc"), ("c++", "c++"), ("ar", "ar"), ("ranlib", "ranlib")):
        flags = [] if name in ("ar", "ranlib") else ["-target", spec["target"], "-mcpu=" + spec["cpu"],
                "-fPIC", "-I" + str(sdk / "sysroot/usr/include/aarch64-linux-gnu")]
        result[name] = "#!/bin/sh\nexec " + shlex.join([str(sdk / "zig/zig"), command, *flags]) + ' "$@"\n'
    return result

def build_component(sdk, name, spec, recipe, jobs):
    prefix, work = sdk / "prefix", sdk / "work"
    work.mkdir(parents=True, exist_ok=True)
    stage = work / (name + "-install")
    shutil.rmtree(stage, ignore_errors=True)
    stage.mkdir()
    if name == "sysroot":
        target = stage / "sysroot"
        target.mkdir()
        for package in recipe["packages"]["packages"]:
            archive = download(recipe["packages"]["origin"] + package["Filename"], package["SHA256"])
            run(["dpkg-deb", "--extract", archive, target])
    elif name == "toolchain":
        zig = sdk / "zig"
        if (not zig.exists() or not (zig / "zig").exists() or
                (read_record(sdk, name) or {}).get("recipe") != recipe or
                cache_reason(sdk, read_record(sdk, name), recipe) == "changed output zig/zig"):
            shutil.rmtree(zig, ignore_errors=True)
            shutil.rmtree(work / "zig", ignore_errors=True)
            source = extract(download(recipe["source"]["url"], recipe["source"]["sha256"]), work / "zig")
            shutil.move(str(source), zig)
        for name_, text in compiler_drivers(sdk, spec).items():
            file = sdk / "bin" / name_
            write_changed(file, text)
            file.chmod(0o755)
        return [zig / "zig", *[sdk / "bin" / n for n in ["cc", "c++", "ar", "ranlib"]]]
    else:
        previous = read_record(sdk, name)
        source_recipe = {"source": recipe["source"], "patches": recipe["component"].get("patches", [])}
        source_record = work / (name + "-source.json")
        prior_source = json.loads(source_record.read_text()) if source_record.exists() else (
            {"source": previous["recipe"]["source"], "patches": previous["recipe"]["component"].get("patches", [])}
            if previous else None)
        # FFmpeg builds in its source tree; every rebuild must discard its objects.
        if name == "ffmpeg" or prior_source != source_recipe:
            shutil.rmtree(work / name, ignore_errors=True)
        build = work / (name + "-build")
        shutil.rmtree(build, ignore_errors=True)
        source = extract(download(recipe["source"]["url"], recipe["source"]["sha256"]), work / name)
        env = {**os.environ, "PMJS_SDK_ROOT": str(sdk), "PKG_CONFIG_PATH": "",
               "PKG_CONFIG_LIBDIR": str(prefix / "lib/pkgconfig"), "PKG_CONFIG_SYSROOT_DIR": ""}
        install_env = {**env, "DESTDIR": str(stage)}
        installed = stage / str(prefix).lstrip("/")
        component = recipe["component"]
        for file, before, after in component.get("patches", []):
            path = source / file
            text = path.read_text()
            if before in text:
                write_changed(path, text.replace(before, after))
            elif after not in text:
                raise ValueError(f"Pinned patch no longer matches: {path}")
        write_changed(source_record, json.dumps(source_recipe, sort_keys=True) + "\n")
        options = [option.format(prefix=prefix) for option in component["options"]]
        if name == "ffmpeg":
            run([source / "configure", *options,
                 *["--" + n + "=" + str(sdk / "bin" / binary) for n, binary in
                   [("cc", "cc"), ("cxx", "c++"), ("ar", "ar"), ("ranlib", "ranlib")]],
                 "--prefix=" + str(prefix), "--extra-cflags=-DPMJS_TOOLCHAIN_ID=" + recipe["toolchain"]], cwd=source, env=env)
            run(["make", "-j" + str(jobs)], cwd=source, env=env)
            run(["make", "install"], cwd=source, env=install_env)
        else:
            run(["cmake", "-S", source, "-B", build, "-G", "Ninja",
                 "-DCMAKE_TOOLCHAIN_FILE=" + str(TOOLCHAIN),
                 "-DCMAKE_BUILD_TYPE=Release", "-DCMAKE_INSTALL_PREFIX=" + str(prefix), "-DCMAKE_SKIP_RPATH=ON",
                 "-DCMAKE_C_FLAGS=-DPMJS_TOOLCHAIN_ID=" + recipe["toolchain"],
                 "-DCMAKE_CXX_FLAGS=-DPMJS_TOOLCHAIN_ID=" + recipe["toolchain"],
                 "-DCMAKE_INSTALL_LIBDIR=lib", "-DCMAKE_PREFIX_PATH=" + str(prefix),
                 "-DCMAKE_POSITION_INDEPENDENT_CODE=ON", "-DBUILD_SHARED_LIBS=ON", *options], env=env)
            run(["cmake", "--build", build, "--parallel", jobs], env=env)
            run(["cmake", "--install", build], env=install_env)
        notices = installed / "notices" / name
        notices.mkdir(parents=True)
        for pattern in ["LICENSE*", "COPYING*", "COPYRIGHT*", "README.ijg", "docs/FTL.TXT", "docs/GPLv2.TXT"]:
            for file in source.glob(pattern):
                if file.is_file():
                    shutil.copyfile(file, notices / file.name)
        if not any(notices.iterdir()):
            raise ValueError("Missing dependency notices: " + name)
        # DESTDIR embeds the absolute prefix; publication uses SDK-relative paths.
        relative = stage / "prefix"
        shutil.move(str(installed), relative)
        for file in list(stage.iterdir()):
            if file != relative:
                shutil.rmtree(file)
    return publish(sdk, name, stage)


def prepare_locked(sdk, jobs, explain=False, verify=False):
    spec = json.loads((ROOT / "sdk-recipes.json").read_text())
    desired = recipes(sdk, spec)
    if not explain and not verify:
        sdk.mkdir(parents=True, exist_ok=True)
    dirty = set()
    for name, recipe in desired.items():
        started = time.monotonic()
        record = read_record(sdk, name)
        reason = cache_reason(sdk, record, recipe)
        if name == "toolchain" and reason is None:
            if any((sdk / "bin" / driver).read_text() != text for driver, text in compiler_drivers(sdk, spec).items()):
                reason = "compiler wrapper paths or arguments changed"
        dependencies = ["toolchain", "sysroot", *recipe.get("component", {}).get("dependencies", [])] if name not in ("toolchain", "sysroot") else []
        if dirty.intersection(dependencies):
            reason = "changed dependency " + ", ".join(sorted(dirty.intersection(dependencies)))
        if reason:
            if verify:
                raise ValueError(f"SDK {name}: {reason}; run prepare-sdk.py --sdk {sdk}")
            print(f"SDK {name}: rebuild ({reason})", flush=True)
            dirty.add(name)
            if not explain:
                files = build_component(sdk, name, spec, recipe, jobs)
                complete(sdk, name, recipe, files)
        else:
            print(f"SDK {name}: unchanged", flush=True)
        print(f"SDK {name}: {(time.monotonic() - started):.2f}s", flush=True)
    if explain:
        return
    metadata = sdk_metadata(sdk, verify)
    for file, text in metadata.items():
        if verify:
            if not file.exists() or file.read_text() != text:
                raise ValueError(f'SDK generated metadata changed: {file}; run prepare-sdk.py --sdk {sdk}')
        else:
            write_changed(file, text)
    if not verify:
        print(f"Portable SDK ready: {sdk}")


def sdk_metadata(sdk, verify):
    result = {}
    pc_dir = sdk / "prefix/lib/pkgconfig"
    for file in (sdk / "sysroot/usr/lib/aarch64-linux-gnu/pkgconfig").glob("*.pc"):
        text = file.read_text().replace("prefix=/usr", "prefix=" + str(sdk / "sysroot/usr"))
        text = text.replace("/usr/lib/aarch64-linux-gnu", str(sdk / "sysroot/usr/lib/aarch64-linux-gnu"))
        if file.name in ("egl.pc", "glesv2.pc"):
            text = "\n".join(line for line in text.splitlines() if not line.startswith(("Requires.private:", "Libs.private:"))) + "\n"
        result[pc_dir / file.name] = text
    # Check derived provider files before pkg-config can consume them.
    for file, text in result.items():
        if verify and (not file.exists() or file.read_text() != text):
            raise ValueError('SDK provider metadata changed: ' + str(file))
        if not verify:
            write_changed(file, text)
    env = {**os.environ, "PKG_CONFIG_PATH": "", "PKG_CONFIG_LIBDIR": str(pc_dir), "PKG_CONFIG_SYSROOT_DIR": ""}
    lock = []
    for name, package in {"SDL2": "sdl2", "EGL": "egl", "GLES": "glesv2", "PNG": "libpng", "ZLIB": "zlib",
                          "JPEG": "libjpeg", "FREETYPE": "freetype2", "HARFBUZZ": "harfbuzz", "AVFORMAT": "libavformat",
                          "AVCODEC": "libavcodec", "AVUTIL": "libavutil", "SWRESAMPLE": "libswresample", "SWSCALE": "libswscale"}.items():
        value = subprocess.check_output(["pkg-config", "--modversion", package], env=env, text=True).strip()
        lock.append(f"set(PMJS_LOCK_{name} {value})")
    result[sdk / "dependencies.cmake"] = "\n".join(lock) + "\n"
    return result


def prepare(sdk, jobs, explain=False):
    if explain:
        return prepare_locked(sdk, jobs, True)
    sdk.parent.mkdir(parents=True, exist_ok=True)
    with (sdk.parent / (sdk.name + ".lock")).open("a") as guard:
        fcntl.flock(guard, fcntl.LOCK_EX)
        prepare_locked(sdk, jobs)


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--sdk", type=Path, default=ROOT.parent.parent / ".cache/linux-arm64/sdk")
    parser.add_argument("--jobs", type=int, default=4)
    parser.add_argument("--explain", action="store_true")
    parser.add_argument("--verify", action="store_true")
    args = parser.parse_args()
    try:
        if not args.verify and not args.explain:
            for variable in ('CPATH', 'C_INCLUDE_PATH', 'CPLUS_INCLUDE_PATH', 'LIBRARY_PATH', 'CFLAGS', 'CXXFLAGS', 'LDFLAGS'):
                if os.environ.get(variable):
                    raise ValueError(f"Unset {variable}; SDK build settings belong in sdk-recipes.json")
        if args.verify:
            prepare_locked(args.sdk.resolve(), args.jobs, verify=True)
        else:
            prepare(args.sdk.resolve(), args.jobs, args.explain)
    except (ValueError, OSError, subprocess.CalledProcessError) as error:
        parser.exit(1, str(error) + "\n")
