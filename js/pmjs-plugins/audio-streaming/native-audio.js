'use strict';

(function() {
  if (typeof MvNativeWebAudio === 'undefined' || WebAudio !== MvNativeWebAudio) return;
  var prototype = WebAudio.prototype;
  var previous;
  var reviewed = {
    _load: '99caa79635f7f1830a6f06fe6fc5712171b3eb56ef4ed077888e7abdab1baf00',
    clear: '5f9c2ffa904accbc2edb93d7c943987068671bfd35d1fce73c19ea1e4041f586',
    isReady: 'fe331eec666b44fee2b33bf98a959771c79f816720e36390c11a73deaff58783',
    isPlaying: 'f4dd10eaf5b7405b99a5243511942c4e63afe26441634dfe68008128e2bd547e',
    play: '8a61f7ce64f08e5c0c882dbc0a1b063a6d4704ba205d12465b7f45217280b93b',
    stop: '4a932495a6f294248354cc911e5f3d4544eea7e6307f78cdcfd1b69d3306fd62',
    seek: 'cffcb54ee51cc1ae153f2bbe43ba8e201f9660b95a33f69b704558b7d5ab89d5',
    pitch: {
      get: ['16d7aab1a3cd264077696d31f20e72b2966faf3a1d64385cb03bc0c78dd407f1',
        'f8e7df6e24a17f0ff08a6100d4991d110303cb52901b8dc97a2d80ba2ba87ae1'],
      set: ['1c07f6d983b1ea34d3a02a9ca6ea372b772ddfb37dff236eb43f1f6e351a784d',
        'a9e97372e64ea61761d42c13c14d48f2b0c3f0ed7ba0f8bba1389fa4f3e61088']
    },
    _onLoad: '4280c09dfd91dd2fc5f8b683772644bcf6c61d761fef31c7417c7580d841dbe6'
  };
  var names = Object.keys(reviewed);

  // Only this reviewed decoder script can request a helper before its method
  // replacements are installed. Delay that helper until native ownership is proved.
  var deferredHelpers = [];
  PMJS.plugins.onLoading('AudioStreaming', 'pmjs.audio-streaming.native', function() {
    previous = {};
    names.forEach(function(name) {
      previous[name] = Object.getOwnPropertyDescriptor(prototype, name);
    });
    if (!NativeHost.fs || !globalThis.__pmjsBuiltinRequire || typeof PluginManager === 'undefined') return;
    var source = NativeHost.fs.readText('js/plugins/AudioStreaming.js');
    if (!source || !PMJS.methods.matchesText(source, 'f921703e4d5f8c96f94bbf26af9bdc21d761987d3b39e0e7b71a461b29d5385b')) return;
    return PMJS.plugins.interceptLoad('stbvorbis_stream', 'pmjs.audio-streaming.native', function() {
      deferredHelpers.push('stbvorbis_stream.js');
    });
  });

  PMJS.plugins.onLoaded('AudioStreaming', 'pmjs.audio-streaming.native', function() {
    if (!previous) return;
    var changed = names.map(function(name) {
      return { name: name, before: previous[name], after: Object.getOwnPropertyDescriptor(prototype, name) };
    }).filter(function(entry) {
      var before = entry.before, after = entry.after;
      return !before || !after || before.value !== after.value ||
        before.get !== after.get || before.set !== after.set;
    });
    var unknown = changed.find(function(entry) {
      var descriptor = entry.after, expected = reviewed[entry.name];
      return !descriptor || !descriptor.configurable || !entry.before ||
        (entry.name === 'pitch' ? !PMJS.methods.matchesSource(descriptor.get, expected.get) ||
          !PMJS.methods.matchesSource(descriptor.set, expected.set) :
          !PMJS.methods.matchesSource(descriptor.value, expected));
    });
    if (unknown) {
      PMJS.compat.hit('plugins.audio-streaming.voice', 'unrecognized ' + unknown.name + ' replacement');
      deferredHelpers.splice(0).forEach(function(name) { PluginManager.loadScript(name); });
      return;
    }
    deferredHelpers.length = 0;
    // Restore the pre-plugin composition only for reviewed decoder overrides.
    // Routing, unchanged methods and later guest wrappers remain authored.
    changed.forEach(function(entry) {
      Object.defineProperty(prototype, entry.name, entry.before);
    });
  });
})();
