'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { png } = require('./helpers/png.cjs');

function integer(value) {
  const bytes = Buffer.alloc(4);
  bytes.writeInt32LE(value);
  return bytes;
}
function resourcePath(name) {
  return Buffer.concat([integer(name.length + 1), Buffer.from(name + '\0', 'utf16le')]);
}

function mapEffectBinary(source, transform) {
  const offset = source.indexOf('BIN_');
  assert.equal(source.toString('ascii', 0, 4), 'EFKE');
  assert.ok(offset >= 8);
  const length = source.readInt32LE(offset + 4);
  const binary = transform(Buffer.from(source.subarray(offset + 8, offset + 8 + length)));
  return Buffer.concat([source.subarray(0, offset + 4), integer(binary.length), binary,
    source.subarray(offset + 8 + length)]);
}

function seededEffect(source) {
  return mapEffectBinary(source, binary => {
    assert.equal(binary.toString('ascii', 0, 4), 'SKFE');
    assert.ok([1610, 1705].includes(binary.readInt32LE(4)));
    let offset = 8;
    // Color, normal, distortion, sound, model, material and curve path tables.
    for (let table = 0; table < 7; table++) {
      const count = binary.readInt32LE(offset); offset += 4;
      for (let i = 0; i < count; i++) {
        const characters = binary.readInt32LE(offset); offset += 4 + characters * 2;
      }
    }
    assert.equal(binary.readInt32LE(offset), 0, 'fixture has no procedural models');
    offset += 4;
    const inputs = binary.readInt32LE(offset); offset += 4 + inputs * 4;
    const equations = binary.readInt32LE(offset); offset += 4;
    for (let i = 0; i < equations; i++) {
      const length = binary.readInt32LE(offset); offset += 4 + length;
    }
    // Node count, threshold and magnification precede the authored random seed.
    assert.equal(binary.readInt32LE(offset + 12), -1);
    binary.writeInt32LE(1, offset + 12);
    return binary;
  });
}

// Modify the pinned upstream square fixture's empty resource tables and sound node.
function effectVariant(source, resource, spatial = false) {
  return mapEffectBinary(source, data => {
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
      return Buffer.concat([data.subarray(0, 24), resourcePath(resource),
        data.subarray(24, data.length - 8), sound, data.subarray(data.length - 4)]);
    }
    assert.equal(data.readInt32LE(8), 0);
    data.writeInt32LE(1, 8);
    return Buffer.concat([data.subarray(0, 12), resourcePath(resource), data.subarray(12)]);
  });
}

function dynamicEffect(source) {
  return mapEffectBinary(seededEffect(source), binary => {
    // Pinned SKFE 1610: four default inputs, followed by an empty equation table;
    // the sprite's fixed translation has an unused equation reference.
    assert.equal(binary.readInt32LE(4), 1610);
    assert.equal(binary.readInt32LE(40), 4);
    assert.equal(binary.readInt32LE(60), 0);
    assert.equal(binary.readInt32LE(188), 0); // Fixed translation.
    assert.equal(binary.readInt32LE(192), 16);
    assert.equal(binary.readInt32LE(196), -1);
    binary.writeFloatLE(-6, 44);
    binary.writeInt32LE(1, 60);
    binary.writeInt32LE(0, 196);
    // A local equation copies four external inputs into four output registers.
    const equation = Buffer.concat([0, 1, 4, 4, 0, 1, 2, 3,
      ...[0, 1, 2, 3].flatMap(index => [11, 1, 1, 0, 0x1000 + index, index])].map(integer));
    return Buffer.concat([binary.subarray(0, 64), integer(equation.length), equation, binary.subarray(64)]);
  });
}

function writeEffectFixtures(root) {
  const directory = path.join(root, 'effects');
  const source = fs.readFileSync(path.join(directory, 'Square.efkefc'));
  for (const name of ['Square', 'Laser', 'Trigger']) {
    fs.writeFileSync(path.join(directory, 'Seeded' + name + '.efkefc'),
      seededEffect(fs.readFileSync(path.join(directory, name + '.efkefc'))));
  }
  fs.writeFileSync(path.join(directory, 'Dynamic.efkefc'), dynamicEffect(source));
  for (const [name, resource, spatial] of [
    ['Sound', 'Tone.wav', false], ['SpatialSound', 'Tone.wav', true],
    ['SpatialStereo', 'Stereo.wav', true], ['InvalidSound', 'Invalid.wav', true],
    ['MissingTexture', 'Missing.png'], ['InvalidTexture', 'Invalid.png'],
    ['TextureResource', 'Texture.png'], ['MissingSound', 'Missing.wav'],
  ]) {
    fs.writeFileSync(path.join(directory, name + '.efkefc'), effectVariant(source, resource, spatial));
  }
  const missingModel = Buffer.from(fs.readFileSync(path.join(directory, 'Model.efk')));
  const modelPath = Buffer.from('Model/block.efkmodel', 'utf16le');
  const modelOffset = missingModel.indexOf(modelPath);
  assert.ok(modelOffset >= 0);
  Buffer.from('Model/empty.efkmodel', 'utf16le').copy(missingModel, modelOffset);
  fs.writeFileSync(path.join(directory, 'MissingModel.efk'), missingModel);
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
  const stereo = Buffer.alloc(44 + 32000);
  wave.copy(stereo, 0, 0, 44);
  stereo.writeUInt32LE(stereo.length - 8, 4);
  stereo.writeUInt16LE(2, 22); stereo.writeUInt32LE(32000, 28);
  stereo.writeUInt16LE(4, 32); stereo.writeUInt32LE(32000, 40);
  for (let sample = 0; sample < 8000; sample++) {
    stereo.writeInt16LE(wave.readInt16LE(44 + sample * 2), 44 + sample * 4);
    stereo.writeInt16LE(-500, 46 + sample * 4);
  }
  fs.writeFileSync(path.join(directory, 'Stereo.wav'), stereo);
  fs.writeFileSync(path.join(directory, 'Invalid.wav'), 'invalid audio');
  fs.writeFileSync(path.join(directory, 'Invalid.png'), 'invalid image');
  fs.copyFileSync(path.join(root, 'fixture.png'), path.join(directory, 'Texture.png'));
  const textureRoot = path.join(directory, 'Texture');
  fs.mkdirSync(textureRoot, { recursive: true });
  for (const [index, name] of ['LaserMain01', 'Particle01', 'Particle02'].entries()) {
    const pixels = Buffer.alloc(16 * 16 * 4);
    for (let y = 0; y < 16; y++) for (let x = 0; x < 16; x++) {
      pixels.set([x * 16, y * 16, 64 + index * 64, 128 + x * 8], (y * 16 + x) * 4);
    }
    fs.writeFileSync(path.join(textureRoot, name + '.png'), png(16, 16, pixels));
  }
}

module.exports = { writeEffectFixtures };
