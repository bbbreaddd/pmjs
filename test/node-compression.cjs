'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const path = require('node:path');
const { loadPmjsRuntime, runModule } = require('./helpers/runtime-context.cjs');
const native = require(path.resolve(process.argv[2]));
const codec = native.compression;

// Vectors from the legacy 16-bit-word Base64 codec.
for (const [text, encoded] of [
  ['', 'QAA='], ['hello', 'BYUwNmD2QAA='], ['こんにちは', 'soMmSGTWDIhgyPYMQAA='],
  ['\u0000\ud800\udfff\uffff', 'ACAA3P/7j//0AA=='], ['abcabcabcabc', 'IYIwxqHpQAA=']
]) {
  assert.equal(codec.compressLZString(text), encoded);
  assert.equal(codec.decompressLZString(encoded), text);
  assert.equal(codec.decompressLZString('\n' + encoded + ' !'), text);
}
assert.equal(codec.decompressLZString(''), null);
for (const input of [null, undefined, 1, {}, []]) {
  assert.throws(() => codec.compressLZString(input));
  assert.throws(() => codec.decompressLZString(input));
}
const allUnits = Array.from({ length: 65536 }, (_, i) => String.fromCharCode(i)).join('');
assert.equal(codec.decompressLZString(codec.compressLZString(allUnits)), allUnits);
assert.equal(codec.decompressLZString(codec.compressLZString('a'.repeat(100000))), 'a'.repeat(100000));

if (process.env.PMJS_LZ_STRING_REFERENCE) {
  const reference = fs.readFileSync(process.env.PMJS_LZ_STRING_REFERENCE, 'utf8');
  const lz = vm.runInNewContext(reference + '; LZString');
  let seed = 12345;
  const random = () => { seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0; return seed; };
  const compare = text => {
    const encoded = lz.compressToBase64(text);
    assert.equal(codec.compressLZString(text), encoded);
    assert.equal(codec.decompressLZString(encoded), text);
    assert.equal(lz.decompressFromBase64(codec.compressLZString(text)), text);
  };
  compare(allUnits);
  for (let trial = 0; trial < 100; trial++) {
    let text = '';
    const length = random() % 4000;
    for (let i = 0; i < length; i++) text += String.fromCharCode(random() % (trial % 2 ? 65536 : 128));
    compare(text);
  }
  for (let trial = 0; trial < 1000; trial++) {
    let text = '';
    const length = random() % 50;
    for (let i = 0; i < length; i++) text += 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/= !'[random() % 67];
    let expected, failed = false;
    try { expected = lz.decompressFromBase64(text); } catch (_) { failed = true; }
    if (failed) assert.throws(() => codec.decompressLZString(text));
    else assert.equal(codec.decompressLZString(text), expected, JSON.stringify(text));
  }
  let compressions = 0, decompressions = 0;
  const storage = { readText() { return lz.compressToBase64('hello'); }, generation() { return 0; }, exists() { return true; } };
  const ctx = loadPmjsRuntime({ __pmjsBuiltinRequire: require, queueMicrotask,
    NativeHost: { storage, compression: {
      compressLZString(input) { compressions++; return codec.compressLZString(input); },
      decompressLZString(input) { decompressions++; return codec.decompressLZString(input); }
    } }, StorageManager: { localFilePath() { return '/save/file'; }, loadFromLocalFile() {}, localFileExists() {} } });
  vm.runInContext(reference, ctx);
  runModule(ctx, 'js/pmjs-mv/storage.js');
  ctx.installNativeStorageManager();
  assert.equal(ctx.LZString.compressToBase64('hello'), lz.compressToBase64('hello'));
  assert.equal(compressions, 1);
  assert.equal(ctx.StorageManager.loadFromLocalFile(1), 'hello');
  assert.equal(decompressions, 1);
  const originalCompress = ctx.LZString.compress;
  ctx.LZString.compress = () => 'custom';
  lz.compress = () => 'custom';
  assert.equal(ctx.LZString.compressToBase64('hello'), lz.compressToBase64('hello'));
  assert.equal(compressions, 1);
  ctx.LZString.compress = originalCompress;
  ctx.LZString.compressToBase64('hello');
  assert.equal(compressions, 2);
  const originalPow = vm.runInContext('Math.pow', ctx);
  vm.runInContext('Math.pow = function(a, b) { return a ** b; }', ctx);
  ctx.LZString.compressToBase64('hello');
  assert.equal(compressions, 2);
  vm.runInContext('Math', ctx).pow = originalPow;
  assert.equal(ctx.LZString.compressToBase64(null), '');
  assert.equal(compressions, 2);
  ctx.LZString.decompressFromBase64 = () => 'custom';
  assert.equal(ctx.StorageManager.loadFromLocalFile(1), 'custom');
  assert.equal(decompressions, 1);
}
console.log('LZString compression compatibility passed');
