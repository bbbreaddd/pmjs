'use strict';

const fs = require('node:fs');
const fsp = fs.promises;
const path = require('node:path');
const crypto = require('node:crypto');
const vm = require('node:vm');
const { parsePluginManifest } = require('./plugin-manifest.cjs');
const { performance } = require('node:perf_hooks');
const { COMPILER_VERSION, mapContract, geometryEstimate, engineTilemap, compileRpgMap, compileTiledMap } = require('./map-demand.cjs');
const hash = bytes => crypto.createHash('sha256').update(bytes).digest('hex');
const identity = object => hash(JSON.stringify(object));
const HASH = /^[a-f0-9]{64}$/;

async function ordinaryUpperBound(inputs, renderer, files) {
  if (renderer === 'mz') return inputs.length * 1024 * 1024 * 4;
  let bytes = 0;
  for (const input of inputs) {
    const { header } = await files.inspect(input.file, 'map-source');
    if (!header || header.length < 24 || header.subarray(0, 8).toString('hex') !== '89504e470d0a1a0a' ||
        header.readUInt32BE(8) !== 13 || header.toString('ascii', 12, 16) !== 'IHDR') return Infinity;
    const width = header.readUInt32BE(16), height = header.readUInt32BE(20);
    if (!width || !height || width > 8192 || height > 8192) return Infinity;
    // Decoded sources use at most four bytes per pixel; grayscale can use less.
    bytes += width * height * 4;
  }
  return bytes;
}

function validTileDescriptor(d) {
  const rect = r => Array.isArray(r) && r.length === 4 && r.every(Number.isSafeInteger) && r[0] >= 0 && r[1] >= 0 && r[2] > 0 && r[3] > 0;
  if (!d || d.version !== 1 || !Number.isInteger(d.halo) || d.halo < 1 || d.halo > 32 || !Array.isArray(d.pages) || !d.pages.length || d.pages.length > 4096 ||
      !Array.isArray(d.sources) || !d.sources.length || d.sources.length > 512) return false;
  for (const page of d.pages) if (!/^tiles-\d+\.png$/.test(page.path) ||
    !Number.isSafeInteger(page.width) || !Number.isSafeInteger(page.height) ||
    page.width < 1 || page.height < 1 || page.width > 2048 || page.height > 2048) return false;
  for (const source of d.sources) {
    if (!Number.isSafeInteger(source.width) || !Number.isSafeInteger(source.height) ||
        source.width < 1 || source.height < 1 || source.width > 8192 || source.height > 8192 ||
        source.width*source.height*4 > 128*1024*1024 ||
        !Array.isArray(source.regions) || source.regions.length > 65536) return false;
    for (const r of source.regions) {
      if (!rect(r.rect) || !rect(r.atlas) || !Number.isInteger(r.page) || !d.pages[r.page] ||
          r.rect[0]+r.rect[2] > source.width || r.rect[1]+r.rect[3] > source.height ||
          r.rect[2] !== r.atlas[2] || r.rect[3] !== r.atlas[3]) return false;
      const page = d.pages[r.page];
      if (r.atlas[0] < d.halo || r.atlas[1] < d.halo || r.atlas[0]+r.atlas[2]+d.halo > page.width ||
          r.atlas[1]+r.atlas[3]+d.halo > page.height) return false;
    }
  }
  return true;
}
async function validateEntry(directory, key, files) {
  async function validate(manifest, reused) {
    if (manifest.key !== key || manifest.compiler !== COMPILER_VERSION ||
        manifest.descriptorHash !== identity(manifest.descriptor) ||
        (manifest.descriptor && !validTileDescriptor(manifest.descriptor)) ||
        !Array.isArray(manifest.outputs)) return false;
    if (manifest.outputs.length !== (manifest.descriptor ? manifest.descriptor.pages.length : 0)) return false;
    if (manifest.outputs.some(page => !page || !/^tiles-\d+\.png$/.test(page.path) || !HASH.test(page.hash))) return false;
    return files.validateOutputs(directory, manifest.outputs, page => page.hash, async (page, file, checked) => {
      if (reused && checked.reused) return true;
      let bytes = checked.header;
      if (!bytes) {
        const handle = await fsp.open(file, 'r');
        bytes = Buffer.alloc(24);
        try { if ((await handle.read(bytes, 0, bytes.length, 0)).bytesRead !== bytes.length) return false; }
        finally { await handle.close(); }
      }
      const expected = manifest.descriptor.pages.find(p => p.path === page.path);
      return !!expected && bytes.length >= 24 && bytes.subarray(0, 8).toString('hex') === '89504e470d0a1a0a' &&
        bytes.readUInt32BE(16) === expected.width && bytes.readUInt32BE(20) === expected.height;
    });
  }
  try {
    return await files.validatedManifest(directory, validate);
  } catch (_) { return null; }
}

