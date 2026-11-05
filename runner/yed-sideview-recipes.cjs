'use strict';

const { parsePluginManifest } = require('./plugin-manifest.cjs');
async function yedSideviewFrames(read, logger = console) {
  const frames = new Map();
  try {
    const manifest = await read('js/plugins.js');
    if (manifest === null) return frames;
    const { plugins } = parsePluginManifest(manifest.toString('utf8'));
    const plugin = plugins.find(p => p?.status && p.name === 'YED_SideviewBattler');
    if (!plugin) return frames;
    const parameters = plugin.parameters || {};
    for (const file of ['data/Actors.json', 'data/Enemies.json']) {
      const bytes = await read(file);
      if (bytes === null) continue;
      const records = JSON.parse(bytes);
      if (!Array.isArray(records)) throw new Error('invalid sideview battler database');
      for (const record of records) {
        if (!record) continue;
        let filename = '', standard = false;
        let width = Number(parameters['Default Frame Width'] || 0);
        let height = Number(parameters['Default Frame Height'] || 0);
        for (const line of String(record.note || '').split(/[\r\n]+/)) {
          const name = line.match(/<Sideview Battler:[ ]*(.*)>/i);
          if (name) filename = name[1];
          if (/<Sideview Battler Default>/i.test(line)) standard = true;
          const size = line.match(/<Sideview Battler Size:[ ]*(\d+),[ ]*(\d+)>/i);
          if (size) { width = Number(size[1]); height = Number(size[2]); }
        }
        if (!filename || standard || filename.includes('\\') || filename.includes('\0') ||
            filename.split('/').some(part => !part || part === '.' || part === '..')) continue;
        const source = 'img/sv_actors/' + filename + '.png';
        const valid = [width, height].every(n => Number.isSafeInteger(n) && n > 0);
        const previous = frames.get(source);
        const conflict = frames.has(source) && (!previous || previous.width !== width || previous.height !== height);
        frames.set(source, valid && !conflict ? { width, height } : null);
      }
    }
    return frames;
  } catch (error) {
    logger.warn('[pmjs] YED_SideviewBattler preparation metadata unavailable: ' + error.message);
    return new Map();
  }
}

module.exports = { yedSideviewFrames };
