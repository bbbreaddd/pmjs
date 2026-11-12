'use strict';

// Class names remain data. Loading a save never evaluates constructors or scripts.
function decodeGraph(json) {
  const registry = new Map();
  function index(value, depth = 0) {
    if (depth > 128) throw new Error('save nesting limit exceeded');
    if (!value || typeof value !== 'object') return value;
    if (Object.hasOwn(value, '@r')) return value;
    const body = Object.hasOwn(value, '@a') ? value['@a'] : value;
    if (value['@c'] !== undefined) {
      if (registry.has(value['@c'])) throw new Error('duplicate save reference');
      registry.set(value['@c'], body);
    }
    for (const key of Object.keys(body)) {
      if (['__proto__', 'constructor', 'prototype'].includes(key)) throw new Error('invalid save field');
      if (key !== '@c') body[key] = index(body[key], depth + 1);
    }
    delete body['@c'];
    return body;
  }
  function expand(value, ancestors = new Set()) {
    if (!value || typeof value !== 'object') return value;
    if (Object.hasOwn(value, '@r')) {
      if (!registry.has(value['@r'])) throw new Error('missing save reference');
      value = registry.get(value['@r']);
    }
    if (ancestors.has(value)) throw new Error('cyclic save state is unsupported');
    const chain = new Set(ancestors).add(value);
    if (Array.isArray(value)) return value.map(item => expand(item, chain));
    return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, expand(item, chain)]));
  }
  return expand(index(JSON.parse(json)));
}

function encodeGraph(contents) {
  let sequence = 0;
  const seen = new Map();
  const emitted = new Set();
  function identify(value, depth = 0) {
    if (depth > 128) throw new Error('save nesting limit exceeded');
    if (!value || typeof value !== 'object' || seen.has(value) || Object.hasOwn(value, '@r')) return;
    seen.set(value, ++sequence);
    for (const item of Object.values(value)) identify(item, depth + 1);
  }
  identify(contents);
  function encode(value, depth = 0) {
    if (depth > 128) throw new Error('save nesting limit exceeded');
    if (!value || typeof value !== 'object') return value;
    if (typeof value['@r'] === 'string') {
      let target = contents;
      for (const key of value['@r'].split('/').slice(1)) {
        if (!target || !Object.hasOwn(target, key)) throw new Error('invalid save reference path');
        target = target[key];
      }
      if (!seen.has(target)) throw new Error('missing save reference target');
      return { '@r': seen.get(target) };
    }
    const id = seen.get(value);
    if (emitted.has(value)) return { '@r': id };
    emitted.add(value);
    if (Array.isArray(value)) return { '@c': id, '@a': value.map(item => encode(item, depth + 1)) };
    return { '@c': id, ...Object.fromEntries(Object.entries(value).map(([key, item]) => [key, encode(item, depth + 1)])) };
  }
  return JSON.stringify(encode(contents));
}

module.exports = { decodeGraph, encodeGraph };