function gameInputs(native, files) {
  if (!native.fs || typeof native.fs.readBytes !== 'function' || typeof native.fs.readDirectory !== 'function')
    throw new Error('game filesystem unavailable for map preparation');
  function read(logical) {
    const file = native.assets.sourcePath(logical), sourceIdentity = native.assets.sourceIdentity(logical);
    const contents = native.fs.readBytes(logical);
    if (!file || contents === null) throw new Error('missing game input '+logical);
    const bytes = Buffer.from(contents);
    const capturedIdentity = native.assets.sourceIdentity(logical);
    if (capturedIdentity !== sourceIdentity && (native.assets.sourcePath(logical) !== file || hash(fs.readFileSync(file)) !== hash(bytes)))
      throw new Error('game input changed while reading '+logical);
    const checked = files.inspectSync(file, bytes, 'map-input');
    if (native.assets.sourceIdentity(logical) !== capturedIdentity) throw new Error('game input changed while recording '+logical);
    return { bytes, dependency: { logical, file, sourceIdentity: capturedIdentity, hash: checked.hash } };
  }
  async function dependency(logical) {
    const file = native.assets.sourcePath(logical);
    const sourceIdentity = native.assets.sourceIdentity(logical);
    if (!file || !sourceIdentity) throw new Error('missing game input ' + logical);
    const checked = await files.inspect(file, 'map-input');
    const capturedIdentity = native.assets.sourceIdentity(logical);
    if (native.assets.sourcePath(logical) !== file || capturedIdentity !== sourceIdentity)
      throw new Error('game input changed while hashing ' + logical);
    return { logical, file, sourceIdentity: capturedIdentity, hash: checked.hash };
  }
  return { read, dependency, exists: logical => native.fs.exists(logical),
    directory: logical => native.fs.readDirectory(logical) || [] };
}
async function engineContract(game, mz) {
  const engine = game.read('js/'+(mz ? 'rmmz_core.js' : 'rpg_core.js'));
  const source = engine.bytes.toString('utf8'), dependencies = [engine.dependency];
  const manifest = game.exists('js/plugins.js') ? game.read('js/plugins.js') : null;
  if (manifest) dependencies.push(manifest.dependency);
  const plugins = manifest ? parsePluginManifest(manifest.bytes.toString('utf8')).plugins : [];
  const pluginIdentities = [];
  for (const plugin of plugins) {
    if (!plugin.status) continue;
    const dependency = await game.dependency('js/plugins/'+plugin.name+'.js');
    dependencies.push(dependency);
    pluginIdentities.push({ name: plugin.name, parameters: plugin.parameters, hash: dependency.hash });
  }
  return { Tilemap: engineTilemap(source, mz), dependencies,
    identity: { engine: engine.dependency.hash, plugins: pluginIdentities } };
}
async function resolveTiled(game, map) {
  const clone = structuredClone(map), dependencies = [];
  for (const tileset of clone.tilesets || []) if (tileset.source) {
    const { bytes, dependency } = game.read('maps/'+path.posix.basename(tileset.source.replaceAll('\\', '/')));
    dependencies.push(dependency);
    Object.assign(tileset, JSON.parse(bytes));
  }
  return { map: clone, dependencies };
}
async function prepareMapsPhase({ gameRoot, cacheRoot, native, width = 816, height = 624,
  shouldCancel = () => false, onProgress = () => {}, logger = console, verifyRegions = false, verifyHashes = false,
  preparationContext = 'live', portableIndex = null, portableAssetRoot = null, session }) {
  if (!session) throw new Error('map preparation phase requires a preparation session');
  cacheRoot = session.root;
  if (!['live', 'offline'].includes(preparationContext)) throw new Error('invalid preparation context');
  const offline = preparationContext === 'offline';
  const indexedMaps = new Map();
  for (const entry of portableIndex?.entries || []) {
    if (!indexedMaps.has(entry.identity)) indexedMaps.set(entry.identity, entry);
  }
  const started = performance.now(), root = path.join(cacheRoot, 'maps');
  const result = { enabled: true, selected: 0, refused: 0, generated: 0, hits: 0, negativeHits: 0,
    installed: 0, compilationHits: 0, indexedCopies: 0, nativePacks: 0, earlyRefusals: 0, processingMs: 0,
    verifiedRegions: 0, identityRefreshes: 0, snapshotBytes: 0, additionalSnapshotBytes: 0, pageBytes: 0, durationMs: 0, cancelled: false, maps: [], index: {} };
  const files = session.files;
  const digest = file => files.hash(file, 'map-input');
  const entries = [], keys = [], snapshots = new Map(), sourceDependencies = new Map();
  async function captureSnapshot(input) {
    let snapshot = snapshots.get(input.sourceHash);
    if (snapshot) return snapshot;
    // Existing decrypted cache files already provide leased, immutable bytes.
    if (path.resolve(input.file).startsWith(path.resolve(cacheRoot, 'entries')+path.sep)) snapshot = input.file;
    else {
      snapshot = path.join(root, 'sources', input.sourceHash+'.png');
      if (await digest(snapshot).catch(() => null) !== input.sourceHash) {
        const temporary = snapshot+'.stage-'+crypto.randomBytes(6).toString('hex');
        try {
          await files.copyVerified(input.file, temporary, input.sourceHash, 'snapshot');
          await files.publish(temporary, snapshot);
          await digest(snapshot);
        } finally { await fsp.rm(temporary, { force: true }); }
        result.additionalSnapshotBytes += (await fsp.stat(snapshot)).size;
      }
    }
    snapshots.set(input.sourceHash, snapshot);
    result.snapshotBytes += (await fsp.stat(snapshot)).size;
    return snapshot;
  }
  function report(phase, source, completed, total) {
    onProgress({ phase: 'map-'+phase, source, completed, total, remaining: total-completed,
      generated: result.generated, hits: result.hits, fallback: result.refused, sourceBytes: result.snapshotBytes,
      elapsedMs: performance.now()-started });
  }
  try {
    report('discover', '', 0, 0);
    if (!native.assets || typeof native.assets.processTiles !== 'function' ||
        (!offline && typeof native.assets.installTileSets !== 'function'))
      throw new Error('tile preparation unavailable in this addon');

    const data = session.inventory.filter(file => /^data\/Map\d+\.json$/i.test(file)).map(file => file.slice(5)).sort();
    result.total = data.length;
    if (!data.length) {
      if (!offline) { native.assets.installTileSets([]); native.assets.preparedMapIndex = {}; }
      session.setIndex('maps', null);
      result.entries = [];
      result.validation = files.stats;
      return result;
    }
    report('discover', '', 0, 0);
    const game = gameInputs(native, files), mz = game.exists('js/rmmz_core.js');
    const systemInput = game.read('data/System.json'), sheetsInput = game.read('data/Tilesets.json');
    const system = JSON.parse(systemInput.bytes), sheets = JSON.parse(sheetsInput.bytes);
    const contract = await engineContract(game, mz);
    const sharedDependencies = [...contract.dependencies, systemInput.dependency, sheetsInput.dependency];
    const checkedDependencies = new Map();
    async function validateDependencies(dependencies) {
      for (const dependency of dependencies) {
        const before = dependency.logical && native.assets.sourceIdentity(dependency.logical);
        const checked = checkedDependencies.get(dependency.file);
        if (!verifyHashes && checked && checked.hash === dependency.hash &&
            checked.logical === dependency.logical && checked.sourceIdentity === dependency.sourceIdentity &&
            (!dependency.logical || before === checked.sourceIdentity)) continue;
        if (dependency.logical && native.assets.sourcePath(dependency.logical) !== dependency.file ||
            await digest(dependency.file) !== dependency.hash)
          throw new Error('map dependency changed during preparation: '+(dependency.logical || dependency.file));
        if (dependency.logical) {
          const current = native.assets.sourceIdentity(dependency.logical);
          if (!current || before !== current) throw new Error('map dependency changed while validating: '+dependency.logical);
          // Link-count changes alter stat identity without changing captured content.
          if (current !== dependency.sourceIdentity) { dependency.sourceIdentity=current; ++result.identityRefreshes; }
        }
        checkedDependencies.set(dependency.file, { ...dependency });
      }
    }
    await fsp.mkdir(path.join(root, 'entries'), { recursive: true });
    await fsp.mkdir(path.join(root, 'sources'), { recursive: true });
    report('validate', '', 0, data.length);
    result.validation = files.stats;
    let imported = null;
    if (portableIndex?.compiler === COMPILER_VERSION &&
        portableIndex.compilations && typeof portableIndex.compilations === 'object' &&
        portableIndex.mapInputs && typeof portableIndex.mapInputs === 'object') {
      const rebound = {};
      for (const [name, entry] of Object.entries(portableIndex.mapInputs)) {
        if (!/^Map\d+\.json$/i.test(name) || !Array.isArray(entry?.dependencies)) continue;
        const dependencies = [];
        for (const dependency of entry.dependencies) {
          if (typeof dependency.logical !== 'string' || dependency.logical.includes('..') ||
              dependency.logical.startsWith('/') || !HASH.test(dependency.hash)) break;
          const file = native.assets.sourcePath(dependency.logical);
          if (!file || await digest(file).catch(() => null) !== dependency.hash) break;
          dependencies.push({ logical: dependency.logical, file,
            sourceIdentity: native.assets.sourceIdentity(dependency.logical), hash: dependency.hash });
        }
        if (dependencies.length === entry.dependencies.length)
          rebound[name] = { ...entry, dependencies };
      }
      imported = { compiler: COMPILER_VERSION, compilations: portableIndex.compilations,
        compilationsHash: identity(portableIndex.compilations), mapInputs: rebound,
        mapInputsHash: identity(rebound) };
    }
    if (session.data.indices.maps?.compiler !== COMPILER_VERSION) session.setIndex('maps', null);
    const previousIndex = session.data.indices.maps || imported;
    const recompileMapInputs = new Set(previousIndex?.recompileMapInputs || []);
    const previousCompilationsValid = !!previousIndex?.compilations &&
      previousIndex.compilationsHash === identity(previousIndex.compilations);
    const previousInputsValid = !!previousIndex?.mapInputs &&
      previousIndex.mapInputsHash === identity(previousIndex.mapInputs);
    const previousCompilations = previousCompilationsValid ? previousIndex.compilations : {};
    const previousInputs = previousInputsValid ? previousIndex.mapInputs : {};
    const compilations = {}, mapInputs = {};
    async function unchangedDependencies(cached) {
      if (!Array.isArray(cached.dependencies) || !cached.dependencies.length) return null;
      const dependencies = [];
      for (const input of cached.dependencies) {
        if (typeof input.logical !== 'string' || !HASH.test(input.hash)) return null;
        const file = native.assets.sourcePath(input.logical);
        const sourceIdentity = native.assets.sourceIdentity(input.logical);
        if (!file || file !== input.file || await digest(file) !== input.hash ||
            native.assets.sourceIdentity(input.logical) !== sourceIdentity) return null;
        dependencies.push({ logical: input.logical, file, sourceIdentity, hash: input.hash });
      }
      return dependencies;
    }
    for (let index = 0; index < data.length; ++index) {
      if (shouldCancel()) { result.cancelled = true; break; }
      const filename = data[index], mapId = Number(filename.match(/\d+/)[0]);
      report('compile', filename, index, data.length);
      let declined = false;
      let stage, row = { mapId, filename, selected: false };
      try {
        const tiledFile = 'maps/Map'+mapId+'.json';
        const tiled = game.exists(tiledFile), cachedInputs = previousInputs[filename];
        let dependencies, demand, compile, visualContract, cachedEntryKey, cachedEntrySources;
        const compilationKey = inputs => identity({ compiler: COMPILER_VERSION, processor: native.assets.tilePreparationVersion,
          compilation: true, dependencies: [...sharedDependencies,...inputs].map(input=>input.hash), width, height });
        if (!recompileMapInputs.has(filename) && cachedInputs && cachedInputs.tiled === tiled) {
          dependencies = await unchangedDependencies(cachedInputs).catch(() => null);
          if (dependencies) {
            const cached = previousCompilations[compilationKey(dependencies)];
            if (cached && HASH.test(cachedInputs.contractHash)) {
              demand = { ...cached, contractHash: cachedInputs.contractHash };
              if (HASH.test(cachedInputs.entryKey || '') && Array.isArray(cachedInputs.entrySources)) {
                cachedEntryKey = cachedInputs.entryKey;
                cachedEntrySources = cachedInputs.entrySources;
              }
            }
          }
        }
        if (!demand) {
          const input = game.read('data/'+filename);
          const map = JSON.parse(input.bytes);
          dependencies = [input.dependency];
          if (tiled) {
            const tiledInput = game.read(tiledFile), resolved = await resolveTiled(game, JSON.parse(tiledInput.bytes));
            dependencies.push(tiledInput.dependency, ...resolved.dependencies);
            compile = () => compileTiledMap(resolved.map);
            visualContract = () => resolved.map;
          } else {
            compile = () => compileRpgMap({ map, tileset: sheets[map.tilesetId], Tilemap: contract.Tilemap,
              mz, tileWidth: mz ? system.tileSize || 48 : 48 });
            visualContract = () => mapContract(map, sheets[map.tilesetId],
              mz ? system.tileSize || 48 : 48, mz ? system.tileSize || 48 : 48);
          }
        }
        const refusalKey = compilationKey(dependencies);
        const refusalDirectory = path.join(root,'entries',refusalKey);
        const refusal = await validateEntry(refusalDirectory,refusalKey,files);
        if (refusal && !recompileMapInputs.has(filename)) {
          declined = true; keys.push(refusalKey); ++result.hits; ++result.negativeHits; throw new Error(refusal.reason);
        }
        try {
          const cached = recompileMapInputs.has(filename) ? null : previousCompilations[refusalKey];
          if (demand) ++result.compilationHits;
          else if (cached) {
            const { renderer, ...prepared } = cached;
            delete prepared.contract;
            demand = { renderer, contract: visualContract(), ...prepared };
            ++result.compilationHits;
          } else demand = compile();
          recompileMapInputs.delete(filename);
          if (!demand.sources.length) throw new Error('no compact tile demand');
        } catch (error) {
          recompileMapInputs.delete(filename);
          declined = true;
          keys.push(refusalKey);
          stage = await fsp.mkdtemp(path.join(root,'entries','.stage-'));
          files.writeManifest(stage, { filename, compiler: COMPILER_VERSION, key: refusalKey,
            descriptor: null, descriptorHash: identity(null), outputs: [], reason: error.message });
          await validateDependencies([...sharedDependencies, ...dependencies]);
          if (shouldCancel()) { result.cancelled=true; break; }
          await fsp.rm(refusalDirectory,{recursive:true,force:true});
          await fsp.rename(stage,refusalDirectory); files.publishManifest(stage, refusalDirectory); stage=null; ++result.generated;
          throw error;
        }
        if (demand.contract) {
          demand.contractHash = identity(demand.contract);
          delete demand.contract;
        }
        if (demand.geometryDensity) {
          demand.geometryBytes = geometryEstimate(demand, width, height);
          delete demand.geometryDensity;
          delete demand.geometryWidth;
          delete demand.geometryHeight;
          delete demand.loopHorizontal;
          delete demand.loopVertical;
        }
        compilations[refusalKey] = { ...demand };
        mapInputs[filename] = { tiled, dependencies, contractHash: demand.contractHash, compilationKey: refusalKey };
        row.renderer = demand.renderer;
        row.features = demand.features;
        let inputs = [];
        for (const input of demand.sources) {
          let dependency = sourceDependencies.get(input.source);
          if (!dependency || verifyHashes) {
            const file = native.assets.sourcePath(input.source);
            if (!file) { inputs.push({ ...input, file: null, sourceHash: null }); continue; }
            const sourceIdentity = native.assets.sourceIdentity(input.source);
            if (!dependency || dependency.sourceIdentity !== sourceIdentity || dependency.file !== file) {
              dependency = { logical: input.source, file, sourceIdentity, hash: await digest(file) };
              sourceDependencies.set(input.source, dependency);
            }
            if (native.assets.sourceIdentity(input.source) !== sourceIdentity) throw new Error('tile source changed while hashing');
          }
          const { file, sourceIdentity, hash: sourceHash } = dependency;
          inputs.push({ ...input, file, sourceHash, sourceIdentity });
        }
        const merged = new Map();
        for (const input of inputs) {
          const prior = input.sourceIdentity && merged.get(input.sourceIdentity);
          if (prior) {
            const rectangles = new Map([...prior.rectangles,...input.rectangles].map(rect=>[rect.join(','),rect]));
            prior.rectangles = [...rectangles.values()];
          } else merged.set(input.sourceIdentity || input.source,input);
        }
        inputs = [...merged.values()];
        const entrySources = inputs.map(({ source, sourceHash }) => ({ source, hash: sourceHash }));
        const sameSources = Array.isArray(cachedEntrySources) && cachedEntrySources.length === entrySources.length &&
          entrySources.every((input, index) => HASH.test(input.hash || '') &&
            cachedEntrySources[index]?.source === input.source && cachedEntrySources[index]?.hash === input.hash);
        let key;
        if (cachedEntryKey && sameSources) {
          key = cachedEntryKey;
        } else {
          key = identity({ compiler: COMPILER_VERSION, processor: native.assets.tilePreparationVersion,
            demand, dependencies: dependencies.map(dependency => dependency.hash), contract: contract.identity, width, height,
            sources: inputs.map(({ source, sourceHash }) => ({ source, sourceHash })) });
        }
        mapInputs[filename] = { ...mapInputs[filename], entryKey: key, entrySources };
        keys.push(key);
        let directory = session.directory('maps/entries', key);
        let manifest = await validateEntry(directory, key,files);
        let outcome = manifest ? 'reused-local' : 'generated';
        if (manifest) { ++result.hits; if (!manifest.descriptor) ++result.negativeHits; }
        else {
          report('pack', filename, index, data.length);
          if (fs.existsSync(directory)) directory = session.newDirectory('maps/entries', key);
          stage = await fsp.mkdtemp(path.join(root, 'entries', '.stage-'));
          let descriptor, reason;
          const geometryBytes = geometryEstimate(demand, width, height);
          const missing = inputs.filter(input => !input.file);
          if (missing.length) reason = 'missing tile source '+missing.map(input => input.source).join(', ');
          else if (inputs.every(input => !input.rectangles.length)) reason = 'no visual tile demand';
          if (!reason && geometryBytes >= await ordinaryUpperBound(inputs, demand.renderer, files)) {
            reason = 'packed allocations and geometry are not smaller';
            ++result.earlyRefusals;
          }
          if (!reason && !session.repairSources.has(key) && portableAssetRoot && Array.isArray(portableIndex?.entries)) {
            const indexed = indexedMaps.get(key);
            if (indexed && validTileDescriptor(indexed.descriptor) &&
                indexed.descriptor.sources.length === inputs.length &&
                indexed.outputs?.length === indexed.descriptor.pages.length) {
              try {
                for (let i = 0; i < indexed.outputs.length; ++i) {
                  const page = indexed.outputs[i], expected = indexed.descriptor.pages[i];
                  if (!/^assets\/maps\/[a-f0-9]{64}\/tiles-\d+\.png$/.test(page.path) ||
                      path.basename(page.path) !== expected.path || !HASH.test(page.hash))
                    throw new Error('invalid indexed map page');
                  const source = path.join(portableAssetRoot, page.path);
                  const checked = await files.copyVerified(source, path.join(stage, expected.path), page.hash, 'map-import');
                  const header = checked.header;
                  if (header.length < 24 || header.subarray(0, 8).toString('hex') !== '89504e470d0a1a0a' ||
                      header.readUInt32BE(16) !== expected.width || header.readUInt32BE(20) !== expected.height)
                    throw new Error('indexed map page header differs');
                }
                descriptor = indexed.descriptor;
                ++result.indexedCopies; outcome = 'reused-package';
              } catch (_) {
                for (const page of indexed.descriptor.pages)
                  await fsp.rm(path.join(stage, page.path), { force: true });
              }
            }
          }
          if (!reason && !descriptor) {
            const processingStarted = performance.now();
            try { ++result.nativePacks; descriptor = await native.assets.processTiles(inputs, stage); }
            catch (error) { if (error.code !== 'PMJS_TILE_UNSUPPORTED') throw error; reason = error.message; }
            finally { result.processingMs += performance.now() - processingStarted; }
          }
          if (descriptor && (!validTileDescriptor(descriptor) || descriptor.sources.length !== inputs.length)) throw new Error('invalid tile descriptor');
          const pageBytes = descriptor ? descriptor.pages.reduce((n, p) => n+p.width*p.height*4, 0) : 0;
          // Both straight and premultiplied pages are prewarmed. Retained CPU
          // geometry and four additional vertex attributes are included in admission.
          const metadataBytes = descriptor ? descriptor.sources.reduce((sum,source)=>sum+192+source.regions.length*36,256)+descriptor.pages.length*128 : 0;
          const ordinaryBytes = demand.renderer === 'mz' ? inputs.length*1024*1024*4 : descriptor?.ordinaryBytes || 0;
          const compactBytes = pageBytes*2+geometryBytes+metadataBytes;
          if (!reason && compactBytes >= ordinaryBytes) reason = 'packed allocations and geometry are not smaller';
          if (reason) {
            for (const page of descriptor?.pages || []) await fsp.rm(path.join(stage, page.path));
            descriptor = null;
          }
          const outputs = [];
          for (const page of descriptor ? descriptor.pages : []) outputs.push({ path: page.path, hash: await files.hash(path.join(stage, page.path), 'output') });
          manifest = { filename, compiler: COMPILER_VERSION, processor: native.assets.tilePreparationVersion,
            dependencies: [...sharedDependencies, ...dependencies, ...inputs].map(input => ({ source: input.logical || input.source, hash: input.hash || input.sourceHash })),
            settings: { width, height }, outcome: descriptor ? outcome : 'ordinary-choice', key, descriptor, descriptorHash: identity(descriptor), outputs,
            reason, estimates: { pageBytes, geometryBytes, metadataBytes, ordinaryBytes, compactBytes } };
          // Publish the complete result only after its outputs validate.
          files.writeManifest(stage, manifest);
          if (!await validateEntry(stage, key,files)) throw new Error('tile output validation failed');
          if (shouldCancel()) { result.cancelled = true; break; }
          await validateDependencies([...sharedDependencies, ...dependencies]);
          await fsp.rename(stage, directory); files.publishManifest(stage, directory); stage = null; ++result.generated;
        }
        await validateDependencies([...dependencies, ...inputs.map(input => sourceDependencies.get(input.source)).filter(Boolean)]);
        Object.assign(row, manifest.estimates);
        if (!manifest.descriptor) { declined = true; throw new Error(manifest.reason); }
        for (const input of inputs) input.snapshot = await captureSnapshot(input);
        if (verifyRegions) result.verifiedRegions += await native.assets.processTiles(inputs, directory, manifest.descriptor);
        const descriptor = structuredClone(manifest.descriptor);
        // Validated output hashes let native loads accept unchanged pages whose inode was renumbered.
        for (const page of descriptor.pages) page.hash = manifest.outputs.find(output => output.path === page.path).hash;
        descriptor.sources.forEach((source, i) => Object.assign(source, {
          source: inputs[i].source, snapshot: inputs[i].snapshot, sourceHash: inputs[i].sourceHash, sourceIdentity: inputs[i].sourceIdentity }));
        entries.push({ identity: key, directory, descriptor, outputs: manifest.outputs });
        result.index[mapId] = { identity: key, renderer: demand.renderer, contractHash: demand.contractHash,
          sources: inputs.map(input => input.source),
          tileWidth: demand.tileWidth, tileHeight: demand.tileHeight };
        row.selected = true; ++result.selected;
        session.outcome('map:' + filename, outcome);
        for (const page of descriptor.pages) result.pageBytes += (await fsp.stat(path.join(directory, page.path))).size;
      } catch (error) {
        row.reason = error.message; ++result.refused;
        session.outcome('map:' + filename, declined ? 'ordinary-choice' : 'ordinary-failure', error.message);
        logger.warn('[pmjs] map preparation ordinary '+filename+': '+error.message);
      } finally {
        if (stage) await fsp.rm(stage, { recursive: true, force: true });
        result.maps.push(row);
      }
      report('validate', filename, index+1, data.length);
    }
    if (!result.cancelled) {
      await validateDependencies(sharedDependencies);
      report('validate', '', data.length, data.length);
      await files.save();
      for (const entry of entries) for (const source of entry.descriptor.sources)
        source.sourceIdentity = sourceDependencies.get(source.source).sourceIdentity;
      if (!offline) {
        report('install', '', data.length, data.length);
        const installed = native.assets.installTileSets(entries, false, true);
        result.activation = installed?.accepted ? installed : { accepted: entries.slice(0, installed).map(entry => entry.identity), rejected: [] };
        result.installed = result.activation.accepted.length;
        for (const [mapId, prepared] of Object.entries(result.index))
          if (!result.activation.accepted.includes(prepared.identity)) delete result.index[mapId];
      } else result.installed = entries.length;
      if (shouldCancel()) { result.cancelled = true; throw new Error('map preparation cancelled'); }
      if (!offline) native.assets.preparedMapIndex = result.index;
      result.entries = entries;
      report('cleanup', '', data.length, data.length);
      const retainedKeys = [...keys];
      for (const snapshot of snapshots.values()) {
        const match = /^entries\/([^/]+)\//.exec(path.relative(cacheRoot, snapshot).split(path.sep).join('/'));
        if (match) retainedKeys.push(match[1]);
      }
      const reusablePreviousIndex = previousIndex === session.data.indices.maps &&
        previousCompilationsValid && previousInputsValid;
      const nextIndex = { compiler: COMPILER_VERSION, keys: retainedKeys, snapshots: [...snapshots.keys()],
        compilations, compilationsHash: identity(compilations), mapInputs, mapInputsHash: identity(mapInputs),
        recompileMapInputs: [...recompileMapInputs] };
      result.compilations = compilations;
      result.mapInputs = mapInputs;
      session.setIndex('maps', nextIndex, reusablePreviousIndex);
      await files.save();

    }
  } catch (error) {
    if (!offline) {
      native.assets.installTileSets && native.assets.installTileSets([]);
      native.assets.preparedMapIndex = {};
    }
    result.error = error.message;
    for (const row of result.maps) if (row.selected) { row.selected = false; row.reason = error.message; }
    result.refused += result.selected; result.selected = result.installed = 0; result.index = {};
    logger.warn('[pmjs] map preparation unavailable: '+error.message);
  } finally {
    result.durationMs = performance.now()-started;
  }
  return result;
}
async function prepareMaps(options) {
  const onProgress = options.onProgress || (() => {});
  const result = await require('./preparation.cjs').prepareGameAssets({
    ...options,
    portableIndex: { maps: options.portableIndex },
    images: false,
    maps: true,
    onProgress: value => {
      if (value.phase !== 'start') onProgress(value);
    }
  });
  if (result.maps) result.maps.releaseCacheLease = result.releaseCacheLease;
  return result.maps;
}

module.exports = { prepareMapsPhase, prepareMaps, validTileDescriptor, validateEntry, identity, engineContract };
