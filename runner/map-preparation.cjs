'use strict';

const fs = require('node:fs');
const fsp = fs.promises;
const path = require('node:path');
const crypto = require('node:crypto');
const vm = require('node:vm');
const { performance } = require('node:perf_hooks');
const { acquireLock, createLease, retainLeases } = require('./asset-preparation.cjs');
const { preparationFiles } = require('./preparation-files.cjs');
const { COMPILER_VERSION, mapContract, geometryEstimate, engineTilemap, compileRpgMap, compileTiledMap } = require('./map-demand.cjs');
const hash = bytes => crypto.createHash('sha256').update(bytes).digest('hex');
const identity = object => hash(JSON.stringify(object));
const digest = async file => hash(await fsp.readFile(file));
const HASH = /^[a-f0-9]{64}$/;
async function readJson(file) { return JSON.parse(await fsp.readFile(file, 'utf8')); }
async function publishJson(file, value) {
  const handle = await fsp.open(file, 'wx');
  try { await handle.writeFile(JSON.stringify(value)+'\n'); await handle.sync(); }
  finally { await handle.close(); }
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
  const file = path.join(directory, 'manifest.json');
  async function validate(manifest, reused) {
    if (manifest.key !== key || manifest.compiler !== COMPILER_VERSION ||
        manifest.descriptorHash !== identity(manifest.descriptor) ||
        (manifest.descriptor && !validTileDescriptor(manifest.descriptor)) ||
        !Array.isArray(manifest.outputs)) return false;
    if (manifest.outputs.length !== (manifest.descriptor ? manifest.descriptor.pages.length : 0)) return false;
    for (const page of manifest.outputs) {
      if (!/^tiles-\d+\.png$/.test(page.path) || !HASH.test(page.hash)) return false;
      const file = path.join(directory, page.path);
      const checked = files ? await files.inspect(file) : { hash: await digest(file), reused: false };
      if (checked.hash !== page.hash) return false;
      if (reused && checked.reused) continue;
      const bytes = await fsp.readFile(path.join(directory, page.path));
      const expected = manifest.descriptor.pages.find(p => p.path === page.path);
      if (!expected || bytes.length < 24 || bytes.subarray(0, 8).toString('hex') !== '89504e470d0a1a0a' ||
          bytes.readUInt32BE(16) !== expected.width || bytes.readUInt32BE(20) !== expected.height) return false;
    }
    return true;
  }
  try {
    if (files) return await files.validatedJson(file, validate);
    const manifest = await readJson(file);
    return await validate(manifest, false) ? manifest : null;
  } catch (_) { return null; }
}

