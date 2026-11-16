'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const test = require('node:test');
const { createStorage } = require('../runner/storage.cjs');
const { temporaryDirectory } = require('./helpers/temp.cjs');

function fixture(engine = 'mv', virtualFiles = {}) {
  const root = temporaryDirectory('pmjs-save-mount-');
  const storage = createStorage(root), gameReads = [];
  const context = vm.createContext({ Buffer, console, __pmjsBuiltinRequire: require,
    PMJS_RUNTIME_ENGINE: engine, PMJS: { config: { virtualFiles }, tasks: { enqueue: setImmediate } },
    NativeHost: { storage, fs: {
      readBytes(name) { gameReads.push(name); return Buffer.from('game data'); },
    } } });
  vm.runInContext(fs.readFileSync(path.join(__dirname, '../js/pmjs-web/filesystem.js'), 'utf8'), context);
  return { root, storage, guest: context.fsModule, context, gameReads };
}

for (const engine of ['mv', 'mz']) {
  test(engine + ' save aliases share files, metadata and directory operations', () => {
    const { root, guest } = fixture(engine);
    for (const directory of ['/save', '/game/save', 'save', './save/']) {
      assert.equal(guest.existsSync(directory), true);
      assert.equal(guest.statSync(directory).isDirectory(), true);
      assert.equal(guest.mkdirSync(directory, { recursive: true }), undefined);
      assert.throws(() => guest.mkdirSync(directory), { code: 'EEXIST' });
    }
    guest.writeFileSync('/game/save/settings.json', '{"columns":4}');
    assert.equal(fs.readFileSync(path.join(root, 'settings.json'), 'utf8'), '{"columns":4}');
    guest.appendFileSync('save/settings.json', '\n');
    assert.equal(guest.readFileSync('/save/settings.json', 'utf8'), '{"columns":4}\n');
    assert.equal(guest.statSync('/save/settings.json').ino, guest.lstatSync('save/settings.json').ino);
    guest.accessSync('/game/save/settings.json', guest.constants.R_OK | guest.constants.W_OK);
    assert.deepEqual(Array.from(guest.readdirSync('/game/save')), ['settings.json']);
    assert.equal(guest.readdirSync('save', { withFileTypes: true })[0].isFile(), true);
    guest.renameSync('/save/settings.json', '/game/save/renamed.json');
    assert.equal(guest.existsSync('save/settings.json'), false);
    guest.copyFileSync('save/renamed.json', '/save/copy.json');
    guest.unlinkSync('/game/save/renamed.json');
    guest.rmSync('save/copy.json');
    assert.deepEqual(Array.from(guest.readdirSync('/save')), []);
  });
}

test('promises and read streams use the same persistent files through different aliases', async () => {
  const { guest } = fixture();
  await guest.promises.writeFile('save/file.rpgsave', 'existing progress');
  assert.equal(await guest.promises.readFile('/game/save/file.rpgsave', 'utf8'), 'existing progress');
  let contents = '';
  for await (const chunk of guest.createReadStream('/game/save/file.rpgsave', { encoding: 'utf8' })) contents += chunk;
  assert.equal(contents, 'existing progress');
  await guest.promises.rename('/game/save/file.rpgsave', '/save/renamed.rpgsave');
  await guest.promises.unlink('save/renamed.rpgsave');
  assert.equal(guest.existsSync('/save/renamed.rpgsave'), false);
});

test('mount matching preserves unrelated game paths and save filenames', () => {
  const { guest, gameReads } = fixture('mv', { directoryEntryAliases: { languages: { '.yaml': '.LANG' } } });
  guest.mkdirSync('/game/save/languages');
  guest.writeFileSync('save/languages/settings.yaml', 'settings');
  assert.deepEqual(Array.from(guest.readdirSync('/game/save/languages')), ['settings.yaml']);
  for (const name of ['/game/data/save/file', '/game/save-other/file', '/elsewhere/save/file']) {
    assert.equal(guest.readFileSync(name, 'utf8'), 'game data');
  }
  assert.deepEqual(gameReads, ['data/save/file', 'save-other/file', 'elsewhere/save/file']);
});

test('custom mount declarations share storage without implicitly mounting the game root', () => {
  const { guest, gameReads } = fixture(null, { saveDirectories: ['profile/saves'] });
  guest.writeFileSync('/game/profile/saves/settings.json', 'custom settings');
  assert.equal(guest.readFileSync('/save/settings.json', 'utf8'), 'custom settings');
  assert.equal(guest.readFileSync('save/settings.json', 'utf8'), 'game data');
  assert.deepEqual(gameReads, ['save/settings.json']);
  for (const directory of ['.', '../save', '/game/save']) {
    assert.throws(() => fixture('mv', { saveDirectories: [directory] }), /save directory|game-relative/);
  }
});

test('existing persistent saves remain authoritative and escape symlinks remain rejected', () => {
  const { root, storage, guest, gameReads } = fixture();
  storage.writeText('file1.rpgsave', 'existing progress');
  assert.equal(guest.readFileSync('/game/save/file1.rpgsave', 'utf8'), 'existing progress');
  assert.deepEqual(gameReads, []);
  const outside = temporaryDirectory('pmjs-save-outside-');
  fs.writeFileSync(path.join(outside, 'keep'), 'untouched');
  fs.symlinkSync(outside, path.join(root, 'escape'));
  assert.throws(() => guest.writeFileSync('/game/save/escape/keep', 'changed'), { code: 'EACCES' });
  assert.equal(fs.readFileSync(path.join(outside, 'keep'), 'utf8'), 'untouched');
});
