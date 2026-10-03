'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const { createMzContext, runModule } = require('./helpers/mz-context.cjs');

function harness(options) {
  const fixture = createMzContext(options);
  const { context } = fixture;
  fixture.created = [];
  fixture.released = [];
  fixture.canvases = [];
  const OriginalCanvas = context.CanvasElement;
  context.CanvasElement = class extends OriginalCanvas {
    constructor() { super(); fixture.canvases.push(this); }
    getContext() {
      if (this.context) return this.context;
      const ctx = super.getContext();
      ctx.fillRect = (...args) => this.drawCalls.push([ctx.fillStyle, ...args]);
      return this.context = ctx;
    }
    _releaseNativeCanvas() { this.released = true; }
  };
  Object.assign(context.NativeHost.render, {
    createTileLayer(points, handles) {
      const handle = fixture.created.length + 1;
      fixture.created.push({ handle, points: Array.from(points), handles: Array.from(handles) });
      return handle;
    },
    releaseTileLayer(handle) { fixture.released.push(handle); },
  });
  context.PIXI.filters = { AlphaFilter: class {
    constructor(alpha) { this.alpha = alpha; this.enabled = true; }
  } };
  runModule(context, 'js/pmjs-pixi5/filters.js');
  runModule(context, 'js/pmjs-mz/display.js');
  context.PMJS.methods.install();
  return fixture;
}

test('MZ tiles retain resources on transfer and repaint only at authored uploads', () => {
  const f = harness();
  const layer = new f.context.Tilemap.Layer();
  const image = { width: 48, height: 48, _nativeImage: { handle: 100 } };
  layer._images = [image];
  layer._needsTexturesUpdate = true;
  layer._elements = [[0, 0, 0, 8, 16, 24, 24]];
  const firstStage = new f.context.PIXI.Container();
  firstStage.addChild(layer);
  f.render(firstStage);
  assert.deepEqual(f.created[0].points, [0, 0, 8, 16, 24, 24, 0, 0, 0]);
  firstStage.children.length = 0;
  f.render(firstStage);
  const nextStage = new f.context.PIXI.Container();
  nextStage.addChild(layer);
  f.render(nextStage);
  assert.equal(f.created.length, 1);
  assert.deepEqual(f.released, []);
  image.__pmjsContentRevision = 1;
  f.render(nextStage);
  assert.equal(f.created.length, 1, 'unpublished tileset changes must not alter drawing');
  layer._needsTexturesUpdate = true;
  f.render(nextStage);
  assert.equal(f.created.length, 2);
  assert.deepEqual(f.released, [1]);
  assert.equal(f.canvases[0].released, true);
  layer._elements[0][1] = 24;
  f.render(nextStage);
  assert.equal(f.created.at(-1).points[0], 24, 'animation source rectangle must repaint');
  layer.destroy();
  assert.deepEqual(f.released, [1, 2, 3]);
  assert.equal(layer.destroyed, true);
});

test('MZ delayed atlas uploads, empty replacement and half-alpha shadows remain observable', () => {
  const f = harness();
  const layer = new f.context.Tilemap.Layer();
  layer._elements = [[0, 0, 0, 0, 0, 24, 24], [-1, 0, 0, 24, 0, 12, 12]];
  f.render(layer);
  const first = f.created[0];
  assert.equal(first.handles.length, 2);
  assert.deepEqual(f.canvases[1].drawCalls, [['rgba(0,0,0,0.5)', 0, 0, 1, 1]]);
  layer._images = [{ width: 48, height: 48, _nativeImage: { handle: 100 } }];
  layer._needsTexturesUpdate = true;
  f.render(layer);
  assert.notEqual(f.created[1].handles[0], first.handles[0]);
  assert.equal(f.created[1].handles[1], first.handles[1], 'shadow texture is independent of tileset readiness');
  layer._elements = [];
  f.render(layer);
  assert.deepEqual(f.released, [1, 2]);
  layer.destroy();
  assert.deepEqual(f.released, [1, 2], 'empty and destroyed layers must not release twice');
  f.context.PMJS.pixi5.releaseRenderer(f.renderOwner);
  assert.equal(f.canvases[2].released, true);
});

test('reviewed tile render relocation preserves filter processing; arbitrary overrides reject before submission', () => {
  const f = harness();
  const layer = new f.context.Tilemap.Layer();
  layer._images = [{ width: 24, height: 24, _nativeImage: { handle: 100 } }];
  layer._needsTexturesUpdate = true;
  layer._elements = [[0, 0, 0, 0, 0, 24, 24]];
  layer._render = layer.render;
  layer.render = f.context.PIXI.Container.prototype.render;
  layer.filters = [new f.context.PIXI.filters.AlphaFilter(0.25)];
  const packet = f.render(layer);
  const kinds = Array.from({ length: packet.count }, (_, i) => packet.metadata[i * 7]);
  assert.deepEqual(kinds, [6, 4, 7]);
  layer._render = function() {};
  assert.throws(() => f.render(layer), /render.render-method/);
  assert.equal(f.submissions.length, 1);
});

