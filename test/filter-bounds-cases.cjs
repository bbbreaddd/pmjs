'use strict';

const NO_PARENT = 0xffffffff;
const BG = 0xc86432;
const BG_RGBA = [200, 100, 50, 255];
const HALVE = [0.5, 0, 0, 0, 0,
  0, 0.5, 0, 0, 0,
  0, 0, 0.5, 0, 0,
  0, 0, 0, 1, 0, 1];
const IDENTITY_ALPHA_OFFSET = [1, 0, 0, 0, 0,
  0, 1, 0, 0, 0,
  0, 0, 1, 0, 0,
  0, 0, 0, 1, 0.5, 1];
const DIM_ADJUST = [1, 1, 1, 0.5, 1, 1, 1, 1, 0, 0,
  0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0];
const BLUR = [2, 1, 0, 0, 0, 0, 0, 0, 0, 0,
  0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0];
const MASK_PARAMS = [1, 0, 0, 1, 0, 0, 0, 0, 2, 2,
  1, 0, 0, 2, 2, 0, 0, 0, 0, 0, 0];
const HALVED_FIXTURE = [128, 26, 51, 255];

function beginRecord(kind, parent, resource, tint, blend, flags) {
  return [kind, parent, resource, tint, blend, flags, 0];
}

function baseValues(stride) {
  const values = new Float32Array(stride);
  values.set([1, 0, 0, 1, 0, 0, 1], 0);
  return values;
}

function filterBeginValues(stride, params) {
  const values = baseValues(stride);
  values.set(params.slice(0, 10), 7);
  values.set(params.slice(10, 21), 22);
  values[33] = 1;
  return values;
}

function spriteValues(stride, x, y, w, h) {
  const values = baseValues(stride);
  values[4] = x;
  values[5] = y;
  values.set([0, 0], 7);
  values.set([0, 0, 2, 2], 9);
  values.set([w, h], 13);
  return values;
}

function screenFill(stride, tint) {
  return { metadata: new Uint32Array(beginRecord(3, NO_PARENT, 0, tint, 0, 0)),
    values: baseValues(stride) };
}

function filterBegin(stride, kind, resource, params) {
  return { metadata: new Uint32Array(beginRecord(6, NO_PARENT, resource,
    0xffffff, kind, 0, 0)),
    values: filterBeginValues(stride, params) };
}

function filterEnd(stride) {
  return { metadata: new Uint32Array(beginRecord(7, NO_PARENT, 0, 0xffffff,
    0, 0, 0)),
    values: baseValues(stride) };
}

function toneAdjust(stride, params) {
  const values = baseValues(stride);
  values.set(params.slice(0, 20), 7);
  return { metadata: new Uint32Array(beginRecord(5, NO_PARENT, 0, 0xffffff,
    0, 0, 0)), values };
}

function sprite(stride, handle, x, y, tint) {
  return { metadata: new Uint32Array(beginRecord(1, NO_PARENT, handle,
    tint === undefined ? 0xffffff : tint, 0, 0)),
    values: spriteValues(stride, x, y, 2, 2) };
}

function filterBeginClipped(stride, kind, resource, params, clip) {
  const record = filterBegin(stride, kind, resource, params);
  record.metadata[5] |= 1;
  record.values.set(clip, 17);
  return record;
}

function buildCases(stride, handle) {
  return {
    'preserving color matrix': [
      screenFill(stride, BG),
      filterBegin(stride, 25, 0, HALVE),
      sprite(stride, handle, 6, 6),
      filterEnd(stride),
    ],
    'non-preserving color matrix': [
      screenFill(stride, BG),
      filterBegin(stride, 25, 0, IDENTITY_ALPHA_OFFSET),
      sprite(stride, handle, 6, 6),
      filterEnd(stride),
    ],
    'overlapping sprites': [
      screenFill(stride, BG),
      filterBegin(stride, 25, 0, HALVE),
      sprite(stride, handle, 4, 4),
      sprite(stride, handle, 5, 5, 0x00ff00),
      filterEnd(stride),
    ],
    'sparse preserving color matrix': [
      screenFill(stride, BG),
      filterBegin(stride, 25, 0, HALVE),
      sprite(stride, handle, 1, 1),
      sprite(stride, handle, 13, 1),
      sprite(stride, handle, 1, 13),
      sprite(stride, handle, 13, 13),
      filterEnd(stride),
      sprite(stride, handle, 8, 8, 0x00ff00),
    ],
    'adjustment filter': [
      screenFill(stride, BG),
      filterBegin(stride, 8, 0, DIM_ADJUST),
      sprite(stride, handle, 10, 10),
      filterEnd(stride),
    ],
    'blur filter': [
      screenFill(stride, BG),
      filterBegin(stride, 0, 0, BLUR),
      sprite(stride, handle, 6, 6),
      filterEnd(stride),
    ],
    'nested preserving filters': [
      screenFill(stride, BG),
      filterBegin(stride, 25, 0, HALVE),
      filterBegin(stride, 25, 0, HALVE),
      sprite(stride, handle, 2, 2),
      filterEnd(stride),
      filterEnd(stride),
    ],
    'alpha mask filter': [
      screenFill(stride, BG),
      filterBegin(stride, 3, handle, MASK_PARAMS),
      sprite(stride, handle, 0, 0),
      filterEnd(stride),
    ],
    'clipped filter bounds': [
      screenFill(stride, BG),
      filterBeginClipped(stride, 25, 0, HALVE, [4, 4, 8, 8]),
      sprite(stride, handle, 5, 5),
      filterEnd(stride),
    ],
    'disjoint clip': [
      screenFill(stride, BG),
      filterBeginClipped(stride, 25, 0, HALVE, [0, 0, 2, 2]),
      sprite(stride, handle, 10, 10),
      filterEnd(stride),
    ],
    'clipped color matrix with unboundable content': [
      screenFill(stride, BG),
      filterBeginClipped(stride, 25, 0, HALVE, [0, 0, 16, 16]),
      sprite(stride, handle, 1, 1),
      sprite(stride, handle, 13, 1),
      toneAdjust(stride, HALVE),
      sprite(stride, handle, 1, 13),
      sprite(stride, handle, 13, 13),
      filterEnd(stride),
    ],
    'unboundable nested inside bounded': [
      screenFill(stride, BG),
      filterBegin(stride, 25, 0, HALVE),
      filterBegin(stride, 0, 0, BLUR),
      sprite(stride, handle, 6, 6),
      filterEnd(stride),
      filterEnd(stride),
    ],
    'clipped unboundable nested inside bounded': [
      screenFill(stride, BG),
      filterBegin(stride, 25, 0, HALVE),
      filterBeginClipped(stride, 0, 0, BLUR, [4, 4, 12, 12]),
      sprite(stride, handle, 6, 6),
      filterEnd(stride),
      filterEnd(stride),
    ],
  };
}

module.exports = {
  NO_PARENT,
  BG,
  BG_RGBA,
  HALVE,
  IDENTITY_ALPHA_OFFSET,
  DIM_ADJUST,
  BLUR,
  MASK_PARAMS,
  HALVED_FIXTURE,
  buildCases,
};
