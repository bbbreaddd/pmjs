#!/usr/bin/env python3
"""Build and atomically install PMJS using prepared dependencies."""

import argparse
import os
from pathlib import Path
import shutil
import subprocess
import sys

from dependencies import arm64_environment, prepare_arm64
from runtime_artifact import checked_runtime, recognize_runtime

ROOT = Path(__file__).resolve().parent.parent


def run(*args, env=None):
    subprocess.run([str(arg) for arg in args], cwd=ROOT, env=env, check=True)


def require(commands):
    missing = [name for name in commands if shutil.which(name) is None]
    if missing:
        raise ValueError("Missing build tools: " + ", ".join(missing) +
                         ". Install the host requirements in README.md.")


def main():
    parser = argparse.ArgumentParser(description="Build a runnable PMJS installation")
    parser.add_argument("--target", choices=["local", "arm64"], default="local")
    parser.add_argument("--jobs", type=int, default=min(os.cpu_count() or 1, 4))
    parser.add_argument("--output", type=Path)
    parser.add_argument("--build-type", choices=["Debug", "Release", "RelWithDebInfo"])
    args = parser.parse_args()
    if args.jobs < 1:
        parser.error("--jobs must be positive")
    if sys.platform != "linux":
        parser.error("PMJS builds require Linux")
    require(["cmake", "ninja", "pkg-config", "git", "python3"])
    output = (args.output or ROOT / "dist" /
              ("pmjs-arm64" if args.target == "arm64" else "pmjs"))
    if output.is_symlink():
        raise ValueError(f"Output cannot be a symbolic link: {output}")
    output = output.resolve()
    if output in (ROOT, ROOT / "build", ROOT / "dist"):
        parser.error("output must be an installation directory")
    if output.exists():
        if not output.is_dir():
            raise ValueError(f"Output is not a directory: {output}")
        if any(output.iterdir()):
            if not (output / "build-info.json").is_file():
                raise ValueError(f"Output contains unrelated files: {output}")
            try:
                recognize_runtime(output)
            except (OSError, ValueError, KeyError) as error:
                raise ValueError(f"Output is not a recognized PMJS installation: {output}") from error
    env = os.environ.copy()
    preset = "dev"
    if args.target == "arm64":
        prepare_arm64(args.jobs)
        env = arm64_environment()
        preset = "linux-arm64"
    else:
        require(["c++", "node"])
        packages = ("sdl2", "egl", "glesv2", "libpng", "libwebp", "zlib", "libjpeg",
                    "freetype2", "harfbuzz", "libavformat", "libavcodec", "libavutil",
                    "libswresample", "libswscale")
        missing = [package for package in packages if subprocess.run(
            ["pkg-config", "--exists", package], check=False).returncode != 0]
        if missing:
            raise ValueError("Missing native development libraries: " + ", ".join(missing) +
                             ". See README.md.")
    build_name = "pmjs-arm64" if args.target == "arm64" else "local"
    if args.build_type:
        build_name += "-" + args.build_type.lower()
    build_dir = ROOT / "build" / build_name
    configuration = ["-DCMAKE_BUILD_TYPE=" + args.build_type] if args.build_type else []
    run("cmake", "--preset", preset, "-B", build_dir, "-DBUILD_TESTING=OFF", *configuration, env=env)
    run("cmake", "--build", build_dir, "--target", "pmjs_native",
        "--parallel", args.jobs, env=env)
    output.parent.mkdir(parents=True, exist_ok=True)
    stage = output.parent / f".{output.name}.stage-{os.getpid()}"
    backup = output.parent / f".{output.name}.previous-{os.getpid()}"
    try:
        stage.mkdir()
        if args.target == "arm64":
            for component in ("native-addon", "runtime"):
                run("cmake", "--install", build_dir, "--prefix", stage, "--component", component, env=env)
        else:
            run("cmake", "--install", build_dir, "--prefix", stage, env=env)
        checked_runtime(stage)
        if output.exists():
            output.rename(backup)
        try:
            stage.rename(output)
        except BaseException:
            if backup.exists():
                backup.rename(output)
            raise
        if backup.exists():
            shutil.rmtree(backup)
    finally:
        if stage.exists():
            shutil.rmtree(stage)
    print(f"PMJS installed: {output / 'bin/pmjs'}")
    if args.target == "arm64":
        print("ARM64 runtime is ready; run this executable on the target device.")


if __name__ == "__main__":
    try:
        main()
    except (ValueError, OSError, subprocess.CalledProcessError) as error:
        print(f"build: {error}", file=sys.stderr)
        sys.exit(1)
