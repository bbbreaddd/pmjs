'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const zlib = require('node:zlib');
const { spawnSync } = require('node:child_process');
const { temporaryDirectory } = require('./helpers/temp.cjs');

const temporary = temporaryDirectory('pmjs-release-contract-');
try {
  let stage = path.join(temporary, 'relocated runtime');
  fs.cpSync(path.resolve(process.argv[2]), stage, { recursive: true });
  const sourceRecord = path.resolve(process.argv[2]) + '.release.json';
  if (fs.existsSync(sourceRecord)) fs.copyFileSync(sourceRecord, stage + '.release.json');
  const game = path.join(temporary, 'game with spaces');
  const state = path.join(temporary, 'prepared state');
  fs.mkdirSync(path.join(game, 'js/libs'), { recursive: true });
  fs.writeFileSync(path.join(game, 'js/rpg_core.js'), 'Utils.RPGMAKER_VERSION = "1.6.2";');
  fs.writeFileSync(path.join(game, 'js/rpg_managers.js'), '');
  // This release probe ends at guest-library loading. It tests installed launch
  // and preparation, not MV gameplay or normal engine shutdown.
  const guestMarker = '[release-workflow] guest library reached';
  function pixiProbe(version) {
    return 'globalThis.PIXI = {}; PIXI.VERSION = ' + JSON.stringify(version) + ';\n' +
      "__pmjsBuiltinRequire('node:fs').writeSync(1, " + JSON.stringify(guestMarker + '\n') + ');\n' +
      "__pmjsBuiltinRequire('node:process').exit(0);\n";
  }
  function assertGuestReached(result) {
    assert.equal(result.status, 0, result.stdout + result.stderr);
    assert.ok(result.stdout.includes(guestMarker), result.stdout + result.stderr);
  }
  fs.writeFileSync(path.join(game, 'js/libs/pixi.js'), pixiProbe('4.5.4'));
  fs.writeFileSync(path.join(game, 'js/libs/pixi-tilemap.js'), '');
  fs.writeFileSync(path.join(game, 'js/plugins.js'), 'var $plugins = [];');
  fs.mkdirSync(path.join(game, 'data'));
  fs.writeFileSync(path.join(game, 'data/System.json'), '{"gameTitle":"Test"}');
  fs.writeFileSync(path.join(game, 'data/Tilesets.json'), '[]');
  const chunk = (name, data) => {
    const type = Buffer.from(name);
    const body = Buffer.concat([type, data]);
    let crc = 0xffffffff;
    for (const byte of body) {
      crc ^= byte;
      for (let bit = 0; bit < 8; ++bit) crc = crc & 1 ? (crc >>> 1) ^ 0xedb88320 : crc >>> 1;
    }
    const length = Buffer.alloc(4), checksum = Buffer.alloc(4);
    length.writeUInt32BE(data.length); checksum.writeUInt32BE((crc ^ 0xffffffff) >>> 0);
    return Buffer.concat([length, body, checksum]);
  };
  const header = Buffer.alloc(13);
  header.writeUInt32BE(64, 0); header.writeUInt32BE(64, 4); header[8] = 8; header[9] = 6;
  const rows = [];
  for (let y = 0; y < 64; ++y) {
    const row = Buffer.alloc(1 + 64 * 4);
    for (let x = 0; x < 64; ++x) if (x >= 16 && x < 48 && y >= 16 && y < 48) {
      row[1 + x * 4] = 255; row[1 + x * 4 + 3] = 255;
    }
    rows.push(row);
  }
  fs.mkdirSync(path.join(game, 'img/pictures'), { recursive: true });
  fs.writeFileSync(path.join(game, 'img/pictures/fixture[1x1].png'), Buffer.concat([
    Buffer.from('89504e470d0a1a0a', 'hex'), chunk('IHDR', header),
    chunk('IDAT', zlib.deflateSync(Buffer.concat(rows))), chunk('IEND', Buffer.alloc(0))
  ]));
  const config = path.join(temporary, 'config.json');
  fs.writeFileSync(config, '{}');
  const manifest = path.join(temporary, 'adapters.json');
  fs.writeFileSync(manifest, '{"adapters":"auto"}');
  const firstAdapter = path.join(temporary, 'first.js');
  const secondAdapter = path.join(temporary, 'second.js');
  const duplicateAdapter = path.join(temporary, 'other', 'first.js');
  fs.writeFileSync(firstAdapter, 'globalThis.firstBundleAdapter = true;');
  fs.writeFileSync(secondAdapter, 'globalThis.secondBundleAdapter = true;');
  fs.mkdirSync(path.dirname(duplicateAdapter));
  fs.writeFileSync(duplicateAdapter, 'globalThis.thirdBundlePatch = true;');
  const dataRoot = path.join(temporary, 'data-default');
  function cliAt(data, ...args) {
    return spawnSync(path.join(stage, 'bin/pmjs'), args, { cwd: temporary, encoding: 'utf8',
      env: { ...process.env, NODE_OPTIONS: '', NODE_PATH: '', LD_LIBRARY_PATH: '',
        XDG_DATA_HOME: data, XDG_CACHE_HOME: path.join(temporary, 'cache-default') } });
  }
  const cli = (...args) => cliAt(dataRoot, ...args);
  const buildInfo = cli('--build-info');
  assert.equal(buildInfo.status, 0, buildInfo.stdout + buildInfo.stderr);
  assert.match(buildInfo.stdout, /^PMJS /);
  const infoFile = path.join(stage, 'build-info.json');
  const installedInfoBytes = fs.readFileSync(infoFile);
  const installedInfo = JSON.parse(installedInfoBytes);
  if (installedInfo.buildId) assert.ok(buildInfo.stdout.includes(`build=${installedInfo.buildId}`));
  fs.writeFileSync(infoFile, JSON.stringify({ ...installedInfo, buildId: undefined }));
  assert.equal(cli('--build-info').stdout.includes('build='), false, 'older packages without a build ID still work');
  fs.writeFileSync(infoFile, JSON.stringify({ ...installedInfo, buildId: 'build-fixture' }));
  assert.ok(cli('--build-info').stdout.includes('build=build-fixture'), 'relocated package reports its stored build ID');
  const help = cli('--help');
  assert.equal(help.status, 0, help.stdout + help.stderr);
  assert.match(help.stdout, /pmjs prepare --game DIR/);
  const emptyDirectory = path.join(temporary, 'empty-directory');
  fs.mkdirSync(emptyDirectory);
  const noGame = spawnSync(path.join(stage, 'bin/pmjs'), [], {
    cwd: emptyDirectory, encoding: 'utf8', env: { ...process.env, NODE_OPTIONS: '', NODE_PATH: '' }
  });
  assert.match(noGame.stdout, /Usage:/, 'no recognized game in the current directory shows help');
  const unprepared = cli('run', '--game', game, '--state', state);
  assertGuestReached(unprepared);
  const buildInfoSha256 = crypto.createHash('sha256').update(fs.readFileSync(infoFile)).digest('hex');
  const expectedSource = installedInfo.source.dirty ? 'dirty' : installedInfo.source.commit;
  assert.ok(unprepared.stdout.includes(`launcher identity build=build-fixture source=${expectedSource} ` +
    `build_info_sha256=${buildInfoSha256}`));
  for (const pass of ['cache-lookup', 'bootstrap-integrity', 'prelaunch']) {
    assert.ok(unprepared.stdout.includes(`launcher check=runtime pass=${pass}`),
      `runtime verification labels ${pass}`);
    assert.ok(unprepared.stdout.includes(`launcher check=game-inputs pass=${pass}`),
      `game input verification labels ${pass}`);
  }
  const missingGame = cli('run', '--game', path.join(temporary, 'missing-game'));
  assert.notEqual(missingGame.status, 0);
  assert.ok(missingGame.stdout.includes('build=build-fixture'), 'startup failures still identify the installed build');
  assert.ok(fs.existsSync(path.join(state, 'prepared.json')), 'running prepares the game automatically');
  const fromGameDirectory = spawnSync(path.join(stage, 'bin/pmjs'), [], {
    cwd: game, encoding: 'utf8', env: { ...process.env, NODE_OPTIONS: '', NODE_PATH: '',
      LD_LIBRARY_PATH: '', XDG_CACHE_HOME: path.join(temporary, 'cache-default'), XDG_DATA_HOME: dataRoot }
  });
  assertGuestReached(fromGameDirectory);
  const prepared = cli('prepare', '--game', game, '--state', state, '--config', config, '--manifest', manifest);
  assert.equal(prepared.status, 0, prepared.stdout + prepared.stderr);
  const bundle = path.join(temporary, 'game bundle');
  const originalImageHash = crypto.createHash('sha256').update(
    fs.readFileSync(path.join(game, 'img/pictures/fixture[1x1].png'))).digest('hex');
  const bundled = cli('bundle', game, '--output', bundle, '--config', config, '--manifest', manifest,
    '--patch', firstAdapter, '--patch', secondAdapter, '--patch', duplicateAdapter);
  assert.equal(bundled.status, 0, bundled.stdout + bundled.stderr);
  assert.deepEqual(fs.readdirSync(path.join(bundle, 'gamedata')), []);
  const descriptor = JSON.parse(fs.readFileSync(path.join(bundle, 'pmjs.json'), 'utf8'));
  assert.equal(descriptor.game, 'gamedata');
  assert.equal(descriptor.config, 'config.json');
  assert.deepEqual(descriptor.patches, ['patches/first.js', 'patches/second.js', 'patches/first-2.js']);
  assert.equal(descriptor.manifest, 'plugin-selection.json');
  const bundleBootstrap = fs.readFileSync(path.join(bundle, 'bootstrap.js'), 'utf8');
  assert.ok(bundleBootstrap.indexOf('firstBundleAdapter') < bundleBootstrap.indexOf('secondBundleAdapter'));
  assert.ok(bundleBootstrap.indexOf('secondBundleAdapter') < bundleBootstrap.indexOf('thirdBundlePatch'));
  assert.equal(descriptor.assetIndex, 'asset-index.json');
  const index = JSON.parse(fs.readFileSync(path.join(bundle, 'asset-index.json')));
  assert.equal(index.images.length, 1);
  assert.ok(index.images[0].calculated.descriptor);
  assert.equal(index.sections.imageStorage, 1);
  assert.equal(index.imageStorageVersion, 1);
  assert.equal(index.images[0].calculated.storage.version, 1);
  assert.ok([0, 8, 16].includes(index.images[0].calculated.storage.paletteBits));
  assert.equal(fs.existsSync(path.join(bundle, 'assets')), false, 'artwork is not bundled by default');
  const noIndexBundle = path.join(temporary, 'bundle without index');
  const noIndex = cli('bundle', game, '--output', noIndexBundle, '--no-index');
  assert.equal(noIndex.status, 0, noIndex.stdout + noIndex.stderr);
  assert.equal(fs.existsSync(path.join(noIndexBundle, 'asset-index.json')), false);
  const disabledConfig = path.join(temporary, 'disabled-preparation.json');
  fs.writeFileSync(disabledConfig, '{"assetPreparation":{"enabled":false}}');
  const disabledBundle = path.join(temporary, 'disabled-preparation-bundle');
  const disabled = cli('bundle', game, '--output', disabledBundle, '--config', disabledConfig);
  assert.equal(disabled.status, 0, disabled.stdout + disabled.stderr);
  assert.deepEqual(JSON.parse(fs.readFileSync(path.join(disabledBundle, 'asset-index.json'))).images, []);
  const withAssets = path.join(temporary, 'bundle with assets');
  const assetsBundle = cli('bundle', game, '--output', withAssets, '--include-assets');
  assert.equal(assetsBundle.status, 0, assetsBundle.stdout + assetsBundle.stderr);
  const included = JSON.parse(fs.readFileSync(path.join(withAssets, 'asset-index.json')));
  assert.ok(fs.existsSync(path.join(withAssets, included.images[0].calculated.outputs[0].path)));
  const invalidCombination = cli('bundle', game, '--output', path.join(temporary, 'invalid bundle'),
    '--include-assets', '--no-index');
  assert.notEqual(invalidCombination.status, 0);
  assert.equal(crypto.createHash('sha256').update(
    fs.readFileSync(path.join(game, 'img/pictures/fixture[1x1].png'))).digest('hex'), originalImageHash,
  'bundle creation leaves original game files unchanged');
  const movedBundle = path.join(temporary, 'moved bundle');
  fs.renameSync(bundle, movedBundle);
  const oldBundle = path.join(temporary, 'older descriptor bundle');
  fs.cpSync(movedBundle, oldBundle, { recursive: true });
  const oldDescriptorPath = path.join(oldBundle, 'pmjs.json');
  const oldDescriptor = JSON.parse(fs.readFileSync(oldDescriptorPath));
  oldDescriptor.adapters = oldDescriptor.patches;
  delete oldDescriptor.patches;
  fs.writeFileSync(oldDescriptorPath, JSON.stringify(oldDescriptor));
  const oldRun = cliAt(path.join(temporary, 'older descriptor data'), oldBundle, '--game', game);
  assertGuestReached(oldRun);
  const indexedData = path.join(temporary, 'data-indexed');
  const bundledRun = cliAt(indexedData, movedBundle, '--game', game,
    '--state', path.join(temporary, 'bundle state'));
  assertGuestReached(bundledRun);
  assert.ok(fs.existsSync(path.join(temporary, 'bundle state/prepared.json')));
  const cachedRuns = [
    { args: ['run', '--game', game, '--state', state], state },
    { args: [movedBundle, '--game', game, '--state', path.join(temporary, 'bundle state')],
      state: path.join(temporary, 'bundle state') }
  ].map(run => {
    const record = fs.readFileSync(path.join(run.state, 'prepared.json'), 'utf8');
    return { ...run, record, bootstrapTime: fs.statSync(
      path.join(run.state, JSON.parse(record).bootstrap), { bigint: true }).mtimeNs };
  });
  const documentation = path.join(stage, 'THIRD_PARTY_NOTICES.md');
  const originalDocumentation = fs.readFileSync(documentation);
  const originalInfo = fs.readFileSync(infoFile);
  try {
    fs.appendFileSync(documentation, '\nDocumentation update\n');
    const info = JSON.parse(originalInfo);
    if (info.files) {
      info.files['THIRD_PARTY_NOTICES.md'].sha256 = crypto.createHash('sha256')
        .update(fs.readFileSync(documentation)).digest('hex');
      info.files['THIRD_PARTY_NOTICES.md'].bytes = fs.statSync(documentation).size;
    } else {
      info.buildId = 'updated-documentation';
    }
    fs.writeFileSync(infoFile, JSON.stringify(info));
    const updatedPackageHash = crypto.createHash('sha256').update(fs.readFileSync(infoFile)).digest('hex');
    for (const run of cachedRuns) {
      const result = cli(...run.args);
      assertGuestReached(result);
      assert.ok(result.stdout.includes(`build_info_sha256=${updatedPackageHash}`), 'startup logs the current build metadata hash');
      assert.equal(fs.readFileSync(path.join(run.state, 'prepared.json'), 'utf8'), run.record,
        'documentation-only installation changes preserve preparation records');
      assert.equal(fs.statSync(path.join(run.state, JSON.parse(run.record).bootstrap), { bigint: true }).mtimeNs,
        run.bootstrapTime, 'compatible cached bootstraps are neither rebuilt nor recopied');
    }
  } finally {
    fs.writeFileSync(documentation, originalDocumentation);
    fs.writeFileSync(infoFile, originalInfo);
  }
  const editedBundle = path.join(temporary, 'edited bundle');
  fs.cpSync(movedBundle, editedBundle, { recursive: true });
  fs.writeFileSync(path.join(editedBundle, 'config.json'), '{"title":"Edited bundle"}');
  const editedState = path.join(temporary, 'edited bundle state');
  const editedRun = cliAt(path.join(temporary, 'edited bundle data'), editedBundle,
    '--game', game, '--state', editedState);
  assertGuestReached(editedRun);
  const editedRecord = JSON.parse(fs.readFileSync(path.join(editedState, 'prepared.json')));
  assert.notEqual(editedRecord.bootstrapSha256,
    JSON.parse(fs.readFileSync(path.join(editedBundle, 'pmjs.json'))).bootstrapSha256,
  'edited bundle configuration refreshes the cached bootstrap');
  const bundleBootstrapHash = crypto.createHash('sha256').update(
    fs.readFileSync(path.join(movedBundle, 'bootstrap.js'))).digest('hex');
  const runtimeModule = path.join(stage, 'share/pmjs/js/pmjs-core/methods.js');
  const runtimeSource = fs.readFileSync(runtimeModule);
  const beforeComposition = JSON.parse(fs.readFileSync(path.join(temporary, 'bundle state/prepared.json')));
  fs.appendFileSync(runtimeModule, '\n// changed composition\n');
  const refreshed = cliAt(indexedData, movedBundle, '--game', game,
    '--state', path.join(temporary, 'bundle state'));
  assertGuestReached(refreshed);
  const afterComposition = JSON.parse(fs.readFileSync(path.join(temporary, 'bundle state/prepared.json')));
  assert.notEqual(afterComposition.runtimeIdentity, beforeComposition.runtimeIdentity);
  assert.equal(crypto.createHash('sha256').update(
    fs.readFileSync(path.join(movedBundle, 'bootstrap.js'))).digest('hex'), bundleBootstrapHash,
  'distributed bootstrap remains unchanged');
  fs.writeFileSync(runtimeModule, runtimeSource);
  const builder = path.join(stage, 'share/pmjs/tools/build-js-runtime.mjs');
  const builderSource = fs.readFileSync(builder);
  assertGuestReached(cliAt(indexedData, movedBundle, '--game', game,
    '--state', path.join(temporary, 'bundle state')));
  const beforeBuilder = JSON.parse(fs.readFileSync(path.join(temporary, 'bundle state/prepared.json')));
  try {
    fs.appendFileSync(builder, '\n// changed bundle generation\n');
    assertGuestReached(cliAt(indexedData, movedBundle, '--game', game,
      '--state', path.join(temporary, 'bundle state')));
    const afterBuilder = JSON.parse(fs.readFileSync(path.join(temporary, 'bundle state/prepared.json')));
    assert.notEqual(afterBuilder.runtimeIdentity, beforeBuilder.runtimeIdentity,
      'bundle-generation tool changes invalidate preparation independently of the package manifest');
  } finally {
    fs.writeFileSync(builder, builderSource);
  }
  const gameId = crypto.createHash('sha256').update(game).digest('hex').slice(0, 24);
  const preparationId = crypto.createHash('sha256').update(JSON.stringify(game)).digest('hex').slice(0, 16);
  function preparedImage(data) {
    const root = path.join(data, 'pmjs', gameId, 'saves/asset-cache/preparation-v1', preparationId);
    const results = JSON.parse(fs.readFileSync(path.join(root, 'preparation-state.json'))).data.results;
    for (const [key, manifest] of Object.entries(results)) {
      if (manifest.descriptor?.pages?.length) return { manifest,
        page: fs.readFileSync(path.join(root, key, manifest.descriptor.pages[0].path)) };
    }
    throw new Error('prepared fixture image not found');
  }
  const baselineImage = preparedImage(dataRoot);
  const indexedImage = preparedImage(indexedData);
  assert.deepEqual(indexedImage.manifest.descriptor, baselineImage.manifest.descriptor);
  assert.deepEqual(indexedImage.page, baselineImage.page);
  const assetsData = path.join(temporary, 'data-with-assets');
  const assetsRun = cliAt(assetsData, withAssets, '--game', game);
  assertGuestReached(assetsRun);
  assert.deepEqual(preparedImage(assetsData).page, baselineImage.page);
  const damagedAssets = path.join(temporary, 'damaged assets bundle');
  fs.cpSync(withAssets, damagedAssets, { recursive: true });
  fs.appendFileSync(path.join(damagedAssets, included.images[0].calculated.outputs[0].path), 'damaged');
  const damagedData = path.join(temporary, 'data-damaged-assets');
  const damagedRun = cliAt(damagedData, damagedAssets, '--game', game);
  assertGuestReached(damagedRun);
  assert.deepEqual(preparedImage(damagedData).page, baselineImage.page,
    'corrupt included page falls back to native preparation');
  const changedDecoder = path.join(temporary, 'changed decoder bundle');
  fs.cpSync(movedBundle, changedDecoder, { recursive: true });
  const changedIndexFile = path.join(changedDecoder, 'asset-index.json');
  const changedIndex = JSON.parse(fs.readFileSync(changedIndexFile));
  changedIndex.processor.decoder = 'incompatible-decoder';
  fs.writeFileSync(changedIndexFile, JSON.stringify(changedIndex));
  const changedDescriptorFile = path.join(changedDecoder, 'pmjs.json');
  const changedDescriptor = JSON.parse(fs.readFileSync(changedDescriptorFile));
  changedDescriptor.assetIndexSha256 = crypto.createHash('sha256').update(fs.readFileSync(changedIndexFile)).digest('hex');
  fs.writeFileSync(changedDescriptorFile, JSON.stringify(changedDescriptor));
  const incompatibleData = path.join(temporary, 'data-incompatible-index');
  const incompatibleRun = cliAt(incompatibleData, changedDecoder, '--game', game);
  assertGuestReached(incompatibleRun);
  assert.deepEqual(preparedImage(incompatibleData).page, baselineImage.page,
    'incompatible decoder uses ordinary preparation');
  const originalImage = fs.readFileSync(path.join(game, 'img/pictures/fixture[1x1].png'));
  for (const row of rows) for (let x = 16; x < 48; ++x) if (row[1 + x * 4 + 3]) {
    row[1 + x * 4] = 0; row[1 + x * 4 + 1] = 255;
  }
  fs.writeFileSync(path.join(game, 'img/pictures/fixture[1x1].png'), Buffer.concat([
    Buffer.from('89504e470d0a1a0a', 'hex'), chunk('IHDR', header),
    chunk('IDAT', zlib.deflateSync(Buffer.concat(rows))), chunk('IEND', Buffer.alloc(0))
  ]));
  const replacedData = path.join(temporary, 'data-replaced-source');
  const replacedRun = cliAt(replacedData, movedBundle, '--game', game);
  assertGuestReached(replacedRun);
  assert.notEqual(preparedImage(replacedData).manifest.sourceHash, baselineImage.manifest.sourceHash);
  assert.notDeepEqual(preparedImage(replacedData).page, baselineImage.page,
    'source replacement uses newly prepared pixels');
  fs.writeFileSync(path.join(game, 'img/pictures/fixture[1x1].png'), originalImage);
  const record = fs.readFileSync(path.join(state, 'prepared.json'), 'utf8');
  const broken = cli('prepare', '--game', game, '--state', state, '--config', path.join(temporary, 'missing.json'));
  assert.notEqual(broken.status, 0);
  assert.equal(fs.readFileSync(path.join(state, 'prepared.json'), 'utf8'), record,
    'failed preparation preserves the working preparation record');
  fs.writeFileSync(config, '{"title":"Changed"}');
  assertGuestReached(cli('run', '--game', game, '--state', state));
  assert.notEqual(fs.readFileSync(path.join(state, 'prepared.json'), 'utf8'), record,
    'configuration changes refresh preparation');
  fs.writeFileSync(config, '{}');
  for (const file of [manifest, path.join(game, 'js/plugins.js'), path.join(game, 'js/libs/pixi.js'),
    path.join(game, 'js/rpg_core.js')]) {
    const original = fs.readFileSync(file);
    fs.appendFileSync(file, '\n ');
    const prior = fs.readFileSync(path.join(state, 'prepared.json'), 'utf8');
    assertGuestReached(cli('run', '--game', game, '--state', state));
    assert.notEqual(fs.readFileSync(path.join(state, 'prepared.json'), 'utf8'), prior);
    fs.writeFileSync(file, original);
  }
  fs.writeFileSync(path.join(game, 'js/pixi.js'), pixiProbe('4.8.0'));
  const beforePixi = fs.readFileSync(path.join(state, 'prepared.json'), 'utf8');
  assertGuestReached(cli('run', '--game', game, '--state', state));
  assert.notEqual(fs.readFileSync(path.join(state, 'prepared.json'), 'utf8'), beforePixi);
  fs.rmSync(path.join(game, 'js/pixi.js'));
  const bootstrap = path.join(state, JSON.parse(fs.readFileSync(path.join(state, 'prepared.json'))).bootstrap);
  fs.appendFileSync(bootstrap, '\n// damaged\n');
  assertGuestReached(cli('run', '--game', game, '--state', state));
  assert.equal(crypto.createHash('sha256').update(fs.readFileSync(bootstrap)).digest('hex'),
    JSON.parse(fs.readFileSync(path.join(state, 'prepared.json'))).bootstrapSha256,
    'damaged bootstrap is regenerated');
  fs.writeFileSync(infoFile, installedInfoBytes);
  if (!installedInfo.files && !installedInfo.payloadSha256) {
    const plainLoad = cli('self-test');
    assert.equal(plainLoad.status, 0, plainLoad.stdout + plainLoad.stderr);
    assert.equal(JSON.parse(plainLoad.stdout.trim().split('\n').at(-1)).test, 'runtime-load');
    assert.ok(process.argv[3], 'pass the producing build directory to inventory a plain installation');
    const runtimeStage = path.join(temporary, 'distribution');
    for (const component of ['native-addon', 'runtime']) {
      const installed = spawnSync('cmake', ['--install', path.resolve(process.argv[3]),
        '--prefix', runtimeStage, '--component', component], { encoding: 'utf8' });
      assert.equal(installed.status, 0, installed.stdout + installed.stderr);
    }
    fs.writeFileSync(path.join(runtimeStage, 'share/pmjs/notices/unicode-😀-é.txt'), 'payload checksum fixture');
    stage = runtimeStage;
    const manifested = spawnSync('python3', [path.resolve(__dirname, '../tools/release.py'), 'manifest',
      '--stage', stage, '--build', path.resolve(process.argv[3]), '--source', path.resolve(__dirname, '..')],
    { encoding: 'utf8' });
    assert.equal(manifested.status, 0, manifested.stdout + manifested.stderr);
  }
  const packageSha256 = crypto.createHash('sha256').update(fs.readFileSync(path.join(stage, 'build-info.json'))).digest('hex');
  const releaseRecord = path.join(path.dirname(stage), path.basename(stage) + '.release.json');
  const releaseRecordSha256 = crypto.createHash('sha256').update(fs.readFileSync(releaseRecord)).digest('hex');
  const report = path.join(temporary, 'verification.json');
  function archive(verification) {
    fs.writeFileSync(report, JSON.stringify({ releaseRecordSha256, ...verification }));
    return spawnSync('python3', [path.resolve(__dirname, '../tools/release.py'), 'archive',
      '--stage', stage, '--report', report, '--output', path.join(temporary, 'release.tar.gz')],
    { encoding: 'utf8' });
  }
  const wrongPackage = archive({ schema: 2, packageSha256: '0'.repeat(64), static: 'passed' });
  assert.notEqual(wrongPackage.status, 0);
  assert.match(wrongPackage.stderr, /different package/);
  const noExecution = archive({ schema: 2, packageSha256, static: 'passed', smoke: null });
  assert.equal(noExecution.status, 0, noExecution.stdout + noExecution.stderr);
  const noAudit = archive({ schema: 2, packageSha256, smoke: null });
  assert.notEqual(noAudit.status, 0);
  assert.match(noAudit.stderr, /Static package verification is required/);
  const incompleteReceipt = archive({ schema: 2, packageSha256, static: 'passed', smoke: { load: true } });
  assert.notEqual(incompleteReceipt.status, 0);
  assert.match(incompleteReceipt.stderr, /does not verify this exact package/);
  const load = cli('self-test');
  assert.equal(load.status, 0, load.stdout + load.stderr);
  const receipt = JSON.parse(load.stdout.trim().split('\n').at(-1));
  assert.equal(receipt.test, 'package-load');
  assert.equal(receipt.graphics, null);
  const loadOnly = archive({ schema: 2, packageSha256, static: 'passed', smoke: receipt });
  assert.equal(loadOnly.status, 0, loadOnly.stdout + loadOnly.stderr);
  fs.chmodSync(path.join(stage, 'LICENSE'), 0o755);
  const synthesizedModes = cli('self-test');
  assert.equal(synthesizedModes.status, 0, synthesizedModes.stdout + synthesizedModes.stderr);
  fs.chmodSync(path.join(stage, 'bin/pmjs'), 0o644);
  const noExecutable = spawnSync(process.execPath, [path.join(stage, 'share/pmjs/tools/package-self-test.cjs'), stage],
    { encoding: 'utf8', env: { ...process.env, NODE_OPTIONS: '', NODE_PATH: '', LD_LIBRARY_PATH: '' } });
  assert.notEqual(noExecutable.status, 0, 'required executable access is checked');
  fs.chmodSync(path.join(stage, 'bin/pmjs'), 0o755);
  const extraFile = path.join(stage, 'lib/unexpected.so');
  fs.writeFileSync(extraFile, 'unexpected');
  const changedPayload = cli('self-test');
  assert.notEqual(changedPayload.status, 0);
  assert.match(changedPayload.stderr, /exact package payload|runtime payload checksum/);
  fs.rmSync(extraFile);
  fs.appendFileSync(path.join(stage, 'share/pmjs/runner/cli.cjs'), '\n// damaged\n');
  const tampered = cli('self-test');
  assert.notEqual(tampered.status, 0);
  assert.match(tampered.stderr, /package checksum|runtime payload checksum/);
  console.log('Installed preparation, relocation, archive integrity and tamper checks passed');
} finally {
  fs.rmSync(temporary, { recursive: true, force: true });
}
