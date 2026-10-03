/* global PIXI, Graphics, Bitmap, Sprite, Sprite_Animation, Utils, effekseer,
   effectPixelScenario, AudioContext, OfflineAudioContext */
'use strict';

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const zlib = require('node:zlib');
const { effectPixelScenario: scenario } = require('../test/helpers/effect-pixel-scenario.cjs');
const { writeEffectFixtures } = require('../test/effect-fixtures.cjs');
const [scriptDirectory, browserFile, driverDirectory, assetDirectory, outputDirectory] = process.argv.slice(2);
if (![scriptDirectory, browserFile, driverDirectory, assetDirectory, outputDirectory].every(Boolean)) {
  throw Error('Usage: node tools/generate-mz-effect-reference.cjs <stock-script-directory> ' +
    '<chromium-executable> <playwright-package> <native-test-assets> <output-directory>');
}
const { chromium } = require(path.resolve(driverDirectory));
const driverVersion = require(path.join(path.resolve(driverDirectory), 'package.json')).version;
const root = path.resolve(__dirname, '..');
const scripts = path.resolve(scriptDirectory);
const assets = path.resolve(assetDirectory);
const output = path.resolve(outputDirectory);
const hash = file => crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
const scriptFiles = ['libs/pixi.js', 'libs/effekseer.min.js', 'rmmz_core.js', 'rmmz_managers.js', 'rmmz_sprites.js'];
writeEffectFixtures(assets);
fs.mkdirSync(output, { recursive: true });

async function captureParticles(effects) {
  const renderer = new PIXI.Renderer({ width: 64, height: 64, transparent: true,
    antialias: false, preserveDrawingBuffer: true });
  Graphics._app = { renderer };
  Graphics._createEffekseerContext();
  const fx = Graphics.effekseer;
  const factory = {
    container: () => new PIXI.Container(),
    rectangle: (...args) => new PIXI.Rectangle(...args),
    alpha: value => new PIXI.filters.AlphaFilter(value),
    move(target, x, y) { target.position.set(x, y); },
    solid(width, height, color, x, y) {
      const bitmap = new Bitmap(width, height);
      bitmap.fillAll(color);
      const sprite = new Sprite(bitmap);
      sprite.position.set(x, y);
      return sprite;
    },
    animation(handle, target) {
      const animation = new Sprite_Animation();
      animation._handle = handle;
      animation._targets = [target];
      animation._animation = { offsetX: 0, offsetY: 0, displayType: 0, alignBottom: true };
      return animation;
    }
  };
  function capture(stage) {
    renderer.render(stage);
    const gl = renderer.gl;
    const bottom = new Uint8Array(64 * 64 * 4);
    gl.readPixels(0, 0, 64, 64, gl.RGBA, gl.UNSIGNED_BYTE, bottom);
    const top = new Uint8Array(bottom.length);
    for (let y = 0; y < 64; y++) top.set(bottom.subarray((63 - y) * 256, (64 - y) * 256), y * 256);
    return Array.from(top);
  }
  const fixture = {
    factory, fx, capture,
    scale: name => effects[name].handleScale || 1,
    rotation: name => effects[name].rotationX || 0,
    dynamic: name => !!effects[name].dynamic,
    trigger: name => effects[name].trigger,
    seek: name => !!effects[name].seek,
    load(name) {
      return new Promise((resolve, reject) => {
        let effect;
        effect = fx.loadEffect('http://pmjs.test/effects/' + effects[name].file,
          effects[name].scale, () => resolve(effect), reject);
      });
    },
    snapshot(stage, width, height) {
      const texture = PIXI.RenderTexture.create({ width, height });
      renderer.render(stage, texture);
      const canvas = renderer.extract.canvas(texture);
      const presentation = new PIXI.Container();
      presentation.addChild(new PIXI.Sprite(PIXI.Texture.from(canvas)));
      const pixels = capture(presentation);
      texture.destroy(true);
      return pixels;
    }
  };
  try {
    const frames = {};
    for (const name of Object.keys(effects)) frames[name] = await effectPixelScenario(fixture, name);
    const gl = renderer.gl;
    const ext = gl.getExtension('WEBGL_debug_renderer_info');
    const graphics = { version: gl.getParameter(gl.VERSION),
      renderer: gl.getParameter(ext.UNMASKED_RENDERER_WEBGL), attributes: gl.getContextAttributes() };
    return { frames, engine: Utils.RPGMAKER_VERSION, pixi: PIXI.VERSION, graphics };
  } finally { effekseer.releaseContext(fx); }
}

