#!/usr/bin/env python3
"""Provision the release's private raster sources, verifying every download."""
import concurrent.futures
import hashlib
import json
import pathlib
import shutil
import tarfile
import urllib.request
import zipfile

ROOT = pathlib.Path(__file__).resolve().parents[2]
LOCK = pathlib.Path(__file__).with_name("sources.lock.json")


def digest(path):
    return hashlib.sha256(path.read_bytes()).hexdigest()


def extract_member(source, member, destination):
    # Verify extracted bytes against the archive on every invocation, while
    # preserving mtimes for unchanged compiler inputs. GN adaptations are
    # restored from the pinned input rather than becoming source authority.
    member = tarfile.data_filter(member, destination)
    if member is None:
        return
    target = destination / member.name
    if member.isfile() and target.is_file() and not target.is_symlink():
        with source.extractfile(member) as original:
            if target.read_bytes() == original.read():
                return
    source.extract(member, destination, filter="data")


def download(url, destination, checksum):
    destination.parent.mkdir(parents=True, exist_ok=True)
    if destination.exists():
        if digest(destination) != checksum:
            raise RuntimeError(f"Checksum mismatch in cached input: {destination}")
        return
    temporary = destination.with_suffix(destination.suffix + ".download")
    try:
        request = urllib.request.Request(url, headers={"User-Agent": "pmjs-skia65"})
        with urllib.request.urlopen(request, timeout=60) as source, temporary.open("wb") as output:
            shutil.copyfileobj(source, output)
        if digest(temporary) != checksum:
            raise RuntimeError(f"Checksum mismatch downloading {url}")
        temporary.replace(destination)
    finally:
        temporary.unlink(missing_ok=True)


def provision(cache):
    lock = json.loads(LOCK.read_text())
    cache.mkdir(parents=True, exist_ok=True)
    # Always compare with verified archives, including existing source trees.
    for archive in lock["archives"]:
        filename = cache / (archive["name"] + ".tar.gz")
        download(archive["url"], filename, archive["sha256"])
        with tarfile.open(filename) as source:
            for member in source.getmembers():
                parts = pathlib.PurePosixPath(member.name).parts[archive["strip"]:]
                if not parts:
                    continue
                member.name = str(pathlib.PurePosixPath(archive["name"], *parts))
                extract_member(source, member, cache)
    chromium = cache / "chromium"
    base = "https://raw.githubusercontent.com/nwjs/chromium.src/" + lock["chromium"] + "/"

    def fetch(entry):
        download(base + entry["path"], chromium / entry["path"], entry["sha256"])

    with concurrent.futures.ThreadPoolExecutor(max_workers=8) as workers:
        list(workers.map(fetch, lock["files"]))
    tools = cache / "tools"
    tools.mkdir(exist_ok=True)
    for tool in lock["tools"]:
        archive = cache / (tool["name"] + (".zip" if "zipMember" in tool else ".bin"))
        download(tool["url"], archive, tool["sha256"])
        executable = tools / tool["name"]
        if "zipMember" in tool:
            with zipfile.ZipFile(archive) as source:
                executable.write_bytes(source.read(tool["zipMember"]))
        else:
            shutil.copyfile(archive, executable)
        executable.chmod(0o755)
    (cache / "provision.json").write_text(json.dumps({
        "lockSha256": digest(LOCK), "dependencies": lock,
    }, indent=2) + "\n")
    return lock


if __name__ == "__main__":
    import argparse
    parser = argparse.ArgumentParser()
    parser.add_argument("--cache", type=pathlib.Path, default=ROOT / ".cache/skia65")
    provision(parser.parse_args().cache.resolve())
