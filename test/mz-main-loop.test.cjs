'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const vm = require('node:vm');

const sharedSource = fs.readFileSync(path.resolve(__dirname,
  '../js/pmjs-rpgmaker/main-loop.js'), 'utf8');
const mzSource = fs.readFileSync(path.resolve(__dirname,
  '../js/pmjs-mz/main-loop.js'), 'utf8');

test('MZ host tick drains native services, pending work, and scheduler in order', () => {
  const events = [];
  const context = vm.createContext({
    console: { log() {} },
    globalThis: null,
    PMJS: { tasks: { drain() { events.push('pending'); } },
      rpgmaker: { audio: { update() { events.push('audio'); } } },
      web: { video: { update() { events.push('video'); } } },
      mz: { graphics: { updatePresentation() { events.push('presentation'); } } } },
    pmjsDrainScheduler(now) { events.push('scheduler:' + now); },
    SceneManager: { _scene: null },
  });
  context.globalThis = context;
  vm.runInContext(sharedSource, context, { filename: 'pmjs-rpgmaker/main-loop.js' });
  vm.runInContext(mzSource, context, { filename: 'pmjs-mz/main-loop.js' });

  context.__pmjsTick(25);

  assert.deepEqual(events, [
    'audio', 'video', 'pending', 'scheduler:25',
  ]);
  assert.equal(typeof context.__pmjsRender, 'function');
  context.__pmjsRender(25);
  assert.equal(events.at(-1), 'presentation', 'presentation keeps running when the scene ticker is stopped');
});