function gameInputs(native) {
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
    return { bytes, dependency: { logical, file, sourceIdentity: capturedIdentity, hash: hash(bytes) } };
  }
  return { read, exists: logical => native.fs.exists(logical),
    directory: logical => native.fs.readDirectory(logical) || [] };
}
async function engineContract(game, mz) {
  const engine = game.read('js/'+(mz ? 'rmmz_core.js' : 'rpg_core.js'));
  const source = engine.bytes.toString('utf8'), dependencies = [engine.dependency];
  const context = { $plugins: [] }; vm.createContext(context);
  const manifest = game.exists('js/plugins.js') ? game.read('js/plugins.js') : null;
  const manifestSource = manifest ? manifest.bytes.toString('utf8') : 'var $plugins=[];';
  if (manifest) dependencies.push(manifest.dependency);
  vm.runInContext(manifestSource, context, { timeout: 1000 });
  const plugins = [];
  for (const plugin of context.$plugins) if (plugin.status) {
    const source = game.read('js/plugins/'+plugin.name+'.js');
    dependencies.push(source.dependency);
    plugins.push({ name: plugin.name, parameters: plugin.parameters, hash: source.dependency.hash });
  }
  return { Tilemap: engineTilemap(source, mz), dependencies, identity: { engine: hash(source), plugins } };
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
async function prepareMaps({ gameRoot, cacheRoot, native, width = 816, height = 624,
  shouldCancel = () => false, onProgress = () => {}, logger = console, verifyRegions = false, verifyHashes = false }) {
  const started = performance.now(), root = path.join(cacheRoot, 'maps');
  const result = { enabled: true, selected: 0, refused: 0, generated: 0, hits: 0, negativeHits: 0,
    installed: 0, compilationHits: 0, verifiedRegions: 0, identityRefreshes: 0, snapshotBytes: 0, additionalSnapshotBytes: 0, pageBytes: 0, durationMs: 0, cancelled: false, maps: [], index: {} };
  let release;
  let files;
  const digest = file => files.hash(file);
  const entries = [], keys = [], snapshots = new Map(), sourceDependencies = new Map();
  async function captureSnapshot(input) {
    let snapshot = snapshots.get(input.sourceHash);
    if (snapshot) return snapshot;
    // Existing decrypted cache files already provide leased, immutable bytes.
    if (path.resolve(input.file).startsWith(path.resolve(cacheRoot, 'entries')+path.sep)) snapshot = input.file;
    else {
      snapshot = path.join(root, 'sources', input.sourceHash+'.png');
      if (await digest(snapshot).catch(() => null) !== input.sourceHash) {
        const temporary = snapshot+'.stage-'+process.pid;
        try {
          await fsp.copyFile(input.file, temporary);
          if (await digest(temporary) !== input.sourceHash) throw new Error('source snapshot changed while copying');
          await fsp.rename(temporary, snapshot);
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
    if (!native.assets || typeof native.assets.processTiles !== 'function' || typeof native.assets.installTileSets !== 'function')
      throw new Error('tile preparation unavailable in this addon');
    const game = gameInputs(native), mz = game.exists('js/rmmz_core.js');
    const systemInput = game.read('data/System.json'), sheetsInput = game.read('data/Tilesets.json');
    const system = JSON.parse(systemInput.bytes), sheets = JSON.parse(sheetsInput.bytes);
    const contract = await engineContract(game, mz);
    const sharedDependencies = [...contract.dependencies, systemInput.dependency, sheetsInput.dependency];
    const data = game.directory('data').filter(file => /^Map\d+\.json$/i.test(file)).sort();
    async function validateDependencies(dependencies) {
      for (const dependency of dependencies) {
        const before = dependency.logical && native.assets.sourceIdentity(dependency.logical);
        if (dependency.logical && native.assets.sourcePath(dependency.logical) !== dependency.file ||
            await digest(dependency.file) !== dependency.hash)
          throw new Error('map dependency changed during preparation: '+(dependency.logical || dependency.file));
        if (dependency.logical) {
          const current = native.assets.sourceIdentity(dependency.logical);
          if (!current || before !== current) throw new Error('map dependency changed while validating: '+dependency.logical);
          // Link-count changes alter stat identity without changing captured content.
          if (current !== dependency.sourceIdentity) { dependency.sourceIdentity=current; ++result.identityRefreshes; }
        }
      }
    }
    await fsp.mkdir(path.join(root, 'entries'), { recursive: true });
    await fsp.mkdir(path.join(root, 'sources'), { recursive: true });
    release = await acquireLock(root, shouldCancel, () => report('wait', '', 0, data.length));
    if (!release) { result.cancelled = true; return result; }
    files = await preparationFiles(root, verifyHashes);
    result.validation = files.stats;
    const indexFile = path.join(root, 'index-'+identity({ title: system.gameTitle || '',
      engine: mz ? 'mz' : 'mv', plugins: contract.identity.plugins.map(plugin => plugin.name) })+'.json');
    const previousIndex = await readJson(indexFile).catch(() => null);
    const previousCompilations = previousIndex?.compilations &&
      previousIndex.compilationsHash === identity(previousIndex.compilations) ? previousIndex.compilations : {};
    const previousInputs = previousIndex?.mapInputs &&
      previousIndex.mapInputsHash === identity(previousIndex.mapInputs) ? previousIndex.mapInputs : {};
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
      let stage, row = { mapId, filename, selected: false };
      try {
        const tiledFile = 'maps/Map'+mapId+'.json';
        const tiled = game.exists(tiledFile), cachedInputs = previousInputs[filename];
        let dependencies, demand, compile, visualContract;
        const compilationKey = inputs => identity({ compiler: COMPILER_VERSION, processor: native.assets.tilePreparationVersion,
          compilation: true, dependencies: [...sharedDependencies,...inputs].map(input=>input.hash), width, height });
        if (cachedInputs && cachedInputs.tiled === tiled) {
          dependencies = await unchangedDependencies(cachedInputs).catch(() => null);
          if (dependencies) {
            const cached = previousCompilations[compilationKey(dependencies)];
            if (cached && cachedInputs.contract) {
              let visual = cachedInputs.contract;
              if (cached.renderer !== 'tiled') {
                const { tileWidth, tileHeight, ...map } = visual;
                const tileset = sheets[map.tilesetId];
                visual = { ...map, tilesetNames: tileset.tilesetNames,
                  flags: tileset.flags, tileWidth, tileHeight };
              }
              const { renderer, ...prepared } = cached;
              delete prepared.contract;
              demand = { renderer, contract: visual, ...prepared };
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
        if (refusal) { keys.push(refusalKey); ++result.hits; ++result.negativeHits; throw new Error(refusal.reason); }
        try {
          const cached = previousCompilations[refusalKey];
          if (demand) ++result.compilationHits;
          else if (cached) {
            const { renderer, ...prepared } = cached;
            delete prepared.contract;
            demand = { renderer, contract: visualContract(), ...prepared };
            ++result.compilationHits;
          } else demand = compile();
          if (!demand.sources.length) throw new Error('no compact tile demand');
        } catch (error) {
          keys.push(refusalKey);
          stage = await fsp.mkdtemp(path.join(root,'entries','.stage-'));
          await publishJson(path.join(stage,'manifest.json'), { compiler: COMPILER_VERSION, key: refusalKey,
            descriptor: null, descriptorHash: identity(null), outputs: [], reason: error.message });
          await validateDependencies(dependencies);
          if (shouldCancel()) { result.cancelled=true; break; }
          await fsp.rm(refusalDirectory,{recursive:true,force:true});
          await fsp.rename(stage,refusalDirectory); stage=null; ++result.generated;
          throw error;
        }
        const prepared = { ...demand }, visual = { ...demand.contract };
        delete prepared.contract;
        compilations[refusalKey] = prepared;
        if (demand.renderer !== 'tiled') { delete visual.tilesetNames; delete visual.flags; }
        mapInputs[filename] = { tiled, dependencies, contract: visual };
        row.renderer = demand.renderer;
        row.features = demand.features;
        let inputs = [];
        for (const input of demand.sources) {
          const file = native.assets.sourcePath(input.source);
          if (!file) { inputs.push({ ...input, file: null, sourceHash: null }); continue; }
          const sourceIdentity = native.assets.sourceIdentity(input.source);
          let dependency = sourceDependencies.get(input.source);
          if (!dependency || dependency.sourceIdentity !== sourceIdentity || dependency.file !== file) {
            dependency = { logical: input.source, file, sourceIdentity, hash: await digest(file) };
            sourceDependencies.set(input.source, dependency);
          }
          const sourceHash = dependency.hash;
          if (native.assets.sourceIdentity(input.source) !== sourceIdentity) throw new Error('tile source changed while hashing');
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
        const key = identity({ compiler: COMPILER_VERSION, processor: native.assets.tilePreparationVersion,
          demand, dependencies: dependencies.map(dependency => dependency.hash), contract: contract.identity, width, height, sources: inputs.map(({ source, sourceHash }) => ({ source, sourceHash })) });
        keys.push(key);
        const directory = path.join(root, 'entries', key);
        let manifest = await validateEntry(directory, key,files);
        if (manifest) { ++result.hits; if (!manifest.descriptor) ++result.negativeHits; }
        else {
          report('pack', filename, index, data.length);
          stage = await fsp.mkdtemp(path.join(root, 'entries', '.stage-'));
          let descriptor, reason;
          const missing = inputs.filter(input => !input.file);
          if (missing.length) reason = 'missing tile source '+missing.map(input => input.source).join(', ');
          else if (inputs.every(input => !input.rectangles.length)) reason = 'no visual tile demand';
          else try { descriptor = await native.assets.processTiles(inputs, stage); }
          catch (error) { if (error.code !== 'PMJS_TILE_UNSUPPORTED') throw error; reason = error.message; }
          if (descriptor && (!validTileDescriptor(descriptor) || descriptor.sources.length !== inputs.length)) throw new Error('invalid tile descriptor');
          const pageBytes = descriptor ? descriptor.pages.reduce((n, p) => n+p.width*p.height*4, 0) : 0;
          // Both straight and premultiplied pages are prewarmed. Retained CPU
          // geometry and four additional vertex attributes are included in admission.
          const geometryBytes = geometryEstimate(demand, width, height);
          const metadataBytes = descriptor ? descriptor.sources.reduce((sum,source)=>sum+192+source.regions.length*36,256)+descriptor.pages.length*128 : 0;
          const ordinaryBytes = demand.renderer === 'mz' ? inputs.length*1024*1024*4 : descriptor?.ordinaryBytes || 0;
          const compactBytes = pageBytes*2+geometryBytes+metadataBytes;
          if (!reason && compactBytes >= ordinaryBytes) reason = 'packed allocations and geometry are not smaller';
          if (reason) {
            for (const page of descriptor?.pages || []) await fsp.rm(path.join(stage, page.path));
            descriptor = null;
          }
          const outputs = [];
          for (const page of descriptor ? descriptor.pages : []) outputs.push({ path: page.path, hash: await digest(path.join(stage, page.path)) });
          manifest = { compiler: COMPILER_VERSION, key, descriptor, descriptorHash: identity(descriptor), outputs,
            reason, estimates: { pageBytes, geometryBytes, metadataBytes, ordinaryBytes, compactBytes } };
          await publishJson(path.join(stage, 'manifest.json'), manifest);
          if (!await validateEntry(stage, key,files)) throw new Error('tile output validation failed');
          if (shouldCancel()) { result.cancelled = true; break; }
          await validateDependencies(dependencies);
          await fsp.rm(directory, { recursive: true, force: true });
          await fsp.rename(stage, directory); stage = null; ++result.generated;
          for (const page of outputs) await digest(path.join(directory, page.path));
          if (!await validateEntry(directory, key,files)) throw new Error('published tile output validation failed');
        }
        await validateDependencies(dependencies);
        Object.assign(row, manifest.estimates);
        if (!manifest.descriptor) throw new Error(manifest.reason);
        for (const input of inputs) input.snapshot = await captureSnapshot(input);
        if (verifyRegions) result.verifiedRegions += await native.assets.processTiles(inputs, directory, manifest.descriptor);
        const descriptor = structuredClone(manifest.descriptor);
        descriptor.sources.forEach((source, i) => Object.assign(source, {
          source: inputs[i].source, snapshot: inputs[i].snapshot, sourceHash: inputs[i].sourceHash, sourceIdentity: inputs[i].sourceIdentity }));
        entries.push({ identity: key, directory, descriptor });
        result.index[mapId] = { identity: key, renderer: demand.renderer, contractHash: identity(demand.contract),
          animationPhases: demand.animationPhases, sources: inputs.map(input => input.source),
          tileWidth: demand.tileWidth, tileHeight: demand.tileHeight };
        row.selected = true; ++result.selected;
        for (const page of descriptor.pages) result.pageBytes += (await fsp.stat(path.join(directory, page.path))).size;
      } catch (error) {
        row.reason = error.message; ++result.refused;
        logger.warn('[pmjs] map preparation ordinary '+filename+': '+error.message);
      } finally {
        if (stage) await fsp.rm(stage, { recursive: true, force: true });
        result.maps.push(row);
      }
      report('validate', filename, index+1, data.length);
    }
    if (!result.cancelled) {
      await validateDependencies([...sharedDependencies, ...sourceDependencies.values()]);
      await files.save();
      for (const entry of entries) for (const source of entry.descriptor.sources)
        source.sourceIdentity = sourceDependencies.get(source.source).sourceIdentity;
      result.releaseCacheLease = await createLease(root, [...keys, ...snapshots.keys()], native);
      result.installed = native.assets.installTileSets(entries);
      if (result.installed !== entries.length) throw new Error('some tile sets were not installed');
      native.assets.preparedMapIndex = result.index;
      const nextIndex = { keys, snapshots: [...snapshots.keys()],
        compilations, compilationsHash: identity(compilations), mapInputs, mapInputsHash: identity(mapInputs) };
      if (previousCompilations !== previousIndex?.compilations || previousInputs !== previousIndex?.mapInputs ||
          previousIndex?.compilationsHash !== nextIndex.compilationsHash ||
          previousIndex?.mapInputsHash !== nextIndex.mapInputsHash ||
          identity(previousIndex.keys || []) !== identity(keys) || identity(previousIndex.snapshots || []) !== identity(nextIndex.snapshots)) {
        const stagedIndex = indexFile+'.stage-'+process.pid;
        await fsp.rm(stagedIndex, { force: true });
        await publishJson(stagedIndex, nextIndex);
        await fsp.rename(stagedIndex, indexFile);
      }
      const retained = new Set([...keys, ...snapshots.keys()]);
      for (const file of await fsp.readdir(root)) if (/^index-[a-f0-9]{64}\.json$/.test(file) && file !== path.basename(indexFile)) {
        const index = await readJson(path.join(root, file)).catch(() => null);
        for (const key of [...index && index.keys || [], ...index && index.snapshots || []]) if (HASH.test(key)) retained.add(key);
      }
      await retainLeases(root, retained);
      for (const file of await fsp.readdir(path.join(root, 'entries'))) if (file.startsWith('.stage-') || HASH.test(file) && !retained.has(file))
        await fsp.rm(path.join(root, 'entries', file), { recursive: true, force: true });
      for (const file of await fsp.readdir(path.join(root, 'sources'))) if (/^[a-f0-9]{64}\.png$/.test(file) && !retained.has(file.slice(0,-4)))
        await fsp.rm(path.join(root, 'sources', file), { force: true });

    }
  } catch (error) {
    result.error = error.message;
    for (const row of result.maps) if (row.selected) { row.selected = false; row.reason = error.message; }
    result.refused += result.selected; result.selected = result.installed = 0; result.index = {};
    logger.warn('[pmjs] map preparation unavailable: '+error.message);
    native.assets.installTileSets && native.assets.installTileSets([]);
    native.assets.preparedMapIndex = {};
  } finally {
    if (release) await release();
    result.durationMs = performance.now()-started;
  }
  return result;
}
module.exports = { prepareMaps, validTileDescriptor, validateEntry, identity };
