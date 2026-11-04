'use strict';

(function() {
  var id = 'isat.dormont-static-events';
  PMJS.optimizations.register({ id: id, owner: 'pmjs-isat',
    fallback: 'retain complete event updates' });
  PMJS.phases.on('afterGuestPlugins', 'pmjs.isat.static-events', function() {
    if (!PMJS.optimizations.isEnabled(id)) return;
    var qualification = PMJS.isatSourceQualification;
    if (!qualification || qualification.verified !== true) {
      PMJS.optimizations.refuse(id, 'unqualified ISAT sources');
      return;
    }
    if (typeof Game_CharacterBase !== 'function' || typeof Game_Character !== 'function' ||
        typeof Game_Event !== 'function' || typeof Game_Map !== 'function' ||
        !globalThis.Galv || !Galv.CA || !globalThis.Yanfly || !Yanfly.ECP) {
      PMJS.optimizations.refuse(id, 'missing event update lifecycle');
      return;
    }
    // The settled path replaces this particular MV and enabled-plugin composition.
    var methodHashes = {
      "Game_CharacterBase": {
        "update": "2111401663c4b5934ed5acd92b2915ae6f19389e5337809009acb6e8c57ec148",
        "isStopping": "75cee58c0e49b4acd3bb658afbfe8cea891f718288ee2def3cc7097d39cbfc9c",
        "isMoving": "cf1bd74dfc226ef31c50b443c45fec9e2ae5787fd9f37ddfafd86e51f62e2beb",
        "isJumping": "20488f73c7ee50e6df935c99fb8639bb1d3d24f0754ff88aedb3707b50c84427",
        "updateStop": "2a3cff3b644d200505238ba89d452ee23c138d3755b2c719ed017bdcd2610ad6",
        "updateAnimation": "96665833f2a3f531d8ee44c93b340c112855f560e062862d068f4c3050d7d025",
        "updateAnimationCount": "43bb11349a7e597c9ee4e255813a575b6cd4a0bce101e8e28dc2a94185a7095c",
        "hasWalkAnime": "0b26e9ab41f431c1d6eb0603f1c58298769e5f36fba215bc96863547abfe2a23",
        "hasStepAnime": "43a833e9c3b77f857bcf3ecb10be2c79ae5f33fcb1a5f8b6acbb7a475154a707",
        "animationWait": "3bb92acc76f2c1000be9ea92bcb18a3b7bc4f54cf4c4f51fbfbdd2c18e46b973",
        "realMoveSpeed": "151790edaa7b5ce2d01685d47ffb89c8c2a4fa3bbc8bc28dcf1a7fd70490f4d3",
        "pattern": "f448c2f4006cf1441205392c63fe405784c375bd947ae83f444e78c285f87910"
      },
      "Game_Character": {
        "update": "af76834a0363102c01aa25895f381aa3e2802c23fe50ca81ebb005ea99861a97",
        "updateStop": "5c2cfe8a00304c356adcab68ba2ebf1df83ef4b2a067ccce4d607a515f2cb2a4"
      },
      "Game_Event": {
        "update": "b64f788327d8e66b6d3c146b3ffc4ed9835248099e44fde27021fcc9ece62c37",
        "updateStop": ["f090d4f08baf04c79ddc21bdb6cedb2fd4e5c3c304f36ba4278c4ee5e95b0e40", "19a88e3dfe47ab368a9f01038747e9fb69a8de3175fe22f47bdab4c673e1b7a9"],
        "updateSelfMovement": "d22847e9ca8298d23329cc6403eb01140a855ef35787ab1ed71406fb735d5c04",
        "preventSelfMovement": "663905fd7a1efadbf98376df27009964bf0817cd08138c23042cdaa954749593",
        "checkEventTriggerAuto": ["46901fe816bed2bc7ed660b907d3101566c90d0bc23760ef213faada0b2ffd6d", "453235bf8c20a8ab550aadb490b6c660a50a99c60d38565124445b3e4b400d45"],
        "updateParallel": ["5dea25214cd48d6898be66defd5fc519c7b560d7083eb908dfdfc5ab6f7d88cd", "815c8cdaa95cd1247bba1d5108e11059e47762a7b3da2d3eced8e7cb04803c1d"],
        "updateAlert": "0c15b7ef382ffd0c80c766e73d5bf45c4f683aa3febad7f7dca70801aa49eeb4",
        "alertConditions": "48581d9494c5f96789ba3064698d5dea179266ba590a10036dd9d422873b488f",
        "updateReturnPhase": "9cddf6367a1c2e411853ab59357aa0ca484490eaccdf9c13b7e7807ccace8db1",
        "isOriginalPattern": ["145d9a7328c325897120ff7a65bf5a463686edf2e7ecec77cf0146533522d548", "594fda96e2c2309176bfe416dad56e8140501ac0fff8a2d3548dd25fa7281dbd"],
        "isDashing": "ce9822b37969d2482e1f04387268ed98d46b3e4efcb2da184a7f2ea47b3924aa"
      }
    };
    var classes = { Game_CharacterBase: Game_CharacterBase,
      Game_Character: Game_Character, Game_Event: Game_Event };
    var watched = [];
    for (var className in methodHashes) {
      for (var name in methodHashes[className]) {
        var prototype = classes[className].prototype;
        var method = prototype[name];
        if (!PMJS.methods.matchesSource(method, methodHashes[className][name])) {
          PMJS.optimizations.refuse(id, 'unrecognized ' + className + '.' + name);
          return;
        }
        watched.push([prototype, name, method]);
      }
    }
    var base = Game_CharacterBase.prototype;
    var event = Game_Event.prototype;
    var originalUpdate = event.update;
    var mapUpdate = Game_Map.prototype.updateEvents;
    var inheritedUpdate = Galv.CA.Game_Character_update;
    var originalEvent = Yanfly.ECP.Game_Event_update;
    if (inheritedUpdate !== base.update || !PMJS.methods.matchesSource(originalEvent,
        ['7d33fee1f625b00d52d89dc8c0bfbaa878ac997e10243572b0abb1a60fc5b629', '7670bb37a4c9ff075102e942a4bf646bb185ba99f772d3482b57659a50179933'])) {
      PMJS.optimizations.refuse(id, 'unrecognized event update predecessors');
      return;
    }
    watched.push([Galv.CA, 'Game_Character_update', inheritedUpdate],
      [Yanfly.ECP, 'Game_Event_update', originalEvent]);
    var inQualifiedMapUpdate = false;
    function settled(target) {
      return Object.getPrototypeOf(target) === event && target._erased === false &&
        target._moveType === 0 && target._trigger >= 0 && target._trigger < 3 &&
        !target._interpreter && target.disableCharAnims === true &&
        target._realX === target._x && target._realY === target._y &&
        target._jumpCount === 0 && target._locked === false &&
        target._moveRouteForcing === false && target._stepAnime === false &&
        target._isDashing === false &&
        (target._pattern < 3 ? target._pattern : 1) === target._originalPattern &&
        target._animationCount >= 0 && target._animationCount < (9 - target._moveSpeed) * 3 &&
        target._chasePlayer === false && target._fleePlayer === false &&
        target._alertPlayer === false && target._returnPhase === false &&
        typeof target._stopCount === 'number' && Number.isFinite(target._stopCount) &&
        typeof target._alertLock === 'number' && Number.isFinite(target._alertLock) &&
        target.updateStop === event.updateStop && target.updateAnimation === base.updateAnimation &&
        target.updateSelfMovement === event.updateSelfMovement && target.updateAlert === event.updateAlert &&
        target.updateReturnPhase === event.updateReturnPhase && target.updateParallel === event.updateParallel &&
        target.checkEventTriggerAuto === event.checkEventTriggerAuto;
    }
    function updateSettledEvent() {
      if (inQualifiedMapUpdate && settled(this)) {
        // Both clocks advance even when this event has no other work to perform.
        this._stopCount++;
        this._alertLock--;
        return;
      }
      return originalUpdate.apply(this, arguments);
    }
    event.update = updateSettledEvent;
    for (var index = 0; index < watched.length; index++) {
      if (watched[index][0] === event && watched[index][1] === 'update') {
        watched[index][2] = updateSettledEvent;
      }
    }
    Game_Map.prototype.updateEvents = function() {
      var previous = inQualifiedMapUpdate;
      inQualifiedMapUpdate = PMJS.isatSourceQualification === qualification && this._mapId === 30;
      if (inQualifiedMapUpdate) {
        for (var index = 0; index < watched.length; index++) {
          if (watched[index][0][watched[index][1]] !== watched[index][2]) {
            inQualifiedMapUpdate = false;
            break;
          }
        }
      }
      try {
        return mapUpdate.apply(this, arguments);
      } finally {
        inQualifiedMapUpdate = previous;
      }
    };
  });
})();
