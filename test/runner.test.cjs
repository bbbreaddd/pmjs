'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const { parse } = require('../runner/cli.cjs');
const { run, validate } = require('../runner/index.cjs');

function fixture(source) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'pmjs-runner-'));
  const bootstrap = path.join(root, 'bootstrap.js');
  fs.writeFileSync(bootstrap, source);
  return { addon: path.join(root, 'addon.node'), gameRoot: root, bootstrap,
    saveRoot: path.join(root, 'save'), width: 320, height: 240, title: 'Test' };
}
function native(polls = [false]) {
  let now = 0;
  return { initialize() {}, pollEvents: () => polls.shift() ?? false,
    finishLogicStep() {}, beginFrame() {}, renderFrame() {}, swapFrame() {},
    runtime: { monotonicNow: () => (now += 100), quit() {} }, fs: { readText() { return null; } },
    render: {}, scene: {}, images: {}, assets: {}, input: {}, canvas: {}, media: {} };
}

test('CLI parses the documented options', () => {
  const value = parse(['--addon','a','--game-root','g','--bootstrap','b','--save-root','s','--width','640','--height','480','--image-warm-cache-bytes','1024']);
  assert.equal(value.width, 640); assert.equal(value.height, 480);
  assert.equal(value.imageWarmCacheBytes, 1024);
});
test('validation rejects missing paths and dimensions', () => {
  assert.throws(() => validate({}), /addon is required/);
  assert.throws(() => validate({ addon:'a', gameRoot:'g', bootstrap:'b', saveRoot:'s', width:0, height:1 }), /width/);
  assert.throws(() => validate({ addon:'a', gameRoot:'g', bootstrap:'b', saveRoot:'s', width:1, height:1,
    imageWarmCacheBytes: -1 }), /imageWarmCacheBytes/);
  assert.equal(Object.hasOwn(validate({ addon:'a', gameRoot:'g', bootstrap:'b', saveRoot:'s',
    width:1, height:1 }), 'imageWarmCacheBytes'), false);
  assert.equal(validate({ addon:'a', gameRoot:'g', bootstrap:'b', saveRoot:'s', width:1, height:1,
    imageWarmCacheBytes: 0 }).imageWarmCacheBytes, 0);
});
test('afterBootstrap runs once and Node jobs are not starved', async () => {
  const options = fixture('globalThis.__pmjsTick=()=>{};globalThis.__pmjsRender=()=>{};');
  options.native = native();
  let hooked = 0;
  const job = new Promise(resolve => setImmediate(resolve));
  await run(options, { afterBootstrap({ native: host }) {
    hooked++;
    assert.deepEqual(host.runtime.platform(),
      { platform: process.platform, arch: process.arch });
  } });
  await job;
  assert.equal(hooked, 1);
});
test('bootstrap and tick failures reject the run', async () => {
  const bootstrap = fixture('throw new Error("bootstrap failure")');
  bootstrap.native = native();
  await assert.rejects(run(bootstrap), /bootstrap failure/);
  const tick = fixture('globalThis.__pmjsTick=()=>{throw new Error("tick failure")};globalThis.__pmjsRender=()=>{};');
  tick.native = native([true]);
  await assert.rejects(run(tick), /tick failure/);
});
