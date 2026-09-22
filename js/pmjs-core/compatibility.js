(function() {
var nativeCompatibilityHits = Object.create(null);
var renderCompatibilityHits = 0;
var nativeCompatibilityStrict =
  NativeHost.runtime.env('PMJS_STRICT_COMPAT') === '1';
var nativeCompatibilityVerbose =
  NativeHost.runtime.env('PMJS_COMPAT_VERBOSE') === '1';
function nativeCompatibilityHit(capability, detail) {
  var count = (nativeCompatibilityHits[capability] || 0) + 1;
  nativeCompatibilityHits[capability] = count;
  if (capability.indexOf('render.') === 0) renderCompatibilityHits++;
  if (count === 1) {
    var message = '[pmjs-compat] ' + capability + (detail ? ': ' + String(detail) : '');
    if (typeof console !== 'undefined' && console.warn) {
      console.warn(message);
      if (nativeCompatibilityVerbose) {
        console.warn(new Error().stack || '');
      }
    } else if (typeof console !== 'undefined' && console.log) {
      console.log(message);
      if (nativeCompatibilityVerbose) {
        console.log(new Error().stack || '');
      }
    }
  }
  if (nativeCompatibilityStrict) {
    throw new Error('unsupported native capability: ' + capability +
      (detail ? ': ' + String(detail) : ''));
  }
}

function nativeCompatibilityObserved(capability, detail) {
  var count = (nativeCompatibilityHits[capability] || 0) + 1;
  nativeCompatibilityHits[capability] = count;
  if (capability.indexOf('render.') === 0) renderCompatibilityHits++;
  if (count !== 1) return;
  var event = {
    capability: capability,
    detail: detail || '',
    frame: typeof Graphics === 'function' ? Graphics.frameCount : 0
  };
  console.log('[pmjs-compat] ' + JSON.stringify(event));
}

PMJS.compat = {
  hit: nativeCompatibilityHit,
  audit: nativeCompatibilityStrict || nativeCompatibilityVerbose,
  observed: nativeCompatibilityObserved,
  count: function(prefix) {
    if (prefix === 'render.') return renderCompatibilityHits;
    var total = 0;
    for (var capability in nativeCompatibilityHits) {
      if (!prefix || capability.indexOf(prefix) === 0) {
        total += nativeCompatibilityHits[capability];
      }
    }
    return total;
  },
  dump: function() { return Object.assign({}, nativeCompatibilityHits); }
};
})();
