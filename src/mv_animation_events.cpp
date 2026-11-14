#include "mv_engine.hpp"

namespace pmjs::mv {

bool Session::animationEventCommand(const EventCommand& entry, Interpreter& context) {
  const int code = entry.code;
  const auto& p = entry.parameters;

  switch (code) {
    case 212: case 213: {
      if (battle_.active) return true;
      const int target=p[0].integer();
      if(!routeCharacter(target,context))return true;
      const int serial=requestAnimation(0,target==0?context.eventId:target,p[1].integer(),false,code==213);
      if(p[2].boolean())context.waitingEffect=serial;
      return true;
    }
    case 337: {
      const int index = p[2].boolean() ? -1 : p[0].integer();
      for (std::size_t i=0; i<battle_.enemies.size(); ++i) {
        if (index >= 0 && index != static_cast<int>(i)) continue;
        const auto& enemy = battle_.enemies[i];
        if (!enemy.hidden && enemy.hp > 0 &&
            std::find(enemy.states.begin(), enemy.states.end(), 1) == enemy.states.end()) {
          requestAnimation(2, static_cast<int>(i), p[1].integer());
        }
      }
      return true;
    }
    case 261: { // Play Movie
      if (message_.busy) return false;
      if (!p[0].text().empty()) { movieName_ = p[0].text(); movieExplicitSource_ = false; ++movieRequest_; moviePlaying_ = true; context.waitingVideo = true; }
      return true;
    }
    default:
      return false;
  }
}

}  // namespace pmjs::mv

