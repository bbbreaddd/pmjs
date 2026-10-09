#!/usr/bin/env python3
"""Prepare and verify the pinned target Node binary, headers and complete notice."""
import argparse
import fcntl
import hashlib
import json
import shutil
import tarfile
import urllib.request
from pathlib import Path

ROOT = Path(__file__).resolve().parent


def digest(file):
    with file.open('rb') as stream:
        return hashlib.file_digest(stream, 'sha256').hexdigest()


def inventory(root):
    return {str(file.relative_to(root)): digest(file) for file in sorted(root.rglob('*'))
            if file.is_file() and file.name != 'pmjs-node.json'}


def verify(root, spec):
    record = json.loads((root / 'pmjs-node.json').read_text())
    if record.get('layout') != 'runtime-sdk' or record['source'] != spec or record['files'] != inventory(root):
        raise ValueError('Node SDK identity mismatch; run prepare-node.py to restore it')
    for name in ['bin/node', 'include/node/node_api.h', 'LICENSE']:
        if not (root / name).is_file():
            raise ValueError('Node SDK missing ' + name)


def prepare(root, cache, spec):
    try:
        verify(root, spec)
        print('Node SDK verified:', root)
        return
    except (OSError, ValueError, KeyError):
        pass
    cache.mkdir(parents=True, exist_ok=True)
    archive = cache / spec['artifact']
    if not archive.is_file() or digest(archive) != spec['sha256']:
        temporary = archive.with_suffix('.part')
        with urllib.request.urlopen(spec['url'], timeout=60) as source, temporary.open('wb') as target:
            shutil.copyfileobj(source, target)
        if digest(temporary) != spec['sha256']:
            raise ValueError('Node archive checksum mismatch')
        temporary.replace(archive)
    stage = root.with_name(root.name + '.stage')
    shutil.rmtree(stage, ignore_errors=True)
    stage.mkdir(parents=True)
    with tarfile.open(archive) as source:
        prefix = spec['artifact'].removesuffix('.tar.xz') + '/'
        required = ['bin/node', 'LICENSE', 'include/node/']
        members = [member for member in source.getmembers()
                   if member.name.startswith(prefix) and
                   (member.name.removeprefix(prefix) in required[:2] or
                    member.name.removeprefix(prefix).startswith(required[2]))]
        source.extractall(stage, members=members, filter='data')
    extracted = stage / spec['artifact'].removesuffix('.tar.xz')
    record = {'layout': 'runtime-sdk', 'source': spec, 'files': inventory(extracted)}
    (extracted / 'pmjs-node.json').write_text(json.dumps(record, indent=2) + '\n')
    verify(extracted, spec)
    shutil.rmtree(root, ignore_errors=True)
    extracted.rename(root)
    stage.rmdir()
    print('Node SDK ready:', root)


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--output', type=Path, default=ROOT.parent.parent / '.cache/linux-arm64/node')
    parser.add_argument('--cache', type=Path, default=ROOT.parent.parent / '.cache/linux-arm64/downloads')
    parser.add_argument('--verify', action='store_true')
    args = parser.parse_args()
    spec = json.loads((ROOT / 'node.json').read_text())
    try:
        if args.verify:
            verify(args.output.resolve(), spec)
        else:
            args.output.parent.mkdir(parents=True, exist_ok=True)
            with args.output.with_suffix('.lock').open('a') as guard:
                fcntl.flock(guard, fcntl.LOCK_EX)
                prepare(args.output.resolve(), args.cache.resolve(), spec)
    except (OSError, ValueError, KeyError) as error:
        parser.exit(1, str(error) + '\n')