async function captureAudio() {
  const result = [], panners = [];
  const original = AudioContext.prototype.createPanner;
  AudioContext.prototype.createPanner = function() {
    const panner = original.call(this);
    panners.push(panner);
    return panner;
  };
  const gl = document.createElement('canvas').getContext('webgl');
  try {
    for (const channels of [1, 2]) {
      const fx = effekseer.createContext();
      fx.init(gl);
      try {
        let effect;
        await new Promise((resolve, reject) => {
          effect = fx.loadEffect('http://pmjs.test/effects/' +
            (channels === 1 ? 'SpatialSound' : 'SpatialStereo') + '.efkefc', 1, resolve, reject);
        });
        for (const [x, y, z] of [[0, 0, 0], [-1, 0, 0], [1, 0, 0], [0, 1, 0],
          [0, 0, 4], [0, 0, -4], [3, 4, 0], [-3, 0, 4], [0, 0, -100]]) {
          const start = panners.length;
          const handle = fx.play(effect, x, y, z);
          fx.update(2);
          const p = panners.length > start ? panners.at(-1) : null;
          if (channels === 1 && !p) throw Error('Mono panner not created');
          if (channels === 2 && p) throw Error('Stereo unexpectedly spatialized');
          const offline = new OfflineAudioContext(2, 512, 48000);
          const source = offline.createBufferSource();
          source.buffer = offline.createBuffer(channels, 512, 48000);
          for (let c = 0; c < channels; c++) source.buffer.getChannelData(c).fill(c === 0 ? 0.25 : -0.125);
          let params = null;
          if (p) {
            const target = offline.createPanner();
            target.panningModel = p.panningModel;
            target.distanceModel = p.distanceModel;
            target.refDistance = p.refDistance;
            target.maxDistance = p.maxDistance;
            target.rolloffFactor = p.rolloffFactor;
            target.positionX.value = p.positionX.value;
            target.positionY.value = p.positionY.value;
            target.positionZ.value = p.positionZ.value;
            params = { panningModel: p.panningModel, distanceModel: p.distanceModel,
              refDistance: p.refDistance, maxDistance: p.maxDistance, rolloffFactor: p.rolloffFactor };
            source.connect(target);
            target.connect(offline.destination);
          } else source.connect(offline.destination);
          source.start();
          const buffer = await offline.startRendering();
          result.push({ channels, x, y, z, left: buffer.getChannelData(0)[256],
            right: buffer.getChannelData(1)[256], panner: params });
          handle.stop();
          fx.update(1);
        }
        fx.releaseEffect(effect);
      } finally { effekseer.releaseContext(fx); }
    }
    let burstPannerPositions;
    const burst = effekseer.createContext();
    burst.init(gl);
    try {
      const resources = [];
      for (const name of ['SpatialSound', 'SpatialStereo']) {
        resources.push(await new Promise((resolve, reject) => {
          let effect;
          effect = burst.loadEffect('http://pmjs.test/effects/' + name + '.efkefc', 1,
            () => resolve(effect), reject);
        }));
      }
      const before = panners.length;
      const mono = burst.play(resources[0], -1, 0, 0);
      const stereo = burst.play(resources[1], 1, 0, 0);
      burst.update(2);
      const emitted = panners.slice(before);
      burstPannerPositions = emitted.map(p => [p.positionX.value, p.positionY.value, p.positionZ.value]);
      mono.stop(); stereo.stop(); burst.update(2);
      for (const resource of resources) burst.releaseEffect(resource);
    } finally { effekseer.releaseContext(burst); }
    return { rows: result, burstPannerPositions };
  } finally { AudioContext.prototype.createPanner = original; }
}

