'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const test = require('node:test');

test('guest process retains monotonic tuple, difference and bigint clocks', () => {
  const hostCwd = process.cwd();
  const context = vm.createContext({ process, PMJS: { config: {} },
    nativePlatform: { platform: process.platform, arch: process.arch }, NativeHost: { runtime: {} } });
  vm.runInContext(fs.readFileSync(path.join(__dirname, '../js/pmjs-web/modules.js'), 'utf8'), context);
  const before = process.hrtime.bigint();
  const start = context.process.hrtime();
  const diff = context.process.hrtime(start);
  const bigint = context.process.hrtime.bigint();
  const after = process.hrtime.bigint();
  assert.equal(start.length, 2);
  assert.equal(diff.length, 2);
  for (const [seconds, nanoseconds] of [start, diff]) {
    assert.ok(Number.isInteger(seconds) && seconds >= 0);
    assert.ok(Number.isInteger(nanoseconds) && nanoseconds >= 0 && nanoseconds < 1e9);
  }
  assert.ok(bigint >= before && bigint <= after);
  assert.throws(() => context.process.hrtime('invalid'), { code: 'ERR_INVALID_ARG_TYPE' });
  assert.equal(context.process.cwd(), '/game');
  assert.equal(process.cwd(), hostCwd);
});
