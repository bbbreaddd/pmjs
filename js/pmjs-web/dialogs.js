(function installBrowserDialogs() {
  if (typeof NativeHost === 'undefined' || !NativeHost.dialog ||
      typeof NativeHost.runtime === 'undefined' ||
      typeof NativeHost.runtime.env !== 'function') {
    return;
  }

  var nativeString = String;
  var nativeTypeError = TypeError;
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

  function noteDialogHit(capability, message) {
    PMJS.compat.observed(capability, message.slice(0, 160));
  }

  try {
    var candidates = [];
    if (PMJS.config.fonts && PMJS.config.fonts.GameFont) {
      candidates.push(String(PMJS.config.fonts.GameFont));
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

  function domString(value) {
    if (typeof value === 'symbol') throw new nativeTypeError('Cannot convert a Symbol value to a string');
    return nativeString(value);
  }

  function observe(capability, message) {
    noteDialogHit(capability, message);
    if (mode === 'strict') throw new Error('unsupported native capability: ' + capability);
  }

  function checkReceiver(receiver) {
    if (receiver !== globalThis) throw new nativeTypeError('Illegal invocation');
  }

  var dialogs = { alert() {
    checkReceiver(this);
    var message = arguments.length ? domString(arguments[0]) : '';
    observe('browser.dialog.alert', message);
    if (mode !== 'headless') NativeHost.dialog.alert(message);
  }, confirm() {
    checkReceiver(this);
    var message = arguments[0] === undefined ? '' : domString(arguments[0]);
    observe('browser.dialog.confirm', message);
    return mode === 'headless' ? headlessAnswers.confirm : !!NativeHost.dialog.confirm(message);
  }, prompt() {
    checkReceiver(this);
    var message = arguments[0] === undefined ? '' : domString(arguments[0]);
    var defaultValue = arguments[1] === undefined ? '' : domString(arguments[1]);
    observe('browser.dialog.prompt', message);
    if (mode === 'headless') {
      return headlessAnswers.prompt == null ? null : String(headlessAnswers.prompt);
    }
    return NativeHost.dialog.prompt(message, defaultValue);
  } };
  globalThis.alert = dialogs.alert;
  globalThis.confirm = dialogs.confirm;
  globalThis.prompt = dialogs.prompt;
})();
