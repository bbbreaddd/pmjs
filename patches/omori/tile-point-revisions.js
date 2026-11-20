'use strict';

(function() {
  var id = 'omori.tile-point-revisions';
  PMJS.optimizations.register({ id: id, owner: 'pmjs-omori',
    fallback: 'compare live tile coordinates with the retained geometry snapshot' });
  PMJS.phases.on('afterGuestPlugins', id, function() {
    if (!PMJS.optimizations.isEnabled(id)) return;
    var Constructor = PIXI.tilemap && PIXI.tilemap.RectTileLayer;
    var prototype = Constructor && Constructor.prototype;
    var retained = PMJS.yedRetainedTiles;
    if (!prototype || !retained || !PMJS.methods.matchesSource(prototype.addRect,
        '2e5c59a3b525c587fe540426e9440684f8d364f56be4064549958e4825196c99') ||
        !PMJS.methods.matchesSource(prototype.clear,
        '1860d063bad8a58e030acf6a8915935e4ad02cade3ed624f057a1553be3ee614') ||
        !PMJS.methods.matchesSource(retained.flushAnimation,
        'dc59a01520e2211a3b0368eb331beed16c155524927a23e060ab4e374969914a')) {
      PMJS.optimizations.refuse(id, 'unrecognized tile writers');
      return;
    }
    var digest, modSources;
    try {
      var hash = __pmjsBuiltinRequire('node:crypto').createHash('sha256');
      var Buffer = __pmjsBuiltinRequire('node:buffer').Buffer;
      modSources = PMJS.omori && PMJS.omori.modSourceIdentity ? PMJS.omori.modSourceIdentity() : null;
      function readSource(file) {
        return Buffer.from(readGameBytes(file)).toString('utf8').replace(/\r\n/g, '\n');
      }
      hash.update(readSource('js/plugins.js'));
      $plugins.forEach(function(plugin) {
        if (!plugin.status) return;
        hash.update((modSources && modSources.pluginNames[plugin.name] || plugin.name) + '\0');
        hash.update(readSource('js/plugins/' + plugin.name + '.js'));
      });
      hash.update(readSource('js/libs/pixi-tilemap.js'));
      if (modSources) hash.update('\0modloader\0' + modSources.digest);
      digest = hash.digest('hex');
    } catch (_) {
      PMJS.optimizations.refuse(id, 'tile source identity unavailable');
      return;
    }
    if (![
      'ebc98404226f51c05b0345fbcbaa0074ca5199fda1912aa0d022708b005e0317',
      'b2d4ded21ef340df9c7f4ccc802134bab0dd297c1be392957a6a4f24ef53b300',
      '2bc535afc6a46e94647d822258fbefa0ad83171805bb1742f6405f49b236f7ff',
      'fa139f3943f5857b7e194c4bba3081cd2c9a3ecb46da60be96d501cc3a170f2f'
    ].includes(digest)) {
      PMJS.optimizations.refuse(id, 'tile source identity changed', { digest: digest });
      return;
    }
    var animationWriter = retained.flushAnimation;
    var addRect = prototype.addRect;
    var clear = prototype.clear;
    var records = new WeakMap();
    var refused = new WeakSet();
    function addTrackedRect() {
      if (!records.has(this)) records.set(this, this.pointsBuf);
      try { return addRect.apply(this, arguments); }
      finally { this._pmjsNativeGeneration = (this._pmjsNativeGeneration || 0) + 1; }
    }
    prototype.addRect = addTrackedRect;
    PMJS.pixi4.tilePointRevision = function(layer, points) {
      if (modSources && !modSources.valid) {
        PMJS.optimizations.reportFallback(id, 'mod execution hooks changed');
        return -1;
      }
      if (refused.has(layer) || Object.getPrototypeOf(layer) !== prototype ||
          layer.addRect !== addTrackedRect || layer.clear !== clear ||
          PMJS.yedRetainedTiles !== retained || retained.flushAnimation !== animationWriter) return -1;
      var previous = records.get(layer);
      if (previous && previous !== points) {
        refused.add(layer);
        records.delete(layer);
        return -1;
      }
      if (!previous) return -1;
      var generation = layer._pmjsNativeGeneration || 0;
      return Number.isSafeInteger(generation) && generation >= 0 ? generation : -1;
    };
  });
})();
