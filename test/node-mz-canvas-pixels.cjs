'use strict';

const assert = require('node:assert/strict'), fs = require('node:fs'), path = require('node:path'), crypto = require('node:crypto');
const { createHostContext } = require('./helpers/mz-host-context.cjs');
const { canvasFixtures } = require('./helpers/mz-canvas-scenario.cjs');
const expected = require('./assets/reference/mz-canvas.json');
assert.equal(expected.scenarioSha256, crypto.createHash('sha256').update(fs.readFileSync(
  path.join(__dirname, 'helpers/mz-canvas-scenario.cjs'))).digest('hex'));
const native = require(path.resolve(process.argv[2]));
native.initialize({ gameRoot: path.resolve(process.argv[3]), width: 64, height: 64, windowTitle: 'MZ canvas stock pixels' });
try {
  const context = createHostContext(native, { graphics: false });
  const vm = require('node:vm');
  vm.runInContext('globalThis.canvasFixtures = ' + canvasFixtures.toString(), context);
  const actual = context.canvasFixtures(expected.extraColors);
  for (const [label, frame] of Object.entries(expected.frames)) {
    const pixels = actual[label].pixels;
    assert.equal(pixels.length, frame.pixels.length);
    const differences = pixels.map((value, i) => Math.abs(value - frame.pixels[i]));
    assert.ok(differences.every(delta => delta <= 1), label + ': maximum channel mismatch ' + Math.max(...differences));
  }
  const drawing = context.document.createElement('canvas').getContext('2d');
  for (const factory of ['createLinearGradient', 'createRadialGradient']) {
    const gradient = factory === 'createLinearGradient' ? drawing[factory](0, 0, 10, 10) : drawing[factory](0, 0, 0, 10, 10, 10);
    assert.throws(() => gradient.addColorStop(0.5, 'invalid'), { name: 'SyntaxError' });
  }
  assert.ok(actual['weather/snow'].pixels.some((value, i) => i % 4 === 3 && value > 0 && value < 255),
    'snow circle retains antialiased edge coverage');
  console.log('MZ stock color assignment and antialiased circle pixels passed');
} finally { native.runtime.quit(); }
