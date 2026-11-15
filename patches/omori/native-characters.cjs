'use strict';

function captureNativeCharacters(runtime, engine, session) {
  const scope = runtime.scope, definitions = [];
  const defaults = Object.entries(Object.getOwnPropertyDescriptors(scope.Sprite_Character.prototype))
    .filter(([name, descriptor]) => name !== 'constructor' && typeof descriptor.value === 'function')
    .map(([method, descriptor]) => ({ method, function: descriptor.value, bindingType: 'Sprite_Character' }));
  let labelSetup;
  function add(owner, method, operation, base) {
    if (typeof owner?.[method] !== 'function') throw new TypeError('Character presentation method is missing: ' + method);
    const definition = { owner, method, operation, function: owner[method], base };
    definitions.push(definition);
    return definition;
  }
  const alias = (owner, property) => ({ owner, property });
  function loaded(plugin, install) {
    scope.PMJS.plugins.onLoaded(plugin, 'omori.native-characters.' + plugin, install);
  }
  for (const [method, operation] of Object.entries({ isObjectCharacter:'object', jumpHeight:'jump', shiftY:'shift', scrolledX:'scrolledX', scrolledY:'scrolledY' }))
    add(scope.Game_CharacterBase.prototype, method, 'character.' + operation);
  for (const method of ['tileWidth', 'tileHeight', 'adjustX', 'adjustY', 'width', 'height', 'displayX', 'displayY',
    'isLoopHorizontal', 'isLoopVertical', 'screenTileX', 'screenTileY']) add(scope.Game_Map.prototype, method, 'map.' + method);
  loaded('fuku_testpack', () => {
    add(scope.Game_CharacterBase.prototype, 'screenX', 'position.fukuX');
    add(scope.Game_CharacterBase.prototype, 'screenY', 'position.fukuY');
  });
  loaded('YEP_CoreEngine', () => {
    add(scope.Sprite_Character.prototype, 'updateHalfBodySprites', 'core.halfBodies',
      alias(scope.Yanfly.Core, 'Sprite_Character_updateHalfBodySprites'));
    for (const axis of ['X', 'Y']) add(scope.Game_Map.prototype, 'adjust' + axis, 'map.yepAdjust' + axis);
  });
  loaded('YED_Tiled', () => {
    const prototype = runtime.nativeTiledSprites?.reflectionPrototype;
    if (prototype) add(prototype, 'update', 'reflection.chain', alias(scope.Sprite_Character.prototype, 'update'));
    add(scope.Game_CharacterBase.prototype, 'screenZ', 'character.screenZ');
  });
  loaded('ExtraMovementFrames', () => {
    add(scope.Sprite_Character.prototype, 'patternWidth', 'frames.width', alias(scope.ModernAlgebra.EMF, 'SpriteCharacter_patternWidth'));
    add(scope.Game_CharacterBase.prototype, 'isEmfCharacter', 'character.emf');
    add(scope.Game_CharacterBase.prototype, 'emfCharacterState', 'character.emfState');
  });
  loaded('Custom_Character_Rectangles', () => {
    const methods = { characterBlockX: 'blockX', characterBlockY: 'blockY', characterPatternX: 'patternX',
      characterPatternY: 'patternY', patternWidth: 'width', patternHeight: 'height' };
    for (const [method, operation] of Object.entries(methods)) add(scope.Sprite_Character.prototype, method, 'frame.' + operation,
      alias(scope._TDS_.CustomCharacterRectangles, 'Sprite_Character_' + method));
  });
  loaded('YEP_EventMiniLabel', () => {
    const prototype = scope.Sprite_Character.prototype;
    add(prototype, 'update', 'label.chain', alias(scope.Yanfly.EML, 'Sprite_Character_update'));
    labelSetup = add(prototype, 'setupMiniLabel', 'label.setup').function;
    for (const [method, operation] of Object.entries({ updateMiniLabel: 'update', positionMiniLabel: 'position',
      updateMiniLabelZoom: 'zoom', refreshMiniLabel: 'refresh' })) add(prototype, method, 'label.' + operation);
    const label = scope.Window_EventMiniLabel.prototype;
    add(label, 'update', 'label.windowUpdate', alias(scope.Window_Base.prototype, 'update'));
    for (const [method, operation] of Object.entries({ bufferX: 'bufferX', bufferY: 'bufferY', updatePage: 'page',
      updateOpacity: 'opacity', show: 'show', hide: 'hide', showMiniLabel: 'allowed', withinRange: 'range',
      meetsFacingRequirements: 'facing' })) add(label, method, 'label.' + operation);
  });
  loaded('Liquid_EventIcons', () => {
    const prototype = scope.Sprite_Character.prototype;
    add(prototype, 'update', 'icons.chain', alias(scope.Liquid.Eventcons, 'Sprite_Character_update'));
    add(prototype, 'updateAnimation', 'icons.animation', alias(scope.Liquid.Eventcons, 'Sprite_Character_updateAnimation'));
    for (const [method, operation] of Object.entries({ setupEventcon: 'setup', startEventcon: 'start',
      updateEventcon: 'update', endEventcon: 'end', isEventconPlaying: 'playing' })) add(prototype, method, 'icons.' + operation);
    for (const [method, operation] of Object.entries({ eventconId: 'eventId', eventconImg: 'eventImage',
      startEventcon: 'eventStart', endEventcon: 'eventEnd', isEventconPlaying: 'eventPlaying' }))
      add(scope.Game_CharacterBase.prototype, method, 'character.' + operation);
    add(scope.Sprite_EventCon.prototype, 'update', 'eventcon.update', alias(scope.Sprite_Base.prototype, 'update'));
    for (const method of ['updateFrame', 'speed', 'waitTime', 'frameIndex']) add(scope.Sprite_EventCon.prototype, method,
      'eventcon.' + ({ updateFrame: 'frame', waitTime: 'wait', frameIndex: 'index' }[method] || method));
  });
  loaded('YEP_EventSpriteOffset', () => {
    for (const axis of ['X', 'Y']) {
      add(scope.Game_CharacterBase.prototype, 'screen' + axis, 'position.offset' + axis,
        alias(scope.Yanfly.EvSpOf, 'Game_CharacterBase_screen' + axis));
      add(scope.Game_CharacterBase.prototype, 'spriteOffset' + axis, 'character.offset' + axis);
    }
    add(scope.Game_CharacterBase.prototype, 'initSpriteOffsets', 'character.offsetInit');
  });
  loaded('Omori BASE', () => {
    const prototype = scope.Sprite_Character.prototype;
    add(prototype, 'update', 'omori.chain', alias(scope._TDS_.OmoriBASE, 'Sprite_Character_update'));
    add(prototype, 'updateCharacterFrame', 'omori.frame', alias(scope._TDS_.OmoriBASE, 'Sprite_Character_updateCharacterFrame'));
    for (const method of ['updateBobble', 'updateInputIcon', 'updateShadow']) add(prototype, method,
      'omori.' + ({ updateBobble: 'bobble', updateInputIcon: 'input', updateShadow: 'shadow' }[method]));
    add(scope.Game_CharacterBase.prototype, 'isSingleFrame', 'character.singleFrame');
    add(scope.Sprite_InputButton.prototype, 'update', 'input.update', alias(scope.Sprite.prototype, 'update'));
    for (const [method, operation] of Object.entries({ updateAnimation: 'animation', refreshFrame: 'frame', resetAnimation: 'reset', activate: 'activate' }))
      add(scope.Sprite_InputButton.prototype, method, 'input.' + operation);
  });
  loaded('GTP_OmoriFixes', () => {
    add(scope.Sprite_Character.prototype, 'setupMiniLabel', 'label.delay', { function: labelSetup });
    for (const axis of ['X', 'Y']) add(scope.Game_Map.prototype, 'display' + axis, 'map.scaledDisplay' + axis);
  });

  return {
    install() {
      if (!definitions.length) return;
      const environment = {
        get scene() { return scope.SceneManager._scene; },
        get player() { return scope.$gamePlayer; },
        get system() { return scope.$gameSystem; },
        get map() { return scope.$gameMap; },
        get mapData() { return scope.$dataMap; },
        get screenWidth() { return scope.Graphics.width; },
        get screenHeight() { return scope.Graphics.height; },
        get labelParameters() { return scope.Yanfly?.Param; },
        get iconParameters() { return scope.Liquid?.Param; },
        constructors: scope
      };
      for (const definition of definitions) {
        const original = definition.function, method = definition.method;
        definition.native = function(...args) {
          return engine.characterPresentationInvoke(session, this, original, method, definition.operation === 'frames.width' ? args : []);
        };
        Object.defineProperties(definition.native, { name: { value: original.name }, length: { value: original.length } });
      }
      engine.registerCharacterPresentation(session, environment, runtime.displaySymbol(), defaults, definitions);
      for (const definition of definitions) if (!/^(character|position|map)\./.test(definition.operation) && definition.owner[definition.method] === definition.function)
        definition.owner[definition.method] = definition.native;
      runtime.characterPresentation = { environment, stats: () => engine.characterPresentationStats(session) };
    }
  };
}

module.exports = { captureNativeCharacters };
