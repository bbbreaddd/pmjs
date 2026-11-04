'use strict';

const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const timers = require('node:timers');
const { createStorage } = require('../runner/storage.cjs');

function summary(values) {
  values.sort((a, b) => a - b);
  return { samples: values.length, p50: values[Math.floor(values.length * 0.5)],
    p95: values[Math.floor(values.length * 0.95)], max: values.at(-1) };
}

async function scheduler(source) {
  const context = vm.createContext({ PMJS: {}, performance, console,
    __pmjsBuiltinRequire: require, NativeHost: { runtime: { scheduling: timers } } });
  vm.runInContext(fs.readFileSync(source, 'utf8'), context, { filename: source });
  try {
    const results = {};
    for (const promiseDepth of [0, 4]) {
      const samples = [];
      for (let round = 0; round < 9; round++) {
        const started = performance.now();
        for (let index = 0; index < 5000; index++) context.PMJS.tasks.enqueue(() => {
          if (!promiseDepth) return;
          let promise = Promise.resolve();
          for (let depth = 0; depth < promiseDepth; depth++) promise = promise.then(() => {});
          return promise;
        }, { errorMode: 'uncaught' });
        await context.PMJS.tasks.idle();
        if (round >= 2) samples.push(performance.now() - started);
      }
      results[promiseDepth ? 'promiseChainsMs' : 'callbacksMs'] = summary(samples);
    }
    return results;
  } finally { context.PMJS.tasks.stop(); }
}

async function frames(runtimeRoot) {
  let tickerUpdates = 0, animationCallbacks = 0;
  const context = vm.createContext({ PMJS: {}, performance, console,
    __pmjsBuiltinRequire: require, NativeHost: { runtime: { scheduling: timers } },
    SceneManager: { ticker: { _pmjsHostDriven: true, update() { tickerUpdates++; } } } });
  for (const module of ['pmjs-web/scheduler', 'pmjs-rpgmaker/main-loop', 'pmjs-mv/main-loop']) {
    const filename = path.join(runtimeRoot, 'js', module + '.js');
    vm.runInContext(fs.readFileSync(filename, 'utf8'), context, { filename });
  }
  const tasks = context.PMJS.tasks, results = {};
  try {
    for (const rafCount of [0, 1, 8]) {
      const initialTicks = tickerUpdates, initialCallbacks = animationCallbacks;
      const samples = [];
      for (let round = 0; round < 9; round++) {
        const started = performance.now();
        for (let frame = 0; frame < 2000; frame++) {
          for (let index = 0; index < rafCount; index++) context.requestAnimationFrame(() => { animationCallbacks++; });
          await tasks.runFrame(() => Promise.resolve(context.__pmjsTick(frame * 1000 / 60))
            .then(() => context.__pmjsRender()));
        }
        if (round >= 2) samples.push((performance.now() - started) / 2000);
      }
      let promises = 0;
      const remove = require('node:v8').promiseHooks.createHook({ init() { promises++; } });
      try {
        for (let frame = 0; frame < 100; frame++) {
          for (let index = 0; index < rafCount; index++) context.requestAnimationFrame(() => { animationCallbacks++; });
          await tasks.runFrame(() => Promise.resolve(context.__pmjsTick(frame * 1000 / 60))
            .then(() => context.__pmjsRender()));
        }
      } finally { remove(); }
      if (tickerUpdates - initialTicks !== 18100 || animationCallbacks - initialCallbacks !== 18100 * rafCount) {
        throw new Error('frame pipeline did not execute the expected guest callbacks');
      }
      results[rafCount] = { frameMs: summary(samples), promisesPerFrameIncludingDriver: promises / 100 };
    }
    return results;
  } finally { tasks.stop(); }
}

async function writes(root, sizes = [16 * 1024, 256 * 1024, 1024 * 1024]) {
  fs.mkdirSync(root, { recursive: true });
  const directory = fs.mkdtempSync(path.join(root, 'save-write-'));
  try {
    const storage = createStorage(directory), results = {};
    for (const size of sizes) {
      const bytes = Buffer.alloc(size, 97), durations = [], delays = [];
      for (let index = 0; index < 30; index++) {
        const start = performance.now();
        const checkpoint = new Promise(resolve => timers.setImmediate(() => resolve(performance.now() - start)));
        storage.writeBytes('slot/save', bytes);
        durations.push(performance.now() - start);
        delays.push(await checkpoint);
      }
      results[size] = { writeMs: summary(durations), eventLoopDelayMs: summary(delays) };
    }
    return results;
  } finally { fs.rmSync(directory, { recursive: true, force: true }); }
}

async function main() {
  const args = process.argv.slice(2);
  if (![2, 4].includes(args.length) || !['--scheduler', '--frames', '--write-root'].includes(args[0]) ||
      (args.length === 4 && (args[0] !== '--write-root' || args[2] !== '--sizes'))) {
    throw new Error('usage: node tools/benchmark-async-boundaries.cjs --scheduler FILE | --frames RUNTIME_DIRECTORY | --write-root DIRECTORY [--sizes BYTES,...]');
  }
  const sizes = args[3] && args[3].split(',').map(Number);
  if (sizes && !sizes.every(size => Number.isSafeInteger(size) && size > 0)) throw new Error('invalid write sizes');
  const results = args[0] === '--scheduler' ? await scheduler(path.resolve(args[1]))
    : args[0] === '--frames' ? await frames(path.resolve(args[1])) : await writes(path.resolve(args[1]), sizes);
  console.log(JSON.stringify({ node: process.version, mode: args[0], results }, null, 2));
}
main().catch(error => { console.error(error); process.exitCode = 1; });
