'use strict';

function pluginArrayText(source) {
  let scanQuote = null, scanEscaped = false, scanLineComment = false, scanBlockComment = false;
  let assignment = -1;
  for (let index = 0; index < source.length; index += 1) {
    const character = source[index], next = source[index + 1];
    if (scanLineComment) { if (character === '\n') scanLineComment = false; continue; }
    if (scanBlockComment) { if (character === '*' && next === '/') { scanBlockComment = false; index += 1; } continue; }
    if (scanQuote !== null) {
      if (scanEscaped) scanEscaped = false;
      else if (character === '\\') scanEscaped = true;
      else if (character === scanQuote) scanQuote = null;
      continue;
    }
    if (character === '/' && next === '/') { scanLineComment = true; index += 1; continue; }
    if (character === '/' && next === '*') { scanBlockComment = true; index += 1; continue; }
    if (character === '"' || character === "'" || character === '`') { scanQuote = character; continue; }
    if (character === '$' && source.slice(index, index + 8) === '$plugins' &&
        !/[\w$.]/.test(source[index - 1] || '') && !/[\w$]/.test(source[index + 8] || '')) {
      const match = source.slice(index + 8).match(/^\s*=/);
      if (match) { assignment = index + 8 + match[0].length; break; }
    }
  }
  if (assignment < 0) throw new Error('js/plugins.js does not assign $plugins');
  let start = assignment;
  while (/\s/.test(source[start] || '')) start += 1;
  if (source[start] !== '[') throw new Error('js/plugins.js does not assign a literal $plugins array');

  let depth = 0, quote = null, escaped = false, lineComment = false, blockComment = false;
  for (let index = start; index < source.length; index += 1) {
    const character = source[index], next = source[index + 1];
    if (lineComment) { if (character === '\n') lineComment = false; continue; }
    if (blockComment) { if (character === '*' && next === '/') { blockComment = false; index += 1; } continue; }
    if (quote !== null) {
      if (escaped) escaped = false;
      else if (character === '\\') escaped = true;
      else if (character === quote) quote = null;
      continue;
    }
    if (character === '/' && next === '/') { lineComment = true; index += 1; continue; }
    if (character === '/' && next === '*') { blockComment = true; index += 1; continue; }
    if (character === '"' || character === "'") quote = character;
    else if (character === '[') depth += 1;
    else if (character === ']') {
      depth -= 1;
      if (depth === 0) return source.slice(start, index + 1);
    }
  }
  throw new Error('js/plugins.js has an unterminated $plugins array');
}

function stripComments(source) {
  let quote = null, escaped = false, lineComment = false, blockComment = false, result = '';
  for (let index = 0; index < source.length; index += 1) {
    const character = source[index], next = source[index + 1];
    if (lineComment) {
      if (character === '\n') { lineComment = false; result += character; }
      else result += ' ';
      continue;
    }
    if (blockComment) {
      if (character === '*' && next === '/') { result += '  '; index += 1; blockComment = false; }
      else result += character === '\n' ? '\n' : ' ';
      continue;
    }
    if (quote !== null) {
      result += character;
      if (escaped) escaped = false;
      else if (character === '\\') escaped = true;
      else if (character === quote) quote = null;
      continue;
    }
    if (character === '/' && next === '/') { result += '  '; index += 1; lineComment = true; continue; }
    if (character === '/' && next === '*') { result += '  '; index += 1; blockComment = true; continue; }
    if (character === '"' || character === "'") quote = character;
    result += character;
  }
  if (blockComment) throw new Error('unterminated comment in $plugins array');
  return result;
}

function parsePluginManifest(source, label = 'js/plugins.js') {
  try {
    const array = stripComments(pluginArrayText(String(source)));
    let quote = null, escaped = false, json = '';
    for (let index = 0; index < array.length; index += 1) {
      const character = array[index];
      if (quote !== null) {
        if (escaped) escaped = false;
        else if (character === '\\') escaped = true;
        else if (character === quote) quote = null;
      } else if (character === '"' || character === "'") quote = character;
      if (quote === "'") throw new Error('single-quoted strings are not supported');
      if (quote === null && character === ',' && /^\s*[\]}]/.test(array.slice(index + 1))) {
        const previous = json.trimEnd().slice(-1);
        if (!['[', '{', ':', ','].includes(previous)) continue;
      }
      json += character;
    }
    const entries = JSON.parse(json);
    if (!Array.isArray(entries)) throw new Error('$plugins is not an array');
    return { plugins: entries };
  } catch (error) {
    throw new Error(`unsupported generated plugin manifest ${label}: ${error.message}`);
  }
}

module.exports = { parsePluginManifest };
