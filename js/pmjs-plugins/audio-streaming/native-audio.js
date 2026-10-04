'use strict';

(function() {
  if (typeof MvNativeWebAudio === 'undefined' || WebAudio !== MvNativeWebAudio) return;
  var prototype = WebAudio.prototype;
  var previous;
  var reviewed = {
    _load: '81b0d6d5161e713978225664945de969b65525b26d1cf5162d9f43638091b9eb',
    clear: '6c235331c0a98344be571c68d98bf38f2f11ff773edfdb72dbc5099af0af0a0c',
    isReady: 'c74ac96a12f4c5e0a5531a3f85422417f03adf2d712aee20e9a4801489f93bc6',
    isPlaying: 'fb786fad0f411038c7a4a18163e32eb217b01d81036eed6c135e43450409bfb0',
    play: '9c231ba0f41068aed148bd34af93afca488622a0042a9cbe59762841735c7ba5',
    stop: '809d2656665159e1d3d6faf0439a812df4fc9648578f08d28789313d8e661876',
    seek: '425761a8d1268e4e4f0a4437a6e2067d9ee074eff3522e84bfa91609081df404',
    pitchget: '16d7aab1a3cd264077696d31f20e72b2966faf3a1d64385cb03bc0c78dd407f1',
    pitchset: '1c07f6d983b1ea34d3a02a9ca6ea372b772ddfb37dff236eb43f1f6e351a784d'
  };
  var names = ['_load', 'clear', 'isReady', 'isPlaying', 'play', 'stop', 'seek', 'pitch'];

  function matches(fn, fingerprint) {
    if (typeof fn !== 'function' || !globalThis.__pmjsBuiltinRequire) return false;
    var source = Function.prototype.toString.call(fn)
      .replace(/^(async )?function(?:\s+[\w$]+)?\s*\(/, '$1function(');
    return globalThis.__pmjsBuiltinRequire('crypto').createHash('sha256')
      .update(source).digest('hex') === fingerprint;
  }

  PMJS.plugins.onLoading('AudioStreaming', 'pmjs.audio-streaming.native', function() {
    previous = {};
    names.forEach(function(name) {
      previous[name] = Object.getOwnPropertyDescriptor(prototype, name);
    });
  });

  PMJS.plugins.onLoaded('AudioStreaming', 'pmjs.audio-streaming.native', function() {
    if (!previous) return;
    var changed = names.filter(function(name) {
      var before = previous[name];
      var after = Object.getOwnPropertyDescriptor(prototype, name);
      return !before || !after || before.value !== after.value ||
        before.get !== after.get || before.set !== after.set;
    });
    var unknown = changed.find(function(name) {
      var descriptor = Object.getOwnPropertyDescriptor(prototype, name);
      return !descriptor || !descriptor.configurable || !previous[name] ||
        (name === 'pitch' ? !matches(descriptor.get, reviewed.pitchget) ||
          !matches(descriptor.set, reviewed.pitchset) : !matches(descriptor.value, reviewed[name]));
    });
    if (unknown) {
      PMJS.compat.hit('plugins.audio-streaming.voice', 'unrecognized ' + unknown + ' replacement');
      return;
    }
    // Restore the pre-plugin composition only for reviewed decoder overrides.
    // Routing, unchanged methods and later guest wrappers remain authored.
    changed.forEach(function(name) {
      Object.defineProperty(prototype, name, previous[name]);
    });
  });
})();
