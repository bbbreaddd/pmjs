'use strict';

const path = require('node:path');
const fs = require('node:fs');
const os = require('node:os');
const childProcess = require('node:child_process');
const cases = require('./filter-bounds-cases.cjs');

const native = require(path.resolve(process.argv[2]));
native.initialize({
  gameRoot: path.resolve(process.argv[3]),
  assetRoot: '',
  width: 16,
  height: 16,
  windowTitle: 'pmjs filter bounds test',
});

const stride = native.scene.schema.valueStride;
const boundedBuild = process.env.PMJS_FILTER_BOUNDS !== '0';
const image = native.images.load('fixture.png');
const built = cases.buildCases(stride, image.handle);

function checkPixel(actual, expected, tolerance, label) {
  const got = [(actual >>> 24) & 0xff, (actual >>> 16) & 0xff,
    (actual >>> 8) & 0xff, actual & 0xff];
  const ok = got.every((value, index) => Math.abs(value - expected[index]) <= tolerance);
  if (!ok) {
    throw new Error(label + ': pixel mismatch actual=[' + got + '] expected=[' +
      expected + '] tolerance=' + tolerance);
  }
}

function submit(records) {
  const metadata = new Uint32Array(records.length * 7);
  const values = new Float32Array(records.length * stride);
  records.forEach((record, index) => {
    metadata.set(record.metadata, index * 7);
    values.set(record.values, index * stride);
  });
  native.beginFrame();
  native.scene.submit(native.scene.packetVersion, metadata, values, records.length);
  native.renderScene();
}

function runCase(label, expectations) {
  const records = built[label];
  const before = native.render.stats();
  submit(records);
  const frame = native.canvas.captureScene();
  try {
    for (const expectation of expectations.pixels) {
      const packed = native.canvas.pixel(frame.handle, expectation.x, expectation.y);
      checkPixel(packed, expectation.rgba, 4, label + ' @(' +
        expectation.x + ',' + expectation.y + ')');
    }
  } finally {
    native.canvas.release(frame.handle);
  }
  const after = native.render.stats();
  const boundedDelta = after.filterBoundedApplications - before.filterBoundedApplications;
  if (boundedDelta !== expectations.boundedDelta) {
    throw new Error(label + ': bounded application delta ' + boundedDelta +
      ' expected ' + expectations.boundedDelta);
  }
  for (const kind of Object.keys(expectations.applications)) {
    const delta = after.filterApplications[Number(kind)] -
      before.filterApplications[Number(kind)];
    if (delta !== expectations.applications[kind]) {
      throw new Error(label + ': kind ' + kind + ' application delta ' + delta +
        ' expected ' + expectations.applications[kind]);
    }
  }
  const clearDelta = after.filterTargetClears - before.filterTargetClears;
  if (clearDelta !== expectations.clears) {
    throw new Error(label + ': target clear delta ' + clearDelta +
      ' expected ' + expectations.clears);
  }
}

function compareFullFrame(label) {
  const records = built[label];
  submit(records);
  const frame = native.canvas.captureScene();
  let local;
  try {
    local = Buffer.from(native.canvas.readPixels(frame.handle, 0, 0, 16, 16));
  } finally {
    native.canvas.release(frame.handle);
  }
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'pmjs-filter-bounds-'));
  const outPath = path.join(tmp, 'frame.rgba');
  const childEnv = Object.assign({}, process.env);
  if (boundedBuild) {
    childEnv.PMJS_FILTER_BOUNDS = '0';
  } else {
    delete childEnv.PMJS_FILTER_BOUNDS;
  }
  try {
    childProcess.execFileSync(process.execPath,
      [path.join(__dirname, 'node-filter-bounds-dump.cjs'),
        path.resolve(process.argv[2]), path.resolve(process.argv[3]),
        label, outPath],
      { env: childEnv, stdio: 'inherit' });
    const reference = fs.readFileSync(outPath);
    if (!local.equals(reference)) {
      let first = -1;
      for (let index = 0; index < Math.min(local.length, reference.length); index++) {
        if (local[index] !== reference[index]) {
          first = index;
          break;
        }
      }
      throw new Error(label + ': full frame differs from fullscreen path at byte ' +
        first + ' of ' + local.length);
    }
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
}

