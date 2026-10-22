'use strict';

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

const MAX_INPUT_BYTES = 128 * 1024 * 1024;
const MAX_OUTPUT_BYTES = 64 * 1024 * 1024;
const MAX_PROCESSOR_FILES = 32;
const MAX_DISCOVERED_FILES = 100000;
const MAX_OUTPUTS = 4096;
const PROCESSOR_SUFFIX = '.pmjs-processor.cjs';
const ID = /^[a-z][a-z0-9_-]{0,63}$/;
const HASH = /^[a-f0-9]{64}$/;
const hash = bytes => crypto.createHash('sha256').update(bytes).digest('hex');

function relative(name) {
  return typeof name === 'string' && name.length > 0 && !name.includes('\\') &&
    !name.includes('\0') && !path.posix.isAbsolute(name) &&
    name.split('/').every(part => part && part !== '.' && part !== '..');
}
function fileInside(root, name) {
  if (!relative(name)) throw new Error('invalid port source path: ' + name);
  const actual = fs.realpathSync(path.join(root, ...name.split('/')));
  const base = fs.realpathSync(root);
  if (!actual.startsWith(base + path.sep) || !fs.statSync(actual).isFile())
    throw new Error('port source outside game: ' + name);
  return actual;
}
function loadProcessor(filename) {
  if (!filename.endsWith('.cjs')) throw new Error('port processor must be a .cjs file');
  const processor = require(filename);
  if (!processor || !ID.test(processor.id) || !Number.isSafeInteger(processor.version) ||
      processor.version < 1 || !(Array.isArray(processor.outputs) &&
      processor.outputs.length > 0 && processor.outputs.length <= MAX_OUTPUTS ||
      typeof processor.discover === 'function' && typeof processor.generate === 'function')) {
    throw new Error('invalid port processor manifest: ' + filename);
  }
  // `files` declares the self-contained sibling modules the entry file requires;
  // they are copied beside it so packaged processors resolve their own imports.
  const files = processor.files ?? [];
  if (!Array.isArray(files) || files.length > MAX_PROCESSOR_FILES) {
    throw new Error('invalid port processor file list: ' + filename);
  }
  const declared = new Set();
  for (const file of files) {
    if (typeof file !== 'string' || !relative(file) || file.endsWith(PROCESSOR_SUFFIX) ||
        declared.has(file) || !file.endsWith('.cjs')) {
      throw new Error('invalid port processor file: ' + filename);
    }
    declared.add(file);
  }
  const ids = new Set();
  for (const entry of processor.outputs || []) {
    if (!entry || !ID.test(entry.id) || !relative(entry.source) ||
        typeof entry.generate !== 'function' || ids.has(entry.id)) {
      throw new Error('invalid/duplicate port output: ' + filename);
    }
    ids.add(entry.id);
  }
  return processor;
}
function scanProcessorFiles(roots) {
  const found = new Set(), visited = new Set();
  function visit(directory) {
    let real;
    try { real = fs.realpathSync(directory); } catch { return; }
    if (visited.has(real)) return;
    visited.add(real);
    for (const entry of fs.readdirSync(real, { withFileTypes: true })) {
      const filename = path.join(real, entry.name);
      if (entry.isDirectory()) visit(filename);
      else if (entry.isFile() && entry.name.endsWith(PROCESSOR_SUFFIX)) found.add(filename);
    }
  }
  for (const root of roots || []) {
    try {
      const stat = fs.statSync(root);
      visit(stat.isDirectory() ? root : path.dirname(root));
    } catch (_) {}
  }
  return [...found].sort();
}
function discoverAdapterProcessors(adapterFiles) {
  return scanProcessorFiles(adapterFiles);
}
function discoverBundledProcessors(bundleRoot) {
  return bundleRoot ? scanProcessorFiles([path.join(bundleRoot, 'preparation')]) : [];
}
function selectedOutputs(processor, files, sourcePath, inspect) {
  if (typeof processor.discover !== 'function') return processor.outputs;
  if (files.length > MAX_DISCOVERED_FILES) throw new Error('too many game files for port discovery');
  const fileSet = new Set(files);
  const read = name => {
    if (!fileSet.has(name)) throw new Error('undeclared discovery source: ' + name);
    const filename = sourcePath(name);
    if (fs.statSync(filename).size > MAX_INPUT_BYTES) throw new Error('oversized port input');
    const bytes = fs.readFileSync(filename);
    inspect?.(name, filename, bytes);
    return bytes;
  };
  const selected = processor.discover({ files, read });
  if (!Array.isArray(selected) || selected.length > MAX_OUTPUTS)
    throw new Error('port discovery must return 0-' + MAX_OUTPUTS + ' outputs');
  const found = new Set();
  return selected.map(item => {
    if (typeof item === 'string') item = { source: item };
    if (!item || typeof item.source !== 'string' || !fileSet.has(item.source))
      throw new Error('port discovery selected missing/invalid source');
    // Natural default: filename minus extension. Collisions require explicit IDs.
    const defaultId = path.posix.basename(item.source).replace(/\.[^.]+$/, '').toLowerCase()
      .replace(/[^a-z0-9_-]+/g, '-');
    const id = item.id || defaultId;
    if (!ID.test(id) || found.has(id)) throw new Error('invalid/duplicate discovered output: ' + id);
    found.add(id);
    return { id, source: item.source,
      generate: bytes => processor.generate(bytes, { id, source: item.source }) };
  });
}
function buildPortPreparation({ bundleRoot, processors = [], adapters = [] }) {
  processors = [...new Set([...processors, ...discoverAdapterProcessors(adapters)])];
  const descriptors = [];
  const used = new Set();
  for (const filename of processors) {
    const absolute = fs.realpathSync(filename);
    const processor = loadProcessor(absolute);
    // A package may be built without the user's game files. Keep the processor
    // in the bundle; the device will discover eligible inputs on first launch.
    if (used.has(processor.id)) throw new Error('duplicate port processor ID: ' + processor.id);
    used.add(processor.id);
    const directory = `preparation/${processor.id}`;
    const entryFile = `${directory}/${processor.id}${PROCESSOR_SUFFIX}`;
    const destination = path.join(bundleRoot, entryFile);
    fs.mkdirSync(path.dirname(destination), { recursive: true });
    fs.copyFileSync(absolute, destination, fs.constants.COPYFILE_EXCL);
    const packagedFiles = [];
    for (const file of processor.files ?? []) {
      const record = { path: `${directory}/${file}` };
      const source = fileInside(path.dirname(absolute), file);
      if (!fs.statSync(source).isFile()) throw new Error('missing port processor file: ' + file);
      const target = path.join(bundleRoot, record.path);
      fs.mkdirSync(path.dirname(target), { recursive: true });
      fs.copyFileSync(source, target, fs.constants.COPYFILE_EXCL);
      record.sha256 = hash(fs.readFileSync(target));
      packagedFiles.push(record);
    }
    const records = [];
    descriptors.push({ id: processor.id, version: processor.version,
      processor: entryFile, processorSha256: hash(fs.readFileSync(destination)),
      ...(packagedFiles.length ? { files: packagedFiles } : {}),
      outputs: records });
  }
  return descriptors;
}
function verifyPortDescriptor(bundleRoot, records, verifyOutputs = true) {
  if (records === undefined) return [];
  if (!Array.isArray(records) || records.length > 32) throw new Error('invalid port preparation descriptors');
  const names = new Set(), ids = new Set();
  for (const desc of records) {
    if (!desc || !ID.test(desc.id) || ids.has(desc.id) ||
        (desc.version !== undefined && (!Number.isSafeInteger(desc.version) || desc.version < 1)) ||
        desc.processor !== `preparation/${desc.id}/${desc.id}${PROCESSOR_SUFFIX}` ||
        !HASH.test(desc.processorSha256) ||
        !Array.isArray(desc.outputs) || desc.outputs.length > MAX_OUTPUTS)
      throw new Error('invalid port preparation descriptor');
    ids.add(desc.id);
    const declaredFiles = desc.files ?? [];
    if (!Array.isArray(declaredFiles) || declaredFiles.length > MAX_PROCESSOR_FILES)
      throw new Error('invalid port processor file list');
    const directory = `preparation/${desc.id}`;
    const packaged = new Set([desc.processor]);
    for (const descriptor of declaredFiles) {
      if (!descriptor || typeof descriptor.path !== 'string' ||
          !relative(descriptor.path) || !descriptor.path.endsWith('.cjs') ||
          !descriptor.path.startsWith(directory + '/') || packaged.has(descriptor.path) ||
          !HASH.test(descriptor.sha256))
        throw new Error('invalid port processor file descriptor');
      packaged.add(descriptor.path);
    }
    const processor = fileInside(bundleRoot, desc.processor);
    if (hash(fs.readFileSync(processor)) !== desc.processorSha256)
      throw new Error('port processor hash mismatch');
    for (const descriptor of declaredFiles) {
      const file = fileInside(bundleRoot, descriptor.path);
      if (hash(fs.readFileSync(file)) !== descriptor.sha256)
        throw new Error('port processor file hash mismatch: ' + descriptor.path);
    }
    const outputs = new Set();
    for (const item of desc.outputs) {
      if (!item || !ID.test(item.id) || outputs.has(item.id) || !relative(item.source) ||
          !HASH.test(item.sourceSha256)) throw new Error('invalid port output descriptor');
      outputs.add(item.id);
      const expected = `assets/ports/${desc.id}/${item.id}.pma1`;
      if (item.file !== undefined || item.sha256 !== undefined) {
        if (item.file !== expected || !HASH.test(item.sha256)) throw new Error('invalid port output file');
        if (verifyOutputs) {
          const file = fileInside(bundleRoot, item.file);
          if (fs.statSync(file).size > MAX_OUTPUT_BYTES + 1024 * 1024 ||
              hash(fs.readFileSync(file)) !== item.sha256)
            throw new Error('port output hash mismatch');
        }
        names.add(item.file);
      }
    }
  }
  return names;
}
async function processorRecords({ bundleRoot, descriptors, adapters, logger, files }) {
  if (Array.isArray(descriptors) && descriptors.length) return descriptors.filter(desc => {
    const valid = desc && ID.test(desc.id) && relative(desc.processor);
    if (!valid) logger.warn('[pmjs] invalid optional port processor declaration');
    return valid;
  });
  const filenames = [...discoverBundledProcessors(bundleRoot), ...discoverAdapterProcessors(adapters)];
  const records = [];
  for (const filename of [...new Set(filenames)]) {
    try {
      delete require.cache[filename];
      const processor = loadProcessor(filename), helpers = [];
      for (const name of processor.files || []) {
        const file = fileInside(path.dirname(filename), name);
        helpers.push({ path: name, sha256: await files.hash(file, 'processor') });
      }
      records.push({ id: processor.id, version: processor.version, sourceFile: filename,
        processorSha256: await files.hash(filename, 'processor'), files: helpers, outputs: [] });
    } catch (error) { logger.warn(`[pmjs] ignoring invalid port processor ${filename}: ${error.message}`); }
  }
  return records;
}

