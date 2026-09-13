'use strict';

const path = require('node:path');
const native = require(path.resolve(process.argv[2]));
native.initialize({gameRoot:path.resolve(process.argv[3]),assetRoot:'',width:640,height:480,windowTitle:'pmjs test'});

async function main() {
  const first = native.images.loadAsync('fixture.png');
  const second = native.images.loadAsync('FIXTURE.png');
  const queued = native.images.memory(20);
  if (queued.pendingDecodeJobs !== 1 || queued.decodeJobs !== 1 ||
      queued.coalescedRequests !== 1) {
    throw new Error('duplicate image requests did not share one decode job: ' +
      JSON.stringify(queued));
  }
  const [left, right] = await Promise.all([first, second]);
  if (left.handle !== right.handle) {
    throw new Error('coalesced image requests resolved different handles');
  }
  const loaded = native.images.memory(20);
  const entry = loaded.largest.find(item => item.handle === left.handle);
  if (loaded.pendingDecodeJobs !== 0 || !entry || entry.references !== 2) {
    throw new Error('coalesced callers did not receive independent ownership: ' +
      JSON.stringify(loaded));
  }
  const cached = await native.images.loadAsync('fixture.png');
  const reused = native.images.memory(20);
  const reusedEntry = reused.largest.find(item => item.handle === cached.handle);
  if (cached.handle !== left.handle || reused.decodeJobs !== 1 ||
      reused.pendingDecodeJobs !== 0 || !reusedEntry || reusedEntry.references !== 3) {
    throw new Error('cached async load scheduled another decode job: ' +
      JSON.stringify(reused));
  }
  native.images.release(left.handle);
  native.images.release(right.handle);
  native.images.release(cached.handle);
  console.log('[pmjs-node-image-coalesce] ready');
}

main().catch(error => {
  console.error(error);
  process.exitCode = 1;
});
