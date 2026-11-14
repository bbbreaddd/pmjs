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

function installAudioManager(scope,engine,session,bindings,createArray = values => values) {
  function AudioManager() { throw new Error('AudioManager is a static class'); }
  const invoke=(kind,operation,...args) => engine.audioManager(session,kind,operation,...args);
  const wrap=handle => handle ? bindings.wrap(handle,'WebAudio') : null;
  AudioManager._path='audio/';
  AudioManager.audioFileExt=function() { return scope.WebAudio.canPlayOgg() ? '.ogg' : '.m4a'; };
  AudioManager.createBuffer=function(folder,name) { return new scope.WebAudio(this._path+folder+'/'+encodeURIComponent(name)+this.audioFileExt()); };
  for (const method of ['playBgm','playBgs','playSe','playMe','stopBgm','stopBgs','stopMe','stopSe',
    'fadeOutBgm','fadeOutBgs','fadeOutMe','fadeInBgm','fadeInBgs','replayBgm','replayBgs','playStaticSe'])
    AudioManager[method]=function(...args) { engine.managerInvoke(session,method,...args); invoke('bgm','flush'); };
  AudioManager.stopAll=function() { this.stopMe(); this.stopBgm(); this.stopBgs(); this.stopSe(); };
  AudioManager.shouldUseHtml5Audio=function() { return engine.managerInvoke(session,'shouldUseHtml5Audio'); };
  AudioManager.makeEmptyAudioObject=function() { return {name:'',volume:0,pitch:0,pan:0,pos:0}; };
  for (const kind of ['bgm','bgs','me']) {
    const suffix=kind[0].toUpperCase()+kind.slice(1);
    Object.defineProperty(AudioManager,'_'+kind+'Buffer',{
      configurable:true,get() { return wrap(invoke(kind,'buffer')); },
      set(value) { invoke(kind,'buffer',value ? bindings.handle(value) : null); }
    });
    AudioManager['update'+suffix+'Parameters']=function(sound) { invoke(kind,'parameters',sound); };
    if (kind==='me') continue;
    const current=new Proxy({}, {
      get(target,key) { return invoke(kind,'current')?.[key]; },
      set(target,key,value) { invoke(kind,'current',{...invoke(kind,'current'),[key]:value}); return true; },
      ownKeys() { return Reflect.ownKeys(invoke(kind,'current') || {}); },
      getOwnPropertyDescriptor(target,key) { const value=invoke(kind,'current'); return value && Object.hasOwn(value,key) ? {enumerable:true,configurable:true,writable:true,value:value[key]} : undefined; }
    });
    Object.defineProperty(AudioManager,'_current'+suffix,{
      configurable:true,get() { return invoke(kind,'current') ? current : null; },set(value) { invoke(kind,'current',value); }
    });
    AudioManager['isCurrent'+suffix]=function(sound) { return engine.managerInvoke(session,'isCurrent'+suffix,sound); };
    AudioManager['updateCurrent'+suffix]=function(sound,pos=0) { invoke(kind,'current',{name:sound.name,volume:sound.volume,pitch:sound.pitch,pan:sound.pan,pos}); };
    AudioManager['save'+suffix]=function() { const sound=invoke(kind,'current'); return sound ? {...sound,pos:this['_'+kind+'Buffer']?.seek() || 0} : this.makeEmptyAudioObject(); };
  }
  for (const kind of ['bgm','bgs','me','se']) for (const prefix of ['', '_']) Object.defineProperty(AudioManager,prefix+kind+'Volume',{
    configurable:true,get() { return scope.ConfigManager[kind+'Volume']; },set(value) { scope.ConfigManager[kind+'Volume']=value; }
  });
  const readEffects=() => invoke('se','buffers').map(wrap);
  const writeEffects=items => invoke('se','buffers',items.map(item => item ? bindings.handle(item) : null));
  const effects=new Proxy(createArray([]),{
    get(target,key,receiver) {
      if (key==='length') return readEffects().length;
      if (typeof key==='string' && /^(0|[1-9][0-9]*)$/.test(key)) return readEffects()[Number(key)];
      return Reflect.get(target,key,receiver);
    },
    set(target,key,value) {
      const items=readEffects();
      if (key==='length') items.length=value;
      else if (typeof key==='string' && /^(0|[1-9][0-9]*)$/.test(key)) items[Number(key)]=value;
      else return Reflect.set(target,key,value);
      writeEffects(items); return true;
    },
    has(target,key) { return key==='length' || typeof key==='string' && /^(0|[1-9][0-9]*)$/.test(key) ? key==='length' || Number(key)<readEffects().length : Reflect.has(target,key); },
    ownKeys() { return [...readEffects().keys()].map(String).concat('length'); },
    getOwnPropertyDescriptor(target,key) {
      if (key==='length') return {...Reflect.getOwnPropertyDescriptor(target,key),value:readEffects().length};
      if (typeof key!=='string' || !/^(0|[1-9][0-9]*)$/.test(key)) return Reflect.getOwnPropertyDescriptor(target,key);
      const items=readEffects(); return Number(key)<items.length ? {configurable:true,enumerable:true,writable:true,value:items[Number(key)]} : Reflect.getOwnPropertyDescriptor(target,key);
    }
  });
  Object.defineProperty(AudioManager,'_seBuffers',{configurable:true,get() { return effects; },set(value) { writeEffects(value); }});
  AudioManager.updateSeParameters=function(buffer,sound) { invoke('se','parameters',bindings.handle(buffer),sound); };
  scope.AudioManager=AudioManager;
}

module.exports = { installTextManager, installSoundManager, installAudioManager };
