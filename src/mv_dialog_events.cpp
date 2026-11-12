#include "mv_engine.hpp"
#include "mv_managers.hpp"

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
      ui_.variableId = varId;
      ui_.maxDigits = digits; ui_.digitIndex = 0;
      int initialValue = variable(varId).integer();
      if (initialValue < 0) initialValue = 0;
      const int maxVal = static_cast<int>(std::pow(10, digits)) - 1;
      ui_.numberInput = std::clamp(initialValue, 0, maxVal);
      message_.busy = true;
      messageAge_ = 0;
      return true;
    }
    case 104: { // Select Item
      const int varId = p[0].integer();
      const int itypeId = p.array().size() > 1 ? p[1].integer() : 1;
      ui_.variableId = varId;
      ui_.category = itypeId;
      ui_.cursor = 0;
      message_.busy = true;
      messageAge_ = 0;
      return true;
    }
    case 105: { // Show Scrolling Text
      message_ = {};
      message_.busy = true; message_.scrolling = true;
      message_.scrollSpeed = p[0].number(2)/2; message_.scrollNoFast = p[1].boolean();
      message_.scrollY = -database_["sceneContract"]["height"].number(624);
      messageAge_ = 0;
      ui_.cursor = 0;
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
      ui_.nameInput = actors_.at(actorId).name;
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
      }
      return true;
    }
    case 217: { // Gather Followers
      if (battle_.active) return true;
      for (auto& follower : followers_) {
        follower.x = player_.x;
        follower.y = player_.y;
        follower.realX = player_.realX;
        follower.realY = player_.realY;
        follower.direction = player_.direction;
      }
      return true;
    }
    default:
      return false;
  }
}

}  // namespace pmjs::mv
