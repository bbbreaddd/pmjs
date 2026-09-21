(function installBrowserDialogs() {
  if (typeof NativeHost === 'undefined' || !NativeHost.dialog ||
      typeof NativeHost.runtime === 'undefined' ||
      typeof NativeHost.runtime.env !== 'function') {
    return;
  }

  var mode = 'interactive';
  try {
    var configured = NativeHost.runtime.env('PMJS_DIALOG_MODE');
    if (configured === 'strict' || configured === 'headless') mode = configured;
  } catch (_) {}

  var headlessAnswers = { confirm: false, prompt: null };
  if (mode === 'headless') {
    try {
      var parsed = JSON.parse(NativeHost.runtime.env('PMJS_DIALOG_HEADLESS') || '{}');
      if (parsed && typeof parsed === 'object') {
        if (typeof parsed.confirm !== 'undefined') {
          headlessAnswers.confirm = !!parsed.confirm;
        }
        if (typeof parsed.prompt !== 'undefined') headlessAnswers.prompt = parsed.prompt;
      }
    } catch (_) {}
  }

  var dialogHits = Object.create(null);
  var dialogVerbose = false;
  try {
    dialogVerbose = NativeHost.runtime.env('PMJS_COMPAT_VERBOSE') === '1';
  } catch (_) {}
  // Same [pmjs-compat] records the report merges, without routing through
  // the throwing strict-compat counter.
  var compatObserved = (typeof nativeCompatibilityObserved === 'function') ?
    nativeCompatibilityObserved : null;
  function noteDialogHit(capability, message) {
    var detail = String(message).slice(0, 160);
    if (compatObserved) {
      try {
        compatObserved(capability, detail);
      } catch (_) {}
      return;
    }
    var count = (dialogHits[capability] || 0) + 1;
    dialogHits[capability] = count;
    if (count === 1 && dialogVerbose) {
      console.log('[pmjs-compat] ' + JSON.stringify({
        capability: capability,
        detail: detail
      }));
    }
  }

  try {
    var candidates = [];
    if (typeof pmjsGameConfig !== 'undefined' && pmjsGameConfig &&
        pmjsGameConfig.fonts && pmjsGameConfig.fonts.GameFont) {
      candidates.push(String(pmjsGameConfig.fonts.GameFont));
    }
    if (globalThis.PMJS && PMJS.fonts && typeof PMJS.fonts.resolveDescriptor === 'function') {
      var resolvedGameFont = PMJS.fonts.resolveDescriptor('16px GameFont');
      if (resolvedGameFont && resolvedGameFont.faces && resolvedGameFont.faces[0] &&
          resolvedGameFont.faces[0].path) {
        candidates.push(resolvedGameFont.faces[0].path);
      }
    }
    candidates.push('fonts/mplus-1m-regular.ttf', 'fonts/mplus-1mn-regular.ttf',
      'fonts/gamefont.ttf');
    for (var i = 0; i < candidates.length; i++) {
      if (NativeHost.fs && NativeHost.fs.exists(candidates[i]) &&
          !NativeHost.fs.isDirectory(candidates[i])) {
        NativeHost.dialog.setFont(candidates[i]);
        break;
      }
    }
  } catch (_) {}

  function strictDialog(capability) {
    return function(message) {
      noteDialogHit(capability, message);
      throw new Error('unsupported native capability: ' + capability);
    };
  }

  function dialogMessage(value) {
    return value === undefined ? '' : String(value);
  }

  if (mode === 'strict') {
    globalThis.alert = strictDialog('browser.dialog.alert');
    globalThis.confirm = strictDialog('browser.dialog.confirm');
    globalThis.prompt = strictDialog('browser.dialog.prompt');
    return;
  }

  if (mode === 'headless') {
    globalThis.alert = function(message) {
      noteDialogHit('browser.dialog.alert', message);
    };
    globalThis.confirm = function(message) {
      noteDialogHit('browser.dialog.confirm', message);
      return headlessAnswers.confirm;
    };
    globalThis.prompt = function(message, defaultValue) {
      noteDialogHit('browser.dialog.prompt', message);
      return (typeof headlessAnswers.prompt === 'undefined' ||
        headlessAnswers.prompt === null) ? null :
        String(headlessAnswers.prompt);
    };
    return;
  }

  globalThis.alert = function(message) {
    noteDialogHit('browser.dialog.alert', message);
    NativeHost.dialog.alert(dialogMessage(message));
  };
  globalThis.confirm = function(message) {
    noteDialogHit('browser.dialog.confirm', message);
    return !!NativeHost.dialog.confirm(dialogMessage(message));
  };
})();
