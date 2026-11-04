'use strict';

(function() {
  var id = 'isat.dormont-blank-characters';
  PMJS.optimizations.register({ id: id, owner: 'pmjs-isat',
    fallback: 'run the ordinary character presentation update chain' });
  PMJS.phases.on('beforeBoot', 'pmjs.isat.blank-characters', function() {
    if (!PMJS.optimizations.isEnabled(id)) return;
    var qualification = PMJS.isatSourceQualification;
    if (!qualification || qualification.verified !== true) {
      PMJS.optimizations.refuse(id, 'unqualified ISAT sources');
      return;
    }
    var refusals = [];
    var hashes = {
      "Sprite_Character": {
        "update": [
          "6bffe01ec98ab0ec3a3033cda99e348aaca341a2e26584cd4689a4d2a2615251"
        ],
        "updateBitmap": [
          "71c23e9a8c236d690977d51279a300364e957a20bf49d242f92ac297a9ac85f9"
        ],
        "isImageChanged": [
          "eac0bd1a91158ec454d19b0fec02357ef17f76b0d7bd4f0e2ced2e1935cdbeb9", "ae9d40ad596788e34ba124e3aaabd2ba87e2a559c2f9ebe5ba6c7bb197809098"
        ],
        "updateFrame": [
          "f9fa3e9e43adcbeea4ed8a637aa167b3d9a6f19eb9b040005345dce9c8619f91"
        ],
        "updateCharacterFrame": [
          "719880bcf767f19364aec2737025ca9cd316c19a955c4e314f4c8542b7019e8d",
          "9fd6a0ad3f31ed2b7d2a6b1c89c188c614aedb920bf2c345fc09f77bc8fec89d"
        ],
        "updatePosition": [
          "33d303c624383759b3803f99526bec76e75e95cfb53b9d1834abaf983b8676f1"
        ],
        "updateAnimation": [
          "52ed1b23f87b3225cf677a6caa5aa7ee66ebb6db5cb722003ccec21b941061ac"
        ],
        "updateOther": [
          "e9c96c8aa36e67085ceb32d432614f20382adae38c63f9a1b288f925fb01f3ae"
        ],
        "updateVisibility": [
          "2be69dbd3f7bb089dbb86f5387de11c1f8647007c662cc4c2c78edd02dd14bc4"
        ],
        "updateBalloon": [
          "83534184b260259d66543b87707ca28b0844ce62ecd491dc98ba0b63b95c8d55",
          "b11edec76ba3617aec03f9658a4c2d95f0e5b3e3fa5f892b7c7976102758ed7f"
        ],
        "setupBalloon": [
          "480fac3e85315d55d399c44a33efba36d80b496cab5ca75d8d78edc31c89b124"
        ],
        "startBalloon": [
          "a0c30ab65be92f5e5a386a5ec3f2e7be868574ceb8c85bcb2a2b03b0042743d9"
        ],
        "endBalloon": [
          "73dc2b393f5dbc8400fd132250dbe193504767715971723c46bb46b3805c0509"
        ],
        "isBalloonPlaying": [
          "18f92a34954f00c632eed0daa9504bcd80ef2bdb0c800382d6f31fe6a9b269dd"
        ],
        "setupAnimation": [
          "a1d8332023fb69796552c4bb24b6e7e39203445740898735374c8348a03cc326"
        ],
        "updateHalfBodySprites": [
          "47092631641a26aa9d3d7e9f80e1840b8f0fb9e12e6b2a3a454cb3788a16ff78",
          "dc65b8c8604adc6a5d1af43015c944195f69dfb3e24e39cb19ee2a766a15a9a4"
        ],
        "patternWidth": [
          "46d44179ca8be450446e5486f0833d96341cccf2818bc772256de52f0ab5e3f6"
        ],
        "patternHeight": [
          "6bcbe7b8a62bed13e40f7f299222c571593ee561cc9d1b6e484d0a006318d7d3"
        ],
        "characterBlockX": [
          "76d7c5af3b172bb03cb15aedf693673a32e4760c0c7a95a79bc420a5983317d1"
        ],
        "characterBlockY": [
          "20953a88f0212e8821f2ed3cc0e3557ecf2988c1082a7c3dbc6444f89cea6de6"
        ],
        "characterPatternX": [
          "d8367f4faa2dd88f43d512d35c9c2af9873798f219bac91f4589c9d88f1c6b95"
        ],
        "characterPatternY": [
          "d82f8f1ef9c986740a1d6e0aed4c655f17a2847ddfe3305a5737859694d8c59d"
        ]
      },
      "Sprite_Base": {
        "update": [
          "fd9d2f86de93fece0c102aac5e1bb5aec263509403dc05be6d099db79a97f263", "2bc8d7a193bc04f901171c8003c18806cebfee25b96652bb8eac70730b268c20"
        ],
        "updateVisibility": [
          "2c3e4c95bd9c9c047755085370a835ac99d5eee56c5a30e10512d80f95efa1c7", "c5c8e5ccce5781a4a6c50229161df45f731a462ac7afbb4e276f48aa70d1a9e5"
        ],
        "updateAnimationSprites": [
          "30575574c798ac1d0086edb495a72ab561e65d4ae6090978004e1ed1a426a2fd"
        ],
        "isAnimationPlaying": [
          "f141b61a0662614e922f982e34dab974ea4887c2fcec5fa0c64279490141bf39", "a914b3c62dc7f2d1b5b248ed2ce0365978492d9406cdb896f6ca16f308bff68d"
        ],
        "startAnimation": [
          "10d9ca931693e47717a7eee8a178016285c462a9492a2c2cf93a29ffa91d95b1", "63d5dd7e1364ebbb3b8bb608ddcfc64ffc4ae5080f748c4de4e576e195c588c9",
          "1e1782e4b008b27e5cd67edb45e6844830f4127c7b2620f424f6bd89da6feab9"
        ]
      },
      "Sprite": {
        "update": [
          "afc0c175fbd5adfb4ffc57345ca0aea27ec1338fe74789c2c3599dca1c001594", "27950ec1883504d9dc0543d220c7b3149b48aaae13c837b2f7c5a937927877ef"
        ],
        "synchronizeHorrorFiltersWithSource": [
          "77bd772fa8bd00f211d4dd7344afca3b4e2d0590567e2c7d84dbe04bb80a3d00"
        ],
        "updateHorrorEffects": [
          "5a2e127a3a66d10dbac9ea5a08ce2f600c8c51737d8e60141b8e3fab61f4b66f", "3d661c4d877d03ab6263383bef281abd7af0762b56a8358036fddb2ab961d6f8",
          "9260befd5b45556ad2fa3d618ba31a782c7b84396828aad1f27a2839d2f270fe"
        ],
        "updateHorrorNoise": [
          "5886848c86d64f40d6342cd985179c8d0f328e8d4231011f044ebcd3b8c2d686", "39ecec355e2ba9f146be450dc1db0e3383f1f8145e99bae4aa607fcb3427d751"
        ],
        "updateHorrorGlitch": [
          "e9cd9bde2e143ff995b921da4afdaf4f1f580f2fa6340888a36e7536f5e20ea6"
        ],
        "updateHorrorTV": [
          "f5469ca6d318fe389e00824aa5daf6f698f3e4a300b21a79372910c5434f2254", "16f0ea220202863bd97b9004f9e0645091724d5c16fd1872c1fb04057b56bd50"
        ],
        "setFrame": [
          "7249cc11c521d64bf7945f8f41b64df58c8d85b88cb451ee5b1943350e4e5eec",
          "e845b8472e5abe9f2be443d37c7b695dde240f92f9c252dd48e68c827970eee4"
        ],
        "_refresh": [
          "ddde82855ebc9eb4daff5969f4831a8a8d669d0db3aa478fe5442d5d9aab9ea9", "e731cfedc090bebe4fb0aedda70dfb2156a05c270ec88ba0c11914484d78c0d2",
          "2bd71ec71c58755bc083aa5ab20ebcadfa27175ed4797c1dc84ca8171bbeac56",
          "4eb530a3a6e2eed80076515ae67787e9943dc3737e603c3f3d87cbcf4349a0b5"
        ]
      },
      "Game_CharacterBase": {
        "tileId": [
          "481710e9a33ea748bc40ece465f580d4ff00077d83d624a69c031f811a746bf5"
        ],
        "characterName": [
          "b58d9b0f6575bdb0705e0ed33b8036a03aa11901972b8eaa0264a6b8d778eeb6"
        ],
        "characterIndex": [
          "59542fc4ef3e8f9c26e2fd4f04fc80754eb47ceafd6a77c604618db069d4f915"
        ],
        "animationId": [
          "1bcaa1f38731d3e5f166ca3c1b95b98c282609c0dd951976ecfee38d6fc8fc19"
        ],
        "balloonId": [
          "6d829ba381f164a748190b055a171b0baa6966931f4b8649132a1ecea9ae7b72"
        ],
        "isTransparent": [
          "d79771b5540c6d63a72c60cdc1172dd4536620ed02e599f677bfe91542804968"
        ],
        "bushDepth": [
          "8a4fbfe05d34f416a67d41668d56217bd7155e42736f34e1edda5fb8e3ca92dc"
        ],
        "opacity": [
          "4dcb2ae4b3a1553030ea983ffd0c89ce9183be4156164e7ceaedcb0c40cecc72"
        ],
        "blendMode": [
          "931aa49e6553e52473b52ca64955e1811ce9104fd24dd44c149f21dce817babf", "5e01b0d546de9e1b215013b3faa655289e29cde7b8feba1cece567792b616f9d"
        ],
        "endAnimation": [
          "9065933cc8e16535dd5f782b69aab944d2360820514ac4d992aeb275b14a571b"
        ],
        "endBalloon": [
          "621e0e09cc96adeb02991c4eade244ac0ec0107efc0552692dd40db9b6508b9a"
        ],
        "screenX": [
          "903553f509554d6d28b7d773178fd88ce1e591f02653403cc664a698716a6625"
        ],
        "screenY": [
          "1981e8b2fc1feb72d89d76c2a5017462cd567791cb6a1fd033f13bc19a9a8a28"
        ],
        "screenZ": [
          "ec039141a5695e2339edc3cf3281fdfde44472c96b357799e016988070006e68"
        ],
        "scrolledX": [
          "5e869b56b7d81491a8ec102d02a6c180f426188e3ed5443f12a5f653403a5753"
        ],
        "scrolledY": [
          "b06eeecf1d97d3ce88be0da79cb2fb3511f25d3eddfe48cf29e8e50e593f9aa9"
        ],
        "shiftY": [
          "f567fa2a0f50532f855cf925ba7476640529748df18395f6331dc36ea9dba125"
        ],
        "jumpHeight": [
          "e74c2dd6d43983d1f83290a2064547101c650eb6a703c0ea66ac76e8e1a6a71a"
        ],
        "pattern": [
          "f448c2f4006cf1441205392c63fe405784c375bd947ae83f444e78c285f87910"
        ],
        "direction": [
          "ff6d019794c6df7de9b2ac7d43dc5cfa37bbcbb9c61d8ff3cb4d5ec8e5364761", "05461066904aba317fdc295a0f58609eac081e21cd29357696f28fce81f8c719"
        ]
      }
    };
    function digest(method) {
      return typeof method === 'function' ? PMJS.methods.fingerprint(PMJS.methods.sourceOf(method)) : null;
    }
    var prototypes = { Sprite_Character: Sprite_Character.prototype, Sprite_Base: Sprite_Base.prototype,
      Sprite: Sprite.prototype, Game_CharacterBase: Game_CharacterBase.prototype };
    var captured = {};
    for (var group in hashes) {
      captured[group] = {};
      for (var name in hashes[group]) {
        var method = prototypes[group][name];
        if (hashes[group][name].indexOf(digest(method)) < 0) refusals.push(group + '.' + name);
        captured[group][name] = method;
      }
    }
    var stockSpriteUpdate = globalThis.Olivia && Olivia.HorrorEffects && Olivia.HorrorEffects.___Sprite_update___;
    if (!PMJS.methods.matchesSource(stockSpriteUpdate, ["0fd3a3e3f5fa2f6d60b4b6c805f4fe3533b02bcb1e154b7716503b626d32cfa9", "b0cc32cdeda35aad82df8f597061031fe5b8b4e65b710453dddeef90149e7de9"])) refusals.push('Olivia.Sprite_update predecessor');
    var animationPredecessor = globalThis.master2015hp && master2015hp.isatSnp && master2015hp.isatSnp.b_2;
    var masterAnimation = !PMJS.methods.matchesSource(captured.Sprite_Base.startAnimation, ["10d9ca931693e47717a7eee8a178016285c462a9492a2c2cf93a29ffa91d95b1", "63d5dd7e1364ebbb3b8bb608ddcfc64ffc4ae5080f748c4de4e576e195c588c9"]);
    if (masterAnimation && !PMJS.methods.matchesSource(animationPredecessor, ["10d9ca931693e47717a7eee8a178016285c462a9492a2c2cf93a29ffa91d95b1", "63d5dd7e1364ebbb3b8bb608ddcfc64ffc4ae5080f748c4de4e576e195c588c9"])) {
      refusals.push('master2015hp.startAnimation predecessor');
    }
    var refreshRecords = PMJS.methods && PMJS.methods.dump().filter(function(record) { return record.key === 'Sprite._refresh'; }) || [];
    if (PMJS.methods.matchesSource(captured.Sprite._refresh, "4eb530a3a6e2eed80076515ae67787e9943dc3737e603c3f3d87cbcf4349a0b5") &&
        !refreshRecords.some(function(record) { return record.id === 'pmjs.mv.native-sprite-tint' &&
          record.state === 'installed' && record.mutations.length === 0; })) {
      refusals.push('nativeRefresh registration');
    }
    var mapUpdate = Spriteset_Map.prototype.update;
    if (["e1ef16368f75f8f947b537e1ba65ef5a325f7c441c5f3bcb9ba1990dbebc9308", "3d511e82479f03dfe21a1145f8f713fc032dd953d42e0be1201fd554bdbea1ef"].indexOf(digest(mapUpdate)) < 0) refusals.push('Spriteset_Map.update');
    if (refusals.length) {
      PMJS.optimizations.refuse(id, 'unrecognized blank-character update graph: ' + refusals.join(', '));
      return;
    }
    var original = captured.Sprite_Character.update;
    var spriteMethods = captured.Sprite_Character, baseMethods = captured.Sprite_Base;
    var characterMethods = captured.Game_CharacterBase, horrorMethods = captured.Sprite;
    var instances = new WeakMap();
    var qualifiedUpdate = false, emptyBitmap = null, wrapper;
    var knownCharacterProtos = new Set([globalThis.Game_CharacterBase, globalThis.Game_Character, globalThis.Game_Event,
      globalThis.Game_Player, globalThis.Game_Follower, globalThis.Game_Vehicle].filter(function(type) { return typeof type === 'function'; })
      .map(function(type) { return type.prototype; }));
    var reachedCharacterProtos = new Set();
    function graphUnchanged() {
      if (PMJS.isatSourceQualification !== qualification) return false;
      for (var group in captured) for (var name in captured[group]) {
        var expected = group === 'Sprite_Character' && name === 'update' ? wrapper : captured[group][name];
        if (prototypes[group][name] !== expected) {
          var horror = PMJS.isatHorrorPresentation;
          if (group !== 'Sprite' || name !== 'update' ||
              !horror || horror.ordinaryUpdate !== captured.Sprite.update || horror.stockUpdate !== stockSpriteUpdate ||
              horror.inactiveUpdate !== Sprite.prototype.update ||
              typeof horror.isInactive !== 'function' || !horror.isInactive()) return false;
        }
      }
      for (var proto of reachedCharacterProtos) for (var name in characterMethods) {
        if (proto[name] !== characterMethods[name]) return false;
      }
      return Olivia.HorrorEffects.___Sprite_update___ === stockSpriteUpdate &&
        (!masterAnimation || master2015hp.isatSnp.b_2 === animationPredecessor);
    }
    // This is ISAT's reviewed producer/helper graph. Its authored walking code does
    // not install late own helper overrides. Unknown prototypes and instance dispatch
    // use the ordinary update; this is not a general arbitrary-mutation contract.
    function qualified(sprite, character) {
      var spriteProto = Object.getPrototypeOf(sprite), characterProto = Object.getPrototypeOf(character);
      if (spriteProto !== Sprite_Character.prototype || !knownCharacterProtos.has(characterProto)) return false;
      var record = instances.get(sprite);
      if (!record || record.character !== character || record.characterProto !== characterProto) {
        var known = true;
        for (var name in spriteMethods) if (name !== 'update' &&
            (Object.prototype.hasOwnProperty.call(sprite, name) || sprite[name] !== spriteMethods[name])) known = false;
        for (var name in baseMethods) if (name !== 'update' && name !== 'updateVisibility' &&
            (Object.prototype.hasOwnProperty.call(sprite, name) || sprite[name] !== baseMethods[name])) known = false;
        for (var name in horrorMethods) if (name !== 'update' &&
            (Object.prototype.hasOwnProperty.call(sprite, name) || sprite[name] !== horrorMethods[name])) known = false;
        for (var name in characterMethods) if (Object.prototype.hasOwnProperty.call(character, name) ||
            character[name] !== characterMethods[name]) known = false;
        record = { character: character, characterProto: characterProto, known: known };
        instances.set(sprite, record);
        if (known) reachedCharacterProtos.add(characterProto);
      }
      return record.known && sprite.updateBitmap === spriteMethods.updateBitmap &&
        sprite.updateFrame === spriteMethods.updateFrame && sprite.updatePosition === spriteMethods.updatePosition &&
        sprite.updateAnimation === spriteMethods.updateAnimation && sprite.updateBalloon === spriteMethods.updateBalloon &&
        sprite.updateOther === spriteMethods.updateOther && character.characterName === characterMethods.characterName &&
        character.tileId === characterMethods.tileId && character.animationId === characterMethods.animationId &&
        character.balloonId === characterMethods.balloonId;
    }
    Spriteset_Map.prototype.update = function() {
      var previous = qualifiedUpdate, previousEmpty = emptyBitmap;
      qualifiedUpdate = !!globalThis.$gameMap && $gameMap.mapId() === 30 &&
        Object.getPrototypeOf(this) === Spriteset_Map.prototype && graphUnchanged();
      emptyBitmap = ImageManager._imageCache.get('empty');
      try { return mapUpdate.apply(this, arguments); }
      finally { qualifiedUpdate = previous; emptyBitmap = previousEmpty; }
    };
    function active(filters) { return filters && (filters.noiseFilter || filters.glitchFilter || filters.tvFilter); }
    function eligible(sprite) {
      var character = sprite._character;
      if (!character || character._characterName !== '' || character._tileId !== 0 ||
          sprite._characterName !== '' || sprite._tileId !== 0 ||
          character._animationId !== 0 || character._balloonId !== 0 ||
          character._animationPlaying !== false || character._balloonPlaying !== false ||
          character._bushDepth !== 0 || sprite._bushDepth !== 0 || sprite._balloonSprite ||
          !sprite._animationSprites || sprite._animationSprites.length || sprite.children.length ||
          sprite._horrorFiltersSource !== character || active(character._horrorFilters) || active(sprite._horrorFilters) ||
          sprite._filters && sprite._filters.length || sprite._mask || sprite.shader || sprite._cacheAsBitmap) return false;
      if (PMJS.pixi4.bitmapPresentation && PMJS.pixi4.bitmapPresentation.has(sprite)) return false;
      // MV materializes its canonical empty Bitmap as 1x1. Character framing requests
      // fractional dimensions, which Sprite._refresh floors to a zero-area raster frame.
      var bitmap = sprite._bitmap, frame = sprite._frame, real = sprite._realFrame;
      if (!bitmap || bitmap !== emptyBitmap || bitmap.width > 1 || bitmap.height > 1 ||
          !frame || frame.width < 0 || frame.width >= 1 ||
          frame.height < 0 || frame.height >= 1 || !Number.isFinite(frame.width) || !Number.isFinite(frame.height) ||
          !real || real.width !== 0 || real.height !== 0) return false;
      return qualified(sprite, character);
    }
    wrapper = Sprite_Character.prototype.update = function() {
      if (qualifiedUpdate && eligible(this)) {
        this.visible = false;
        return;
      }
      return original.apply(this, arguments);
    };
  });
})();
