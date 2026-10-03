'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

function integer(value) {
  const bytes = Buffer.alloc(4);
  bytes.writeInt32LE(value);
  return bytes;
}
function resourcePath(name) {
  return Buffer.concat([integer(name.length + 1), Buffer.from(name + '\0', 'utf16le')]);
}

// Modify the pinned upstream square fixture's empty resource tables and sound node.
function effectVariant(source, resource, spatial = false) {
  const chunks = [source.subarray(0, 8)];
  assert.equal(source.toString('ascii', 0, 4), 'EFKE');
  for (let offset = 8; offset < source.length;) {
    const kind = source.subarray(offset, offset + 4);
    const length = source.readInt32LE(offset + 4);
    let data = Buffer.from(source.subarray(offset + 8, offset + 8 + length));
    if (kind.toString() === 'BIN_') {
      assert.equal(data.toString('ascii', 0, 4), 'SKFE');
      if (resource.endsWith('.wav')) {
        assert.equal(data.readInt32LE(20), 0);
        assert.equal(data.readInt32LE(data.length - 8), 0);
        const sound = Buffer.alloc(48);
        sound.writeInt32LE(1, 0); // Sound use; wave index remains zero.
        sound.writeFloatLE(1, 8);
        sound.writeFloatLE(1, 12);
        sound.writeInt32LE(Number(spatial), 24);
        sound.writeFloatLE(1, 36);
        data.writeInt32LE(1, 20);
        data = Buffer.concat([data.subarray(0, 24), resourcePath(resource),
          data.subarray(24, data.length - 8), sound, data.subarray(data.length - 4)]);
      } else {
        assert.equal(data.readInt32LE(8), 0);
        data.writeInt32LE(1, 8);
        data = Buffer.concat([data.subarray(0, 12), resourcePath(resource), data.subarray(12)]);
      }
    }
    chunks.push(kind, integer(data.length), data);
    offset += 8 + length;
  }
  return Buffer.concat(chunks);
}

function writeEffectFixtures(root) {
  const directory = path.join(root, 'effects');
  const source = fs.readFileSync(path.join(directory, 'Square.efkefc'));
  for (const [name, resource, spatial] of [
    ['Sound', 'Tone.wav', false], ['SpatialSound', 'Tone.wav', true],
    ['MissingTexture', 'Missing.png'], ['InvalidTexture', 'Invalid.png'],
    ['TextureResource', 'Texture.png'], ['MissingSound', 'Missing.wav'],
  ]) {
    fs.writeFileSync(path.join(directory, name + '.efkefc'), effectVariant(source, resource, spatial));
  }
  const wave = Buffer.alloc(44 + 16000);
  wave.write('RIFF'); wave.writeUInt32LE(wave.length - 8, 4); wave.write('WAVEfmt ', 8);
  wave.writeUInt32LE(16, 16); wave.writeUInt16LE(1, 20); wave.writeUInt16LE(1, 22);
  wave.writeUInt32LE(8000, 24); wave.writeUInt32LE(16000, 28);
  wave.writeUInt16LE(2, 32); wave.writeUInt16LE(16, 34);
  wave.write('data', 36); wave.writeUInt32LE(16000, 40);
  for (let sample = 0; sample < 8000; sample++) {
    wave.writeInt16LE(Math.round(Math.sin(sample * Math.PI * 440 / 4000) * 1000), 44 + sample * 2);
  }
  fs.writeFileSync(path.join(directory, 'Tone.wav'), wave);
  fs.writeFileSync(path.join(directory, 'Invalid.png'), 'invalid image');
  fs.copyFileSync(path.join(root, 'fixture.png'), path.join(directory, 'Texture.png'));
}

module.exports = { writeEffectFixtures };
