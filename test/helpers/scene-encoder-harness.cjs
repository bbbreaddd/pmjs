'use strict';

const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const WRITER_REQUIREMENTS = new Set(['js/pmjs-web/canvas.js', 'js/pmjs-pixi4/render-preflight.js',
  'js/pmjs-pixi4/scene-primitives.js', 'js/pmjs-mv/bitmap-mesh.js', 'js/pmjs-plugins/mpp/triangle-bitmap.js',
  'js/pmjs-pixi4/scene-filters.js', 'js/pmjs-pixi4/scene-packet.js',
  'js/pmjs-mv/render-prepare.js',
  'js/pmjs-pixi4/scene-prepare.js', 'js/pmjs-pixi4/scene-classify.js',
  'js/pmjs-pixi4/scene-encoders.js', 'js/pmjs-pixi4/scene-effects.js']);

const root = path.resolve(__dirname, '../..');
const profile = JSON.parse(fs.readFileSync(path.join(root, 'profiles/mv.json'), 'utf8'));
const adapters = JSON.parse(fs.readFileSync(path.join(root, 'profiles/plugin-adapters.json'), 'utf8'));
const mpp = adapters.adapters.find(adapter => adapter.plugins.includes('MPP_EncounterEffect'));
const writerSources = [...profile.modules.slice(0, -1), ...mpp.modules, profile.modules.at(-1)]
  .filter(source => WRITER_REQUIREMENTS.has(source));
for (const source of WRITER_REQUIREMENTS) {
  if (!writerSources.includes(source)) throw new Error('Scene harness source missing from composition: ' + source);
}

function loadWriterSources() {
  return writerSources.map(relative =>
    fs.readFileSync(path.join(root, relative), 'utf8')).join('\n');
}

