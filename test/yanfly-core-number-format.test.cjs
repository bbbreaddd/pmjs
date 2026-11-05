'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const test = require('node:test');
const source = fs.readFileSync(require.resolve('../js/pmjs-plugins/yanfly/core-number-format.js'),'utf8');
function fixture({enabled=true,recognized=true}={}) {
  const context=vm.createContext({});
  vm.runInContext(`
    var fallbacks=0;
    var Yanfly={Param:{DigitGroup:true},Util:{toGroup:function(value){fallbacks++;if(typeof value==='string'||!Yanfly.Param.DigitGroup)return value;return value.toLocaleString('en');}}};
    var PMJS={plugins:{registerOptimization(){},onLoaded(_name,_id,fn){fn();}},
      phases:{on(_name,_id,fn){fn();}},optimizations:{isEnabled:()=>${enabled},refuse(){this.refused=true;}},methods:{matchesSource:()=>${recognized}}};
  `,context);
  vm.runInContext(source,context);
  return {context,run(code){return vm.runInContext(code,context);}};
}
test('numeric grouping reuses a formatter with native default English output',()=>{
  const h=fixture();
  assert.equal(h.run(`[0,-0,1,-1,1234567,1234.56789,1e21,1e-8,NaN,Infinity,-Infinity].every(n=>Yanfly.Util.toGroup(n)===n.toLocaleString('en'))`),true);
  assert.equal(h.context.fallbacks,0);
  assert.equal(h.run('PMJS.plugins.numberFormat.diagnostics().formatted'),11);
  h.run('Yanfly.Param.DigitGroup=false');assert.equal(h.run('Yanfly.Util.toGroup(12345)'),12345);
  assert.equal(h.run('Yanfly.Util.toGroup("0001234")'),'0001234');
});
test('custom receivers, method replacement and unsupported plugin bodies keep ordinary behavior',()=>{
  const h=fixture();
  assert.equal(h.run('Yanfly.Util.toGroup({toLocaleString(locale){return "custom:"+locale;}})'),'custom:en');
  assert.equal(h.run('Yanfly.Util.toGroup(1234n)'),(1234n).toLocaleString('en'));
  h.run('Number.prototype.toLocaleString=function(locale){return "changed:"+locale;}');
  assert.equal(h.run('Yanfly.Util.toGroup(12)'),'changed:en');
  assert.equal(h.context.fallbacks,3);
  const replaced=fixture();replaced.run('Intl.NumberFormat=function(){throw Error("unexpected constructor");}');
  assert.equal(replaced.run('Yanfly.Util.toGroup(1234)'),'1,234');assert.equal(replaced.context.fallbacks,1);
  const disabled=fixture({enabled:false});assert.equal(disabled.run('Yanfly.Util.toGroup(1234)'),'1,234');assert.equal(disabled.context.fallbacks,1);
  const unknown=fixture({recognized:false});assert.equal(unknown.context.PMJS.optimizations.refused,true);
  assert.equal(unknown.run('Yanfly.Util.toGroup(1234)'),'1,234');assert.equal(unknown.context.fallbacks,1);
});

test('formatting keeps the native locale contract when the public format accessor changes',()=>{
  const h=fixture();
  h.run('Object.defineProperty(Intl.NumberFormat.prototype,"format",{get(){throw Error("custom format accessor");}})');
  assert.equal(h.run('Yanfly.Util.toGroup(1234.5678)'),h.run('(1234.5678).toLocaleString("en")'));
});
