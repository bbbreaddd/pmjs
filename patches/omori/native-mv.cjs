'use strict';
const fs = require('node:fs');
const path = require('node:path');
const { loadTiledMap } = require('../../runner/tiled-map-data.cjs');

function prepareGame({ loaded, gameRoot, loadTiledMap }) {
  loaded.database.tiledMaps = {
    87: loadTiledMap(gameRoot, 'maps/map87.json'),
    999: loadTiledMap(gameRoot, 'maps/map999.json')
  };
  const parameters = loaded.manifest.plugins.find(plugin => plugin.status && plugin.name === 'YEP_CoreEngine')?.parameters;
  if (parameters) {
    loaded.settings.width = Number(parameters['Screen Width']);
    loaded.settings.height = Number(parameters['Screen Height']);
  }
}

function createRuntime(options) {
  let nativeMapMethods;
  const runtime = options.createPluginRuntime(options.engine, options.session, {
    ...options,
    beforePlugins(runtime) {
      const prototype = runtime.scope.Spriteset_Map.prototype;
      nativeMapMethods = Object.fromEntries(['createTilemap', 'loadTileset', 'updateTileset'].map(name => [name, prototype[name]]));
      runtime.runScript(fs.readFileSync(path.join(__dirname,'plugins.js'),'utf8'),'omori/plugins.js');
      options.beforePlugins?.(runtime);
    }
  });
  if (runtime.scope.Imported?.YED_Tiled) {
    const isMapReady = runtime.mapDatabase.isReady;
    let publishedMap = null, publishedId = null;
    runtime.mapDatabase.isReady = function() {
      if (!isMapReady.call(this)) return false;
      const id = this.requestedMapId, map = runtime.scope.$dataMap;
      if (publishedMap !== map || publishedId !== id) {
        const source = 'maps/map' + id + '.json';
        const tiled = fs.existsSync(path.join(options.gameRoot, source)) ? loadTiledMap(options.gameRoot, source) : null;
        options.engine.databaseInvoke(options.session, 'publishTiledMap', id, tiled);
        publishedMap = map; publishedId = id;
      }
      return true;
    };
    const prototype = runtime.scope.Spriteset_Map.prototype;
    for (const [name, method] of Object.entries(nativeMapMethods)) {
      if (typeof method !== 'function') throw new Error('Native map method is unavailable: ' + name);
      prototype[name] = method;
    }
    const createTilemap = prototype.createTilemap;
    prototype.createTilemap = function() {
      createTilemap.call(this);
      this._tilemap.hideOnLevel = level => this.setMapLevel(level);
    };
  }
  return runtime;
}

module.exports = { prepareGame, createRuntime };
