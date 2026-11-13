#include "mv_engine.hpp"
#include "mv_managers.hpp"
#include "mv_windows.hpp"

#include <algorithm>
#include <cmath>

namespace pmjs::mv {

bool Session::dialogEventCommand(const Value& entry, Interpreter& context) {
  const int code = entry["code"].integer();
  const auto& p = entry["parameters"];

  switch (code) {
    case 103: { // Input Number
      const int varId = p[0].integer();
      const int digits = std::clamp(p[1].integer(), 1, 8);
      message_.numberVariableId = varId;
      message_.numberDigits = digits;
      message_.busy = true;
      messageAge_ = 0;
      return true;
    }
    case 104: { // Select Item
      const int varId = p[0].integer();
      const int itypeId = (p.array().size() > 1 && p[1].integer() != 0) ? p[1].integer() : 2;
      message_.itemVariableId = varId;
      message_.itemType = itypeId;
      message_.busy = true;
      messageAge_ = 0;
      return true;
    }
    case 105: { // Show Scrolling Text
      message_ = {};
      message_.busy = true; message_.scrolling = true;
      message_.scrollSpeed = p[0].number(2)/2; message_.scrollNoFast = p[1].boolean();
      message_.scrollY = -static_cast<double>(screenHeight_);
      messageAge_ = 0;
      while (context.index + 1 < static_cast<int>(context.list.size()) &&
             context.list[context.index + 1]["code"].integer() == 405) {
        ++context.index;
        message_.lines.push_back(context.list[context.index]["parameters"][0]);
      }
      return true;
    }
    case 303: { // Name Input Processing
      if (battle_.active) return true;
      const int actorId = p[0].integer();
      const int maxChars = p[1].integer();
      if (database_["actors"][actorId].null()) return true;
      if (!actors_.contains(actorId)) initializeActor(actorId);
      SceneManager::pushScene(*this, Scene::name);
      ui_.nameActorId = actorId;
      ui_.nameMaxLength = std::max(1, maxChars);
      ui_.nameInput = Window_NameEdit::initialName(actors_.at(actorId).name, ui_.nameMaxLength);
      return true;
    }
    case 351: { // Open Menu Screen
      if (!battle_.active) {
        SceneManager::pushScene(*this, Scene::menu);
      }
      return true;
    }
    case 352: { // Open Save Screen
      if (!battle_.active) {
        SceneManager::pushScene(*this, Scene::save);
        ui_.cursor = std::max(0, lastAccessedSavefileId_ - 1);
      }
      return true;
    }
    default:
      return false;
  }
}

}  // namespace pmjs::mv
