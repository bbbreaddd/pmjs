'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const vm = require('node:vm');
const { temporaryDirectory } = require('./helpers/temp.cjs');

const tool = fs.readFileSync(path.join(__dirname, '../tools/game-font-reference.cjs'), 'utf8');

async function capture(engine, failAt) {
  const root = temporaryDirectory('pmjs-font-tool-');
  const font = path.join(root, 'font.ttf');
  fs.writeFileSync(font, 'font fixture');
  const manifest = path.join(root, 'manifest.json');
  fs.writeFileSync(manifest, JSON.stringify({ fonts: [
    { path: font, size: 24, cases: ['Text'] },
    { path: font, size: 24, cases: ['More text'] }
  ] }));
  const output = path.join(root, 'reference.json');
  fs.writeFileSync(output, 'previous complete reference');
  const calls = [];
  const errors = [];
  let stagedRoot;
  let reads = 0;
  const native = {
    initialize(options) { stagedRoot = options.gameRoot; calls.push('initialize'); },
    runtime: { quit() { calls.push('quit'); } },
    canvas: {
      measureTextMetrics() { return { width: 42 }; },
      create() { calls.push('create'); return { handle: reads + 1 }; },
      drawText() { calls.push('draw'); if (failAt === 'draw') throw new Error('draw failed'); },
      readPixels() {
        reads++;
        if (failAt === 'read' && reads === 2) throw new Error('read failed');
        return new Uint8Array(1024 * 192 * 4);
      },
      release() { calls.push('release'); }
    }
  };
  const electron = {
    app: { whenReady: async () => {}, quit() { calls.push('quit'); },
      exit(code) { calls.push('exit:' + code); } },
    BrowserWindow: class {
      async loadURL() { if (failAt === 'load') throw new Error('load failed'); }
      webContents = { executeJavaScript: async () => {
        reads++;
        if (failAt === 'read' && reads === 2) throw new Error('read failed');
        return [];
      } };
      destroy() { calls.push('destroy'); }
    }
  };
  const processFixture = { versions: engine === 'electron' ? { electron: 'test' } : {},
    argv: ['node', 'tool', '--manifest', manifest, '--output', output,
      '--addon', path.join(root, 'addon.node')] };
  await vm.runInNewContext(tool, {
    require(name) {
      if (name === 'electron') return electron;
      if (name === path.join(root, 'addon.node')) return native;
      return require(name);
    },
    process: processFixture, console: { error(error) { errors.push(error.message); } }
  }, { filename: 'game-font-reference.cjs' });
  return { output, calls, errors, stagedRoot, processFixture };
}

test('native font capture releases canvases, shuts down and removes staged inputs', async () => {
  const result = await capture('native');
  assert.equal(JSON.parse(fs.readFileSync(result.output, 'utf8')).fonts.length, 2);
  assert.deepEqual(result.calls, ['initialize', 'create', 'draw', 'release',
    'create', 'draw', 'release', 'quit']);
  assert.equal(fs.existsSync(result.stagedRoot), false);
  assert.deepEqual(result.errors, []);
});

for (const failAt of ['draw', 'read']) {
  test('native font capture cleans up a failed ' + failAt + ' and retains the previous reference', async () => {
    const result = await capture('native', failAt);
    assert.equal(result.calls.filter(call => call === 'create').length,
      result.calls.filter(call => call === 'release').length);
    assert.equal(result.calls.at(-1), 'quit');
    assert.equal(fs.existsSync(result.stagedRoot), false);
    assert.equal(fs.readFileSync(result.output, 'utf8'), 'previous complete reference');
    assert.deepEqual(result.errors, [failAt + ' failed']);
    assert.equal(result.processFixture.exitCode, 1);
  });
}

for (const failAt of ['load', 'read']) {
  test('Electron font capture cleans up a failed ' + failAt + ' without publishing a partial reference', async () => {
    const result = await capture('electron', failAt);
    assert.deepEqual(result.calls, ['destroy', 'quit', 'exit:1']);
    assert.equal(fs.readFileSync(result.output, 'utf8'), 'previous complete reference');
    assert.deepEqual(result.errors, [failAt + ' failed']);
  });
}
