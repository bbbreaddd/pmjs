'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const vm = require('node:vm');

const runtimeRoot = path.resolve(__dirname, '..');

test('virtual file aliases are configured data', () => {
  const source = fs.readFileSync(path.join(runtimeRoot,
    'js/pmjs-web/filesystem.js'), 'utf8');
  const end = source.indexOf('\nvar pendingTasks =');
  const context = {
    pmjsGameConfig: { virtualFiles: {
      extensionAliases: { '.alias': '.json' },
      directoryEntryAliases: { locale: { '.json': '.LANG' } },
    } },
  };
  vm.runInNewContext(source.slice(0, end) +
    '\nthis.contract = { gameReadPath, gameDirectoryEntries };', context);
  assert.equal(context.contract.gameReadPath('/game/data/System.ALIAS'),
    'data/System.json');
  assert.deepEqual(Array.from(context.contract.gameDirectoryEntries(
    '/game/locale/', ['en.json', 'readme.txt'])), ['en.LANG', 'readme.txt']);
});

test('registered CommonJS requests are exact and cannot be replaced', () => {
  const source = fs.readFileSync(path.join(runtimeRoot,
    'js/pmjs-web/modules.js'), 'utf8');
  const end = source.indexOf('\nvar compatibilityNoop');
  const context = { Array, Object, Error };
  vm.runInNewContext(source.slice(0, end) +
    '\nthis.contract = { registerCommonJsModule, registeredCommonJsModules };',
  context);
  const exports = { available: true };
  context.contract.registerCommonJsModule(['platform-api', './platform-api'], exports);
  assert.equal(context.contract.registeredCommonJsModules['platform-api'], exports);
  assert.throws(() => context.contract.registerCommonJsModule('platform-api', {}),
    /already registered/);
});
