#include "mv_engine.hpp"
#include "mv_managers.hpp"

#include <algorithm>
#include <cmath>

namespace pmjs::mv {

namespace {
int itemBasePrice(const Value& database, int kind, int id) {
  const auto& table = database[kind == 0 ? "items" : kind == 1 ? "weapons" : "armors"];
  if (id < 0 || id >= static_cast<int>(table.array().size()) || table[id].null()) return 0;
  return table[id]["price"].integer(0);
}
}  // namespace

bool Session::shopEventCommand(const Value& entry, Interpreter& context) {
  if (entry["code"].integer() != 302) return false;
  if (battle_.active) return true;

  const auto& p = entry["parameters"];
  SceneManager::pushScene(*this, Scene::shop);
  ui_.shopPurchaseOnly = p.array().size() > 4 ? p[4].boolean() : false;
  ui_.shopGoods.clear();

  auto addGood = [&](const Value::Array& params) {
    if (params.size() < 2) return;
    ShopGood good;
    good.kind = params[0].integer(); // 0: item, 1: weapon, 2: armor
    good.id = params[1].integer();
    const int priceType = params.size() > 2 ? params[2].integer() : 0;
    if (priceType == 0) {
      good.price = itemBasePrice(database_, good.kind, good.id);
    } else {
      good.price = params.size() > 3 ? params[3].integer() : 0;
    }
    ui_.shopGoods.push_back(good);
  };

  addGood(p.array());

  while (context.index + 1 < static_cast<int>(context.list.size()) &&
         context.list[context.index + 1]["code"].integer() == 605) {
    ++context.index;
    addGood(context.list[context.index]["parameters"].array());
  }

  return true;
}

}  // namespace pmjs::mv
