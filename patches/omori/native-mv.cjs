'use strict';

function prepareGame({ loaded, gameRoot, loadTiledMap }) {
  loaded.database.tiledMaps = { 87: loadTiledMap(gameRoot, 'maps/map87.json') };
  const parameters = loaded.manifest.plugins.find(plugin => plugin.status && plugin.name === 'YEP_CoreEngine')?.parameters;
  if (parameters) {
    loaded.settings.width = Number(parameters['Screen Width']);
    loaded.settings.height = Number(parameters['Screen Height']);
  }
}

function createRuntime(options) {
  return options.createPluginRuntime(options.engine, options.session, options);
}

module.exports = { prepareGame, createRuntime };
