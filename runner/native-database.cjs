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
  const writable = () => {
    if (published < 0 && !engine.databaseInvoke(session, 'canWrite')) throw new Error('Database loading is only bound before game state initialization');
  };
  manager._databaseFiles = parse(JSON.stringify(databaseFiles.map(({ name, src }) => ({ name, src }))));
  manager._errorUrl = null;
  for (const file of databaseFiles) scope[file.name] = null;
  scope.$dataMap = null;
  manager.loadDatabase = function() {
    writable();
    ++generation; loaded.clear(); failure = null; this._errorUrl = null;
    const test = this.isBattleTest() || this.isEventTest();
    for (const file of this._databaseFiles) this.loadDataFile(file.name, (test ? 'Test_' : '') + file.src);
    if (this.isEventTest()) this.loadDataFile('$testEvent', 'Test_Event.json');
  };
  manager.loadDataFile = function(name, src) {
    writable();
    const file = path.resolve(gameRoot, 'data', src);
    scope[name] = null;
    try {
      const data = parse(fs.readFileSync(file, 'utf8').replace(/^\uFEFF/, ''));
      if (data === null) throw new Error('Database file contains null: ' + file);
      scope[name] = data;
      this.onLoad(data);
      loaded.add(name); ++generation;
    } catch (error) { this._errorUrl = file; failure = error; throw error; }
  };
  manager.checkError = function() { if (failure) throw failure; };
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
        writable();
        const names = new Set([...scope.DataManager._databaseFiles.map(file => file.name), ...loaded]);
        for (const name of names) {
          const key = keys.get(name) || 'plugin:' + name;
          if (!Object.hasOwn(tables, key)) Object.defineProperty(tables, key, { enumerable: true, get() { return scope[name]; } });
        }
        if (published < 0) engine.databaseInvoke(session, 'publish', tables);
        published = generation;
      }
      return true;
    }
  };
  return runtime.database;
}

module.exports = { installDatabase };
