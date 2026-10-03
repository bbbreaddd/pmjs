'use strict';
const assert = require('node:assert/strict');
const test = require('node:test');
const { createZoomContext } = require('./helpers/zoom-blur-context.cjs');
test('reviewed fullscreen ZoomBlur uses authored uniforms and rejects changed drawing', () => {
  const f = createZoomContext();
  const { context: c } = f;
  const renderer = new c.PIXI.Renderer({ width: 32, height: 24, transparent: true });
  const stage = new c.PIXI.Container();
  stage.filterArea = new c.PIXI.Rectangle(0, 0, 32, 24);
  const filter = new c.PIXI.filters.ZoomBlurFilter({ center: [12, 8], strength: 0.2, innerRadius: 3, radius: 16 });
  stage.filters = [filter];
  renderer.render(stage);
  let packet = f.submissions.at(-1);
  const begin = Array.from(packet.metadata).findIndex((v, i) => i % 7 === 0 && v === 6) / 7;
  assert.deepEqual(Array.from(packet.values.slice(begin * 41 + 7, begin * 41 + 12)),
    [12, 8, Math.fround(0.2), 3, 16]);
  assert.equal(packet.values[begin * 41 + 16], 1);
  const validProgram = filter.program;
  const mutations = [() => { filter.apply = () => {}; },
    () => { filter.program = { ...validProgram, fragmentSrc: validProgram.fragmentSrc + '\n// altered' }; },
    () => { filter.padding = 2; }, () => { filter.resolution = 2; },
    () => { stage.filterArea.width = 16; }, () => { filter.uniforms.uStrength = NaN; },
    () => { stage.filters.push({ enabled: true, resolution: 2, padding: 0, autoFit: true }); }];
  for (const mutate of mutations) {
    filter.apply = c.PIXI.Filter.prototype.apply; filter.program = validProgram;
    filter.padding = 0; filter.resolution = 1; filter.uniforms.uStrength = 0.2;
    stage.filterArea.width = 32; stage.filters = [filter];
    mutate();
    const count = f.submissions.length;
    assert.throws(() => renderer.render(stage), /render.filter/);
    assert.equal(f.submissions.length, count);
  }
});
