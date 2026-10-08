'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { createHash } = require('node:crypto');
const { spawnSync } = require('node:child_process');
const test = require('node:test');
const { temporaryDirectory } = require('./helpers/temp.cjs');

function fixture() {
  const root = temporaryDirectory('pmjs-fetchcontent-');
  const upstream = path.join(root, 'upstream');
  fs.mkdirSync(upstream);
  fs.writeFileSync(path.join(upstream, 'tiles.txt'), 'old first\ncontext\nold second\n');
  fs.writeFileSync(path.join(upstream, 'dummy.c'), 'int dummy;\n');
  fs.writeFileSync(path.join(upstream, 'CMakeLists.txt'),
    'add_library(Effekseer STATIC dummy.c)\nadd_library(EffekseerRendererGL STATIC dummy.c)\n');
  const archive = path.join(root, 'upstream.tar');
  assert.equal(spawnSync('cmake', ['-E', 'tar', 'cf', archive, 'upstream'], { cwd: root }).status, 0);
  const sha = createHash('sha256').update(fs.readFileSync(archive)).digest('hex');
  const module = fs.readFileSync(path.resolve(__dirname, '../cmake/Effekseer.cmake'), 'utf8')
    .replace(/set\(effekseer_archive_sha "[^"]+"\)/, `set(effekseer_archive_sha "${sha}")`)
    .replace('https://codeload.github.com/effekseer/Effekseer/tar.gz/${effekseer_revision}', archive);
  fs.writeFileSync(path.join(root, 'Effekseer.cmake'), module);
  fs.mkdirSync(path.join(root, 'third_party'));
  const patch = path.join(root, 'third_party/effekseer-mz.patch');
  fs.writeFileSync(patch, '--- a/tiles.txt\n+++ b/tiles.txt\n@@ -1,3 +1,3 @@\n-old first\n+new first\n context\n old second\n');
  fs.writeFileSync(path.join(root, 'CMakeLists.txt'),
    'cmake_minimum_required(VERSION 3.20)\nproject(patch_test C)\n' +
    'add_library(PkgConfig::GLES INTERFACE IMPORTED)\nadd_library(PkgConfig::EGL INTERFACE IMPORTED)\n' +
    'include(Effekseer.cmake)\nFetchContent_GetProperties(pmjs_effekseer)\nfile(WRITE "${CMAKE_BINARY_DIR}/source.txt" "${pmjs_effekseer_SOURCE_DIR}")\n');
  const build = path.join(root, 'build');
  return { upstream, patch, run(...args) {
    return spawnSync('cmake', ['-S', root, '-B', build, ...args], { encoding: 'utf8' });
  }, source() { return fs.readFileSync(path.join(build, 'source.txt'), 'utf8'); } };
}

function succeeds(result) {
  assert.equal(result.status, 0, result.stdout + result.stderr);
}

test('updated same-file patches populate fresh sources and unchanged patches reuse them', () => {
  const f = fixture();
  succeeds(f.run());
  const first = f.source();
  assert.equal(fs.readFileSync(path.join(first, 'tiles.txt'), 'utf8'), 'new first\ncontext\nold second\n');
  fs.writeFileSync(f.patch, '--- a/tiles.txt\n+++ b/tiles.txt\n@@ -1,3 +1,3 @@\n-old first\n+new first\n context\n-old second\n+new second\n');
  succeeds(f.run());
  const second = f.source();
  assert.notEqual(second, first);
  assert.equal(fs.readFileSync(path.join(second, 'tiles.txt'), 'utf8'), 'new first\ncontext\nnew second\n');
  fs.writeFileSync(path.join(second, 'retained'), 'sentinel');
  succeeds(f.run());
  assert.equal(f.source(), second);
  assert.equal(fs.readFileSync(path.join(second, 'retained'), 'utf8'), 'sentinel');
});

test('incompatible patches fail during population', () => {
  const f = fixture();
  fs.writeFileSync(f.patch, '--- a/tiles.txt\n+++ b/tiles.txt\n@@ -1 +1 @@\n-missing\n+new\n');
  assert.notEqual(f.run().status, 0);
});

test('custom sources must be patched already and are never modified', () => {
  const f = fixture();
  const override = `-DFETCHCONTENT_SOURCE_DIR_PMJS_EFFEKSEER=${f.upstream}`;
  const result = f.run(override);
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /must already contain the pinned patch/);
  assert.equal(fs.readFileSync(path.join(f.upstream, 'tiles.txt'), 'utf8'), 'old first\ncontext\nold second\n');
  fs.writeFileSync(path.join(f.upstream, 'tiles.txt'), 'new first\ncontext\nold second\n');
  succeeds(f.run(override));
  assert.equal(f.source(), f.upstream);
  assert.equal(fs.readFileSync(path.join(f.upstream, 'tiles.txt'), 'utf8'), 'new first\ncontext\nold second\n');
});