async function main() {
  const browser = await chromium.launch({ headless: false, executablePath: path.resolve(browserFile),
    args: ['--no-sandbox', '--use-gl=angle', '--use-angle=gles', '--ignore-gpu-blocklist',
      '--enable-webgl', '--disable-gpu-sandbox', '--autoplay-policy=no-user-gesture-required'] });
  try {
    const page = await browser.newPage({ viewport: { width: 64, height: 64 } });
    page.on('pageerror', error => console.error(error));
    await page.route('http://pmjs.test/**', route => {
      const name = new URL(route.request().url()).pathname.slice(1);
      const file = name === 'effekseer.wasm' ? path.join(scripts, 'libs', name) : path.join(assets, name);
      const contentType = name.endsWith('.png') ? 'image/png' :
        name.endsWith('.wasm') ? 'application/wasm' : 'application/octet-stream';
      return route.fulfill({ body: fs.readFileSync(file), contentType,
        headers: { 'access-control-allow-origin': '*' } });
    });
    for (const file of scriptFiles) await page.addScriptTag({ path: path.join(scripts, file) });
    await page.evaluate(() => new Promise((resolve, reject) =>
      effekseer.initRuntime('http://pmjs.test/effekseer.wasm', resolve, reject)));
    await page.addScriptTag({ content: 'globalThis.effectPixelScenario = ' + scenario.toString() });
    const effects = {
      Square: { file: 'SeededSquare.efkefc', scale: 1, seek: true },
      Laser: { file: 'SeededLaser.efkefc', scale: 1, seek: true },
      Ribbon: { file: 'Ribbon.efk', scale: 1 }, Ring: { file: 'Ring.efk', scale: 1, rotationX: Math.PI / 2 },
      Track: { file: 'Track.efk', scale: 1 }, Model: { file: 'Model.efk', scale: 1 },
      Dynamic: { file: 'Dynamic.efkefc', scale: 1, dynamic: true, seek: true },
      Trigger: { file: 'SeededTrigger.efkefc', scale: 1, trigger: 0, seek: true },
      TriggerIdle: { file: 'SeededTrigger.efkefc', scale: 1, trigger: 1, seek: true }
    };
    const result = await page.evaluate(captureParticles, effects);
    const audio = await page.evaluate(captureAudio);
    const audioRows = audio.rows;
    const audioFile = path.join(output, 'audio.tsv');
    fs.writeFileSync(audioFile, audioRows.map(row =>
      ['channels', 'x', 'y', 'z', 'left', 'right'].map(key => row[key]).join('\t')).join('\n') + '\n');
    for (const [name, frames] of Object.entries(result.frames)) {
      const encoded = frames.map(({ label, pixels }) => ({ label, rgba: Buffer.from(pixels).toString('base64') }));
      fs.writeFileSync(path.join(output, name + '.json.gz'), zlib.gzipSync(JSON.stringify(encoded), { level: 9 }));
      console.log(name + ': ' + frames.length + ' stock-reference frames captured');
    }
    for (const entry of Object.values(effects)) entry.sha256 = hash(path.join(assets, 'effects', entry.file));
    const provenance = {
      engine: result.engine, pixi: result.pixi, chromium: browser.version(),
      driver: 'playwright-core ' + driverVersion, graphics: result.graphics,
      scripts: Object.fromEntries([...scriptFiles, 'libs/effekseer.wasm'].map(name => [name, hash(path.join(scripts, name))])),
      effects, modelSha256: hash(path.join(assets, 'effects/Model/block.efkmodel')),
      fixtureNotes: {
        seeking: 'Modern seek fixtures author random seed 1. setRandomSeed changes current random state ' +
          'but backward seeking restores the original authored seed. Legacy samples do not author a seed.',
        dynamic: 'Square with a local equation mapping external inputs 0/1/2 to fixed translation; default input 0 is -6.',
        trigger: 'Pinned TriggerLaser with trigger 0; TriggerIdle sends only unrelated trigger 1 at identical update times.'
      },
      scenarioSha256: hash(path.join(root, 'test/helpers/effect-pixel-scenario.cjs')),
      channelTolerance: 1, maxOutlierPixels: 0,
      audio: {
        file: 'audio.tsv', sha256: hash(audioFile), columns: ['sourceChannels', 'x', 'y', 'z', 'left', 'right'],
        sampleRate: 48000, frames: 512, sampleIndex: 256, monoInput: 0.25, stereoInput: [0.25, -0.125],
        panner: audioRows[0].panner,
        simultaneousMonoStereo: { requestedPositions: [[-1, 0, 0], [1, 0, 0]],
          observedPannerPositions: audio.burstPannerPositions },
        method: 'Capture PannerNode creation and parameters during stock bundled Effekseer mono/stereo playback. ' +
          'Render constant inputs through the captured panner using OfflineAudioContext, or directly for stereo. Fixed default listener.',
        specification: 'https://webaudio.github.io/web-audio-api/#panning-algorithm'
      },
      generatorSha256: hash(__filename), fixtureGeneratorSha256: hash(path.join(root, 'test/effect-fixtures.cjs')),
      pngEncoderSha256: hash(path.join(root, 'test/helpers/png.cjs'))
    };
    fs.writeFileSync(path.join(output, 'provenance.json'), JSON.stringify(provenance, null, 2) + '\n');
  } finally { await browser.close(); }
}
main().catch(error => { console.error(error); process.exitCode = 1; });
