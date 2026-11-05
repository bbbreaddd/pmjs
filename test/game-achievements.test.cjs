'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const { temporaryDirectory } = require('./helpers/temp.cjs');

function game(plugins) {
  const root = temporaryDirectory('pmjs-achievement-discovery-');
  fs.mkdirSync(path.join(root, 'js/plugins'), { recursive: true });
  fs.mkdirSync(path.join(root, 'data'));
  fs.writeFileSync(path.join(root, 'js/plugins.js'), 'var $plugins = ' + JSON.stringify(plugins.map(plugin =>
    ({ name: plugin.name, status: plugin.enabled !== false, parameters: {} }))) + ';');
  for (const plugin of plugins) {
    const file = path.join(root, 'js/plugins', plugin.name + '.js');
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, plugin.source || '');
  }
  return root;
}

function data(root, name, value) {
  fs.writeFileSync(path.join(root, 'data', name), JSON.stringify(value));
}
function command(code, ...parameters) { return { code, parameters }; }
function map(root, commands) {
  data(root, 'Map001.json', { events: [null, { id: 1, pages: [{ list: commands }] }], data: [] });
}
async function inspect(root) { return (await import('../tools/game-inspect.mjs')).inspectAchievements(root); }
function ids(report) { return report.catalog.map(entry => entry.id); }

test('enabled Steam calls and unchanged forwarding functions discover literal IDs without executing source', async () => {
  const root = game([
    { name: 'Cyclone-Steam' }, { name: 'OrangeGreenworks' },
    { name: 'Custom', source: `throw new Error('must never execute');
      function grant(value) { CycloneSteam.activateAchievement(value, callback); }
      function changed(value) { value = 'different'; CycloneSteam.activateAchievement(value); }
      function shadowed(value) { function inner(value) { CycloneSteam.activateAchievement(value); } }
      // grant('COMMENT');
      const text = "grant('STRING')";
      const expression = /grant('REGEX')/;
      const combined = text + /grant('OPERATOR_REGEX')/.source;
      if (true) /grant('CONTROL_REGEX')/.test(text);
      OrangeGreenworks.activateAchievement('PLUGIN');` },
    { name: 'Disabled', enabled: false, source: "CycloneSteam.activateAchievement('DISABLED');" }
  ]);
  map(root, [command(101, "grant('DIALOGUE')"),
    command(108, "grant('EVENT_COMMENT')"),
    command(355, 'grant('), command(655, "'CONTINUED');"),
    command(355, "CycloneSteam['activateAchievement']('ESC\\x41PED');"),
    command(355, 'CycloneSteam.activateAchievement(`STATIC`);'),
    command(355, 'CycloneSteam.activateAchievement(`DYNAMIC_${value}`);'),
    command(355, "CycloneSteam.activateAchievement('PREFIX' + variable);"),
    command(355, "changed('REWRITTEN'); shadowed('SHADOWED');"),
    command(355, "// comment\rgrant('CR_COMMENT');"),
    command(111, 12, "OrangeGreenworks.getAchievement('CONDITION')"),
    command(122, 1, 1, 0, 4, "OrangeGreenworks.getAchievement('FORMULA')"),
    command(205, -1, { list: [command(45, "grant('MOVE')")] })]);
  const report = await inspect(root);
  assert.deepEqual(ids(report), ['CONDITION', 'CONTINUED', 'CR_COMMENT', 'ESCAPED', 'FORMULA', 'MOVE', 'PLUGIN', 'STATIC']);
  assert.equal(report.diagnostics.filter(item => item.reason === 'dynamic-achievement-id').length, 2);
  assert.ok(report.references.some(item => item.kind === 'plugin-script' && item.id === 'PLUGIN'));
  assert.ok(report.references.some(item => item.kind === 'event-script' && item.id === 'CONTINUED'));
});