function makeHarness() {
  let nextHandle = 100;
  const compatHits = [];
  const compatObserved = [];
  const hitCounts = Object.create(null);
  const submitted = [];
  const counts = { filterPlans: 0, rectMasks: 0, alphaMasks: 0 };

  class Transform {
    constructor() {
      this.localTransform = { a: 1, b: 0, c: 0, d: 1, tx: 0, ty: 0 };
      const world = { a: 1, b: 0, c: 0, d: 1, tx: 0, ty: 0 };
      world.identity = function() {
        world.a = 1; world.b = 0; world.c = 0; world.d = 1;
        world.tx = 0; world.ty = 0;
      };
      this.worldTransform = world;
    }
    updateLocalTransform() {
      const owner = this.owner;
      this.localTransform = { a: 1, b: 0, c: 0, d: 1,
        tx: (owner && owner.x) || 0, ty: (owner && owner.y) || 0 };
    }
  }
  class Container {
    constructor() {
      this.children = []; this.visible = true; this.renderable = true;
      this.alpha = 1; this.x = 0; this.y = 0; this.parent = null;
      this.transform = new Transform(); this.transform.owner = this;
      this.tint = 0xffffff; this.blendMode = 0;
    }
    addChild(child) {
      child.parent = this; this.children.push(child); return child;
    }
  }
  class Sprite extends Container {
    constructor(texture) {
      super(); this.texture = texture || null;
      this.anchor = { x: 0, y: 0 };
    }
  }
  class Graphics extends Container {
    constructor() {
      super(); this.graphicsData = []; this.dirty = 0; this.boundsPadding = 0;
      this._localBounds = { x: 0, y: 0, width: 0, height: 0 };
    }
    getBounds() { return this._localBounds; }
    getLocalBounds() { return this._localBounds; }
  }
  class Rectangle {
    constructor(x, y, width, height) {
      this.type = 1; this.x = x; this.y = y;
      this.width = width; this.height = height;
    }
  }
  class TilingSprite extends Container {
    constructor(texture, width, height) {
      super(); this.texture = texture; this.width = width; this.height = height;
      this.anchor = { x: 0, y: 0 }; this.tileScale = { x: 1, y: 1 };
      this.tilePosition = { x: 0, y: 0 }; this.origin = null;
      this.tileTransform = { pivot: { x: 0, y: 0 }, rotation: 0,
        localTransform: {}, updateLocalTransform: () => {
          const transform = this.tileTransform, angle = transform.rotation;
          const a = Math.cos(angle) * this.tileScale.x, b = Math.sin(angle) * this.tileScale.x;
          const c = -Math.sin(angle) * this.tileScale.y, d = Math.cos(angle) * this.tileScale.y;
          transform.localTransform = { a, b, c, d,
            tx: this.tilePosition.x - transform.pivot.x * a - transform.pivot.y * c,
            ty: this.tilePosition.y - transform.pivot.x * b - transform.pivot.y * d };
        } };
    }
  }
  class Mesh extends Container {
    constructor(texture) {
      super(); this.texture = texture;
      this.vertices = new Float32Array([0, 0, 10, 0, 0, 10]);
      this.uvs = new Float32Array([0, 0, 1, 0, 0, 1]);
      this.indices = new Uint16Array([0, 1, 2]);
      this.drawMode = 0; this.dirty = 0; this.indexDirty = 0;
    }
  }
  Mesh.DRAW_MODES = { TRIANGLE_MESH: 0, TRIANGLES: 1 };
  class ParticleContainer extends Container {
    constructor() {
      super();
      this._maxSize = 10; this._batchSize = 16384;
      this._properties = [false, true, false, false, false];
      this._bufferUpdateIDs = [0]; this._updateID = 1;
    }
  }
  class ScreenSprite extends Container {
    constructor() {
      super(); this._red = 10; this._green = 20; this._blue = 30;
    }
  }

  class Tilemap extends Container {}
  class Window extends Container {}
  class WindowLayer extends Container {}
  class BlurFilter {
    constructor(blur, quality) {
      this.blur = blur; this.quality = quality || 1; this.enabled = true;
    }
  }
  class ColorMatrixFilter {
    constructor(matrix) {
      this.matrix = matrix || [
        1, 0, 0, 0, 0,
        0, 1, 0, 0, 0,
        0, 0, 1, 0, 0,
        0, 0, 0, 1, 0
      ];
      this.alpha = 1;
      this.enabled = true;
    }
  }

  function makeTexture(width, height) {
    const handle = nextHandle++;
    const source = { _nativeImage: { handle }, width, height };
    const baseTexture = { source, resolution: 1, scaleMode: 0, width, height };
    const frame = { x: 0, y: 0, width, height };
    return { baseTexture, _frame: frame, frame, orig: frame, trim: null,
      rotate: 0, _updateID: 1, width, height };
  }

  function canvas2d() {
    return { resetTransform() {}, clearRect() {}, translate() {},
      beginPath() {}, moveTo() {}, lineTo() {}, closePath() {}, rect() {},
      arc() {}, fill() {}, stroke() {}, drawImage() {}, fillRect() {},
      set fillStyle(v) {}, set globalAlpha(v) {}, set lineWidth(v) {},
      set strokeStyle(v) {} };
  }
  class CanvasElement {
    constructor() { this.width = 0; this.height = 0; this._h = nextHandle++; }
    getContext() { return canvas2d(); }
    _ensureNativeCanvas() { return { handle: this._h }; }
    _releaseNativeCanvas() {}
  }

  const sandbox = {
    console, Math, Number, String, Array, Object, Float32Array, Uint32Array,
    Uint8ClampedArray, Uint16Array, JSON, Error, WeakMap,
    PIXI: { Container, Sprite, Graphics, Rectangle,
      extras: { TilingSprite }, mesh: { Mesh },
      particles: { ParticleContainer }, tilemap: {},
      SCALE_MODES: { LINEAR: 0, NEAREST: 1 },
      filters: { BlurFilter, ColorMatrixFilter }, DisplayObject: Container,
      Texture: { EMPTY: null } },
    ScreenSprite, Tilemap, Window, WindowLayer, CanvasElement,
    PMJS: { compat: { dump: () => ({ ...hitCounts }),
      count: prefix => Object.entries(hitCounts).reduce((total, [kind, count]) =>
        total + (!prefix || kind.startsWith(prefix) ? count : 0), 0),
      hit: (...args) => sandbox.nativeCompatibilityHit(...args),
      observed: (...args) => sandbox.nativeCompatibilityObserved(...args) },
      optimizations: { isEnabled: () => true } },
    nativeCompatibilityHits: hitCounts,
    nativeCompatibilityHit(kind, detail) {
      compatHits.push([kind, String(detail)]);
      hitCounts[kind] = (hitCounts[kind] || 0) + 1;
    },
    nativeCompatibilityObserved(kind, detail) {
      compatObserved.push([kind, String(detail)]);
    },
    NativeHost: { plugins: { mpp: { createBitmapMesh() { return nextHandle++; } } }, mv: { createBitmapMesh() { return nextHandle++; } },
      scene: { schema: { version: 1, metadataStride: 7, valueStride: 41,
          transactionalSubmit: true, clampedTilingSampling: true },
        packetVersion: 1,
        submit(version, metadata, values, count) {
          submitted.push({ version, count,
            metadata: Array.from(metadata.slice(0, count * 7)),
            values: Array.from(values.slice(0, count * 41)) });
        } },
      render: { createMesh() { return nextHandle++; }, releaseMesh() {},
        createTileLayer() { return nextHandle++; }, releaseTileLayer() {} },
      canvas: {},
      runtime: { env() { return undefined; } }
    }
  };
  sandbox.globalThis = sandbox;
  sandbox.window = sandbox;
  vm.createContext(sandbox);
  vm.runInContext(loadWriterSources(), sandbox,
    { filename: 'scene-writer.js' });
  const filterPlanner = sandbox.nativeSceneFilter;
  sandbox.nativeSceneFilter = function(node, filters) {
    counts.filterPlans++;
    return filterPlanner(node, filters);
  };
  const rectMask = sandbox.nativeRectangleMask;
  sandbox.nativeRectangleMask = function(mask) {
    counts.rectMasks++;
    return rectMask(mask);
  };
  const alphaMask = sandbox.nativeAlphaMask;
  sandbox.nativeAlphaMask = function(mask) {
    counts.alphaMasks++;
    return alphaMask(mask);
  };
  function sprite(width, height) {
    return new sandbox.PIXI.Sprite(makeTexture(width || 32, height || 32));
  }
  return { sandbox, submitted, compatHits, compatObserved, counts, makeTexture, sprite };
}

module.exports = { makeHarness, writerSources };
