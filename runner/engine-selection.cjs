'use strict';
const fs = require('node:fs');

function selectEngine(options) {
  let engine = options.engine;
  if (engine === undefined && options.config) {
    const config = JSON.parse(fs.readFileSync(options.config, 'utf8'));
    if (!config || typeof config !== 'object' || Array.isArray(config)) throw new Error('configuration must be an object');
    engine = config.engine;
  }
  if (engine === undefined) return 'javascript';
  if (!['javascript', 'native-mv'].includes(engine)) throw new Error(`unknown engine: ${engine}`);
  return engine;
}
module.exports = { selectEngine };
