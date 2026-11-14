#include "mv_engine.hpp"
#include "mv_core_utils.hpp"

namespace pmjs::mv {
bool Session::systemEventCommand(const EventCommand& entry) {
  const auto& parameters = entry.parameters;
  switch (entry.code) {
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
    case 241: AudioManager::playBgm(*this, parameters[0]); return true;
    case 242:
      savedBgm_ = AudioManager::makeEmptyAudioObject();
      AudioManager::fadeOutBgm(*this, parameters[0].integer()); return true;
    case 243:
      system_.storedBgm = savedBgm_.null() ? AudioManager::makeEmptyAudioObject() : savedBgm_;
      audio("save-bgm", {}); return true;
    case 244:
      if (!system_.storedBgm.null()) { savedBgm_ = system_.storedBgm; audio("replay-bgm", {}); }
      return true;
    case 245: AudioManager::playBgs(*this, parameters[0]); return true;
    case 246:
      savedBgs_ = AudioManager::makeEmptyAudioObject();
      AudioManager::fadeOutBgs(*this, parameters[0].integer()); return true;
    case 249: AudioManager::playMe(*this, parameters[0]); return true;
    case 250: AudioManager::playSe(*this, parameters[0]); return true;
    case 251: AudioManager::stopSe(*this); return true;
    default: return false;
  }
}
}  // namespace pmjs::mv
