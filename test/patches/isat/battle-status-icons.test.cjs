'use strict';

const { loadPmjsRuntime } = require('../../helpers/runtime-context.cjs');

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const vm = require('node:vm');

const adapter = fs.readFileSync(path.join(__dirname, '../../../patches/isat/battle-status-icons.js'), 'utf8');

function setup({ recognized = true, qualification = { verified: true }, extraWork = false } = {}) {
  const context = loadPmjsRuntime({
    console: { log() {}, error() {} },
    __pmjsBuiltinRequire: require,
  });
  context.globalThis = context;
  if (qualification) context.PMJS.isatSourceQualification = qualification;
  vm.runInContext(`
    function Window_BattleStatusUpgrade(actor) {
      this._actor = actor;
      this._checkForRefresh = [];
      this.refreshCount = 0;
    }
    Window_BattleStatusUpgrade.prototype.refresh = function() {
      this.refreshCount++;
    };
    Window_BattleStatusUpgrade.prototype.updateRefreshes = function() {
      ${extraWork ? 'this.authoredUpdates = (this.authoredUpdates || 0) + 1;' : ''}
      const actor = this._actor;
      const length = this._checkForRefresh.length;
      for (let i = 0; i < length; i++) {
        const info = this._checkForRefresh[i];
        if (info[0] !== eval(info[1])) {
          this.refresh();
          break;
        }
      }
    };
    Window_BattleStatusUpgrade.prototype.drawActorIconsScale = function(actor) {
      this._checkForRefresh.push([actor.allIcons(), "actor.allIcons()"]);
    };
  `, context);
  const hash = method => context.PMJS.methods.fingerprint(context.PMJS.methods.sourceOf(method));
  const source = adapter
    .replace('ffd96184669de4d75cdbcd5ba90ccca6f0c5fa033941f1d020eead313f466154', hash(context.Window_BattleStatusUpgrade.prototype.updateRefreshes))
    .replace('5079c41aea8d86f452570edc42bfd1d5463dca629bf0e68eb3dafc34578ee1d1', hash(context.Window_BattleStatusUpgrade.prototype.drawActorIconsScale));
  if (!recognized) context.Window_BattleStatusUpgrade.prototype.drawActorIconsScale = function() {};
  const original = context.Window_BattleStatusUpgrade.prototype.updateRefreshes;
  new vm.Script(source).runInContext(context);
  context.PMJS.phases.emit('afterGuestPlugins');
  context.PMJS.phases.emit('afterPlugins');
  context.PMJS.methods.install();
  context.PMJS.optimizations.finalize();
  const refusal = context.PMJS.optimizations.dump()
    .find(entry => entry.id === 'isat.battle-status-icons')?.refusalReason ?? undefined;
  return { context, original, refusal };
}

test('unchanged icon contents do not redraw the battle status panel', () => {
  const { context, refusal } = setup();
  const actor = { hp: 42, icons: [3, 7], allIcons() { return this.icons.slice(); } };
  const panel = new context.Window_BattleStatusUpgrade(actor);
  panel.drawActorIconsScale(actor);
  panel._checkForRefresh.push([actor.hp, 'actor.hp']);
  panel.updateRefreshes();
  panel.updateRefreshes();
  assert.equal(refusal, undefined);
  assert.equal(panel.refreshCount, 0);
});

test('icon and ordinary value changes still redraw the panel', () => {
  const { context } = setup();
  const actor = { hp: 42, icons: [3, 7], allIcons() { return this.icons.slice(); } };
  const panel = new context.Window_BattleStatusUpgrade(actor);
  panel.drawActorIconsScale(actor);
  panel._checkForRefresh.push([actor.hp, 'actor.hp']);
  actor.icons = [3, 8];
  panel.updateRefreshes();
  assert.equal(panel.refreshCount, 1);
  actor.icons = [3, 7];
  actor.hp = 41;
  panel.updateRefreshes();
  assert.equal(panel.refreshCount, 2);
});

test('unknown plugin composition keeps the original refresh check', () => {
  const { context, original, refusal } = setup({ recognized: false });
  assert.match(refusal, /unrecognized battle status icon refresh/);
  assert.equal(context.Window_BattleStatusUpgrade.prototype.updateRefreshes, original);
});

test('missing or failed source qualification preserves authored update work', () => {
  for (const qualification of [null, { verified: false, reason: 'unreviewed plugin' }]) {
    const { context, original, refusal } = setup({ qualification, extraWork: true });
    assert.equal(context.Window_BattleStatusUpgrade.prototype.updateRefreshes, original);
    assert.equal(refusal, qualification ? qualification.reason : 'unqualified battle status sources');
    const actor = { allIcons() { return [3, 7]; } };
    const panel = new context.Window_BattleStatusUpgrade(actor);
    panel.drawActorIconsScale(actor);
    panel.updateRefreshes();
    assert.equal(panel.authoredUpdates, 1);
    assert.equal(panel.refreshCount, 1);
  }
});
