'use strict';

function spriteRoundingCases() {
  const rows = [];
  for (const anchor of [0, 0.5]) {
    for (const position of [5.75, 15.75]) {
      for (const scale of [1, 1.2]) {
        for (const rounded of [false, true]) {
          rows.push({ label: `basic-${rows.length}`, anchor, position, scale, rounded });
        }
      }
    }
  }
  for (const position of [-1.75, -0.75]) {
    rows.push({ label: `negative-${position}`, position });
  }
  for (const settingsResolution of [0.5, 2]) {
    for (const resolution of [1, 2]) {
      rows.push({ label: `resolution-${settingsResolution}-${resolution}`, settingsResolution, resolution });
    }
  }
  rows.push({ label: 'rotated-trim', trim: true, rotation: 0.35, anchor: 0.5 });
  rows.push({ label: 'mirrored-parent', scale: -1.2, parent: true, anchor: 0.5 });
  rows.push({ label: 'child-unrounded', child: true, parent: true });
  rows.push({ label: 'child-rounded', child: true, childRounded: true, parent: true });
  rows.push({ label: 'alpha-clip', alpha: 0.5, clip: true, parent: true });
  rows.push({ label: 'high-resolution-texture', textureResolution: 2, rounded: false });
  rows.push({ label: 'snapshot', snapshot: true, resolution: 2, child: true, childRounded: true });
  for (const atlasRotation of [0, 2, 4, 6, 8, 10, 12, 14]) {
    for (const rounded of [false, true]) {
      rows.push({ label: `atlas-${atlasRotation}-${Number(rounded)}`, atlasRotation,
        sourceWidth: 16, sourceHeight: 8, anchor: 0.5, scale: 1, rounded });
    }
  }
  rows.push({ label: 'logical-size', logicalWidth: 4, logicalHeight: 12, rounded: false });
  rows.push({ label: 'atlas-snapshot', atlasRotation: 2, sourceWidth: 16, sourceHeight: 8,
    snapshot: true, rounded: false, scale: 1, anchor: 0.5 });
  for (const screen of ['stock', 'invisible', 'unrenderable', 'alpha', 'color', 'shape',
    'filter', 'transform', 'tint', 'fill-alpha', 'empty', 'removed']) {
    rows.push({ label: `screen-${screen}`, screen, rounded: false });
  }
  return rows.map(row => ({
    position: 15.75, scale: 1.2, rounded: true, anchor: 0,
    settingsResolution: 1, resolution: 1, textureResolution: 1, rotation: 0, ...row,
  }));
}

function spriteRoundingPixels(width = 8, height = 8) {
  return Uint8Array.from({ length: width * height * 4 }, (_, i) => {
    const x = Math.floor(i / 4) % width, y = Math.floor(i / (width * 4));
    return [[255, 0, 0, 255], [0, 255, 0, 255],
      [0, 0, 255, 255], [255, 255, 255, 255]][(x >= width / 2 ? 1 : 0) + (y >= height / 2 ? 2 : 0)][i % 4];
  });
}

module.exports = { spriteRoundingCases, spriteRoundingPixels };