function clipsFor(packet, resource) {
  const result = [];
  for (let i = 0; i < packet.count; i++) {
    if (packet.metadata[i * 7] !== 1 || packet.metadata[i * 7 + 2] !== resource) continue;
    let parent = packet.metadata[i * 7 + 1];
    while (parent !== 0xffffffff && !(packet.metadata[parent * 7 + 5] & 1)) {
      parent = packet.metadata[parent * 7 + 1];
    }
    assert.notEqual(parent, 0xffffffff, 'window drawing must have an exclusion clip');
    result.push(Array.from(packet.values.slice(parent * 41 + 17, parent * 41 + 21)));
  }
  return result;
}

test('MZ windows exclude overlaps with disjoint regions, including partial openness', () => {
  for (const openness of [255, 128]) {
    const f = harness();
    const layer = new f.context.WindowLayer();
    const bottom = new f.context.Window(0, 0, 64, 64);
    const top = new f.context.Window(16, 8, 32, 48);
    top.openness = openness;
    bottom.addChild(f.sprite(101, 0, 0, 64, 64));
    top.addChild(f.sprite(102, 16, 8, 32, 48));
    layer.addChild(bottom); layer.addChild(top);
    layer.addChild(f.sprite(103, 0, 0, 1, 1));
    const packet = f.render(layer);
    const drawOrder = Array.from({ length: packet.count }, (_, i) =>
      packet.metadata[i * 7] === 1 ? packet.metadata[i * 7 + 2] : 0).filter(Boolean);
    assert.equal(drawOrder[0], 102);
    assert.equal(drawOrder.at(-1), 103, 'non-window children draw after windows');
    const clips = clipsFor(packet, 101);
    const height = 48 * openness / 255;
    const y1 = 8 + (48 - height) / 2;
    for (let y = 0.5; y < 64; y++) for (let x = 0.5; x < 64; x++) {
      const count = clips.filter(([l, t, r, b]) => x >= l && x < r && y >= t && y < b).length;
      const covered = x >= 16 && x < 48 && y >= y1 && y < y1 + height;
      assert.equal(count, covered ? 0 : 1, `overlap or gap at ${x},${y}`);
    }
    top.drawShape = function() {};
    assert.throws(() => f.render(layer), /render.window-shape/);
    assert.equal(f.submissions.length, 1);
  }
});

test('transform-time client scrolling and neutral AlphaFilter clipping reach the packet', () => {
  const f = harness();
  const stage = new f.context.PIXI.Container();
  const client = new f.context.PIXI.Container();
  const cursor = f.sprite(201, 0, 0, 16, 16);
  client.addChild(cursor); stage.addChild(client);
  client.filters = [new f.context.PIXI.filters.AlphaFilter(1)];
  let updates = 0;
  const retainedParent = {};
  stage.parent = retainedParent;
  stage.updateTransform = () => {
    updates++;
    client.filterArea = { x: 4, y: 6, width: 20, height: 12 };
    client.transform.localTransform.tx = -updates * 8;
    cursor.alpha = updates === 1 ? 0.5 : 0.25;
  };
  const first = f.render(stage);
  const second = f.render(stage);
  assert.equal(updates, 2);
  assert.equal(stage.parent, retainedParent);
  assert.deepEqual(clipsFor(second, 201), [[4, 6, 24, 18]]);
  assert.notDeepEqual(Array.from(first.values), Array.from(second.values));
  assert.ok(!Array.from({ length: second.count }, (_, i) => second.metadata[i * 7]).includes(6),
    'neutral alpha still clips without allocating a filter target');
});

for (const strictCompatibility of [false, true]) {
  test('MZ display gaps preserve legal descendants in production and reject strictly (' + strictCompatibility + ')', () => {
    for (const failure of ['window-shape', 'tile-atlas-size']) {
      const f = harness({ strictCompatibility }), c = f.context;
      const root = new c.PIXI.Container();
      let producer;
      if (failure === 'window-shape') {
        producer = new c.WindowLayer();
        const window = new c.Window(0, 0, 32, 24);
        window.drawShape = () => {};
        window.addChild(f.sprite(101, 0, 0, 8, 8)); producer.addChild(window);
      } else {
        producer = new c.Tilemap.Layer();
        producer._images = [{ width: 1025, height: 24, _nativeImage: { handle: 100 } }];
        producer._needsTexturesUpdate = true; producer._elements = [[0, 0, 0, 0, 0, 24, 24]];
        producer.addChild(f.sprite(101, 0, 0, 8, 8));
      }
      root.addChild(producer); root.addChild(f.sprite(102, 0, 0, 8, 8));
      if (strictCompatibility) {
        assert.throws(() => f.render(root), new RegExp('render.' + failure));
        assert.equal(f.submissions.length, 0);
      } else {
        const packet = f.render(root);
        const handles = Array.from({ length: packet.count }, (_, i) => packet.metadata[i * 7 + 2]).filter(Boolean);
        assert.deepEqual(handles, [101, 102]);
      }
      assert.equal(c.PMJS.compat.count('render.'), 1);
      if (failure === 'tile-atlas-size') {
        assert.equal(producer._needsTexturesUpdate, true);
        assert.equal(f.created.length, 0);
      }
    }
  });
}
