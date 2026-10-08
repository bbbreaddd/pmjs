'use strict';
const assert = require('node:assert/strict');
const { spawnSync } = require('node:child_process');
const path = require('node:path');
const test = require('node:test');
const { temporaryDirectory } = require('./helpers/temp.cjs');

test('Skia raster cache preserves pinned sources and archive integrity', () => {
  const result = spawnSync('python3', [path.resolve(__dirname, '../tools/skia65/build_test.py')], { encoding: 'utf8' });
  assert.equal(result.status, 0, result.stdout + result.stderr);
});

test('Skia compiler and Python wrappers use resolved executables outside system directories', () => {
  const script = String.raw`
import sys, os, pathlib, subprocess
from types import SimpleNamespace
from unittest import mock
root, directory = map(pathlib.Path, sys.argv[1:])
sys.path.insert(0, str(root / 'tools/skia65'))
import build, raster
binaries = directory / 'tools with spaces'
binaries.mkdir()
for name in ['clang-20', 'clang++-20', 'python', 'llvm-strip-20']:
    executable = binaries / name
    version = 'LLVM version 20.1.2 fixture' if name == 'llvm-strip-20' else 'clang version 20.1.2 fixture'
    executable.write_text('#!/bin/sh\nif [ "$1" = "--version" ]; then echo "' + version + '"; else printf "%s\\n" "' + name + '" "$@"; fi\n')
    executable.chmod(0o755)
os.environ['PATH'] = str(binaries) + os.pathsep + os.environ['PATH']
cache = directory / 'cache'
(cache / 'tools').mkdir(parents=True)
class StopBuild(Exception): pass
with mock.patch.object(raster, 'provision', return_value={'clangVersion':'20.1.2', 'tools':[]}), \
     mock.patch.object(raster, 'replace', side_effect=StopBuild), \
     mock.patch.object(raster.sys, 'executable', str(binaries / 'python')):
    try: build.build(SimpleNamespace(cache=cache, arch='x64', sdk=None, output=directory / 'component', verify=False, reuse=False))
    except StopBuild: pass
for wrapper, name in [('clang','clang-20'), ('clang++','clang++-20'), ('python','python')]:
    actual = subprocess.check_output([cache / 'tools' / wrapper, 'argument with spaces'], text=True)
    assert actual.splitlines() == [name, 'argument with spaces'], actual
missing = directory / 'missing-cache'
output = directory / 'missing-output'
build.build(SimpleNamespace(cache=missing, arch='x64', sdk=None, output=output, verify=False,
                            reuse=False, explain=True, mask_test=False))
assert not missing.exists() and not output.exists()
assert not missing.with_suffix('.lock').exists()
`;
  const result = spawnSync('python3', ['-c', script, path.resolve(__dirname, '..'),
    temporaryDirectory('pmjs-build-tools-')], { encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr);
});
