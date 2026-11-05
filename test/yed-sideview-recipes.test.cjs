'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const { yedSideviewFrames } = require('../runner/yed-sideview-recipes.cjs');
const { automaticRecipe } = require('../runner/asset-preparation.cjs');

function metadata({ enabled = true, actors = [], enemies = [], parameters = {} } = {}) {
  return new Map([
    ['js/plugins.js', Buffer.from('var $plugins = ' + JSON.stringify([
      { name: 'YED_SideviewBattler', status: enabled, parameters }
    ]) + ';')],
    ['data/Actors.json', Buffer.from(JSON.stringify([null, ...actors]))],
    ['data/Enemies.json', Buffer.from(JSON.stringify([null, ...enemies]))]
  ]);
}
function header(width, height) {
  const bytes = Buffer.alloc(24);
  Buffer.from('89504e470d0a1a0a', 'hex').copy(bytes);
  bytes.writeUInt32BE(width, 16); bytes.writeUInt32BE(height, 20);
  return bytes;
}

test('enabled YED frame dimensions override ambiguous standard grids for actors and enemies', async () => {
  const files = metadata({ parameters: { 'Default Frame Width': '90', 'Default Frame Height': '100' },
    actors: [{ note: '<Sideview Battler: custom_actor>\n<Sideview Battler Frames: 4>' }],
    enemies: [{ note: '<Sideview Battler: custom_enemy>\n<Sideview Battler Size: 90, 75>' }] });
  const frames = await yedSideviewFrames(async name => files.get(name) ?? null);
  const recipe = (name, height) => automaticRecipe(null, 'img/sv_actors/'+name+'.png', '0'.repeat(64), header(360, height), frames);
  assert.deepEqual((await recipe('custom_actor', 600)).grid, [4, 6]);
  assert.deepEqual((await recipe('custom_enemy', 600)).grid, [4, 8]);
  assert.deepEqual((await recipe('ordinary_actor', 600)).grid, [9, 6]);
  assert.equal(await recipe('custom_actor', 601), undefined, 'partial frames must not select another guessed grid');
});

test('disabled plugins do not interpret sideview metadata or read battler databases', async () => {
  const files = metadata({ enabled: false });
  const frames = await yedSideviewFrames(async name => {
    assert.equal(name, 'js/plugins.js'); return files.get(name);
  });
  assert.equal(frames.size, 0);
});

test('YED detection accepts truthy status', async () => {
  const files = metadata({ enabled: 1, actors: [{ note: '<Sideview Battler: custom>\n<Sideview Battler Size: 90, 100>' }] });
  const frames = await yedSideviewFrames(async name => files.get(name) ?? null);
  assert.deepEqual(frames.get('img/sv_actors/custom.png'), { width: 90, height: 100 });
});

test('YED defaults, repeated tags, standard battlers and conflicting frame sizes retain their semantics', async () => {
  const files = metadata({ actors: [
    { note: '<Sideview Battler: shared>\n<Sideview Battler Size: 90, 100>' },
    { note: '<Sideview Battler: stock>\n<Sideview Battler Default>' },
    { note: '<Sideview Battler: invalid>\n<Sideview Battler Size: 0, 100>' },
    { note: '<Sideview Battler: ../escape>\n<Sideview Battler Size: 90, 100>' }
  ], enemies: [
    { note: '<sideview battler: shared>\n<Sideview Battler Size: 90, 75>' },
    { note: '<Sideview Battler: renamed>\n<Sideview Battler: final>\n<Sideview Battler Size: 90, 100>\n<Sideview Battler Size: 90, 75>' }
  ] });
  const frames = await yedSideviewFrames(async name => files.get(name) ?? null);
  assert.equal(frames.get('img/sv_actors/shared.png'), null, 'conflicting users cannot supply a guessed layout');
  assert.equal(frames.get('img/sv_actors/invalid.png'), null);
  assert.deepEqual(frames.get('img/sv_actors/final.png'), { width: 90, height: 75 });
  assert.equal(frames.size, 3);
});

test('unreadable sideview metadata leaves ordinary preparation available and reports the reason', async () => {
  const files = metadata(); files.set('data/Actors.json', Buffer.from('{'));
  const warnings = [];
  const frames = await yedSideviewFrames(async name => files.get(name) ?? null, { warn: message => warnings.push(message) });
  assert.equal(frames.size, 0);
  assert.match(warnings[0], /YED_SideviewBattler preparation metadata unavailable/);
});
