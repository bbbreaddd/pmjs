#pragma once
#include "mv_engine.hpp"

namespace pmjs::mv {
Value compileTiledMap(const Value& map, bool halfTile);
Value tiledObjects(const Value& map, bool halfTile);
void visitTiledCells(const Value& map, bool halfTile, const std::string& table, const std::function<void(int,int,int)>& write);
Value tiledReflections(const Value& areas, double x, double y);
}
