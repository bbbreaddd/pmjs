'use strict';
const fs = require('node:fs');
const path = require('node:path');
const { databaseFiles } = require('./mv-engine-data.cjs');

function installDatabase(runtime, engine, session, gameRoot) {
  const scope = runtime.scope, manager = scope.DataManager;
  const parse = runtime.runScript('(function(text) { return JSON.parse(text); })');
  const object = runtime.runScript('(function() { return {}; })');
  const keys = new Map(databaseFiles.map(file => [file.name, file.key]));
  const loaded = new Set(), tables = {};
  let generation = 0, published = -1, failure = null;
  let requestedMapId = null, publishedMapId = null, publishedMap = null;
  const writable = () => {
    if (!engine.databaseInvoke(session, 'canWrite')) throw new Error('Database loading is only bound before game state initialization');
  };
  function expose(name) {
    const key = keys.get(name) || 'plugin:' + name;
    if (!Object.hasOwn(tables, key)) Object.defineProperty(tables, key, { enumerable: true, get() { return scope[name]; } });
  }
  manager._databaseFiles = parse(JSON.stringify(databaseFiles.map(({ name, src }) => ({ name, src }))));
  manager._errorUrl = null;
  for (const file of databaseFiles) scope[file.name] = null;
  scope.$dataMap = null;
  manager.loadDatabase = function() {
    ++generation; loaded.clear(); failure = null; this._errorUrl = null;
    const test = this.isBattleTest() || this.isEventTest();
    for (const file of this._databaseFiles) this.loadDataFile(file.name, (test ? 'Test_' : '') + file.src);
    if (this.isEventTest()) this.loadDataFile('$testEvent', 'Test_Event.json');
  };
  manager.loadDataFile = function(name, src) {
    const map = name === '$dataMap';
    const file = path.resolve(gameRoot, 'data', src);
    scope[name] = null;
    let data;
    try {
      data = parse(fs.readFileSync(file, 'utf8').replace(/^\uFEFF/, ''));
      if (data === null) throw new Error('Database file contains null: ' + file);
    } catch (error) { this._errorUrl ||= file; failure ||= error; return; }
    scope[name] = data;
    if (!map && published >= 0) expose(name);
    this.onLoad(data);
    if (!map) { loaded.add(name); ++generation; }

  };
  const mapId = value => {
    const id = Number(value);
    if (!Number.isInteger(id)) throw new TypeError('Map id must be an integer');
    return Math.max(0, id);
  };
  function beginMapLoad(id) {
    requestedMapId = mapId(id); publishedMapId = null; publishedMap = null;
  }
  manager.loadMapData = function(id) {
    beginMapLoad(id);
    if (requestedMapId > 0) {
      const filename = 'Map' + String(requestedMapId).padStart(3, '0') + '.json';
      const retry = this.loadDataFile.bind(this, '$dataMap', filename);
      this._mapLoader = scope.ResourceHandler ? scope.ResourceHandler.createLoader('data/' + filename, retry) : retry;
      scope.$dataMap = null;
      this.loadDataFile('$dataMap', filename);
    } else this.makeEmptyMap();
  };
  manager.makeEmptyMap = function() {
    beginMapLoad(0);
    scope.$dataMap = parse('{"data":[],"events":[],"width":100,"height":100,"scrollType":3}');
  };
  manager.isMapLoaded = function() { this.checkError(); return Boolean(scope.$dataMap); };
  manager.checkError = function() { if (this._errorUrl) throw failure || new Error('Failed to load: ' + this._errorUrl); };
  manager.isDatabaseLoaded = function() {
    this.checkError();
    return this._databaseFiles.every(file => Boolean(scope[file.name]));
  };
  manager.extractMetadata = function(data) {
    data.meta = Object.assign(object(), engine.databaseInvoke(session, 'metadata', String(data.note)));
  };
  manager.onLoad = function(data) {
    const map = data === scope.$dataMap;
    if (map) this.extractMetadata(data);
    const entries = map ? data.events : data;
    if (Array.isArray(entries)) for (const entry of entries) if (entry && entry.note !== undefined) this.extractMetadata(entry);
    if (data === scope.$dataSystem) scope.Scene_Boot.loadSystemImages();
  };
  runtime.database = {
    load() { scope.DataManager.loadDatabase(); },
    isReady() {
      if (!scope.DataManager.isDatabaseLoaded()) return false;
      if (published !== generation) {
        const names = new Set([...scope.DataManager._databaseFiles.map(file => file.name), ...loaded]);
        for (const name of names) expose(name);
        if (published < 0) { writable(); engine.databaseInvoke(session, 'publish', tables); }
        published = generation;
      }
      return true;
    }
  };
  runtime.mapDatabase = {
    load(id) {
      beginMapLoad(id);
      scope.DataManager.loadMapData(requestedMapId);
    },
    isReady() {
      if (requestedMapId === null || !scope.DataManager.isMapLoaded() || !scope.$dataMap) return false;
      if (publishedMapId !== requestedMapId || publishedMap !== scope.$dataMap) {
        engine.databaseInvoke(session, 'publishMap', requestedMapId, scope.$dataMap);
        publishedMapId = requestedMapId; publishedMap = scope.$dataMap;
      }
      return true;
    }
  };
  return runtime.database;
}

module.exports = { installDatabase };
