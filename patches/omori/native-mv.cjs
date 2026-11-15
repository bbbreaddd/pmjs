'use strict';
const fs = require('node:fs');
const path = require('node:path');
const { loadTiledMap } = require('../../runner/tiled-map-data.cjs');
const { installNativeTiled } = require('./native-tiled.cjs');
const { captureNativeCharacters } = require('./native-characters.cjs');

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
  let nativePosition, characters;
  const runtime = options.createPluginRuntime(options.engine, options.session, {
    ...options,
    nativePlugins: { ...options.nativePlugins, YED_Tiled(runtime) {
      installNativeTiled(runtime, options.engine, options.session, nativePosition,
        data => loadTiledMap(options.gameRoot, 'maps/map' + runtime.mapDatabase.requestedMapId + '.json', data).tilesets);
    } },
    beforePlugins(runtime) {
      nativePosition = runtime.scope.Sprite_Character.prototype.updatePosition;
      characters = captureNativeCharacters(runtime, options.engine, options.session);
      runtime.runScript(fs.readFileSync(path.join(__dirname,'plugins.js'),'utf8'),'omori/plugins.js');
      options.beforePlugins?.(runtime);
    }
  });
  characters.install();
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
        const guest = tiled ? { ...tiled, layers: tiled.sourceLayers } : null;
        if (guest) delete guest.sourceLayers;
        runtime.scope.DataManager._tempTiledData = runtime.runScript('(JSON.parse)')(JSON.stringify(guest));
        runtime.scope.DataManager._tiledLoaded = true;
        if (guest) options.engine.tiledInvoke(options.session, 'bindSource', [id, runtime.scope.DataManager._tempTiledData]);
        publishedMap = map; publishedId = id;
      }
      return true;
    };
  }
  return runtime;
}

module.exports = { prepareGame, createRuntime };
