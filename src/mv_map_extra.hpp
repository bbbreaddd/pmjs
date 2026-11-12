#pragma once

#include "mv_engine.hpp"
#include <vector>

namespace pmjs::mv {

class MapMechanics {
 public:
  static int tileId(const Session& session, int x, int y, int z);
  static std::vector<int> layeredTiles(const Session& session, int x, int y);
  static int autotileType(const Session& session, int x, int y, int z);
  static bool isPassable(const Session& session, int x, int y, int d);
  static std::vector<int> eventsXy(const Session& session, int x, int y);
  static std::vector<int> eventsXyNt(const Session& session, int x, int y);
  static bool isBoatPassable(const Session& session, int x, int y);
  static bool isShipPassable(const Session& session, int x, int y);
  static bool isAirshipLandOk(const Session& session, int x, int y);
  static bool isDamageFloor(const Session& session, int x, int y);
  static bool isLadder(const Session& session, int x, int y);
  static bool isBush(const Session& session, int x, int y);
  static bool isCounter(const Session& session, int x, int y);
  static bool checkLayeredTilesFlags(const Session& session, int x, int y, int bit);
  static int terrainTag(const Session& session, int x, int y);
  static int regionId(const Session& session, int x, int y);
  static int eventIdAt(const Session& session, int x, int y);
  static int canvasToMapX(const Session& session, double x);
  static int canvasToMapY(const Session& session, double y);

  // Tilemap autotile helpers (rpg_core.js Tilemap)
  static bool isTileA1(int tileId);
  static bool isTileA2(int tileId);
  static bool isTileA3(int tileId);
  static bool isTileA4(int tileId);
  static bool isTileA5(int tileId);
  static bool isWaterTile(int tileId);
  static bool isWaterfallTile(int tileId);
  static bool isShadowingTile(int tileId);
  static int getAutotileKind(int tileId);
  static int getAutotileShape(int tileId);
};

}  // namespace pmjs::mv

