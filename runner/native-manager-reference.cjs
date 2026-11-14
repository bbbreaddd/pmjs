'use strict';
const fs = require('node:fs');
const path = require('node:path');
const referenceRoot = fs.existsSync(path.join(__dirname, 'third_party')) ? __dirname : path.dirname(__dirname);
const filename = path.join(referenceRoot, 'third_party/rpg-maker-mv/rpg_managers.js');
let source;
function installManagerReference(runtime, name) {
  source ||= fs.readFileSync(filename, 'utf8');
  const start = source.indexOf('function ' + name + '()');
  if (start < 0) throw new Error('Unknown MV manager: ' + name);
  const next = /^function \w+Manager\(\)/gm;
  next.lastIndex = start + 1;
  const end = next.exec(source)?.index ?? source.length;
  const body = source.slice(start, end).replace(/^var \$\w+\s*=\s*null;\r?\n/gm, '');
  const manager = runtime.runScript('(function() {\n' + body + '\nreturn ' + name + ';\n})()', filename);
  runtime.scope[name] = manager;
  return manager;
}
module.exports = { installManagerReference };
