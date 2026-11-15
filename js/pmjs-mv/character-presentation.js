'use strict';

(function() {
  var presentation = PMJS.pixi4.bitmapPresentation;
  if (!presentation || typeof Sprite_Character !== 'function' ||
      typeof Game_CharacterBase !== 'function') return;
  // Reviewed MV 1.6.1 character methods.
  var spriteHashes = {
    updateCharacterFrame: ['719880bcf767f19364aec2737025ca9cd316c19a955c4e314f4c8542b7019e8d'],
    updateHalfBodySprites: ['47092631641a26aa9d3d7e9f80e1840b8f0fb9e12e6b2a3a454cb3788a16ff78'],
    patternWidth: ['46d44179ca8be450446e5486f0833d96341cccf2818bc772256de52f0ab5e3f6'],
    patternHeight: ['6bcbe7b8a62bed13e40f7f299222c571593ee561cc9d1b6e484d0a006318d7d3'],
    characterBlockX: ['76d7c5af3b172bb03cb15aedf693673a32e4760c0c7a95a79bc420a5983317d1'],
    characterBlockY: ['20953a88f0212e8821f2ed3cc0e3557ecf2988c1082a7c3dbc6444f89cea6de6'],
    characterPatternX: ['d8367f4faa2dd88f43d512d35c9c2af9873798f219bac91f4589c9d88f1c6b95'],
    characterPatternY: ['d82f8f1ef9c986740a1d6e0aed4c655f17a2847ddfe3305a5737859694d8c59d']
  };
  var characterHashes = {
    pattern: ['f448c2f4006cf1441205392c63fe405784c375bd947ae83f444e78c285f87910'],
    direction: ['ff6d019794c6df7de9b2ac7d43dc5cfa37bbcbb9c61d8ff3cb4d5ec8e5364761'],
    characterIndex: ['59542fc4ef3e8f9c26e2fd4f04fc80754eb47ceafd6a77c604618db069d4f915']
  };
  function capture(prototype, hashes) {
    var methods = {};
    for (var name of Object.keys(hashes)) {
      var method = prototype[name];
      if (typeof method !== 'function') return null;
      if (!PMJS.methods.matchesSource(method, hashes[name])) return null;
      methods[name] = method;
    }
    return methods;
  }
  var spriteMethods = capture(Sprite_Character.prototype, spriteHashes);
  var characterMethods = capture(Game_CharacterBase.prototype, characterHashes);
  if (!spriteMethods || !characterMethods) return;
  var frameSetter = Sprite.prototype.setFrame;
  var frameRefresh = Sprite.prototype._refresh;
  var halfBodyMethods = new Map([[spriteMethods.updateHalfBodySprites, function() { return true; }]]);
  var refreshMethods = new Map([[frameRefresh, function() { return true; }]]);
  function register(methods, method, predecessor, verify) {
    if (typeof method !== 'function' || typeof verify !== 'function' ||
        methods.has(method) || !methods.has(predecessor)) return false;
    var predecessorCheck = methods.get(predecessor);
    methods.set(method, function() { return predecessorCheck() && verify(); });
    return true;
  }
  PMJS.mv = PMJS.mv || {};
  PMJS.mv.characterPresentation = {
    registerHalfBodyEquivalent: function(method, predecessor, verify) {
      return register(halfBodyMethods, method, predecessor, verify);
    },
    registerRefreshEquivalent: function(method, predecessor, verify) {
      return register(refreshMethods, method, predecessor, verify);
    }
  };
  function unchanged(object, methods, exclude) {
    return Object.keys(methods).every(function(name) {
      return exclude.includes(name) || object[name] === methods[name];
    });
  }
  function field(object, name) {
    var descriptor = Object.getOwnPropertyDescriptor(object, name);
    return descriptor && Object.hasOwn(descriptor, 'value') ? descriptor.value : undefined;
  }
  Sprite_Character.prototype.updateCharacterFrame = function() {
    var character = this._character, bitmap = this.bitmap, frame = null;
    var dimensions = bitmap && !bitmap.isReady() && presentation.dimensions(this);
    if (dimensions && bitmap.width === 0 && bitmap.height === 0 &&
        field(this, '_tileId') === 0 && field(this, '_bushDepth') === 0 &&
        typeof field(this, '_isBigCharacter') === 'boolean' && this.setFrame === frameSetter &&
        refreshMethods.has(this._refresh) && refreshMethods.get(this._refresh)() &&
        character && unchanged(this, spriteMethods, ['updateCharacterFrame', 'updateHalfBodySprites']) &&
        halfBodyMethods.has(this.updateHalfBodySprites) && halfBodyMethods.get(this.updateHalfBodySprites)() &&
        unchanged(character, characterMethods, [])) {
      var pattern = field(character, '_pattern'), direction = field(character, '_direction');
      var index = field(character, '_characterIndex');
      if (Number.isInteger(pattern) && Number.isInteger(index) && index >= 0 &&
          [2, 4, 6, 8].includes(direction)) {
        var big = this._isBigCharacter;
        var width = dimensions.width / (big ? 3 : 12);
        var height = dimensions.height / (big ? 4 : 8);
        frame = { x: ((big ? 0 : index % 4 * 3) + (pattern < 3 ? pattern : 1)) * width,
          y: ((big ? 0 : Math.floor(index / 4) * 4) + (direction - 2) / 2) * height,
          width: width, height: height };
      }
    }
    spriteMethods.updateCharacterFrame.apply(this, arguments);
    // Keep the original frame unchanged; this only affects native drawing.
    var requested = this._frame;
    if (frame && requested.x === 0 && requested.y === 0 &&
        requested.width === 0 && requested.height === 0) {
      presentation.setCharacterFrame(this, bitmap, frame);
    }
  };
})();