runCase('preserving color matrix', {
  pixels: [
    { x: 6, y: 6, rgba: cases.HALVED_FIXTURE },
    { x: 7, y: 7, rgba: cases.HALVED_FIXTURE },
    { x: 0, y: 0, rgba: cases.BG_RGBA },
    { x: 15, y: 15, rgba: cases.BG_RGBA },
    { x: 6, y: 8, rgba: cases.BG_RGBA },
  ],
  boundedDelta: boundedBuild ? 1 : 0,
  applications: { 25: 1 },
  clears: 1,
});

runCase('non-preserving color matrix', {
  pixels: [
    { x: 0, y: 0, rgba: [100, 50, 25, 255] },
    { x: 15, y: 15, rgba: [100, 50, 25, 255] },
  ],
  boundedDelta: 0,
  applications: { 25: 1 },
  clears: 1,
});

runCase('overlapping sprites', {
  pixels: [
    { x: 4, y: 4, rgba: cases.HALVED_FIXTURE },
    { x: 5, y: 5, rgba: [0, 26, 0, 255] },
    { x: 6, y: 6, rgba: [0, 26, 0, 255] },
    { x: 3, y: 3, rgba: cases.BG_RGBA },
    { x: 7, y: 7, rgba: cases.BG_RGBA },
  ],
  boundedDelta: boundedBuild ? 1 : 0,
  applications: { 25: 1 },
  clears: 1,
});

runCase('adjustment filter', {
  pixels: [
    { x: 10, y: 10, rgba: cases.HALVED_FIXTURE },
    { x: 11, y: 11, rgba: cases.HALVED_FIXTURE },
    { x: 0, y: 0, rgba: cases.BG_RGBA },
  ],
  boundedDelta: boundedBuild ? 1 : 0,
  applications: { 8: 1 },
  clears: 1,
});

runCase('blur filter', {
  pixels: [
    { x: 0, y: 0, rgba: cases.BG_RGBA },
  ],
  boundedDelta: 0,
  applications: { 0: 1 },
  clears: 1,
});

runCase('nested preserving filters', {
  pixels: [
    { x: 2, y: 2, rgba: [64, 13, 26, 255] },
    { x: 3, y: 3, rgba: [64, 13, 26, 255] },
    { x: 0, y: 0, rgba: cases.BG_RGBA },
    { x: 15, y: 15, rgba: cases.BG_RGBA },
  ],
  boundedDelta: boundedBuild ? 2 : 0,
  applications: { 25: 2 },
  clears: 2,
});

runCase('alpha mask filter', {
  pixels: [
    { x: 0, y: 0, rgba: [255, 51, 102, 255] },
    { x: 1, y: 1, rgba: [255, 51, 102, 255] },
    { x: 5, y: 5, rgba: cases.BG_RGBA },
  ],
  boundedDelta: boundedBuild ? 1 : 0,
  applications: { 3: 1 },
  clears: 1,
});

runCase('clipped filter bounds', {
  pixels: [
    { x: 5, y: 5, rgba: cases.HALVED_FIXTURE },
    { x: 6, y: 6, rgba: cases.HALVED_FIXTURE },
    { x: 0, y: 0, rgba: cases.BG_RGBA },
  ],
  boundedDelta: boundedBuild ? 1 : 0,
  applications: { 25: 1 },
  clears: 1,
});

runCase('disjoint clip', {
  pixels: [
    { x: 10, y: 10, rgba: cases.BG_RGBA },
    { x: 0, y: 0, rgba: cases.BG_RGBA },
  ],
  boundedDelta: boundedBuild ? 1 : 0,
  applications: { 25: 1 },
  clears: 1,
});

runCase('unboundable nested inside bounded', {
  pixels: [
    { x: 15, y: 15, rgba: cases.BG_RGBA },
  ],
  boundedDelta: 0,
  applications: { 0: 1, 25: 1 },
  clears: 2,
});

runCase('clipped unboundable nested inside bounded', {
  pixels: [
    { x: 0, y: 0, rgba: cases.BG_RGBA },
    { x: 15, y: 15, rgba: cases.BG_RGBA },
    { x: 13, y: 13, rgba: cases.BG_RGBA },
  ],
  boundedDelta: boundedBuild ? 1 : 0,
  applications: { 0: 1, 25: 1 },
  clears: 2,
});

compareFullFrame('preserving color matrix');
compareFullFrame('unboundable nested inside bounded');
compareFullFrame('clipped unboundable nested inside bounded');

const stats = native.render.stats();
if (typeof stats.filterBoundedApplications !== 'number') {
  throw new Error('bounded filter applications stat is missing');
}
