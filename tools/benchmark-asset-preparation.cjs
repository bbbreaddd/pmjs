'use strict';

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { performance } = require('node:perf_hooks');

const args = process.argv.slice(2);
if (args.length < 5 || args.length > 6) {
  console.error('usage: node benchmark-asset-preparation.cjs ADDON GAME CACHE REPORT CONFIG [PREPARATION_MODULE]');
  process.exit(1);
}
const [addon, gameRoot, cacheRoot, output, config, modulePath] = args.map(value => path.resolve(value));
const preparationModule = modulePath || path.resolve(__dirname, '../runner/asset-preparation.cjs');
const native = require(addon);
const { prepareAssets } = require(preparationModule);
const options = JSON.parse(fs.readFileSync(config));
const preparation = options.assetPreparation || {};
const recipes = preparation.recipes || [];
const hash = file => crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
const jobs = [];
const warnings = [];
const original = native.assets.processImage;
let initialized = false;
native.assets.processImage = async (...values) => {
  const started = performance.now();
  try { return await original(...values); }
  finally { jobs.push({ source: values[0], durationMs: performance.now() - started }); }
};

async function run() {
  native.initialize({ gameRoot, assetRoot: '', width: options.width || 816, height: options.height || 624,
    windowTitle: 'Asset preparation benchmark', imageWarmCacheBytes: 0 });
  initialized = true;
  const phases = {};
  let lastTime = performance.now(), lastPhase = 'startup', lastReported = 0;
  const cpuStarted = process.cpuUsage();
  const started = performance.now();
  const result = await prepareAssets({ gameRoot, cacheRoot, native, recipes,
    verifyHashes: preparation.verifyHashes === true,
    logger: { warn(message) { warnings.push(message); } },
    onProgress(progress) {
      const now = performance.now();
      phases[lastPhase] = (phases[lastPhase] || 0) + now - lastTime;
      lastTime = now;
      lastPhase = progress.phase;
      if (progress.completed > lastReported && progress.completed % 100 === 0) {
        lastReported = progress.completed;
        console.error(`${progress.completed}/${progress.total} images; ${Math.round(progress.elapsedMs)} ms`);
      }
    }
  });
  const imageWarnings = warnings.length;
  let maps;
  if (preparation.maps) {
    const { prepareMaps } = require(path.join(path.dirname(preparationModule), 'map-preparation.cjs'));
    maps = await prepareMaps({ gameRoot, cacheRoot, native,
      width: options.width || 816, height: options.height || 624,
      verifyHashes: preparation.verifyHashes === true,
      logger: { warn(message) { warnings.push(message); } } });
  }
  const wallMs = performance.now() - started;
  const cpu = process.cpuUsage(cpuStarted);
  const maxRssKiB = process.resourceUsage().maxRSS;
  result.releaseCacheLease?.();
  maps?.releaseCacheLease?.();
  if (maps) delete maps.releaseCacheLease;
  const entries = result.entries.map(({ source, descriptor, sourceHash }) => ({ source, descriptor, sourceHash }));
  delete result.releaseCacheLease;
  delete result.entries;
  delete result.decryptedEntries;
  const report = { addonSha256: hash(addon), preparationSha256: hash(preparationModule),
    configSha256: hash(config), processor: native.assets.preparationVersion,
    gameRoot, cacheRoot, result, phases, cpu, maxRssKiB,
    entries, maps, wallMs, jobs, warnings };
  fs.mkdirSync(path.dirname(output), { recursive: true });
  fs.writeFileSync(output, JSON.stringify(report, null, 2) + '\n');
  console.log(JSON.stringify({ output, ...result, wallMs,
    maps: maps && { durationMs: maps.durationMs, selected: maps.selected, refused: maps.refused,
      generated: maps.generated, compilationHits: maps.compilationHits, validation: maps.validation, error: maps.error },
    cpu, maxRssKiB: report.maxRssKiB, warnings: warnings.length }));
  if (!result.total) console.error('No supported source assets discovered; benchmark is empty.');
  if (!result.total || result.cancelled || result.completed !== result.total || result.installed !== result.prepared ||
      imageWarnings || maps?.error || maps?.cancelled || warnings.length-imageWarnings > (maps?.refused || 0))
    process.exitCode = 1;
}
run().catch(error => { console.error(error.stack); process.exitCode = 1; }).finally(() => {
  native.assets.processImage = original;
  if (initialized) native.runtime.quit();
});
