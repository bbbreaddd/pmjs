'use strict';
const fs = require('node:fs');
const path = require('node:path');

function installFilterCompiler(runtime) {
  if (!runtime.scope.PIXI?.filters || runtime.scope.PMJS?.rpgmaker?.nativeFilters) return;
  if (typeof runtime.scope.PMJS?.optimizations?.register !== 'function')
    throw new Error('Native filter compilation requires the shared optimization registry');
  const adjacent=path.join(__dirname,'js');
  const scripts=fs.existsSync(adjacent)?adjacent:path.join(__dirname,'../js');
  const source = fs.readFileSync(path.join(scripts, 'pmjs-pixi4/scene-filters.js'), 'utf8');
  const managers = fs.readFileSync(path.join(scripts, 'pmjs-pixi4/renderer-managers.js'), 'utf8');
  runtime.runScript(`(function() {
    var nativeSceneRenderer = null, nativeSceneUsePixiWorldState = true;
    var nativeIdentityTransform = { a:1,b:0,c:0,d:1,tx:0,ty:0 };
    var nativeSceneRootTransform = nativeIdentityTransform;
    var nativeSceneFilterResolution = 1, nativeSceneFilterDepth = 0;
    var nativeSpriteMaskConstructor = PIXI.SpriteMaskFilter;
    var nativeSceneColorIdentity = [1,0,0,0,0,0,1,0,0,0,0,0,1,0,0,0,0,0,1,0];
    function nativeFilterMatches(filter, ctor) { return !!filter && typeof ctor === 'function' && filter.constructor === ctor; }
    function nativeColorMatrixIsIdentity(values) {
      return !!values && values.length === 20 && nativeSceneColorIdentity.every(function(value, index) { return values[index] === value; });
    }
    function nativeTextureSource(source) {
      if (!source) return null;
      if (typeof source._pmjsNativeTextureSource === 'function') return source._pmjsNativeTextureSource();
      return source._nativeImage || source._nativeCanvas || (source._ensureNativeCanvas && source._ensureNativeCanvas());
    }
    function nativeMaskWorldTransform(sprite) { return sprite.worldTransform; }
    ${managers}
    ${source}
    PMJS.rpgmaker.nativeFilters = {
      compile: function(node, filters) {
        var previous = nativeCustomFilterPlans; nativeCustomFilterPlans = [];
        try {
          var result = nativeSceneFilter(node, filters);
          if (result.unsupported) throw new TypeError('Unsupported native filter program: ' + filters.map(function(filter) { return filter && filter.constructor.name; }).join(', '));
          var groups = result.groups || [];
          if (result.colorMatrix) groups.push({ kind:25,resource:0,parameters:Array.from(result.colorMatrix).concat(result.toneAlpha) });
          return groups;
        } finally { disposeNativeCustomFilterPlans(previous); }
      }
    };
  })()`);
}
module.exports = { installFilterCompiler };
