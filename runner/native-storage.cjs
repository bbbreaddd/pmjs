'use strict';
const path = require('node:path');

function installStorage(runtime, native, storage) {
  const manager = runtime.scope.StorageManager = {};
  const root = () => {
    if (!storage) throw new Error('Plugin storage requires a configured save directory');
    return storage.resolvePath('');
  };
  manager.isLocalMode = () => true;
  manager.localFileDirectoryPath = () => root() + path.sep;
  manager.localFilePath = function(id) {
    const name = id < 0 ? 'config' : id === 0 ? 'global' : 'file' + id;
    return path.join(root(), name + '.rpgsave');
  };
  const relative = id => {
    const file = path.relative(root(), manager.localFilePath(id));
    storage.resolvePath(file);
    return file;
  };
  manager.save = function(id, json) { return this.saveToLocalFile(id, json); };
  manager.load = function(id) { return this.loadFromLocalFile(id); };
  manager.exists = function(id) { return this.localFileExists(id); };
  manager.remove = function(id) { return this.removeLocalFile(id); };
  manager.saveToLocalFile = function(id, json) { storage.writeText(relative(id), native.compression.compressLZString(json)); };
  manager.loadFromLocalFile = function(id) {
    const data = storage.readText(relative(id));
    return data === null ? null : native.compression.decompressLZString(data);
  };
  manager.localFileExists = function(id) { return storage.exists(relative(id)); };
  manager.removeLocalFile = function(id) { storage.remove(relative(id)); };
  runtime.scope.LZString = {
    compressToBase64: native.compression.compressLZString,
    decompressFromBase64: native.compression.decompressLZString
  };
  const config = runtime.scope.ConfigManager;
  if (config) {
    const fields = ['alwaysDash', 'commandRemember', 'bgmVolume', 'bgsVolume', 'meVolume', 'seVolume'];
    const parse = runtime.runScript('(function(text) { return JSON.parse(text); })');
    config.makeData = function() { return Object.fromEntries(fields.map(field => [field, this[field]])); };
    config.readFlag = function(data, name) { return Boolean(data[name]); };
    config.readVolume = function(data, name) { return name in data ? Math.max(0, Math.min(100, Number(data[name]))) : 100; };
    config.applyData = function(data) { for (const field of fields) this[field] = field.endsWith('Volume') ? this.readVolume(data, field) : this.readFlag(data, field); };
    config.save = function() { manager.save(-1, JSON.stringify(this.makeData())); };
    config.load = function() { const json = manager.load(-1); this.applyData(json ? parse(json) : {}); };
  }
  return manager;
}
module.exports = { installStorage };
