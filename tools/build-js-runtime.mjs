#!/usr/bin/env node

import fs from 'node:fs';
import path from 'node:path';
const args = process.argv.slice(2);
const check = args.includes('--check');
function option(name) {
  const index = args.indexOf(name);
  if (index < 0 || index + 1 >= args.length) return null;
  return args[index + 1];
}
const rootArgument = option('--root');
const manifestArgument = option('--manifest');
const outputArgument = option('--output');
if (!rootArgument || !manifestArgument || !outputArgument) {
  console.error('usage: build-js-runtime.mjs --root ROOT --manifest FILE --output FILE [--check]');
  process.exit(2);
}
const root = path.resolve(process.cwd(), rootArgument);
function insideRoot(input, label) {
  const resolved = path.resolve(root, input);
  if (resolved !== root && !resolved.startsWith(root + path.sep)) {
    throw new Error(`${label} must be inside root`);
  }
  return resolved;
}
const manifestPath = insideRoot(manifestArgument, 'manifest');
const output = insideRoot(outputArgument, 'output');
const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
if (!Array.isArray(manifest.modules) || !manifest.modules.length) {
  throw new Error('bundle manifest requires a non-empty modules array');
}
const modules = manifest.modules;

function buildBundle() {
  return modules.map(relative => {
    if (typeof relative !== 'string' || !relative || path.isAbsolute(relative) ||
        relative.split(/[\\/]/).includes('..')) {
      throw new Error(`invalid bundle module: ${relative}`);
    }
    const source = fs.readFileSync(insideRoot(relative, 'module'), 'utf8');
    return `// BEGIN ${relative}\n${source.trimEnd()}\n// END ${relative}\n`;
  }).join('\n');
}

const bundle = buildBundle();
if (check) {
  const current = fs.existsSync(output) ? fs.readFileSync(output, 'utf8') : '';
  if (current !== bundle) {
    console.error(`${path.relative(root, output)} is out of date`);
    process.exitCode = 1;
  }
} else {
  fs.mkdirSync(path.dirname(output), { recursive: true });
  const temporary = `${output}.tmp-${process.pid}`;
  try {
    fs.writeFileSync(temporary, bundle, { flag: 'wx' });
    fs.renameSync(temporary, output);
  } finally {
    try { fs.unlinkSync(temporary); } catch (error) {
      if (error.code !== 'ENOENT') throw error;
    }
  }
  console.log(`generated ${path.relative(root, output)} from ${modules.length} modules`);
}
