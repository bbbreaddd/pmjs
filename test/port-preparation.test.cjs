'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { preparationLocks } = require('./helpers/preparation-lock.cjs');
const { prepareGameAssets } = require('../runner/preparation.cjs');
const { temporaryDirectory } = require('./helpers/temp.cjs');
const { buildPortPreparation, verifyPortDescriptor, reader, loadProcessor } =
  require('../runner/port-preparation.cjs');

const PROCESSOR_ID = 'fixture-prepared';
const TRANSFORM_PREFIX = Buffer.from('fixture-processed:', 'latin1');
const ACTIVE_SOURCE = 'sources/active.bin';
const DECLINED_SOURCE = 'sources/declined.bin';

const PROCESSOR_TEXT = `'use strict';
const prefix = Buffer.from(${JSON.stringify(TRANSFORM_PREFIX.toString('latin1'))}, 'latin1');
module.exports = {
  id: ${JSON.stringify(PROCESSOR_ID)}, version: 1,
  outputs: [
    { id: 'active', source: ${JSON.stringify(ACTIVE_SOURCE)},
      generate(bytes) { return Buffer.concat([prefix, bytes]); } },
    { id: 'declined', source: ${JSON.stringify(DECLINED_SOURCE)},
      generate() { return null; } },
  ],
};
`;

const HELPER_TEXT = `'use strict';
module.exports = {
  decorate(bytes) { return Buffer.concat([Buffer.from('from-helper:'), bytes]); },
};
`;
const MULTI_TEXT = `'use strict';
module.exports = {
  id: 'fixture-multi', version: 1, files: ['support.cjs'],
  outputs: [
    { id: 'composed', source: 'sources/active.bin',
      generate(bytes) { return require('./support.cjs').decorate(bytes); } },
  ],
};
`;
const REJECTING_PROCESSOR_TEXT = `'use strict';
module.exports = { id: 'fixture-rejected', version: 1, outputs: [] };
`;

function fixture() {
  const root = temporaryDirectory('pmjs-prepared-');
  const game = path.join(root, 'game');
  const bundle = path.join(root, 'bundle');
  fs.mkdirSync(path.join(game, 'sources'), { recursive: true });
  fs.mkdirSync(bundle);
  const processor = path.join(root, `${PROCESSOR_ID}.pmjs-processor.cjs`);
  fs.writeFileSync(processor, PROCESSOR_TEXT);
  const warnings = [];
  const logger = { warn: message => warnings.push(message) };
  return {
    root, game, bundle, processor, logger, warnings,
    source: name => path.join(game, ...name.split('/')),
    writeSources(active, declined) {
      fs.writeFileSync(this.source(ACTIVE_SOURCE), active);
      fs.writeFileSync(this.source(DECLINED_SOURCE), declined);
    },
    cache: () => path.join(root, 'cache'),
    bundledFile(record) { return path.join(bundle, ...record.file.split('/')); },
    cleanup() { fs.rmSync(root, { recursive: true, force: true }); },
  };
}

async function run(f, descriptors, extra = {}) {
  const result = await prepareGameAssets({ gameRoot: f.game, cacheRoot: f.cache(),
    native: { assets: { ...preparationLocks(), compressPortArtifact: bytes => Buffer.from(bytes),
      decompressPortArtifact: bytes => Buffer.from(bytes) } },
    images: false, maps: false, bundleRoot: f.bundle, portDescriptors: descriptors, logger: f.logger, ...extra });
  result.releaseCacheLease?.();
  return result;
}

test('bundling declares self-contained processors without generating game data', () => {
  const f = fixture(); f.writeSources('active-input', 'declined-input');
  const records = buildPortPreparation({ gameRoot: f.game, bundleRoot: f.bundle, processors: [f.processor] });
  assert.equal(records.length, 1);
  assert.deepEqual(records[0].outputs, []);
  assert.equal(verifyPortDescriptor(f.bundle, records).size, 0);
  assert.deepEqual(fs.readdirSync(f.bundle), ['preparation']);
});

test('declared outputs generate through the coordinator and declined inputs remain reusable', async () => {
  const f = fixture(); f.writeSources('active-input', 'declined-input');
  const records = buildPortPreparation({ gameRoot: f.game, bundleRoot: f.bundle, processors: [f.processor] });
  const first = await run(f, records);
  assert.equal(first.portArtifacts.size, 1);
  const bytes = reader(first.portArtifacts)(PROCESSOR_ID + '/active');
  assert.deepEqual(bytes, Buffer.concat([TRANSFORM_PREFIX, Buffer.from('active-input')]));
  const warm = await run(f, records);
  assert.equal(warm.validation.hashedFiles, 0);
  assert.equal(warm.portArtifacts.size, 1);
  assert.deepEqual(reader(warm.portArtifacts)(PROCESSOR_ID + '/declined'), null);
});

