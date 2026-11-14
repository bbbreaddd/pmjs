'use strict';
const path = require('node:path');
const { installManagerReference } = require('./native-manager-reference.cjs');

function installStorage(runtime, native, storage) {
  const manager = installManagerReference(runtime, 'StorageManager');
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
  const decompress = data => data === null ? null : native.compression.decompressLZString(data);
  manager.saveToLocalFile = function(id, json) { storage.writeText(relative(id), native.compression.compressLZString(json)); };
  manager.loadFromLocalFile = function(id) { return decompress(storage.readText(relative(id))); };
  manager.localFileExists = function(id) { return storage.readText(relative(id)) !== null; };
  manager.removeLocalFile = function(id) { storage.remove(relative(id)); };
  manager.loadFromLocalBackupFile = function(id) { return decompress(storage.readText(relative(id) + '.bak')); };
  manager.localFileBackupExists = function(id) { return storage.readText(relative(id) + '.bak') !== null; };
  manager.backupExists = function(id) { return this.isLocalMode() ? this.localFileBackupExists(id) : this.webStorageBackupExists(id); };
  manager.backup = function(id) {
    if (!this.exists(id)) return;
    if (this.isLocalMode()) storage.writeText(relative(id) + '.bak', native.compression.compressLZString(this.loadFromLocalFile(id)));
    else runtime.scope.localStorage.setItem(this.webStorageKey(id) + 'bak', runtime.scope.LZString.compressToBase64(this.loadFromWebStorage(id)));
  };
  manager.cleanBackup = function(id) {
    if (!this.backupExists(id)) return;
    if (this.isLocalMode()) storage.remove(relative(id) + '.bak');
    else runtime.scope.localStorage.removeItem(this.webStorageKey(id) + 'bak');
  };
  manager.restoreBackup = function(id) {
    if (!this.backupExists(id)) return;
    this.save(id, this.isLocalMode() ? this.loadFromLocalBackupFile(id) : this.loadFromWebStorageBackup(id));
    this.cleanBackup(id);
  };
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
