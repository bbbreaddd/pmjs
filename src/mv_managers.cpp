#include "mv_managers.hpp"
#include "mv_core_utils.hpp"

#include <algorithm>
#include <cctype>

namespace pmjs::mv {

std::map<std::string, PluginManager::CommandHandler> PluginManager::commands_;
std::map<std::string, Value> PluginManager::parameters_;
std::vector<std::string> PluginManager::scripts_;

namespace {
std::string toLowerAscii(std::string text) {
  for (char& ch : text) ch = static_cast<char>(std::tolower(static_cast<unsigned char>(ch)));
  return text;
}
}

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

bool SceneManager::isCurrentScene(const Session& session, Scene scene) {
  return session.ui_.scene == scene;
}

bool SceneManager::isPreviousScene(const Session& session, Scene scene) {
  return !session.sceneStack_.empty() && session.sceneStack_.back().scene == scene;
}

void SceneManager::stop(Session& session) {
  session.finished_ = true;
}

void SceneManager::resume(Session& session) {
  session.finished_ = false;
}

void SceneManager::exit(Session& session) {
  clearStack(session);
  stop(session);
}

std::string SceneManager::preferableRendererType() {
  return "webgl";
}

bool SceneManager::shouldUseCanvasRenderer() {
  return false;
}

void SoundManager::preloadImportantSounds(Session& session) {
  for (int index = 0; index < 4; ++index) loadSystemSound(session, index);
}

bool SoundManager::loadSystemSound(Session& session, int index) {
  const auto& sounds = session.database()["system"]["sounds"];
  if (index < 0 || index >= static_cast<int>(sounds.array().size())) return false;
  return !sounds[index].null() && !sounds[index]["name"].text().empty();
}

void SoundManager::playSystemSound(Session& session, int index) {
  const auto& sounds = session.database()["system"]["sounds"];
  if (index >= 0 && index < static_cast<int>(sounds.array().size())) {
    AudioManager::playSe(session, sounds[index]);
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

std::string TextManager::format(const std::string& text, const std::vector<std::string>& args) {
  std::string out;
  out.reserve(text.size());
  for (std::size_t i = 0; i < text.size(); ++i) {
    if (text[i] == '%' && i + 1 < text.size() && std::isdigit(static_cast<unsigned char>(text[i + 1]))) {
      std::size_t end = i + 1;
      std::size_t index = 0;
      while (end < text.size() && std::isdigit(static_cast<unsigned char>(text[end]))) {
        index = index * 10 + static_cast<std::size_t>(text[end] - '0');
        ++end;
      }
      if (index >= 1 && index <= args.size()) {
        out += args[index - 1];
      }
      i = end - 1;
    } else {
      out.push_back(text[i]);
    }
  }
  return out;
}

void PluginManager::setup(const Value& plugins) {
  parameters_.clear();
  scripts_.clear();
  for (const auto& plugin : plugins.array()) {
    const std::string name = plugin["name"].text();
    if (plugin["status"].boolean() && !name.empty() &&
        std::find(scripts_.begin(), scripts_.end(), name) == scripts_.end()) {
      setParameters(name, plugin["parameters"]);
      scripts_.push_back(name);
    }
  }
}

const Value& PluginManager::parameters(const std::string& name) {
  static const Value kEmpty;
  auto it = parameters_.find(toLowerAscii(name));
  return it != parameters_.end() ? it->second : kEmpty;
}

void PluginManager::setParameters(const std::string& name, const Value& parameters) {
  parameters_[toLowerAscii(name)] = parameters;
}

const std::vector<std::string>& PluginManager::scripts() {
  return scripts_;
}

void PluginManager::clear() {
  parameters_.clear();
  scripts_.clear();
  commands_.clear();
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

