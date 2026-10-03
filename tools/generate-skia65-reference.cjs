#!/usr/bin/env node
'use strict';
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const zlib = require('node:zlib');
const workspace = path.resolve(__dirname, '../..');
const { launchMvReference } = require(path.join(workspace, 'tests/differential/mv-reference/browser.cjs'));
const { install } = require('./skia65/reference-readback.cjs');
const sha = bytes => crypto.createHash('sha256').update(bytes).digest('hex');
const fonts = ['text-shaping.ttf', 'testfont.ttf'].map(file => {
  const bytes = fs.readFileSync(path.join(__dirname, '../test/assets', file));
  return { file, sha256: sha(bytes), bytes: bytes.toString('base64') };
});
const { cases } = require('../test/helpers/skia65-text-scenario.cjs');

async function reference({ cases, fonts, installSource }) {
  const restore = (0, eval)('(' + installSource + ')')();
  try {
    for (let index = 0; index < fonts.length; index++) {
      const face = new FontFace('SkiaFixture' + index, 'url(data:font/ttf;base64,' + fonts[index].bytes + ')');
      document.fonts.add(await face.load());
    }
    function css(value) {
      return 'rgba(' + [(value >>> 24) & 255, (value >>> 16) & 255, (value >>> 8) & 255, (value & 255) / 255].join(',') + ')';
    }
    const records = [];
    for (const item of cases) for (const layer of ['fill', 'outline', 'full']) {
      const canvas = document.createElement('canvas'); canvas.width = item.width; canvas.height = item.height;
      const ctx = canvas.getContext('2d');
      ctx.fillStyle = css(item.background); ctx.fillRect(0, 0, item.width, item.height);
      // Text parity starts from the oracle's identical premultiplied background,
      // independently of the existing non-text Canvas fillRect implementation.
      const background = Array.from(ctx.getImageData(0, 0, 1, 1).data);
      const backgroundPremul = Array.from(__titleReadCanvas(canvas).subarray(0, 4));
      ctx.font = (item.italic ? 'italic ' : '') + (item.bold ? 'bold ' : '') + item.size + 'px ' +
        item.fontFiles.map(file => 'SkiaFixture' + fonts.findIndex(font => font.file === file)).join(',');
      ctx.textAlign = item.align; ctx.textBaseline = 'alphabetic';
      ctx.lineWidth = item.stroke; ctx.lineJoin = item.join; ctx.lineCap = item.cap; ctx.miterLimit = item.miterLimit;
      if (layer !== 'fill') { ctx.strokeStyle = css(item.outline); ctx.strokeText(item.text, item.x, item.y); }
      if (layer !== 'outline') { ctx.globalAlpha = item.alpha; ctx.fillStyle = css(item.fill); ctx.fillText(item.text, item.x, item.y); }
      const pixels = __titleReadCanvas(canvas);
      let binary = ''; for (let i = 0; i < pixels.length; i += 8192) binary += String.fromCharCode(...pixels.subarray(i, i + 8192));
      records.push({ name: item.name, layer, background, backgroundPremul, width: ctx.measureText(item.text).width, pixels: btoa(binary) });
    }
    return records;
  } finally { restore(); }
}

async function main() {
  const browser = await launchMvReference({ width: 640, height: 480 });
  try {
    const records = await browser.page.evaluate(reference, { cases, fonts, installSource: install.toString() });
    const repeats = await browser.page.evaluate(reference, { cases, fonts, installSource: install.toString() });
    require('node:assert/strict').deepEqual(repeats, records, 'Reference fixture repeats differ');
    const second = await launchMvReference({ width: 640, height: 480 });
    try {
      require('node:assert/strict').deepEqual(await second.page.evaluate(reference,
        { cases, fonts, installSource: install.toString() }), records, 'Fresh reference processes differ');
    } finally { await second.close(); }
    const fixture = { reference: { ...browser.environment, chromium: browser.version() },
      freshProcessReplays: 2, frozenFramesEqual: true,
      fonts: fonts.map(({ bytes, ...item }) => item), cases, records,
      generatorSha256: sha(fs.readFileSync(__filename)), readbackSha256: sha(fs.readFileSync(path.join(__dirname, 'skia65/reference-readback.cjs'))),
      scenarioSha256: sha(fs.readFileSync(path.join(__dirname, '../test/helpers/skia65-text-scenario.cjs'))) };
    const output = path.join(__dirname, '../test/assets/reference/skia65-text.json.gz');
    fs.writeFileSync(output, zlib.gzipSync(JSON.stringify(fixture), { level: 9 }));
    console.log(output);
  } finally { await browser.close(); }
}
if (require.main === module) main().catch(error => { console.error(error); process.exitCode = 1; });
module.exports = { cases, reference };
