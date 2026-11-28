'use strict';

const assert = require('node:assert/strict');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const test = require('node:test');

test('fractional opacity keeps deferred canvas consumers optimizable', () => {
  const script = `
    const fs = require('node:fs');
    const vm = require('node:vm');
    const realm = vm.createContext({ console,
      NativeHost: { runtime: { env: () => '' }, canvas: { release() {} } },
      releaseNativeResource() {}
    });
    for (const name of ['events', 'canvas', 'elements']) {
      vm.runInContext(fs.readFileSync('js/pmjs-web/' + name + '.js', 'utf8'),
        realm, { filename: name + '.js' });
    }
    vm.runInContext(
      ${JSON.stringify(`
        var prototype = {
          createCanvas: function() {
            this.canvas = this.canvas || new CanvasElement();
            this.context = this.canvas.getContext('2d');
            this.canvas.width = 1;
            this.canvas.height = 1;
          }
        };
        Object.defineProperty(prototype, 'width', {
          get: function() {
            if (!this.canvas) this.createCanvas();
            return this.canvas.width;
          }
        });
        function width(bitmap) { return bitmap.width; }
        %PrepareFunctionForOptimization(width);
        var bitmaps = [];
        for (var i = 0; i < 1000; i++) {
          var bitmap = Object.create(prototype);
          width(bitmap);
          bitmaps.push(bitmap);
        }
        bitmaps[0].context.globalAlpha = 0.5;
        for (var i = 0; i < 10000; i++) width(bitmaps[i % bitmaps.length]);
        %OptimizeFunctionOnNextCall(width);
        if (width(bitmaps[0]) !== 1 || bitmaps[0].context.globalAlpha !== 0.5) {
          throw new Error('canvas dimensions or opacity changed');
        }
        // Compare with a forced optimized reference; V8 status bit positions vary.
        function reference(bitmap) { return 1; }
        %PrepareFunctionForOptimization(reference);
        reference(bitmaps[0]); reference(bitmaps[1]);
        %OptimizeFunctionOnNextCall(reference);
        reference(bitmaps[0]);
        console.log('optimized=' +
          (%GetOptimizationStatus(width) === %GetOptimizationStatus(reference)));
      `)}, realm);
  `;
  const child = spawnSync(process.execPath,
    ['--allow-natives-syntax', '--no-concurrent-recompilation', '--trace-opt', '-e', script],
    { cwd: path.resolve(__dirname, '..'), encoding: 'utf8', timeout: 10000 });
  assert.ifError(child.error);
  assert.equal(child.status, 0, child.stderr);
  assert.doesNotMatch(child.stdout, /Maps became deprecated during optimization/);
  assert.match(child.stdout, /optimized=true/);
});
