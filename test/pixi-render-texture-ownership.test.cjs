'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const vm = require('node:vm');

test('destroying a RenderTexture view preserves shared base backing', () => {
  const setup = fs.readFileSync(path.join(__dirname,
    '../js/pmjs-pixi4/setup.js'), 'utf8');
  const setupPrefix = setup.slice(0,
    setup.indexOf("NativeHost.runtime.loadScript('js/libs/pixi-picture.js')"));
  let releases = 0;
  class BaseTexture {
    destroy() { this.destroyed = true; }
  }
  class BaseRenderTexture extends BaseTexture {
    destroy() { super.destroy(); }
  }
  class RenderTexture {
    constructor(baseTexture) { this.baseTexture = baseTexture; }
    destroy(destroyBase) {
      if (destroyBase) this.baseTexture.destroy();
      this.baseTexture = null;
    }
  }
  const context = {
    nativeBootPhase() {},
    NativeHost: { runtime: { loadScript() {} } },
    PIXI: { Container: class {}, BaseTexture, BaseRenderTexture,
      RenderTexture },
    NativeImage: class {}
  };
  context.globalThis = context;
  vm.runInNewContext(setupPrefix, context);

  const base = new BaseRenderTexture();
  const source = { _releaseNativeCanvas() { releases++; } };
  base.__pmjsRenderCanvas = base.source = source;
  const first = new RenderTexture(base);
  const sibling = new RenderTexture(base);
  first.destroy(false);
  assert.equal(releases, 0);
  assert.equal(base.__pmjsRenderCanvas, source);
  assert.equal(sibling.baseTexture, base);

  sibling.destroy(true);
  assert.equal(releases, 1);
  assert.equal(base.__pmjsRenderCanvas, null);
  assert.equal(base.destroyed, true);
});
