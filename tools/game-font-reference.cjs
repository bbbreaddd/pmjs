'use strict';

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const os = require('node:os');
const args = process.argv.slice(2);
function option(name) {
  const index = args.indexOf(name);
  if (index < 0 || !args[index + 1]) throw new Error(`Missing ${name}`);
  return args[index + 1];
}
const manifest = JSON.parse(fs.readFileSync(option('--manifest'), 'utf8'));
const output = option('--output');

function inkBounds(pixels, width, height) {
  let left = width, top = height, right = 0, bottom = 0;
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      if (!pixels[(y * width + x) * 4 + 3]) continue;
      left = Math.min(left, x); top = Math.min(top, y);
      right = Math.max(right, x + 1); bottom = Math.max(bottom, y + 1);
    }
  }
  return right ? [left - 32, top - 96, right - 32, bottom - 96] : [0, 0, 0, 0];
}

async function main() {
  const fonts = manifest.fonts.map(font => ({ ...font,
    sha256: crypto.createHash('sha256').update(fs.readFileSync(font.path)).digest('hex') }));
  const result = { versions: process.versions, fonts: [] };
  if (process.versions.electron) {
    const { app, BrowserWindow } = require('electron');
    await app.whenReady();
    const window = new BrowserWindow({ show: false,
      webPreferences: { backgroundThrottling: false } });
    try {
      await window.loadURL('about:blank');
      for (const [index, font] of fonts.entries()) {
        const data = { family: `Reference${index}`, size: font.size, cases: font.cases,
          bytes: fs.readFileSync(font.path).toString('base64'), boundsSource: inkBounds.toString() };
        const cases = await window.webContents.executeJavaScript(`(async function(data) {
          const face = new FontFace(data.family, 'url(data:font/ttf;base64,' + data.bytes + ')');
          document.fonts.add(await face.load());
          const canvas = document.createElement('canvas');
          canvas.width = 1024; canvas.height = 192;
          const ctx = canvas.getContext('2d');
          ctx.font = data.size + 'px ' + data.family;
          ctx.fontKerning = 'normal';
          const bounds = (0, eval)('(' + data.boundsSource + ')');
          return data.cases.map(text => {
            const metrics = ctx.measureText(text);
            ctx.clearRect(0, 0, 1024, 192);
            ctx.fillText(text, 32, 96);
            return { text, metrics: Object.fromEntries(['width', 'actualBoundingBoxLeft',
              'actualBoundingBoxRight', 'actualBoundingBoxAscent', 'actualBoundingBoxDescent']
              .map(key => [key, metrics[key]])),
              ink: bounds(ctx.getImageData(0, 0, 1024, 192).data, 1024, 192) };
          });
        })(${JSON.stringify(data)})`, true);
        result.fonts.push({ path: font.path, sha256: font.sha256, size: font.size, cases });
      }
      fs.writeFileSync(output, JSON.stringify(result, null, 2) + '\n');
    } finally {
      try { window.destroy(); } finally { app.quit(); }
    }
  } else {
    const native = require(path.resolve(option('--addon')));
    // Stage font contents because the game VFS cannot follow external symlinks.
    const fontRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'pmjs-font-reference-'));
    let initialized = false;
    try {
      fonts.forEach((font, index) => fs.copyFileSync(font.path, path.join(fontRoot, `${index}.ttf`)));
      native.initialize({ gameRoot: fontRoot, assetRoot: '', width: 1024, height: 192,
        windowTitle: 'actual game font reference' });
      initialized = true;
      for (const [index, font] of fonts.entries()) {
        const fontPath = `${index}.ttf`;
        const cases = font.cases.map(text => {
          const metrics = native.canvas.measureTextMetrics(fontPath, text, font.size);
          const canvas = native.canvas.create(1024, 192);
          try {
            native.canvas.drawText(canvas.handle, fontPath, text, 32, 96, font.size, 0xffffffff, 0);
            const pixels = native.canvas.readPixels(canvas.handle, 0, 0, 1024, 192);
            return { text, metrics, ink: inkBounds(pixels, 1024, 192) };
          } finally {
            native.canvas.release(canvas.handle);
          }
        });
        result.fonts.push({ path: font.path, sha256: font.sha256, size: font.size, cases });
      }
      fs.writeFileSync(output, JSON.stringify(result, null, 2) + '\n');
    } finally {
      try {
        if (initialized) native.runtime.quit();
      } finally {
        fs.rmSync(fontRoot, { recursive: true, force: true });
      }
    }
  }
}

main().catch(error => {
  console.error(error);
  if (process.versions.electron) require('electron').app.exit(1);
  else process.exitCode = 1;
});
