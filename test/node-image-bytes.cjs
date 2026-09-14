'use strict';

const fs = require('node:fs');
const path = require('node:path');
const native = require(path.resolve(process.argv[2]));
const root = path.resolve(process.argv[3]);
native.initialize({gameRoot:root,assetRoot:'',width:640,height:480,windowTitle:'pmjs test'});

async function main() {
  const bytes = fs.readFileSync(path.join(root, 'fixture.png'));
  const sync = native.images.loadBytes(bytes);
  const async = await native.images.loadBytesAsync(
    bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength));
  if (sync.width !== 2 || sync.height !== 2 || async.width !== 2 || async.height !== 2) {
    throw new Error('byte-loaded image dimensions are incorrect');
  }
  if (sync.handle === async.handle) {
    throw new Error('memory images unexpectedly shared path-cache identity');
  }

  let malformedRejected = false;
  try { await native.images.loadBytesAsync(Uint8Array.from([1, 2, 3, 4])); }
  catch (_) { malformedRejected = true; }
  if (!malformedRejected) throw new Error('malformed image bytes were accepted');

  let oversizedRejected = false;
  try { native.images.loadBytes(new ArrayBuffer(64 * 1024 * 1024 + 1)); }
  catch (_) { oversizedRejected = true; }
  if (!oversizedRejected) throw new Error('oversized image bytes were accepted');

  native.images.release(sync.handle);
  native.images.release(async.handle);
  console.log('[pmjs-node-image-bytes] ready');
}

main().catch(error => {
  console.error(error);
  process.exitCode = 1;
});
