'use strict';

const command = (code, parameters = [], indent = 0) => ({ code, parameters, indent });
const variable = (id, value) => command(122, [id, id, 0, 0, value]);

function fixture(program) {
  const actor = id => ({ id, name: `Actor ${id}`, classId: 1, initialLevel: 1, equips: [1, 0, 1, 0, 0] });
  return {
    system: { startMapId: 1, startX: 1, startY: 1, partyMembers: [1], variables: Array(100).fill(''),
      equipTypes: ['', 'Weapon', 'Shield', 'Head', 'Body', 'Accessory'] },
    actors: [null, actor(1), actor(2)],
    classes: [null, { params: Array.from({ length: 8 }, () => [0, 10]), learnings: [{ level: 1, skillId: 2 }],
      traits: [{ code: 51, dataId: 1, value: 1 }, { code: 52, dataId: 1, value: 1 }] }],
    skills: [null, { id: 1 }, { id: 2 }], items: [null, { id: 1 }],
    weapons: [null, { id: 1, etypeId: 1, wtypeId: 1, params: Array(8).fill(0) }],
    armors: [null, { id: 1, etypeId: 3, atypeId: 1, params: Array(8).fill(0) }],
    states: [null, { id: 1 }], tilesets: [null, { flags: [0] }],
    commonEvents: [null, { id: 1, list: [command(122, [20, 20, 1, 0, 1]), command(115), variable(20, 999), command(0)] }],
    maps: { 1: { width: 5, height: 5, data: Array(150).fill(0), tilesetId: 1,
      events: [null, { id: 1, x: 3, y: 1, pages: [
        { conditions: {}, trigger: 3, priorityType: 1, image: { direction: 2, pattern: 1 },
          list: [...program, command(123, ['A', 0]), command(0)] },
        { conditions: { selfSwitchValid: true, selfSwitchCh: 'A' }, trigger: 0,
          priorityType: 1, image: { direction: 2, pattern: 1 }, list: [command(0)] },
      ] }] } },
  };
}

module.exports = { fixture, command, variable };
