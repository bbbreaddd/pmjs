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

function pinBodyFingerprint(source, variable, fn, compact = false) {
  const text = Function.prototype.toString.call(fn);
  let body = text.slice(text.indexOf('{') + 1, text.lastIndexOf('}'));
  body = compact ? body.replace(/\s+/g, '') : body
    .replace(/\/\*[\s\S]*?\*\//g, ' ')
    .replace(/(^|[^:'"\\])\/\/[^\n]*/g, '$1 ')
    .replace(/\s+/g, ' ').trim();
  const digest = createHash('sha256').update(body).digest('hex');
  const pattern = new RegExp('(var ' + variable + " = ')[a-f0-9]{64}(')");
  if (!pattern.test(source)) throw new Error('Missing fingerprint: ' + variable);
  return source.replace(pattern, '$1' + digest + '$2');
}
module.exports.pinBodyFingerprint = pinBodyFingerprint;
