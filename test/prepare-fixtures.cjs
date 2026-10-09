'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { writeEffectFixtures } = require('./effect-fixtures.cjs');

function prepare(root) {
  const source = path.join(__dirname, 'assets');
  function decode(directory, relative = '') {
    for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
      const name = path.join(relative, entry.name);
      if (entry.isDirectory()) decode(path.join(directory, entry.name), name);
      else if (entry.name.endsWith('.b64')) {
        const output = path.join(root, name === 'effects/Block.efkmodel.b64' ?
          'effects/Model/block.efkmodel' : name.slice(0, -4));
        fs.mkdirSync(path.dirname(output), { recursive: true });
        fs.writeFileSync(output, Buffer.from(fs.readFileSync(path.join(source, name), 'utf8'), 'base64'));
      }
    }
  }
  fs.mkdirSync(root, { recursive: true });
  decode(source);
  for (const name of ['testfont.ttf', 'text-shaping.ttf']) {
    fs.copyFileSync(path.join(source, name), path.join(root, name));
  }
  for (const name of ['lease.png', 'retained-fixture.png']) {
    fs.copyFileSync(path.join(root, 'fixture.png'), path.join(root, name));
  }
  writeEffectFixtures(root);
}

if (require.main === module) {
  if (process.argv.length !== 3) throw new Error('usage: prepare-fixtures.cjs OUTPUT_DIRECTORY');
  prepare(path.resolve(process.argv[2]));
}
module.exports = { prepare };
