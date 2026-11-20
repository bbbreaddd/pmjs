'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const { makeHarness } = require('./helpers/scene-encoder-harness.cjs');
const { createContext, runModule } = require('./helpers/pixi5-context.cjs');

for (const family of [4, 5]) {
  test(`Pixi ${family} forwards duplicate draw policy and tolerates an older host`, () => {
    for (const available of [true, false]) {
      let enabled = true;
      const forwarded = [], registered = [], refused = [];
      const configure = c => {
        c.PMJS.optimizations = {
          register: entry => registered.push(entry.id),
          refuse: id => refused.push(id),
          isEnabled: id => id === 'scene.duplicate-sprites' ? enabled : true,
        };
        if (available) c.NativeHost.render.setDuplicateSpriteCulling = value => forwarded.push(value);
      };
      let render;
      if (family === 4) {
        const fixture = makeHarness({ beforeWriter: configure });
        render = () => fixture.sandbox.submitNativeScene(new fixture.sandbox.PIXI.Container());
      } else {
        const fixture = createContext(), c = fixture.context;
        configure(c);
        runModule(c, 'js/pmjs-pixi5/scene.js');
        runModule(c, 'js/pmjs-pixi5/renderer.js');
        const app = new c.PIXI.Application({ width: 32, height: 24 });
        render = () => app.render();
      }
      render();
      enabled = false;
      render();
      assert.ok(registered.includes('scene.duplicate-sprites'));
      assert.deepEqual(forwarded, available ? [true, false] : []);
      assert.equal(refused.includes('scene.duplicate-sprites'), !available);
    }
  });
}

test('standalone Pixi 5 rendering supports a host with culling and no policy registry', () => {
  const fixture = createContext(), c = fixture.context;
  c.NativeHost.render.setDuplicateSpriteCulling = () => assert.fail('no policy was configured');
  delete c.PMJS.optimizations;
  runModule(c, 'js/pmjs-pixi5/scene.js');
  runModule(c, 'js/pmjs-pixi5/renderer.js');
  new c.PIXI.Application({ width: 32, height: 24 }).render();
  assert.equal(fixture.submissions.length, 1);
});
