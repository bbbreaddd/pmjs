#include "mv_managers.hpp"

namespace pmjs::mv {

std::map<std::string, PluginManager::CommandHandler> PluginManager::commands_;
std::map<std::string, Value> PluginManager::parameters_;

void SceneManager::gotoScene(Session& session, Scene scene) {
  session.ui_ = {}; session.ui_.scene = scene;
}

void SceneManager::pushScene(Session& session, Scene scene) {
  session.sceneStack_.push_back(session.ui_);
  gotoScene(session, scene);
}

void SceneManager::popScene(Session& session) {
  if (!session.sceneStack_.empty()) {
    session.ui_ = session.sceneStack_.back();
    session.sceneStack_.pop_back();
  }
}

void SceneManager::clearStack(Session& session) {
  session.sceneStack_.clear();
}

bool SceneManager::hasPrevious(const Session& session) {
  return !session.sceneStack_.empty();
}

void SoundManager::playSystemSound(Session& session, int index) {
  const auto& sounds = session.database()["system"]["sounds"];
  if (index >= 0 && index < static_cast<int>(sounds.array().size())) {
    session.audio("se", sounds[index]);
  }
}

void SoundManager::playCursor(Session& session) { playSystemSound(session, 0); }
void SoundManager::playOk(Session& session) { playSystemSound(session, 1); }
void SoundManager::playCancel(Session& session) { playSystemSound(session, 2); }
void SoundManager::playBuzzer(Session& session) { playSystemSound(session, 3); }
void SoundManager::playEquip(Session& session) { playSystemSound(session, 4); }
void SoundManager::playSave(Session& session) { playSystemSound(session, 5); }
void SoundManager::playLoad(Session& session) { playSystemSound(session, 6); }
void SoundManager::playBattleStart(Session& session) { playSystemSound(session, 7); }
void SoundManager::playEscape(Session& session) { playSystemSound(session, 8); }
void SoundManager::playEnemyAttack(Session& session) { playSystemSound(session, 9); }
void SoundManager::playEnemyDamage(Session& session) { playSystemSound(session, 10); }
void SoundManager::playEnemyCollapse(Session& session) { playSystemSound(session, 11); }
void SoundManager::playBossCollapse1(Session& session) { playSystemSound(session, 12); }
void SoundManager::playBossCollapse2(Session& session) { playSystemSound(session, 13); }
void SoundManager::playActorDamage(Session& session) { playSystemSound(session, 14); }
void SoundManager::playActorCollapse(Session& session) { playSystemSound(session, 15); }
void SoundManager::playRecovery(Session& session) { playSystemSound(session, 16); }
void SoundManager::playMiss(Session& session) { playSystemSound(session, 17); }
void SoundManager::playEvasion(Session& session) { playSystemSound(session, 18); }
void SoundManager::playMagicEvasion(Session& session) { playSystemSound(session, 19); }
void SoundManager::playReflection(Session& session) { playSystemSound(session, 20); }
void SoundManager::playShop(Session& session) { playSystemSound(session, 21); }
void SoundManager::playUseItem(Session& session) { playSystemSound(session, 22); }
void SoundManager::playUseSkill(Session& session) { playSystemSound(session, 23); }

std::string TextManager::currencyUnit(const Session& session) {
  return session.database()["system"]["currencyUnit"].text();
}

std::string TextManager::term(const Session& session, const std::string& section, int id) {
  const auto& terms = session.database()["system"]["terms"];
  return terms[section][id].text();
}

std::string TextManager::basic(const Session& session, int basicId) {
  return term(session, "basic", basicId);
}

std::string TextManager::param(const Session& session, int paramId) {
  return term(session, "params", paramId);
}

std::string TextManager::command(const Session& session, int commandId) {
  return term(session, "commands", commandId);
}

std::string TextManager::message(const Session& session, const std::string& key) {
  const auto& messages = session.database()["system"]["terms"]["messages"];
  return messages[key].text();
}

void PluginManager::setup(const Value& plugins) {
  parameters_.clear();
  for (const auto& plugin : plugins.array()) {
    if (plugin["status"].boolean()) {
      parameters_[plugin["name"].text()] = plugin["parameters"];
    }
  }
}

const Value& PluginManager::parameters(const std::string& name) {
  static const Value kEmpty;
  auto it = parameters_.find(name);
  return it != parameters_.end() ? it->second : kEmpty;
}

void PluginManager::registerCommand(const std::string& name, CommandHandler handler) {
  commands_[name] = std::move(handler);
}

bool PluginManager::callCommand(Session& session, const std::string& name, const std::vector<std::string>& args) {
  auto it = commands_.find(name);
  if (it != commands_.end()) {
    it->second(session, args);
    return true;
  }
  return false;
}

}  // namespace pmjs::mv

