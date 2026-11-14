#include "mv_engine.hpp"
#include "mv_managers.hpp"
#include "mv_windows.hpp"

#include <algorithm>
#include <cmath>

namespace pmjs::mv {

namespace {
int itemBasePrice(const Value& database, int kind, int id) {
  if (kind < 0 || kind > 2) return 0;
  const auto& table = database[kind == 0 ? "items" : kind == 1 ? "weapons" : "armors"];
  if (id < 0 || id >= static_cast<int>(table.array().size()) || table[id].null()) return 0;
  return table[id]["price"].integer(0);
}
}  // namespace

std::vector<ShopGood> Session::shopItems(bool selling) const {
  if (!selling) return ui_.shopGoods;
  std::vector<ShopGood> goods;
  static const std::array<std::string, 4> categories{"item", "weapon", "armor", "keyItem"};
  for (const auto& [key, count] : inventory_) {
    if (count <= 0) continue;
    const int kind = key / 100000, id = key % 100000;
    if (!Window_ItemList::includes(*this, categories[std::clamp(ui_.slot, 0, 3)], kind, id)) continue;
    goods.push_back({kind, id, static_cast<int>(std::floor(itemBasePrice(database_, kind, id) / 2.0))});
  }
  return goods;
}

int Session::shopMaximum(const ShopGood& good, bool selling, int money) const {
  if (good.kind < 0 || good.kind > 2 || good.id <= 0) return 0;
  const auto& item = database_[good.kind == 0 ? "items" : good.kind == 1 ? "weapons" : "armors"][good.id];
  if (item.null()) return 0;
  const auto found = inventory_.find(good.kind * 100000 + good.id);
  const int owned = found == inventory_.end() ? 0 : found->second;
  if (selling) return item["price"].number() > 0 ? owned : 0;
  if (good.price > money) return 0;
  return std::max(0, std::min(99 - owned, good.price > 0 ? money / good.price : 99));
}

void Session::updateShop(bool ok, bool cancel, int direction, bool pageUp, bool pageDown) {
  const auto sound = [&](int id) { SoundManager::playSystemSound(*this, id); };
  const bool shift = currentInput_.dash || currentInput_.pressed.contains("shift");
  const bool shiftTriggered = shift && !ui_.shopStatusShiftHeld;
  ui_.shopStatusShiftHeld = shift;
  const bool statusVisible = ui_.category == 1 || ui_.category == 3;
  const bool statusTouched = currentInput_.touchTriggered && currentInput_.touchX && currentInput_.touchY &&
    *currentInput_.touchX >= 456 && *currentInput_.touchX < core::Graphics::boxWidth &&
    *currentInput_.touchY >= 180 && *currentInput_.touchY < core::Graphics::boxHeight;
  if (statusVisible && Window_ShopStatus::maxPages(*this) >= 2 && (shiftTriggered || statusTouched)) {
    ui_.shopStatusPage = Window_ShopStatus::nextPage(*this,ui_.shopStatusPage);
    sound(0);
  }
  const auto leave = [&](bool confirmed = false) {
    if (SceneManager::hasPrevious(*this)) SceneManager::popScene(*this);
    else SceneManager::gotoScene(*this, Scene::map);
    sound(confirmed ? 1 : 2);
  };
  if (ui_.category == 0) {
    const auto commands = Window_ShopCommand::makeCommands(*this, ui_.shopPurchaseOnly);
    const int previous = ui_.cursor;
    int topRow = 0;
    Window_Selectable::moveCursor(ui_.cursor, topRow, static_cast<int>(commands.size()), 3, 1, direction, directionAge_ == 0);
    if (previous != ui_.cursor) sound(0);
    if (cancel) leave();
    else if (ok) {
      const auto& command = commands.at(ui_.cursor);
      if (!command.enabled) sound(3);
      else if (command.symbol == "cancel") leave(true);
      else { ui_.category = command.symbol == "buy" ? 1 : 4; ui_.cursor = 0; ui_.slot = 0; ui_.listTopRow = 0; sound(1); }
    }
    return;
  }
  if (ui_.category == 4) {
    const int previous = ui_.cursor;
    int topRow = 0;
    Window_Selectable::moveCursor(ui_.cursor, topRow, 4, 4, 1, direction, directionAge_ == 0);
    ui_.slot = ui_.cursor;
    if (previous != ui_.cursor) { ui_.listTopRow = 0; sound(0); }
    if (cancel) { ui_.category = 0; ui_.cursor = 1; sound(2); }
    else if (ok) { ui_.category = 2; ui_.cursor = 0; ui_.listTopRow = 0; sound(1); }
    return;
  }
  if (ui_.category == 3) {
    if (direction && !ok && !cancel) {
      const int previous = ui_.shopItemCount;
      const int change = direction == 6 ? 1 : direction == 4 ? -1 : direction == 8 ? 10 : -10;
      ui_.shopItemCount = Window_ShopNumber::changeNumber(ui_.shopItemCount, change, ui_.shopMaxNumber);
      if (previous != ui_.shopItemCount) sound(0);
    }
    if (cancel) { ui_.category = ui_.shopSelling ? 2 : 1; ui_.cursor = ui_.listCursor; sound(2); }
    else if (ok) {
      const auto total = static_cast<std::int64_t>(ui_.shopItemCount) * ui_.shopPrice;
      gold_ = static_cast<int>(std::clamp<std::int64_t>(gold_ + (ui_.shopSelling ? total : -total), 0, 99999999));
      gainItem(ui_.shopKind, ui_.shopId, ui_.shopSelling ? -ui_.shopItemCount : ui_.shopItemCount, false);
      ui_.category = ui_.shopSelling ? 2 : 1; ui_.cursor = ui_.listCursor; sound(21);
    }
    return;
  }
  const bool selling = ui_.category == 2;
  const auto choices = shopItems(selling);
  const int columns = selling ? 2 : 1, count = static_cast<int>(choices.size());
  const int previous = ui_.cursor;
  ui_.cursor = std::clamp(ui_.cursor, 0, std::max(0, count - 1));
  ui_.listTopRow = Window_Selectable::clampTopRow(ui_.listTopRow, count, columns, ui_.listPageRows);
  if (direction) Window_Selectable::moveCursor(ui_.cursor, ui_.listTopRow, count, columns, ui_.listPageRows, direction, directionAge_ == 0);
  if (pageDown || pageUp) Window_Selectable::pageCursor(ui_.cursor, ui_.listTopRow, count, columns, ui_.listPageRows, pageDown);
  if (previous != ui_.cursor) sound(0);
  ui_.listTopRow = Window_Selectable::wheelTopRow(ui_.listTopRow, count, columns, ui_.listPageRows, currentInput_.wheelY);
  if (cancel) { ui_.category = selling ? 4 : 0; ui_.cursor = selling ? ui_.slot : 0; sound(2); }
  else if (ok && !choices.empty()) {
    const auto& good = choices[ui_.cursor];
    const int maximum = shopMaximum(good, selling, gold_);
    if (maximum <= 0) { sound(3); return; }
    ui_.shopSelling = selling; ui_.shopKind = good.kind; ui_.shopId = good.id; ui_.shopPrice = good.price;
    ui_.shopMaxNumber = maximum; ui_.shopItemCount = 1; ui_.listCursor = ui_.cursor; ui_.category = 3; sound(1);
  }
}

bool Session::shopEventCommand(const Value& entry, Interpreter& context) {
  if (entry["code"].integer() != 302) return false;
  if (battle_.active) {
    while (context.index + 1 < static_cast<int>(context.list.size()) &&
           context.list[context.index + 1]["code"].integer() == 605) {
      ++context.index;
    }
    return true;
  }

  const auto& p = entry["parameters"];
  SceneManager::pushScene(*this, Scene::shop);
  ui_.shopPurchaseOnly = p.array().size() > 4 ? p[4].boolean() : false;
  ui_.shopGoods.clear();

  auto addGood = [&](const Value::Array& params) {
    if (params.size() < 2) return;
    ShopGood good;
    good.kind = params[0].integer(); // 0: item, 1: weapon, 2: armor
    good.id = params[1].integer();
    if (good.kind < 0 || good.kind > 2 || good.id <= 0 ||
        database_[good.kind == 0 ? "items" : good.kind == 1 ? "weapons" : "armors"][good.id].null()) return;
    const int priceType = params.size() > 2 ? params[2].integer() : 0;
    if (priceType == 0) {
      good.price = itemBasePrice(database_, good.kind, good.id);
    } else {
      good.price = params.size() > 3 ? params[3].integer() : 0;
    }
    const auto previous = std::find_if(ui_.shopGoods.begin(), ui_.shopGoods.end(), [&](const ShopGood& other) { return other.kind == good.kind && other.id == good.id; });
    if (previous != ui_.shopGoods.end()) good.price = previous->price;
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