test('valid packaged output is reused and damaged output regenerates locally', async () => {
  const f = fixture(); f.writeSources('active-input', 'declined-input');
  const records = buildPortPreparation({ gameRoot: f.game, bundleRoot: f.bundle, processors: [f.processor] });
  const expected = Buffer.concat([TRANSFORM_PREFIX, Buffer.from('active-input')]);
  fs.mkdirSync(path.join(f.bundle, 'assets'));
  fs.writeFileSync(path.join(f.bundle, 'assets/active.pma1'), expected);
  const checksum = bytes => crypto.createHash('sha256').update(bytes).digest('hex');
  records[0].outputs = [{ id: 'active', source: ACTIVE_SOURCE,
    sourceSha256: checksum(Buffer.from('active-input')), file: 'assets/active.pma1', sha256: checksum(expected) }];
  assert.deepEqual(reader((await run(f, records)).portArtifacts)(PROCESSOR_ID + '/active'), expected);
  fs.writeFileSync(path.join(f.bundle, 'assets/active.pma1'), 'corrupt');
  const recovered = await run(f, records, { cacheRoot: path.join(f.root, 'fresh-cache') });
  assert.deepEqual(reader(recovered.portArtifacts)(PROCESSOR_ID + '/active'), expected);
});

test('processor helper changes rebuild derivations and remain self-contained', async () => {
  const f = fixture(); f.writeSources('active-input', 'declined-input');
  fs.writeFileSync(path.join(f.root, 'support.cjs'), HELPER_TEXT);
  fs.writeFileSync(f.processor, MULTI_TEXT);
  const native = { assets: { ...preparationLocks() } };
  const options = { native, gameRoot: f.game, cacheRoot: f.cache(), images: false, maps: false,
    adapters: [f.processor], logger: f.logger };
  const first = await prepareGameAssets(options); first.releaseCacheLease();
  assert.equal(reader(first.portArtifacts)('fixture-multi/composed').toString(), 'from-helper:active-input');
  fs.writeFileSync(path.join(f.root, 'support.cjs'), HELPER_TEXT.replace('from-helper:', 'changed:'));
  const second = await prepareGameAssets(options); second.releaseCacheLease();
  assert.equal(reader(second.portArtifacts)('fixture-multi/composed').toString(), 'changed:active-input');
});

test('processor cache identity includes source paths exposed to generate', async t => {
  const f = fixture(t);
  const processor = path.join(f.root, 'path-sensitive.pmjs-processor.cjs');
  fs.writeFileSync(processor, `'use strict'; module.exports = {
    id: 'path-sensitive', version: 1, outputs: [],
    discover({ files }) { return files.filter(source => source.startsWith('sources/')).map(source => ({ id: 'stable', source })); },
    generate(bytes, { source }) { return Buffer.from(source + ':' + bytes.toString()); }
  };`);
  fs.writeFileSync(f.source('sources/a.bin'), 'same');
  const descriptors = buildPortPreparation({ gameRoot: f.game, bundleRoot: f.bundle, processors: [processor] });
  const first = await run(f, descriptors);
  assert.equal(reader(first.portArtifacts)('path-sensitive/stable').toString(), 'sources/a.bin:same');
  fs.renameSync(f.source('sources/a.bin'), f.source('sources/b.bin'));
  const second = await run(f, descriptors);
  assert.equal(reader(second.portArtifacts)('path-sensitive/stable').toString(), 'sources/b.bin:same');
});

test('invalid optional declarations do not discard valid processors', async () => {
  const f = fixture(); f.writeSources('active-input', 'declined-input');
  const records = buildPortPreparation({ gameRoot: f.game, bundleRoot: f.bundle, processors: [f.processor] });
  const result = await run(f, [{ id: 'bad', processor: '../escape.cjs' }, ...records]);
  assert.equal(result.portArtifacts.size, 1);
  assert.ok(f.warnings.some(message => message.includes('invalid optional')));
});

test('source paths and processor helpers cannot escape their declared roots', () => {
  const f = fixture();
  fs.writeFileSync(f.processor, PROCESSOR_TEXT.replace(ACTIVE_SOURCE, '../outside'));
  assert.throws(() => loadProcessor(f.processor), /invalid/);
});