test('MV commands and MZ typed arguments follow their enabled plugin contracts', async () => {
  const root = game([{ name: 'Archeia_Steamworks' }, { name: 'Archeia/VisuMZ_5_Steamworks' }]);
  data(root, 'CommonEvents.json', [null, { id: 1, list: [
    command(356, 'steamworks activateachievement FIRST'),
    command(356, 'STEAMWORKS grantachievement TWO WORDS'),
    command(357, 'Archeia/VisuMZ_5_Steamworks', 'ActivateAchievement', 'label', { 'Name:str': 'TYPED' }),
    command(357, 'Archeia/VisuMZ_5_Steamworks', 'IsAchievementUnlocked', 'label', { 'Name:str': 'TYPED' }),
    command(357, 'AbsentSteamPlugin', 'ActivateAchievement', 'label', { achievementName: 'ABSENT' }),
    command(357, 'Archeia/VisuMZ_5_Steamworks', 'ActivateAchievement', 'label', { 'Name:str': '\\V[3]' }),
    command(356, 'D_TEXT Achievements unlocked'),
  ] }]);
  const report = await inspect(root);
  assert.deepEqual(ids(report), ['FIRST', 'TWOWORDS', 'TYPED']);
  assert.ok(report.diagnostics.some(item => item.reason === 'inactive-plugin-command'));
  assert.ok(report.diagnostics.some(item => item.reason === 'dynamic-achievement-id'));
});

test('database notetags use the item and class rules only with their active integration', async () => {
  const root = game([{ name: 'Archeia_Steamworks' }]);
  data(root, 'Items.json', [null, { id: 1, note: '<achievement grant: ITEM,+1/>' }]);
  data(root, 'Classes.json', [null, { id: 1, note: '<achievement grant: CLASS,LEARN,3/>' }]);
  data(root, 'Troops.json', [null, { id: 1, note: '<achievement grant: WRONG,+1/>', pages: [] }]);
  assert.deepEqual(ids(await inspect(root)), ['CLASS', 'ITEM']);
  const disabled = game([{ name: 'Archeia_Steamworks', enabled: false }]);
  data(disabled, 'Items.json', [null, { id: 1, note: '<achievement grant: ITEM,+1/>' }]);
  assert.deepEqual(ids(await inspect(disabled)), []);
});

test('inspection leaves preparation catalog-free unless optional metadata is supplied', async () => {
  const { prepareGameConfig } = await import('../tools/game-inspect.mjs');
  const root = game([{ name: 'OrangeGreenworks', source: "OrangeGreenworks.activateAchievement('AUTHORED');" }]);
  const config = Object.freeze({ steam: Object.freeze({ provider: 'portable' }) });
  assert.deepEqual(ids(await inspect(root)), ['AUTHORED']);
  assert.equal(prepareGameConfig(root, config), config);
  const explicit = { achievements: { catalog: [] } };
  assert.equal(prepareGameConfig(root, explicit), explicit);
  fs.mkdirSync(path.join(root, 'lib/steam_settings'), { recursive: true });
  fs.writeFileSync(path.join(root, 'lib/steam_settings/achievements.json'), '[{"name":"DECLARED","displayName":"Declared"}]');
  assert.deepEqual(prepareGameConfig(root).achievements.catalog.map(entry => entry.id), ['DECLARED']);
});

test('missing sources and malformed achievement data remain visible in inspection', async () => {
  const root = game([{ name: 'OrangeGreenworks' }]);
  fs.unlinkSync(path.join(root, 'js/plugins/OrangeGreenworks.js'));
  fs.writeFileSync(path.join(root, 'data/Map001.json'), '{"achievement":');
  const report = await inspect(root);
  assert.deepEqual(ids(report), []);
  assert.deepEqual(report.diagnostics.map(item => item.reason), ['missing-enabled-plugin', 'invalid-data']);
});

test('achievement discovery follows plugin status truthiness and excludes unrelated systems', async () => {
  const root = game([{ name: 'OrangeGreenworks' }, { name: 'LocalAchievements' }]);
  const plugins = [null, { name: 'OrangeGreenworks', status: 'false' }, { name: 'LocalAchievements', status: true }];
  fs.writeFileSync(path.join(root, 'js/plugins.js'),
    'var $plugins = ' + JSON.stringify(plugins) + ';');
  map(root, [command(355, "OrangeGreenworks.activateAchievement('STEAM'); LocalAchievements.unlockAchievement('LOCAL');"),
    command(357, 'AbsentProvider', 'ActivateAchievement', '', { 'Name:str': 'ABSENT' })]);
  assert.deepEqual(ids(await inspect(root)), ['STEAM']);
  plugins[1].status = 0;
  fs.writeFileSync(path.join(root, 'js/plugins.js'),
    'var $plugins = ' + JSON.stringify(plugins) + ';');
  const report = await inspect(root);
  assert.deepEqual(ids(report), []);
  assert.equal(report.coverage, 'no-enabled-provider');
});
