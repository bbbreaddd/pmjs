#include "mv_engine.hpp"

namespace pmjs::mv {
bool Session::systemEventCommand(const Value& entry) {
  const auto& parameters = entry["parameters"];
  switch (entry["code"].integer()) {
    case 132: system_.battleBgm = parameters[0]; return true;
    case 133: system_.victoryMe = parameters[0]; return true;
    case 134: system_.saveEnabled = parameters[0].integer() != 0; return true;
    case 135: system_.menuEnabled = parameters[0].integer() != 0; return true;
    case 136:
      system_.encounterEnabled = parameters[0].integer() != 0;
      encounterCount_ = randomInt(map()["encounterStep"].integer(30)) + randomInt(map()["encounterStep"].integer(30)) + 1;
      return true;
    case 137: system_.formationEnabled = parameters[0].integer() != 0; return true;
    case 138: system_.windowTone = parameters[0]; return true;
    case 139: system_.defeatMe = parameters[0]; return true;
    case 140: {
      const int vehicle = parameters[0].integer();
      if (vehicle >= 0 && vehicle < 3) system_.vehicleBgm[vehicle] = parameters[1];
      return true;
    }
    case 241: audio("bgm", parameters[0]); return true;
    case 242:
      savedBgm_ = Value::Object{{"name", ""}, {"volume", 0}, {"pitch", 0}, {"pan", 0}, {"pos", 0}};
      audio("fade-bgm", parameters[0]); return true;
    case 243:
      system_.storedBgm = savedBgm_.null() ? Value(Value::Object{{"name", ""}, {"volume", 0}, {"pitch", 0}, {"pan", 0}, {"pos", 0}}) : savedBgm_;
      audio("save-bgm", {}); return true;
    case 244:
      if (!system_.storedBgm.null()) { savedBgm_ = system_.storedBgm; audio("replay-bgm", {}); }
      return true;
    case 245: audio("bgs", parameters[0]); return true;
    case 246:
      savedBgs_ = Value::Object{{"name", ""}, {"volume", 0}, {"pitch", 0}, {"pan", 0}, {"pos", 0}};
      audio("fade-bgs", parameters[0]); return true;
    case 249: audio("me", parameters[0]); return true;
    case 250: audio("se", parameters[0]); return true;
    case 251: audio("stop-se", {}); return true;
    default: return false;
  }
}
}  // namespace pmjs::mv
