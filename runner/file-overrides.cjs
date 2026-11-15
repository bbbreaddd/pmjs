'use strict';

function resolveFileOverride(path, overrides, exists) {
  var slash = path.lastIndexOf('/');
  var dot = path.lastIndexOf('.');
  var extension = dot > slash + 1 ? path.slice(dot) : '';
  var directory = slash < 0 ? '.' : path.slice(0, slash).toLowerCase();
  while (directory) {
    var rules = overrides[directory];
    var override = rules && rules[extension.toLowerCase()];
    if (override !== undefined) {
      var candidate = path.slice(0, path.length - extension.length) + override;
      if (exists(candidate)) return candidate;
    }
    if (directory === '.') break;
    var parent = directory.lastIndexOf('/');
    directory = parent < 0 ? '.' : directory.slice(0, parent);
  }
  return null;
}

if (typeof module === 'object' && module.exports) {
  module.exports = { resolveFileOverride };
}
