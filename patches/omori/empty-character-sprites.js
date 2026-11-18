'use strict';
(function() {
  var id = 'omori.empty-character-sprites';
  PMJS.optimizations.register({ id:id, owner:'pmjs-omori', fallback:'ordinary character sprite updates' });
  PMJS.phases.on('afterGuestPlugins', id, function() {
    if (!PMJS.optimizations.isEnabled(id)) return;
    var parked = new WeakMap(), characters = new WeakMap(), holders = new WeakMap();
    var stats = { parked:0, wakes:0 };
    var traversal = null;
    function forget(sprite) {
      var record = parked.get(sprite);
      if (!record) return null;
      parked.delete(sprite);
      var members = characters.get(record.character);
      if (members) members.delete(record.reference);
      return record;
    }
    function wakeSprite(sprite) {
      var record = forget(sprite);
      if (!record) return;
      if (sprite.parent === record.holder && !sprite._destroyed && !record.parent._destroyed) {
        record.parent.addChild(sprite);
        stats.wakes++;
      }
    }
    function wake(character) {
      var members = characters.get(character);
      if (!members) return;
      for (var reference of members) {
        var sprite = reference.deref();
        if (sprite) wakeSprite(sprite);
        else members.delete(reference);
      }
    }
    var prototype = Sprite_Character.prototype, update = prototype.update;
    function canPark(sprite) {
      var character = sprite._character;
      return !(sprite.constructor !== Sprite_Character || prototype.update !== scheduledUpdate || sprite.update !== scheduledUpdate || parked.has(sprite) || sprite._destroyed || !character ||
          character.characterName() || character.tileId() ||
          !sprite.parent || !(sprite.parent instanceof Tilemap) ||
          sprite.bitmap !== ImageManager.loadEmptyBitmap() ||
          sprite.children.length || sprite._balloonSprite || sprite._balloonDuration > 0 ||
          sprite._animationSprites.length || character.animationId() || character.balloonId() ||
          character._inputIcon || character._shadow || character._eventIndex > 0 ||
          sprite._inputIconSprite || sprite._eventconSprite || sprite._shadowSprite ||
          sprite._miniLabel && (sprite._miniLabel._text !== '' || sprite._miniLabel.parent) ||
          sprite._labelDelay > 0 || sprite._horrorFiltersSource && sprite._horrorFiltersSource !== character ||
          sprite.filters && sprite.filters.length ||
          character._horrorFilters && Object.keys(character._horrorFilters).some(function(key) { return !!character._horrorFilters[key]; }));
    }
    function park(sprite) {
      var character = sprite._character;
      var parent = sprite.parent, holder = holders.get(parent);
      if (!holder) {
        holder = new PIXI.Container(); holder.visible = false;
        holder.z = 0; holder.spriteId = 0;
        parent.addChild(holder); holders.set(parent, holder);
      }
      var members = characters.get(character);
      if (!members) { members = new Set(); characters.set(character, members); }
      var reference = new WeakRef(sprite);
      members.add(reference);
      holder.addChild(sprite);
      parked.set(sprite, { character:character, parent:parent, holder:holder, reference:reference });
      stats.parked++;
    }
    var scheduledUpdate = prototype.update = function() {
      var value = update.apply(this, arguments);
      if (canPark(this)) {
        if (traversal && traversal.map === this.parent) traversal.pending.push(this);
        else park(this);
      }
      return value;
    };
    PMJS.phases.on('beforeBoot', id, function() {
      var tilemapUpdate = Tilemap.prototype.update;
      Tilemap.prototype.update = function() {
        if (prototype.update !== scheduledUpdate) {
          var holder = holders.get(this);
          if (holder && holder.children.length) for (var parkedSprite of holder.children.slice()) wakeSprite(parkedSprite);
        }
        var previous = traversal, current = { map:this, pending:[] };
        traversal = current;
        try {
          var value = tilemapUpdate.apply(this, arguments);
          for (var sprite of current.pending) {
            if (sprite.parent === this && canPark(sprite)) park(sprite);
          }
          return value;
        } finally { traversal = previous; }
      };
    });
    function writer(owner, name, action) {
      var original = owner[name];
      if (typeof original !== 'function') return;
      owner[name] = function() {
        action(this);
        return original.apply(this, arguments);
      };
    }
    for (var name of ['setImage','setTileImage','requestAnimation','requestBalloon',
      'setupInputIcon','setupShadow','setupEventcon','createHorrorEffect','setHorrorEffectToValue']) {
      writer(Game_CharacterBase.prototype, name, wake);
    }
    for (var method of ['setCharacter','addChild','addChildAt','refreshMiniLabel',
      'startAnimation','startBalloon','createHorrorNoise','createHorrorGlitch','createHorrorTV']) {
      writer(prototype, method, wakeSprite);
    }
    writer(prototype, 'destroy', forget);
    PMJS.omoriEmptyCharacterSprites = { diagnostics:function() { return { parked:stats.parked,wakes:stats.wakes }; } };
  });
})();
