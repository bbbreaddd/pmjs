'use strict';
const assert = require('node:assert/strict');
const test = require('node:test');
const {makeHarness} = require('./helpers/scene-encoder-harness.cjs');

test('identity classification rejects non-finite and missing coefficients', () => {
  const {sandbox} = makeHarness();
  const identity = [1,0,0,0,0,0,1,0,0,0,0,0,1,0,0,0,0,0,1,0];
  assert.equal(sandbox.nativeColorMatrixIsIdentity(identity),true);
  for(const invalid of [NaN,Infinity,-Infinity,undefined,'1',null]) {
    const matrix=identity.slice();matrix[0]=invalid;
    assert.equal(sandbox.nativeColorMatrixIsIdentity(matrix),false,String(invalid));
  }
  const nearIdentity=identity.slice();nearIdentity[4]=0.0000005;
  assert.equal(sandbox.nativeColorMatrixIsIdentity(nearIdentity),false);
});
