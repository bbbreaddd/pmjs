'use strict';
const { createHash } = require('node:crypto');

// Pin independent fixture implementations without distributing guest source.
// Only the accepted fingerprints change; production recognition still runs.
function reviewedFunctionFixture(source, functions) {
  for (const [recognizer, fn] of Object.entries(functions)) {
    const body = Function.prototype.toString.call(fn)
      .replace(/^function(?:\s+[\w$]+)?\s*\(/, 'function(');
    const digest = createHash('sha256').update(body).digest('hex');
    const pattern = new RegExp('(function ' + recognizer + '\\([\\s\\S]*?)([a-f0-9]{64})');
    source = source.replace(pattern, (_, prefix) => prefix + digest);
  }
  return source;
}
module.exports = { reviewedFunctionFixture };
