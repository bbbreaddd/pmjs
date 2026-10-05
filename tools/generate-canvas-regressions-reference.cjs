'use strict';

const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const zlib = require('node:zlib');
const { canvasRegressionFixtures } = require('../test/helpers/canvas-regression-scenario.cjs');

const reference = {
  nwVersion: '0.29.0', chromiumVersion: '65.0.3325.146', nodeVersion: '9.7.1',
  files: {
    nw: '0c99f7355109513384f386bd6bff014d9c89d011b3eeb5690cae4da56b2aca73',
    'lib/libnw.so': '24ebbbc3dc171134277af7d6c70b83546162e4309ad1e543950e29fd4dfd980d',
    'natives_blob.bin': '47a86495fbc403ade14d7e451c33edb1baa810402d8d192446a7767bc563dd47',
    'snapshot_blob.bin': '2f5c021a21c674911724272da4e1128108e84569bbcdc5ce025de304a2213462',
    'icudtl.dat': '83b3d8cecab6eea5b73263af8a4d475231f6fe4145644aa230a223e89378ab88',
  },
};
const settings = {
  width: 8, height: 8, canvasBackend: 'cpu', freshProcessReplays: 2,
  frozenCaptures: 2, representation: 'getImageData straight RGBA8 converted to premultiplied RGBA8',
};
const scenarioFile = path.resolve(__dirname, '../test/helpers/canvas-regression-scenario.cjs');
const fontFile = path.resolve(__dirname, '../test/assets/testfont.ttf');
const hash = file => crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');

function validateFixture(fixture) {
  assert.deepEqual(fixture.reference, reference, 'Canvas reference pin changed');
  assert.deepEqual(fixture.settings, settings, 'Canvas reference capture settings changed');
  assert.equal(fixture.generatorSha256, hash(__filename), 'Canvas reference generator changed');
  assert.equal(fixture.scenarioSha256, hash(scenarioFile), 'Canvas reference scenario/readback changed');
  assert.equal(fixture.readbackSha256, hash(scenarioFile), 'Canvas reference readback changed');
  assert.equal(fixture.fontSha256, hash(fontFile), 'Canvas reference font changed');
  assert.match(fixture.driverSha256, /^[a-f0-9]{64}$/, 'Canvas reference driver identity missing');
  assert.equal(fixture.channelTolerance, 2, 'Canvas reference tolerance changed');
}

async function generate(executable, driverFile, output) {
  for (const [file, expected] of Object.entries(reference.files)) {
    const digest = crypto.createHash('sha256');
    for await (const bytes of fs.createReadStream(file === 'nw' ? executable : path.join(path.dirname(executable), file))) digest.update(bytes);
    assert.equal(digest.digest('hex'), expected, 'Canvas reference binary changed: ' + file);
  }
  const driverSha256 = hash(driverFile);
  const { launchMvReference } = require(driverFile);
  process.env.PMJS_MV_REFERENCE_EXECUTABLE = executable;
  const font = fs.readFileSync(fontFile).toString('base64');
  let frames;
  for (let replay = 0; replay < settings.freshProcessReplays; replay++) {
    const app = await launchMvReference({ width: settings.width, height: settings.height,
      canvasBackend: settings.canvasBackend });
    try {
      const versions = await app.page.evaluate(function() {
        return { nwVersion: process.versions.nw, chromiumVersion: process.versions.chromium,
          nodeVersion: process.versions.node };
      });
      assert.deepEqual(versions, { nwVersion: reference.nwVersion,
        chromiumVersion: reference.chromiumVersion, nodeVersion: reference.nodeVersion });
      await app.page.evaluate(function(font) {
        const style = document.createElement('style');
        style.textContent = '@font-face { font-family: GameFont; src: url(data:font/ttf;base64,' + font + '); }';
        document.head.appendChild(style);
        return document.fonts.load('7px GameFont');
      }, font);
      await app.page.addScriptTag({ content: 'window.canvasRegressionFixtures = ' + canvasRegressionFixtures.toString() });
      for (let capture = 0; capture < settings.frozenCaptures; capture++) {
        const actual = await app.page.evaluate(function() { return window.canvasRegressionFixtures(); });
        if (frames) assert.deepEqual(actual, frames, 'Canvas reference capture was not reproducible');
        else frames = actual;
      }
    } finally { await app.close(); }
  }
  assert.equal(hash(driverFile), driverSha256, 'Canvas reference driver changed during capture');
  const fixture = { reference, settings, generatorSha256: hash(__filename),
    scenarioSha256: hash(scenarioFile), readbackSha256: hash(scenarioFile), fontSha256: hash(fontFile), driverSha256,
    channelTolerance: 2, frames };
  validateFixture(fixture);
  fs.writeFileSync(output, zlib.gzipSync(JSON.stringify(fixture) + '\n'));
  console.log(JSON.stringify({ output, cases: Object.keys(frames).length }));
}

if (require.main === module) {
  const args = process.argv.slice(2);
  if (args.length !== 3) throw new Error('Usage: generate-canvas-regressions-reference.cjs EXECUTABLE DRIVER OUTPUT.json.gz');
  generate(...args.map(file => path.resolve(file))).catch(error => { console.error(error.stack); process.exitCode = 1; });
}
module.exports = { validateFixture };
