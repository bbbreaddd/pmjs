'use strict';

function installInputState(Input, native, createObject, createArray) {
  const names = ['keyMapper', 'gamepadMapper', '_currentState', '_previousState'];
  for (const name of names) Input[name] = Object.assign(createObject(), native(name));
  function copyButtons(values) {
    const result = createArray(); result.length = values.length;
    for (const key of Object.keys(values)) result[key] = values[key];
    return result;
  }
  Input._gamepadStates = createArray();
  for (const [key, values] of Object.entries(native('_gamepadStates'))) Input._gamepadStates[key] = copyButtons(values);
  function push() {
    for (const name of names) {
      const values = {};
      for (const key of Object.keys(Input[name])) {
        const value = Input[name][key];
        if (name.endsWith('State')) values[key] = Boolean(value);
        else if (/^-?\d+$/.test(key) && value) values[key] = String(value);
      }
      native(name, values);
    }
    const pads = {};
    for (const key of Object.keys(Input._gamepadStates)) {
      if (!/^(0|[1-9][0-9]*)$/.test(key)) continue;
      const values = Input._gamepadStates[key];
      if (values == null) continue;
      pads[key] = Array.from(values, value => value == null ? undefined : Boolean(value));
    }
    native('_gamepadStates', pads);
  }
  function pull(gamepadIndex) {
    for (const name of ['_currentState', '_previousState']) {
      const target = Input[name], values = native(name);
      for (const key of Object.keys(target)) if (!Object.hasOwn(values, key)) delete target[key];
      for (const [key, value] of Object.entries(values)) {
        if (name === '_previousState' && Object.hasOwn(Input._currentState, key) && Boolean(Input._currentState[key]) === value)
          target[key] = Input._currentState[key];
        else if (!Object.hasOwn(target, key) || Boolean(target[key]) !== value) target[key] = value;
      }
    }
    if (gamepadIndex !== undefined) {
      const values = native('_gamepadStates')[gamepadIndex];
      if (values) Input._gamepadStates[gamepadIndex] = copyButtons(values);
    }
  }
  return { push, pull, reset() {
    Input._currentState = createObject(); Input._previousState = createObject(); Input._gamepadStates = createArray();
  } };
}

module.exports = { installInputState };
