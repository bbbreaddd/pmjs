'use strict';

const path = require('node:path');
const native = require(path.resolve(process.argv[2]));
native.initialize({gameRoot: path.resolve(process.argv[3]), assetRoot: '', width: 640, height: 480, windowTitle: 'pmjs test'});

async function main() {
  // --- 1. Basic fallback handle properties ---
  const fb1 = native.images.fallbackImage();
  if (!fb1 || !fb1.handle) throw new Error('fallbackImage() should return a valid handle');
  if (fb1.width !== 4 || fb1.height !== 4) {
    throw new Error('expected fallback to be 4x4, got ' + fb1.width + 'x' + fb1.height);
  }

  let mem = native.images.memory(20);
  if (!mem.fallbackHandle) throw new Error('memory() should expose fallbackHandle');
  if (mem.fallbackHandle !== fb1.handle) {
    throw new Error('fallbackHandle in memory() does not match returned handle');
  }
  if (mem.fallbackReferences !== 1) {
    throw new Error('expected fallbackReferences == 1 after one lease, got ' + mem.fallbackReferences);
  }
  if (mem.fallbackUses !== 1) {
    throw new Error('expected fallbackUses == 1 after one lease, got ' + mem.fallbackUses);
  }

  // --- 2. Multiple leases increment references ---
  const fb2 = native.images.fallbackImage();
  const fb3 = native.images.fallbackImage();
  mem = native.images.memory();
  if (mem.fallbackReferences !== 3) {
    throw new Error('expected fallbackReferences == 3 after three leases, got ' + mem.fallbackReferences);
  }
  if (mem.fallbackUses !== 3) {
    throw new Error('expected fallbackUses == 3, got ' + mem.fallbackUses);
  }

  // --- 3. Releasing leases decrements references ---
  native.images.release(fb1.handle);
  mem = native.images.memory();
  if (mem.fallbackReferences !== 2) {
    throw new Error('expected fallbackReferences == 2 after releasing one lease, got ' + mem.fallbackReferences);
  }

  // Releasing all: fallback should survive because it is pinned by the store
  native.images.release(fb2.handle);
  native.images.release(fb3.handle);
  mem = native.images.memory();
  if (mem.fallbackReferences !== 0) {
    throw new Error('expected fallbackReferences == 0 after releasing all leases, got ' + mem.fallbackReferences);
  }
  // The handle must still be valid (pinned)
  if (!mem.fallbackHandle) throw new Error('fallback handle should survive after all leases released (pinned)');
  const fb4 = native.images.fallbackImage();
  if (!fb4 || !fb4.handle) throw new Error('fallback should still be acquirable after all prior leases released');
  if (fb4.handle !== fb1.handle) throw new Error('re-acquired fallback should return same handle');
  native.images.release(fb4.handle);

  // --- 4. Failed native load does not pollute path cache ---
  let failureThrown = false;
  try {
    await native.images.loadAsync('does-not-exist-pmjs-test.png');
  } catch (_) {
    failureThrown = true;
  }
  if (!failureThrown) throw new Error('loadAsync for missing file should reject');

  let failureThrown2 = false;
  try {
    await native.images.loadAsync('does-not-exist-pmjs-test.png');
  } catch (_) {
    failureThrown2 = true;
  }
  if (!failureThrown2) throw new Error('second loadAsync for missing file should also reject');

  console.log('[pmjs-node-image-fallback] ready');
}

main().catch(error => {
  console.error(error);
  process.exitCode = 1;
});
