'use strict';

const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { parseArgs } = require('node:util');
const { context } = require('../test/helpers/jsonex-context.cjs');

const { values } = parseArgs({ options: {
  source: { type: 'string', default: path.join(__dirname, '../js/pmjs-mv/jsonex.js') },
  label: { type: 'string', default: 'current' },
  stock: { type: 'boolean', default: false },
  events: { type: 'string', default: '300' },
  fields: { type: 'string', default: '40' },
  seed: { type: 'string', default: '42' },
  samples: { type: 'string', default: '15' },
  warmup: { type: 'string', default: '5' },
  output: { type: 'string' }
} });
const settings = {};
for (const key of ['events', 'fields', 'seed', 'samples', 'warmup']) {
  settings[key] = Number(values[key]);
  assert.ok(Number.isSafeInteger(settings[key]) && settings[key] > 0, key + ' must be positive');
}
assert.equal(typeof global.gc, 'function', 'run with node --expose-gc');
const source = fs.readFileSync(values.stock ?
  path.join(__dirname, '../test/fixtures/mv-jsonex.cjs') : values.source, 'utf8');
const ctx = context({ installed: false, fields: settings.fields });
if (!values.stock) {
  vm.runInContext(source, ctx, { filename: values.source });
  ctx.installNativeJsonEx();
  assert.equal(ctx.PMJS.optimizations.reason('storage.jsonex-fast-objects'), 'enabled');
}
const reference = context({ installed: false, fields: settings.fields });
const live = ctx.build(settings.seed, settings.events);
const json = ctx.JsonEx.stringify(live);
assert.equal(json, reference.JsonEx.stringify(reference.build(settings.seed, settings.events)));
const loaded = ctx.JsonEx.parse(json);
assert.equal(loaded.events, loaded.map._events);
assert.equal(ctx.JsonEx.stringify(loaded), reference.JsonEx.stringify(reference.JsonEx.parse(json)));
const fastProperties = {};
for (const [name, events] of [['live', live.events], ['loaded', loaded.events]]) {
  const objects = events.filter(Boolean);
  const fast = objects.filter(event => ctx.fast(event)).length;
  fastProperties[name] = { fast, total: objects.length };
  if (!values.stock) assert.equal(fast, objects.length);
}
const result = {
  label: values.label, node: process.version, arch: process.arch, platform: process.platform,
  sourceSha256: crypto.createHash('sha256').update(source).digest('hex'),
  settings, jsonBytes: Buffer.byteLength(json),
  jsonSha256: crypto.createHash('sha256').update(json).digest('hex'),
  implementation: values.stock ? 'stock' : 'optimized', fastProperties,
  validation: 'passed', operations: {}
};
for (const operation of ['stringify', 'parse']) {
  const input = operation === 'stringify' ? live : json;
  for (let index = 0; index < settings.warmup; index++) ctx.JsonEx[operation](input);
  global.gc();
  const heapBefore = process.memoryUsage().heapUsed;
  const samplesMs = [];
  for (let index = 0; index < settings.samples; index++) {
    const start = performance.now();
    ctx.JsonEx[operation](input);
    samplesMs.push(performance.now() - start);
  }
  const heapAfterSamples = process.memoryUsage().heapUsed;
  global.gc();
  const sorted = samplesMs.toSorted((a, b) => a - b);
  result.operations[operation] = {
    samplesMs, medianMs: sorted[Math.floor(sorted.length / 2)],
    p95Ms: sorted[Math.ceil(sorted.length * 0.95) - 1],
    heapBefore, heapAfterSamples, heapAfterGc: process.memoryUsage().heapUsed,
    rssAfterSamples: process.memoryUsage().rss
  };
}
result.maxRssKiB = process.resourceUsage().maxRSS;
const output = JSON.stringify(result, null, 2) + '\n';
if (values.output) fs.writeFileSync(values.output, output);
process.stdout.write(output);
