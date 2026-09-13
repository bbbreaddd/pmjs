'use strict';

const path = require('node:path');
const native = require(path.resolve(process.argv[2]));
native.initialize({gameRoot:path.resolve(process.argv[3]),assetRoot:'',width:640,height:480,windowTitle:'pmjs test'});

async function main() {
  const ordinary = await native.images.loadAsync('fixture.png');
  let mem = native.images.memory(20);
  let ordinaryEntry = mem.largest.find(e => e.handle === ordinary.handle);
  if (!ordinaryEntry) throw new Error('ordinary image entry missing from memory list');
  if (ordinaryEntry.cpuBytes !== 0) {
    throw new Error(`expected ordinary CPU bytes to be 0, got ${ordinaryEntry.cpuBytes}`);
  }

  const primed = await native.images.loadAsync('retained-fixture.png');
  const retained = await native.images.loadAsync('retained-fixture.png', true);
  mem = native.images.memory(20);
  let retainedEntry = mem.largest.find(e => e.handle === retained.handle);
  if (!retainedEntry) throw new Error('retained image entry missing from memory list');
  if (retainedEntry.cpuBytes === 0) {
    throw new Error('expected retained CPU pixels after initial load');
  }

  const canvas = native.canvas.create(16, 16);
  native.canvas.drawImage(canvas.handle, retained.handle, 0, 0, 16, 16, 0, 0, 16, 16, 1.0);
  mem = native.images.memory(20);
  retainedEntry = mem.largest.find(e => e.handle === retained.handle);
  if (retainedEntry.cpuBytes === 0) {
    throw new Error('expected retained CPU pixels after canvas draw');
  }

  for (let i = 0; i < 65; i++) {
    native.beginFrame();
  }

  mem = native.images.memory(20);
  retainedEntry = mem.largest.find(e => e.handle === retained.handle);
  if (!retainedEntry || retainedEntry.cpuBytes === 0) {
    throw new Error('expected CPU pixels to stay retained after 65 frames');
  }

  native.canvas.drawImage(canvas.handle, retained.handle, 0, 0, 8, 8, 0, 0, 8, 8, 1.0);
  mem = native.images.memory(20);
  retainedEntry = mem.largest.find(e => e.handle === retained.handle);
  if (!retainedEntry || retainedEntry.cpuBytes === 0) {
    throw new Error('expected retained CPU pixels when drawn again');
  }

  native.canvas.release(canvas.handle);
  native.images.release(ordinary.handle);
  native.images.release(primed.handle);
  native.images.release(retained.handle);
  console.log('[pmjs-node-image-retention] ready');
}

main().catch(error => {
  console.error(error);
  process.exitCode = 1;
});
