#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import crypto from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { preparationInputs } from './game-inspect.mjs';

const root = path.resolve(process.argv[2]);
const share = path.join(root, 'share/pmjs');
const info = JSON.parse(fs.readFileSync(path.join(root, 'build-info.json'), 'utf8'));
const args = process.argv.slice(3);
const command = args.shift();
const help = `PMJS ${info.version} (${info.source.commit.slice(0, 12)}${info.source.dirty ? ', modified' : ''})
Usage:
  pmjs prepare --game DIR [--state DIR] [--config FILE] [--manifest FILE]
  pmjs run --game DIR [--state DIR] [--save-root DIR]
  pmjs self-test [--graphics]
  pmjs --version
Prepared files default to the user cache; saves default to the user data directory.
Game JavaScript executes with Node capabilities. Only run games you trust.`;

function invoke(file, arguments_) {
  const result = spawnSync(process.execPath, [file, ...arguments_], { stdio: 'inherit' });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(`operation failed (${result.signal || result.status})`);
}

function parse(values, names) {
  const result = {};
  for (let index = 0; index < values.length; index += 2) {
    const key = values[index];
    if (!names.includes(key) || result[key] || !values[index + 1] || values[index + 1].startsWith('--')) {
      throw new Error(`invalid argument: ${key}`);
    }
    result[key] = path.resolve(values[index + 1]);
  }
  if (!result['--game']) throw new Error('--game is required');
  return result;
}

function hash(file) {
  return crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
}

async function main() {
  if (command === '--version') { console.log(help.split('\n')[0]); return; }
  if (!command || command === '--help' || command === 'help') { console.log(help); return; }
  if (command === 'self-test') {
    if (args.some(value => value !== '--graphics') || args.length > 1) throw new Error('invalid self-test arguments');
    invoke(path.join(share, 'tools/package-self-test.cjs'), [root, ...args]);
    return;
  }
  if (!['prepare', 'run'].includes(command)) throw new Error(`unknown command: ${command}`);
  const options = parse(args, command === 'prepare' ?
    ['--game', '--state', '--config', '--manifest'] : ['--game', '--state', '--save-root']);
  const game = fs.realpathSync(options['--game']);
  if (!fs.statSync(game).isDirectory()) throw new Error('game must be a directory');
  const id = crypto.createHash('sha256').update(game).digest('hex').slice(0, 24);
  const state = options['--state'] || path.join(process.env.XDG_CACHE_HOME || path.join(os.homedir(), '.cache'), 'pmjs', id);
  const prepared = path.join(state, 'prepared.json');
  if (command === 'prepare') {
    fs.mkdirSync(state, { recursive: true });
    const temporary = path.join(state, `bootstrap-${process.pid}.tmp`);
    const inputs = preparationInputs(game, options['--config'], options['--manifest']);
    const buildArgs = ['--game', game, '--output', temporary];
    if (options['--config']) buildArgs.push('--config', options['--config']);
    if (options['--manifest']) buildArgs.push('--manifest', options['--manifest']);
    try {
      invoke(path.join(share, 'tools/build-js-runtime.mjs'), buildArgs);
      if (JSON.stringify(inputs) !== JSON.stringify(preparationInputs(game, options['--config'], options['--manifest']))) {
        throw new Error('preparation inputs changed during generation; prepare again');
      }
      const bootstrap = `bootstrap-${hash(temporary)}.js`;
      fs.renameSync(temporary, path.join(state, bootstrap));
      const record = { schema: 1, game, packageSha256: hash(path.join(root, 'build-info.json')), bootstrap,
        bootstrapSha256: hash(path.join(state, bootstrap)), config: options['--config'] || null,
        manifest: options['--manifest'] || null, inputs };
      const next = `${prepared}.${process.pid}.tmp`;
      fs.writeFileSync(next, JSON.stringify(record, null, 2) + '\n');
      fs.renameSync(next, prepared);
      console.log(`Prepared ${game}`);
    } finally { fs.rmSync(temporary, { force: true }); }
    return;
  }
  if (!fs.existsSync(prepared)) throw new Error('game has not been prepared; run pmjs prepare --game DIR');
  const record = JSON.parse(fs.readFileSync(prepared, 'utf8'));
  if (record.schema !== 1 || record.game !== game || record.packageSha256 !== hash(path.join(root, 'build-info.json')) ||
      !/^bootstrap-[a-f0-9]{64}\.js$/.test(record.bootstrap) ||
      !fs.existsSync(path.join(state, record.bootstrap)) ||
      record.bootstrapSha256 !== hash(path.join(state, record.bootstrap)) ||
      JSON.stringify(record.inputs) !== JSON.stringify(preparationInputs(game, record.config, record.manifest))) {
    throw new Error('prepared runtime or configuration changed; run pmjs prepare again');
  }
  const saveRoot = options['--save-root'] || path.join(process.env.XDG_DATA_HOME || path.join(os.homedir(), '.local/share'), 'pmjs', id, 'saves');
  const { run } = await import('../runner/index.cjs');
  console.log(`[pmjs] build=${info.source.commit} package=${record.packageSha256}`);
  await run({ addon: path.join(root, 'lib/pmjs_native.node'), gameRoot: game,
    bootstrap: path.join(state, record.bootstrap), saveRoot, config: record.config || undefined });
}

main().catch(error => { console.error(`[pmjs] ${error.stack || error}`); process.exitCode = 1; });
