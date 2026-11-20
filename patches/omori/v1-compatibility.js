;(function() {
  PMJS.omori = PMJS.omori || {};
  PMJS.omori.backports = Object.freeze(Object.assign({}, NativeHost.runtime.omoriBackports));
  var readScript = NativeHost.runtime.readGameScript;
  if (readScript) NativeHost.runtime.readGameScript = function(name) {
    var source = readScript(name);
    if (name === 'js/main.js' && source && /\bkey\s*=\s*['"][a-f0-9]{32}['"]/i.test(source) &&
        source.includes('PluginManager=class extends PluginManager')) return '{\n' + source + '\n}';
    return source;
  };
})();
