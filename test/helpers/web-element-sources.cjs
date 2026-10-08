'use strict';
const fs = require('node:fs');
const path = require('node:path');
const root = path.resolve(__dirname, '../..');
const requirements = new Set(['js/pmjs-web/elements.js',
  'js/pmjs-web/video-element.js', 'js/pmjs-web/image-element.js',
  'js/pmjs-web/document.js']);
const elementSources = require('../../profiles/mv.json').modules.filter(file => requirements.has(file));
if (elementSources.length !== requirements.size) throw new Error('incomplete web element profile');
const source = elementSources.map(file => fs.readFileSync(path.join(root, file), 'utf8')).join('\n');
module.exports = { elementSources, source };