async function prepareForRun({ gameRoot, bundleRoot, descriptors, adapters = [],
  compressArtifact, decompressArtifact, logger = console, session = null }) {
  if (!session) throw new Error('port preparation requires a preparation session');
  const resolved = new Map(), assets = session.native.assets, files = session.files;
  const sourcePath = logical => assets.sourcePath?.(logical) || fileInside(gameRoot, logical);
  const records = await processorRecords({ bundleRoot, descriptors, adapters, logger, files });
  for (const desc of records) {
    try {
      const processorFile = desc.sourceFile || fileInside(bundleRoot, desc.processor);
      const processorHash = await files.hash(processorFile, 'processor');
      if (desc.processorSha256 && processorHash !== desc.processorSha256)
        throw new Error('port processor checksum changed');
      const helpers = [];
      for (const item of desc.files || []) {
        const filename = fileInside(desc.sourceFile ? path.dirname(processorFile) : bundleRoot, item.path);
        const checksum = await files.hash(filename, 'processor');
        if (checksum !== item.sha256) throw new Error('port processor helper checksum changed');
        helpers.push([item.path, checksum]);
        delete require.cache[filename];
      }
      delete require.cache[processorFile];
      const processor = loadProcessor(processorFile);
      if (processor.id !== desc.id || desc.version !== undefined && processor.version !== desc.version) throw new Error('port processor identity changed');
      const identity = hash(Buffer.from(JSON.stringify([processorHash, helpers, processor.version])));
      const discoveryInputs = [];
      const outputs = selectedOutputs(processor, session.inventory, sourcePath, (source, filename, bytes) => {
        discoveryInputs.push({ source, file: filename, hash: files.inspectSync(filename, bytes, 'port-discovery').hash });
      });
      for (const entry of outputs) {
        if (session.shouldCancel()) break;
        const id = desc.id + '/' + entry.id;
        try {
          const input = sourcePath(entry.source), inputHash = await files.hash(input, 'port-input');
          const key = hash(Buffer.from(JSON.stringify([identity, entry.id, entry.source, inputHash, discoveryInputs.map(input => [input.source, input.hash])])));
          let directory = session.directory('port/' + desc.id, key);
          let output = path.join(directory, 'data.pma1');
          const previous = session.readManifest(directory);
          if (previous?.sourceHash === inputHash && previous.processor === identity) {
            if (previous.descriptor === null) { session.touch(directory); session.outcome('port:' + id, 'ordinary-choice'); continue; }
            if (await files.hash(output, 'output').catch(() => null) === previous.outputs['data.pma1']) {
              session.touch(directory); session.outcome('port:' + id, 'reused-local'); resolved.set(id, output); continue;
            }
          }
          if (fs.existsSync(directory)) directory = session.newDirectory('port/' + desc.id, key);
          output = path.join(directory, 'data.pma1');
          const dependencies = [{ source: entry.source, hash: inputHash }, ...discoveryInputs.map(({ source, hash }) => ({ source, hash }))];
          let encoded, outcome = 'generated';
          const packaged = desc.outputs?.find(record => record.id === entry.id && record.source === entry.source && record.sourceSha256 === inputHash);
          if (packaged?.file) {
            try {
              const candidate = fileInside(bundleRoot, packaged.file);
              if (await files.hash(candidate, 'package') !== packaged.sha256) throw new Error('packaged output checksum mismatch');
              {
                const bytes = await fs.promises.readFile(candidate);
                if (!decompressArtifact || decompressArtifact(bytes)) { encoded = bytes; outcome = 'reused-package'; }
              }
            } catch (error) { logger.warn(`[pmjs] port preparation ${id}: packaged output unavailable: ${error.message}`); }
          }
          if (!encoded) {
            const bytes = await fs.promises.readFile(input);
            if (bytes.length > MAX_INPUT_BYTES) throw new Error('port input exceeds preparation limit');
            const value = entry.generate ? entry.generate(bytes) : processor.generate(bytes, { id: entry.id, source: entry.source });
            if (value === null) {
              const record = { id, key, source: entry.source, sourceHash: inputHash, processor: identity, dependencies, outcome: 'ordinary-choice', descriptor: null, outputs: {} };
              session.data.results[path.relative(session.root, directory).split(path.sep).join('/')] = record;
              session.markDirty();
              session.touch(directory); session.outcome('port:' + id, 'ordinary-choice');
              continue;
            }
            if (!Buffer.isBuffer(value) && !(value instanceof Uint8Array) || !value.length || value.length > MAX_OUTPUT_BYTES)
              throw new Error('invalid port preparation output');
            encoded = compressArtifact ? Buffer.from(compressArtifact(value)) : Buffer.from(value);
          }
          for (const dependency of discoveryInputs)
            if (await files.hash(sourcePath(dependency.source), 'port-discovery') !== dependency.hash) throw new Error('port discovery input changed while preparing');
          if (await files.hash(input, 'port-input') !== inputHash) throw new Error('port input changed while preparing');
          await fs.promises.mkdir(path.dirname(directory), { recursive: true });
          const stage = await fs.promises.mkdtemp(path.join(path.dirname(directory), '.stage-'));
          try {
            await fs.promises.writeFile(path.join(stage, 'data.pma1'), encoded, { flag: 'wx' });
            const outputHash = await files.hash(path.join(stage, 'data.pma1'), 'output');
            files.writeManifest(stage, { id, key, source: entry.source, sourceHash: inputHash, processor: identity,
              dependencies, outcome, descriptor: { id }, outputs: { 'data.pma1': outputHash } });
            await fs.promises.rename(stage, directory);
            files.publishManifest(stage, directory);
            session.outcome('port:' + id, outcome);
            resolved.set(id, output);
          } finally { await fs.promises.rm(stage, { recursive: true, force: true }); }
        } catch (error) { session.outcome('port:' + id, 'ordinary-failure', error.message); logger.warn(`[pmjs] port preparation ${id} unavailable: ${error.message}`); }
      }
    } catch (error) { logger.warn(`[pmjs] port preparation ${desc.id} unavailable: ${error.message}`); }
  }
  await files.save();
  return resolved;
}

function reader(files, decompressArtifact) {
  return name => {
    const file = typeof name === 'string' &&
      (files instanceof Map ? files.get(name) :
       Object.prototype.hasOwnProperty.call(files, name) ? files[name] : null);
    if (!file) return null;
    try {
      if (fs.statSync(file).size > MAX_OUTPUT_BYTES + 1024 * 1024) return null;
      const bytes = fs.readFileSync(file);
      return decompressArtifact ? decompressArtifact(bytes) : bytes;
    }
    catch { return null; }
  };
}
module.exports = { buildPortPreparation, verifyPortDescriptor, prepareForRun, reader,
  loadProcessor, relative, discoverAdapterProcessors, discoverBundledProcessors };
