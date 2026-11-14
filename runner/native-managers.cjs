'use strict';

function installTextManager(scope) {
  function TextManager() { throw new Error('TextManager is a static class'); }
  for (const [method, section] of Object.entries({ basic: 'basic', param: 'params', command: 'commands', message: 'messages' }))
    TextManager[method] = function(id) { return scope.$dataSystem.terms[section][id] || ''; };
  TextManager.getter = function(method, id) {
    return { configurable: true, get() { return this[method](id); } };
  };
  Object.defineProperty(TextManager, 'currencyUnit', { configurable: true, get() { return scope.$dataSystem.currencyUnit; } });
  for (const [id, name] of ['level', 'levelA', 'hp', 'hpA', 'mp', 'mpA', 'tp', 'tpA', 'exp', 'expA'].entries())
    Object.defineProperty(TextManager, name, TextManager.getter('basic', id));
  const commands = ['fight', 'escape', 'attack', 'guard', 'item', 'skill', 'equip', 'status', 'formation', 'save',
    'gameEnd', 'options', 'weapon', 'armor', 'keyItem', 'equip2', 'optimize', 'clear', 'newGame', 'continue_', null, 'toTitle', 'cancel', null, 'buy', 'sell'];
  for (const [id, name] of commands.entries()) if (name) Object.defineProperty(TextManager, name, TextManager.getter('command', id));
  const messages = ['alwaysDash', 'commandRemember', 'bgmVolume', 'bgsVolume', 'meVolume', 'seVolume', 'possession', 'expTotal',
    'expNext', 'saveMessage', 'loadMessage', 'file', 'partyName', 'emerge', 'preemptive', 'surprise', 'escapeStart', 'escapeFailure',
    'victory', 'defeat', 'obtainExp', 'obtainGold', 'obtainItem', 'levelUp', 'obtainSkill', 'useItem', 'criticalToEnemy', 'criticalToActor',
    'actorDamage', 'actorRecovery', 'actorGain', 'actorLoss', 'actorDrain', 'actorNoDamage', 'actorNoHit', 'enemyDamage', 'enemyRecovery',
    'enemyGain', 'enemyLoss', 'enemyDrain', 'enemyNoDamage', 'enemyNoHit', 'evasion', 'magicEvasion', 'magicReflection', 'counterAttack',
    'substitute', 'buffAdd', 'debuffAdd', 'buffRemove', 'actionFailure'];
  for (const name of messages) Object.defineProperty(TextManager, name, TextManager.getter('message', name));
  scope.TextManager = TextManager;
}

function installSoundManager(scope, engine, session) {
  function SoundManager() { throw new Error('SoundManager is a static class'); }
  SoundManager.playSystemSound = function(index) { engine.managerInvoke(session, 'playSystemSound', index); };
  SoundManager.loadSystemSound = function(index) { engine.managerInvoke(session, 'loadSystemSound', index); };
  SoundManager.preloadImportantSounds = function() { for (let i = 0; i < 4; ++i) this.loadSystemSound(i); };
  const sounds = ['Cursor', 'Ok', 'Cancel', 'Buzzer', 'Equip', 'Save', 'Load', 'BattleStart', 'Escape', 'EnemyAttack',
    'EnemyDamage', 'EnemyCollapse', 'BossCollapse1', 'BossCollapse2', 'ActorDamage', 'ActorCollapse', 'Recovery', 'Miss',
    'Evasion', 'MagicEvasion', 'Reflection', 'Shop', 'UseItem', 'UseSkill'];
  for (const [index, name] of sounds.entries()) SoundManager['play' + name] = function() { this.playSystemSound(index); };
  scope.SoundManager = SoundManager;
}

module.exports = { installTextManager, installSoundManager };
