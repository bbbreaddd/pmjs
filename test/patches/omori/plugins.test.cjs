'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const vm = require('node:vm');

test('disabled OMORI screen effects stay disabled across creation and option changes', () => {
  const loaded = new Map();
  const phases = new Map();
  const context = {
    ConfigManager: { screenEffectsEnabled: false },
    Spriteset_Base: function Spriteset_Base() {},
    PMJS: {
      config: {},
      plugins: { onLoaded(name, owner, callback) { loaded.set(name, callback); } },
      phases: { on(name, owner, callback) { phases.set(name, callback); } },
      methods: { own() {} }
    }
  };
  context.globalThis = context;
  context.Spriteset_Base.prototype.createScreenEffectFilters = function() {
    this._ase_blur_filter = { enabled: true };
    this._ase_zblur_filter = { enabled: true };
    this._ase_glow_filter = { enabled: true };
    this._ase_wave_filter = { enabled: true };
    this._ase_dist_filter = { enabled: true };
    this.otherFilter = { enabled: true };
  };
  context.Spriteset_Base.prototype.update = function() {
    if (context.ConfigManager.screenEffectsEnabled) {
      this._ase_blur_filter.enabled = true;
    }
  };
  vm.runInNewContext(fs.readFileSync(path.join(__dirname, '../../../patches/omori/plugins.js'), 'utf8'),
    context);
  loaded.get('Aries001_AnimationScreenEffects')();
  phases.get('afterGuestPlugins')();

  const spriteset = new context.Spriteset_Base();
  spriteset.createScreenEffectFilters();
  const names = ['_ase_blur_filter', '_ase_zblur_filter', '_ase_glow_filter',
    '_ase_wave_filter', '_ase_dist_filter'];
  for (const name of names) assert.equal(spriteset[name].enabled, false, name);
  assert.equal(spriteset.otherFilter.enabled, true);

  context.ConfigManager.screenEffectsEnabled = true;
  spriteset.update();
  assert.equal(spriteset._ase_blur_filter.enabled, true);
  context.ConfigManager.screenEffectsEnabled = false;
  spriteset.update();
  for (const name of names) assert.equal(spriteset[name].enabled, false, name);
  assert.equal(spriteset.otherFilter.enabled, true);
});


test('adapter can follow a plugin manifest without a trailing semicolon', () => {
  const registrations = [];
  const context = { PMJS: {
    config: {},
    plugins: { onLoaded(name) { registrations.push(name); } },
    methods: { own() {} },
  } };
  vm.runInNewContext('var $plugins = []\n' +
    fs.readFileSync(path.join(__dirname, '../../../patches/omori/plugins.js'), 'utf8'), context);
  assert.equal(context.$plugins.length, 0);
  assert.deepEqual(registrations, ['GTP_CoreUpdates', 'Aries001_AnimationScreenEffects']);
});


test('keyed encrypted plugins execute while the data decryptor stays original', () => {
  const crypto=require('node:crypto'), key='0123456789abcdef0123456789abcdef';
  const iv=Buffer.alloc(16,7),cipher=crypto.createCipheriv('aes-256-ctr',Buffer.from(key),iv);
  const bytes=Buffer.concat([iv,cipher.update('globalThis.decodedPlugin=41;'),cipher.final()]);
  const loaded=new Map(),phases=new Map(),methods=[];
  const context={Buffer,__pmjsBuiltinRequire:require,Encryption:{decrypt:contents=>contents},
    document:{createElement:()=>({})},PluginManager:{_path:'js/plugins/',loadScript(){this.ordinary=(this.ordinary||0)+1;}},
    NativeHost:{fs:{readText:()=>key,exists:name=>name==='js/plugins/Example.OMORI',readBytes:()=>bytes}},
    PMJS:{config:{omori:{encryptionKeyFile:'private-key'}},
      plugins:{onLoaded:(name,owner,fn)=>loaded.set(name,fn)},phases:{on:(name,owner,fn)=>phases.set(name,fn)},methods:{own:definition=>methods.push(definition)}}};
  context.pmjsExecuteScriptElement=script=>vm.runInContext(script.textContent,realm);
  const realm=vm.createContext(context),original=context.Encryption.decrypt;
  const source=fs.readFileSync(path.join(__dirname,'../../../patches/omori/plugins.js'),'utf8');
  vm.runInContext(source,realm);loaded.get('GTP_CoreUpdates')();
  assert.equal(context.Encryption._key,key);assert.equal(methods[0].replace(original),original);
  phases.get('beforePlugins')();context.PluginManager.loadScript('Example.js');
  assert.equal(context.decodedPlugin,41);
  context.PluginManager.loadScript('Plain.js');assert.equal(context.PluginManager.ordinary,1);
  context.NativeHost.fs.readText=()=> 'invalid';assert.throws(()=>vm.runInContext(source,realm),/32 hexadecimal/);
  context.NativeHost.fs.readText=()=>null;assert.throws(()=>vm.runInContext(source,realm),/32 hexadecimal/);
});
