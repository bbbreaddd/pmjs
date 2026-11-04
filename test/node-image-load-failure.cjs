'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const native = require(path.resolve(process.argv[2]));
const root = path.resolve(process.argv[3]);
native.initialize({ gameRoot: root, assetRoot: '', windowTitle: 'Native failure contracts', width: 32, height: 32, imageWarmCacheBytes: 0 });

(async () => {
  native.images.release(native.images.fallbackImage().handle);
  const baseline = native.images.memory();
  const bytes = fs.readFileSync(path.join(root, 'fixture.png'));
  for (const mode of ['allocation', 'unknown', 'wrapper', 'persistent-error', 'no-context']) {
    for (const memory of mode === 'wrapper' ? [false] : [false, true]) {
      process.env.PMJS_IMAGE_FAULT = mode;
      const pending = memory ? [native.images.loadBytesAsync(bytes)] :
        [native.images.loadAsync('fixture.png'), native.images.loadAsync('FIXTURE.png')];
      const results = await Promise.allSettled(pending);
      delete process.env.PMJS_IMAGE_FAULT;
      assert.ok(results.every(result => result.status === 'rejected'), mode + '/' + memory);
      assert.equal(native.images.memory().pendingDecodeJobs, 0);
      for (let frame = 0; frame < 65; frame++) native.beginFrame();
      assert.equal(native.images.memory().liveCount, baseline.liveCount, 'failed installation leaked an image: ' + mode + '/' + memory + ' ' + JSON.stringify(native.images.memory(20)));
      const healthy = await native.images.loadAsync('fixture.png');
      assert.equal(healthy.width, 2);
      native.images.release(healthy.handle);
      for (let frame = 0; frame < 65; frame++) native.beginFrame();
    }
  }
  process.env.PMJS_IMAGE_FAULT = 'hidden-egl';
  try {
    const image = await native.images.loadAsync('fixture.png');
    assert.equal(image.width, 2);
    native.images.release(image.handle);
  } finally { delete process.env.PMJS_IMAGE_FAULT; }
  console.log('image installation failures reject all callers, release resources, and permit retry');
})().catch(error => { console.error(error); process.exitCode = 1; });
