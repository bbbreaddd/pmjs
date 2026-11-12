'use strict';
const fs = require('node:fs');

function loadSceneData(file) {
  const value = JSON.parse(fs.readFileSync(file, 'utf8'));
  if (value.format !== 'pmjs-mv-map-scene-1' || value.database?.sceneContract?.kind !== 'map')
    throw new Error('unsupported native map-scene format');
  const mapId = value.database.sceneContract.mapId;
  if (!Number.isSafeInteger(mapId) || mapId < 1 || value.initialState?.map?._mapId !== mapId)
    throw new Error('map-scene save does not match its declared map');
  const map = value.database.maps?.[mapId], tiled = value.database.tiledMaps?.[mapId];
  if (!map || !tiled || map.width !== tiled.width || map.height !== tiled.height)
    throw new Error('map-scene tile data does not match its event map');
  for (const field of ['width','height','imageCacheBytes'])
    if (!Number.isSafeInteger(value.settings?.[field]) || value.settings[field] < 1)
      throw new Error(`map-scene has invalid ${field}`);
  if (typeof value.settings.fontFile !== 'string' || !value.settings.fontFile.startsWith('fonts/') ||
      value.settings.fontFile.split('/').some(part => !part || part === '..' || part === '.'))
    throw new Error('map-scene has invalid font path');
  return value;
}
module.exports = { loadSceneData };
