'use strict';
const fs = require('node:fs');
const vm = require('node:vm');
const source = fs.readFileSync(require.resolve('../../../../patches/isat/source-qualification.js'), 'utf8');
module.exports = function methodHash(builtinRequire = require) {
  const context = { __pmjsBuiltinRequire: builtinRequire, PMJS: { phases: { on() {} } } };
  vm.createContext(context);
  require('../../../helpers/runtime-context.cjs').runModule(context, 'js/pmjs-core/methods.js');
  vm.runInContext(source, context);
  return context.PMJS.isatMethodHash;
};
