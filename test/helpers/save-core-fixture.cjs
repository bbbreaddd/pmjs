'use strict';

const fs = require('node:fs');
const crypto = require('node:crypto');
const { runModule } = require('./runtime-context.cjs');

// Synthetic implementations exercise repair eligibility without shipped plugin source.
function prepareSaveCoreAdapter(context) {
  context.__pmjsBuiltinRequire = require;
  runModule(context, 'js/pmjs-core/methods.js');
  context.PMJS.compat = { hit() {} };
  context.Window_SaveInfo.prototype.drawContents = function fixtureContents() { return 'guest contents'; };
  context.Scene_File.prototype.onConfirmOk = function fixtureConfirm() { return 'guest confirmation'; };
  const digest = fn => crypto.createHash('sha256').update(fn.toString()).digest('hex');
  return fs.readFileSync(require.resolve('../../js/pmjs-plugins/yanfly/save-core.js'), 'utf8')
    .replace('4a5dc3341613ba4b9132bb00b060859521cf26b4de5a194b1926db0da5f78e23',
      digest(context.Window_SaveInfo.prototype.drawContents))
    .replace('ca2ff7296b178a4f9ec2d63d6a98eb432f1973321049d0d18be5258b40b1153d',
      digest(context.Scene_File.prototype.onConfirmOk));
}

module.exports = { prepareSaveCoreAdapter };
