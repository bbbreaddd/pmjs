'use strict';

(function() {
  var objectUrls = new Map();
  var nextObjectUrl = 1;
  var nativeUrl = globalThis.URL;

  function createObjectURL(blob) {
    if (typeof Blob !== 'undefined' && !(blob instanceof Blob)) {
      throw new TypeError('URL.createObjectURL requires a Blob');
    }
    var url = 'blob:pmjs/' + nextObjectUrl++;
    objectUrls.set(url, blob);
    return url;
  }

  function revokeObjectURL(url) {
    objectUrls.delete(String(url));
  }

  function resolveObjectURL(url) {
    return objectUrls.get(String(url)) || null;
  }

  function isObjectURL(url) {
    return String(url).indexOf('blob:pmjs/') === 0;
  }

  if (typeof nativeUrl === 'function') {
    nativeUrl.createObjectURL = createObjectURL;
    nativeUrl.revokeObjectURL = revokeObjectURL;
  } else {
    globalThis.URL = {
      createObjectURL: createObjectURL,
      revokeObjectURL: revokeObjectURL
    };
  }
  globalThis.pmjsIsObjectURL = isObjectURL;
  globalThis.pmjsResolveObjectURL = resolveObjectURL;
})();
