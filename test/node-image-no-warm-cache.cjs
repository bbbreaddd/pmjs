'use strict';

const path = require('node:path');
const native = require(path.resolve(process.argv[2]));
native.initialize({ gameRoot: path.resolve(process.argv[3]), assetRoot: '',
  width: 640, height: 480, windowTitle: 'pmjs test', imageWarmCacheBytes: 0 });

async function main() {
  const first = await native.images.loadAsync('fixture.png');
  native.images.release(first.handle);
  native.beginFrame();
  const memory = native.images.memory(20);
  if (memory.warmBudgetBytes !== 0 || memory.warmBytes !== 0 ||
      memory.warmCount !== 0 || memory.liveCount !== 0 ||
      memory.budgetEvictions !== 1) {
    throw new Error('zero budget did not disable warm retention: ' +
      JSON.stringify(memory));
  }
  console.log('[pmjs-node-image-no-warm-cache] ready');
}

main().catch(error => {
  console.error(error);
  process.exitCode = 1;
});
