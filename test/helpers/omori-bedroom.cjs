'use strict';
function bedroom() {
  const data = Array(33 * 55).fill(0);
  for (const [x, y, gid] of [[14, 16, 311], [14, 17, 327], [14, 19, 274], [14, 20, 290],
    [16, 19, 308], [16, 20, 324], [18, 19, 275], [18, 20, 291]]) data[y * 33 + x] = gid;
  data[0] = 42;
  const events = Array(80).fill(null); events[79] = { id: 79, name: 'Existing event', pages: [] };
  return { map: { width: 33, height: 55, events }, tiled: { width: 33, height: 55,
    tilesets: [{ firstgid: 153, source: 'DW_NEIGHBORS_ROOM.json' }],
    layers: [{ name: 'GROUND - IV', type: 'tilelayer', data }] } };
}
module.exports = { bedroom };
