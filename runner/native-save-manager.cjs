'use strict';
const { encodeGraph, decodeGraph } = require('./mv-save-codec.cjs');
const roots = ['system', 'screen', 'timer', 'switches', 'variables', 'selfSwitches', 'actors', 'party', 'map', 'player'];
const globalName = key => '$game' + key[0].toUpperCase() + key.slice(1);

function installSaveManager(runtime, engine, session) {
  const scope = runtime.scope, manager = scope.DataManager;
  let projections = new WeakMap();
  const stringify = scope.JsonEx.stringify;
  scope.JsonEx.stringify = function(object) {
    if (!runtime.projectSaveObject) return stringify.call(this, object);
    const seen = new WeakMap();
    function project(value) {
      if (!value || typeof value !== 'object') return value;
      if (seen.has(value)) return seen.get(value);
      const body = runtime.projectSaveObject(value);
      const copy = Array.isArray(value) ? [] : Object.create(Object.getPrototypeOf(value));
      seen.set(value, copy);
      for (const key of Object.keys(body)) Object.defineProperty(copy, key, {
        configurable: true, enumerable: true, writable: true, value: project(body[key])
      });
      return copy;
    }
    return stringify.call(this, project(object));
  };
  const nativeContents = () => decodeGraph(encodeGraph(engine.save(session, false)), { allowCycles: true });
  function pair(snapshot, live, forward, reverse, visited = new Set()) {
    if (!snapshot || typeof snapshot !== 'object' || !live || typeof live !== 'object' || visited.has(snapshot)) return;
    visited.add(snapshot); forward.set(snapshot, live); reverse.set(live, snapshot);
    for (const key of Object.keys(snapshot)) if (key !== '@' && key in live) pair(snapshot[key], live[key], forward, reverse, visited);
  }
  function bindings(snapshot) {
    const forward = new WeakMap(), reverse = new WeakMap();
    for (const key of roots) pair(snapshot[key], scope[globalName(key)], forward, reverse);
    return { forward, reverse };
  }
  function capture() {
    const snapshot = nativeContents(), { forward, reverse } = bindings(snapshot);
    projections = reverse;
    const replaced = new WeakMap();
    function value(object) {
      if (!object || typeof object !== 'object') return object;
      if (forward.has(object)) return forward.get(object);
      if (replaced.has(object)) return replaced.get(object);
      const result = Array.isArray(object) ? [] : {};
      replaced.set(object, result);
      for (const key of Object.keys(object)) if (key !== '@') result[key] = value(object[key]);
      return result;
    }
    runtime.projectSaveObject = object => {
      const native = projections.get(object);
      if (!native) return object;
      const result = Array.isArray(native) ? [] : {};
      for (const key of Object.keys(native)) if (key !== '@') result[key] = value(native[key]);
      for (const key of Object.keys(object)) result[key] = object[key];
      return result;
    };
  }
  manager.isAnySavefileExists = function() {
    const info = this.loadGlobalInfo();
    if (info) for (let index = 1; index < info.length; ++index) if (this.isThisGameFile(index)) return true;
    return false;
  };
  manager.makeSaveContents = function() {
    capture();
    return Object.fromEntries(roots.map(key => [key, scope[globalName(key)]]));
  };
  manager.extractSaveContents = function(contents) {
    const before = nativeContents();
    function core(schema, value) {
      if (!schema || typeof schema !== 'object') return value;
      if (!value || typeof value !== 'object') return value;
      if (Array.isArray(schema)) return Array.from(value, (item, index) => core(schema[index] || schema.find(entry => entry && typeof entry === 'object'), item));
      const result = {};
      const keys = schema['@'] ? Object.keys(schema) : [...new Set([...Object.keys(schema), ...Object.keys(value)])];
      for (const key of keys) result[key] = key === '@' ? schema[key] : core(schema[key], value[key]);
      return result;
    }
    engine.load(session, engine.decodeGraph(encodeGraph(core(before, contents))));
    const schema = nativeContents(), { forward: parsedToLive } = bindings(contents);
    const nativeSchema = bindings(schema).reverse;
    const visited = new WeakMap();
    function restore(object) {
      if (!object || typeof object !== 'object') return object;
      if (visited.has(object)) return visited.get(object);
      const target = parsedToLive.get(object) || object;
      visited.set(object, target);
      const known = nativeSchema.get(target);
      for (const key of Object.keys(object)) {
        const value = restore(object[key]);
        if (!known || !Object.hasOwn(known, key) || (!Array.isArray(target) && !(key in target))) target[key] = value;
      }
      return target;
    }
    for (const key of Object.keys(contents)) contents[key] = restore(contents[key]);
    projections = new WeakMap();
  };
  const loadGlobalInfo = manager.loadGlobalInfo;
  manager.loadGlobalInfo = function() {
    const info = loadGlobalInfo.call(this);
    engine.setSaveMetadata(session, info || []);
    return info;
  };
  const saveGlobalInfo = manager.saveGlobalInfo;
  manager.saveGlobalInfo = function(info) { saveGlobalInfo.call(this, info); engine.setSaveMetadata(session, info); };
  const createGameObjects = manager.createGameObjects;
  manager.createGameObjects = function() {
    let schema;
    if (engine.mapId(session) > 0 && !scope.$gameParty.inBattle()) schema = nativeContents();
    if (schema) {
      const known = bindings(schema).reverse;
      for (const key of roots) {
        const object = scope[globalName(key)], fields = known.get(object);
        if (!fields) continue;
        for (const field of Object.keys(object)) if (!Object.hasOwn(fields, field) && Object.getOwnPropertyDescriptor(object, field)?.configurable) delete object[field];
      }
    }
    createGameObjects.call(this);
  };
  manager.setupNewGame = function() {
    this.createGameObjects(); this.selectSavefileForNewGame(); scope.$gameParty.setupStartingMembers();
    scope.$gamePlayer.reserveTransfer(scope.$dataSystem.startMapId, scope.$dataSystem.startX, scope.$dataSystem.startY);
    scope.Graphics.frameCount = 0;
  };
  manager.isBattleTest = () => scope.Utils.isOptionValid('btest');
  manager.isEventTest = () => scope.Utils.isOptionValid('etest');
  scope.Game_System.prototype.playtime = function() { return Math.floor(scope.Graphics.frameCount / 60); };
  scope.Game_System.prototype.playtimeText = function() {
    const time = this.playtime();
    return [Math.floor(time / 3600), Math.floor(time / 60) % 60, time % 60].map(value => String(value).padStart(2, '0')).join(':');
  };
  scope.Game_System.prototype.onBeforeSave = function() {
    engine.save(session);
    this._framesOnSave = scope.Graphics.frameCount;
    this._bgmOnSave = scope.AudioManager.saveBgm(); this._bgsOnSave = scope.AudioManager.saveBgs();
  };
  scope.Game_System.prototype.onAfterLoad = function() {
    scope.Graphics.frameCount = this._framesOnSave;
    scope.AudioManager.playBgm(this._bgmOnSave); scope.AudioManager.playBgs(this._bgsOnSave);
  };
  scope.Game_Party.prototype.charactersForSavefile = function() { return this.battleMembers().map(actor => [actor.characterName(), actor.characterIndex()]); };
  scope.Game_Party.prototype.facesForSavefile = function() { return this.battleMembers().map(actor => [actor.faceName(), actor.faceIndex()]); };
  scope.Game_Party.prototype.setupStartingMembers = function() {
    for (const actor of this.allMembers()) this.removeActor(actor.actorId());
    for (const id of scope.$dataSystem.partyMembers) this.addActor(id);
  };
  runtime.completeStorage = function(request) {
    if (request.save) scope.$gameSystem.onBeforeSave();
    const success = request.save ? manager.saveGame(request.slot) : manager.loadGame(request.slot);
    if (request.save && success) scope.StorageManager.cleanBackup(request.slot);
    if (request.load && success) scope.$gameSystem.onAfterLoad();
    engine.completeStorage(session, Boolean(success));
    return success;
  };
}
module.exports = { installSaveManager };
