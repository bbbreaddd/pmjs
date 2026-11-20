'use strict';
(function () {
  var id = 'omori.script-triggered-updates';
  PMJS.optimizations.register({
    id: id,
    owner: 'pmjs-omori',
    fallback: 'ordinary event traversal'
  });
  PMJS.phases.on('afterGuestPlugins', id, function () {
    if (!PMJS.optimizations.isEnabled(id)) return;
    var mapStart = Scene_Map.prototype.start;
    Scene_Map.prototype.start = function () {
      var result = mapStart.apply(this, arguments);
      Scene_Map.prototype.start = mapStart;
      install();
      return result;
    };
    function install() {
      var schedules = new WeakMap(),
        owners = new WeakMap(),
        eligible = new WeakSet(),
        diagnosticsEnabled = false;
      var composedUpdate = Game_Event.prototype.update;
      function qualify(event) {
        var page = event.page();
        if (
          !page ||
          (page.trigger < 3 &&
            page.moveType === 0 &&
            !page.stepAnime &&
            (page.trigger === 0 || page.list.every(function (c) {
              return c.code === 0 || c.code === 108 || c.code === 408;
            })))
        )
          eligible.add(event);
        else eligible.delete(event);
      }
      function active(event) {
        return (
          !eligible.has(event) ||
          event.update !== composedUpdate ||
          event._moveType !== 0 ||
          event._locked ||
          event._moveRouteForcing ||
          event._interpreter ||
          event._trigger === 3 ||
          event._stepAnime ||
          event.isMoving() ||
          event.isJumping() ||
          !event.isOriginalPattern() ||
          event._customFrameAnimation ||
          event._spinCount > 0 ||
          event._targetX != null ||
          event._chaseRange > 0 ||
          event._fleeRange > 0 ||
          event._chasePlayer ||
          event._fleePlayer ||
          event._returnPhase ||
          event._alertPlayer ||
          event._fuku_trembleinfo
        );
      }
      function reasons(event) {
        if (!eligible.has(event)) return ['ordinary-page'];
        if (event._stepAnime) return ['step-animation'];
        return active(event) ? ['active-effect-or-movement'] : [];
      }
      function attach(map) {
        var state = schedules.get(map);
        if (state && state.events === map._events) return state;
        if (state) state.models.dispose();
        state = { events: map._events, commonUpdates: 0 };
        var models = PMJS.mv.createUpdateSchedule({
          active: active,
          needsUpdate: function(event) { return event.update !== composedUpdate; },
          reasons: reasons,
          diagnostics: diagnosticsEnabled,
          counters: [
            { name: '_stopCount', rate: 1 },
            { name: '_alertLock', rate: function(event) { return event._erased ? 0 : -1; } }
          ],
          registered: function (record) {
            qualify(record.object);
            owners.set(record.object, record);
          },
          retired: function (event) {
            owners.delete(event);
            eligible.delete(event);
          }
        });
        state.models = models;
        schedules.set(map, state);
        map._events.forEach(function (event, index) {
          if (event) models.register(event, index);
        });
        return state;
      }
      function synchronize(event) {
        var r = owners.get(event);
        if (r) r.synchronize();
      }
      function notify(event) {
        var r = owners.get(event);
        if (r) {
          qualify(event);
          r.wake();
        }
      }
      function writer(name, after) {
        var prototype = Game_Event.prototype;
        while (prototype && !Object.hasOwn(prototype, name))
          prototype = Object.getPrototypeOf(prototype);
        var original = prototype && prototype[name];
        if (typeof original !== 'function') return;
        prototype[name] = function () {
          var record = owners.get(this);
          if (record) record.synchronize();
          var result = original.apply(this, arguments);
          if (after) after(this);
          if (record && !record.queued) notify(this);
          return result;
        };
      }
      Game_CharacterBase.prototype.resetStopCount = function () {
        synchronize(this);
        this._stopCount = 0;
      };
      var checkStop = Game_CharacterBase.prototype.checkStop;
      Game_CharacterBase.prototype.checkStop = function() {
        synchronize(this);
        return checkStop.apply(this, arguments);
      };
      writer('erase');
      writer('setupPage', qualify);
      for (var name of [
        'forceMoveRoute',
        'locate',
        'jump',
        'moveStraight',
        'moveDiagonally',
        'lock',
        'unlock',
        'setPosition',
        'setImage',
        'setTileImage',
        'setStepAnime',
        'setPattern',
        'setMoveSpeed',
        'startSpin',
        'startCustomFrameAnimation',
        'setTarget'
      ])
        writer(name);
      if (globalThis.Fuku_Plugins && Fuku_Plugins.EventTremble) {
        for (var name of ['startObject', 'stopObject']) {
          (function (name, original) {
            Fuku_Plugins.EventTremble[name] = function (event) {
              var record = owners.get(event);
              if (record) record.synchronize();
              var result = original.apply(this, arguments);
              if (record && !record.queued) notify(event);
              return result;
            };
          })(name, Fuku_Plugins.EventTremble[name]);
        }
      }
      var setupEvents = Game_Map.prototype.setupEvents;
      Game_Map.prototype.setupEvents = function () {
        var state = schedules.get(this);
        if (state) state.models.dispose();
        schedules.delete(this);
        return setupEvents.apply(this, arguments);
      };
      Game_Map.prototype.updateEvents = function () {
        var state = attach(this);
        state.models.run();
        this._commonEvents.forEach(function (event) {
          event.update();
        });
        state.commonUpdates += this._commonEvents.length;
      };
      function replace(map, index, event) {
        var state = attach(map),
          old = map._events[index];
        if (old === event) return;
        if (old) state.models.unregister(old);
        map._events[index] = event;
        if (event) state.models.register(event, index);
      }
      if (typeof Game_Map.prototype.spawnEvent === 'function') {
        var spawnEvent = Game_Map.prototype.spawnEvent;
        Game_Map.prototype.spawnEvent = function () {
          var state = attach(this),
            index = this._spawnedEvents.length + Yanfly.Param.EventSpawnerID;
          var old = this._events[index],
            result = spawnEvent.apply(this, arguments);
          if (old) state.models.unregister(old);
          state.models.register(this._events[index], index);
          return result;
        };
      }
      if (typeof Game_Map.prototype.restoreSpawnedEvents === 'function') {
        var restoreSpawnedEvents = Game_Map.prototype.restoreSpawnedEvents;
        Game_Map.prototype.restoreSpawnedEvents = function () {
          var map = this,
            state = attach(this),
            previous = [];
          this._spawnedEvents.forEach(function (event, index) {
            if (event)
              previous.push([
                index + Yanfly.Param.EventSpawnerID,
                map._events[index + Yanfly.Param.EventSpawnerID]
              ]);
          });
          var result = restoreSpawnedEvents.apply(this, arguments);
          previous.forEach(function (pair) {
            if (pair[1] && pair[1] !== map._events[pair[0]]) state.models.unregister(pair[1]);
            state.models.register(map._events[pair[0]], pair[0]);
          });
          return result;
        };
      }
      function materialize() {
        var state = globalThis.$gameMap && schedules.get($gameMap);
        if (state) state.models.materialize();
      }
      for (var pair of [
        [DataManager, 'makeSaveContents'],
        [globalThis.JsonEx, 'stringify']
      ]) {
        if (pair[0] && typeof pair[0][pair[1]] === 'function') {
          (function (object, name, original) {
            object[name] = function () {
              materialize();
              return original.apply(this, arguments);
            };
          })(pair[0], pair[1], pair[0][pair[1]]);
        }
      }
      PMJS.mv.eventUpdateSchedule = {
        notify: notify,
        synchronize: synchronize,
        materialize: materialize,
        replace: replace,
        startingChanged: function () {},
        setDiagnostics: function (enabled) {
          diagnosticsEnabled = !!enabled;
          if (globalThis.$gameMap) attach($gameMap).models.setDiagnostics(diagnosticsEnabled);
        },
        diagnostics: function () {
          var map = globalThis.$gameMap,
            state = map && schedules.get(map);
          return state
            ? Object.assign(
                {
                  installed: true,
                  scope: 'passive-pages',
                  mapId: map.mapId(),
                  models: state.models.diagnostics()
                },
                state.models.stats
              )
            : { installed: true, updates: 0 };
        },
        stats: function (map) {
          var state = schedules.get(map);
          return (
            state && { models: state.models.stats, parallels: { updates: state.commonUpdates } }
          );
        }
      };
    }
  });
})();
