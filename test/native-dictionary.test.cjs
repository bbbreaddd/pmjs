'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { nativeDictionary } = require('../runner/native-dictionary.cjs');

test('native dictionaries reflect replacement, deletion and external mutation without adopting caller objects', () => {
  let data = { 1: 4 };
  const dictionary = nativeDictionary(() => ({}), (method, key, value) => {
    if (method === 'read') return { ...data };
    if (method === 'value') return data[key];
    if (method === 'set') data[key] = value;
    if (method === 'delete') delete data[key];
    if (method === 'replace') data = { ...key };
  });
  assert.equal(dictionary.view[1], 4); dictionary.view[2] = 7; assert.equal(data[2], 7);
  data[1] = 9; assert.equal(dictionary.view[1], 9); assert.deepEqual(Object.keys(dictionary.view), ['1', '2']);
  delete dictionary.view[1]; assert.equal(1 in dictionary.view, false);
  const replacement = { 3: 1 }; dictionary.replace(replacement); replacement[3] = 2;
  assert.equal(dictionary.view[3], 1); assert.equal(2 in dictionary.view, false);
  assert.throws(() => dictionary.replace({ 3: 4, invalid: 5 }), /keys/); assert.equal(data[3], 1);
  assert.throws(() => Object.freeze(dictionary.view), /extensible/);
});
