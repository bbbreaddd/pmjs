#pragma once

#include "mv_engine.hpp"
#include <string>
#include <vector>
#include <map>
#include <functional>

namespace pmjs::mv {

class SceneManager {
 public:
  static void gotoScene(Session& session, Scene scene);
  static void pushScene(Session& session, Scene scene);
  static void popScene(Session& session);
  static void clearStack(Session& session);
  static bool hasPrevious(const Session& session);
  static bool isCurrentScene(const Session& session, Scene scene);
  static bool isPreviousScene(const Session& session, Scene scene);
  static void stop(Session& session);
  static void resume(Session& session);
  static void exit(Session& session);
  static std::string preferableRendererType();
  static bool shouldUseCanvasRenderer();
};

class SoundManager {
 public:
  static void preloadImportantSounds(Session& session);
  static bool loadSystemSound(Session& session, int index);
  static void playCursor(Session& session);
  static void playOk(Session& session);
  static void playCancel(Session& session);
  static void playBuzzer(Session& session);
  static void playEquip(Session& session);
  static void playSave(Session& session);
  static void playLoad(Session& session);
  static void playBattleStart(Session& session);
  static void playEscape(Session& session);
  static void playEnemyAttack(Session& session);
  static void playEnemyDamage(Session& session);
  static void playEnemyCollapse(Session& session);
  static void playBossCollapse1(Session& session);
  static void playBossCollapse2(Session& session);
  static void playActorDamage(Session& session);
  static void playActorCollapse(Session& session);
  static void playRecovery(Session& session);
  static void playMiss(Session& session);
  static void playEvasion(Session& session);
  static void playMagicEvasion(Session& session);
  static void playReflection(Session& session);
  static void playShop(Session& session);
  static void playUseItem(Session& session);
  static void playUseSkill(Session& session);
  static void playSystemSound(Session& session, int index);
};

class TextManager {
 public:
  static std::string currencyUnit(const Session& session);
  static std::string term(const Session& session, const std::string& section, int id);
  static std::string basic(const Session& session, int basicId);
  static std::string param(const Session& session, int paramId);
  static std::string command(const Session& session, int commandId);
  static std::string message(const Session& session, const std::string& key);
  static std::string format(const std::string& text, const std::vector<std::string>& args);

  static std::string level(const Session& s) { return basic(s, 0); }
  static std::string levelA(const Session& s) { return basic(s, 1); }
  static std::string hp(const Session& s) { return basic(s, 2); }
  static std::string hpA(const Session& s) { return basic(s, 3); }
  static std::string mp(const Session& s) { return basic(s, 4); }
  static std::string mpA(const Session& s) { return basic(s, 5); }
  static std::string tp(const Session& s) { return basic(s, 6); }
  static std::string tpA(const Session& s) { return basic(s, 7); }
  static std::string exp(const Session& s) { return basic(s, 8); }
  static std::string expA(const Session& s) { return basic(s, 9); }

  static std::string fight(const Session& s) { return command(s, 0); }
  static std::string escape(const Session& s) { return command(s, 1); }
  static std::string attack(const Session& s) { return command(s, 2); }
  static std::string guard(const Session& s) { return command(s, 3); }
  static std::string item(const Session& s) { return command(s, 4); }
  static std::string skill(const Session& s) { return command(s, 5); }
  static std::string equip(const Session& s) { return command(s, 6); }
  static std::string status(const Session& s) { return command(s, 7); }
  static std::string formation(const Session& s) { return command(s, 8); }
  static std::string save(const Session& s) { return command(s, 9); }
  static std::string gameEnd(const Session& s) { return command(s, 10); }
  static std::string options(const Session& s) { return command(s, 11); }
  static std::string weapon(const Session& s) { return command(s, 12); }
  static std::string armor(const Session& s) { return command(s, 13); }
  static std::string keyItem(const Session& s) { return command(s, 14); }
  static std::string equip2(const Session& s) { return command(s, 15); }
  static std::string optimize(const Session& s) { return command(s, 16); }
  static std::string clear(const Session& s) { return command(s, 17); }
  static std::string newGame(const Session& s) { return command(s, 18); }
  static std::string continueCmd(const Session& s) { return command(s, 19); }
  static std::string toTitle(const Session& s) { return command(s, 21); }
  static std::string cancel(const Session& s) { return command(s, 22); }
  static std::string buy(const Session& s) { return command(s, 24); }
  static std::string sell(const Session& s) { return command(s, 25); }

  static std::string alwaysDash(const Session& s) { return message(s, "alwaysDash"); }
  static std::string commandRemember(const Session& s) { return message(s, "commandRemember"); }
  static std::string bgmVolume(const Session& s) { return message(s, "bgmVolume"); }
  static std::string bgsVolume(const Session& s) { return message(s, "bgsVolume"); }
  static std::string meVolume(const Session& s) { return message(s, "meVolume"); }
  static std::string seVolume(const Session& s) { return message(s, "seVolume"); }
  static std::string possession(const Session& s) { return message(s, "possession"); }
  static std::string expTotal(const Session& s) { return message(s, "expTotal"); }
  static std::string expNext(const Session& s) { return message(s, "expNext"); }
  static std::string saveMessage(const Session& s) { return message(s, "saveMessage"); }
  static std::string loadMessage(const Session& s) { return message(s, "loadMessage"); }
  static std::string file(const Session& s) { return message(s, "file"); }
  static std::string partyName(const Session& s) { return message(s, "partyName"); }
  static std::string emerge(const Session& s) { return message(s, "emerge"); }
  static std::string preemptive(const Session& s) { return message(s, "preemptive"); }
  static std::string surprise(const Session& s) { return message(s, "surprise"); }
  static std::string escapeStart(const Session& s) { return message(s, "escapeStart"); }
  static std::string escapeFailure(const Session& s) { return message(s, "escapeFailure"); }
  static std::string victory(const Session& s) { return message(s, "victory"); }
  static std::string defeat(const Session& s) { return message(s, "defeat"); }
  static std::string obtainExp(const Session& s) { return message(s, "obtainExp"); }
  static std::string obtainGold(const Session& s) { return message(s, "obtainGold"); }
  static std::string obtainItem(const Session& s) { return message(s, "obtainItem"); }
  static std::string levelUp(const Session& s) { return message(s, "levelUp"); }
  static std::string obtainSkill(const Session& s) { return message(s, "obtainSkill"); }
  static std::string useItem(const Session& s) { return message(s, "useItem"); }
  static std::string criticalToEnemy(const Session& s) { return message(s, "criticalToEnemy"); }
  static std::string criticalToActor(const Session& s) { return message(s, "criticalToActor"); }
  static std::string actorDamage(const Session& s) { return message(s, "actorDamage"); }
  static std::string actorRecovery(const Session& s) { return message(s, "actorRecovery"); }
  static std::string actorGain(const Session& s) { return message(s, "actorGain"); }
  static std::string actorLoss(const Session& s) { return message(s, "actorLoss"); }
  static std::string actorDrain(const Session& s) { return message(s, "actorDrain"); }
  static std::string actorNoDamage(const Session& s) { return message(s, "actorNoDamage"); }
  static std::string actorNoHit(const Session& s) { return message(s, "actorNoHit"); }
  static std::string enemyDamage(const Session& s) { return message(s, "enemyDamage"); }
  static std::string enemyRecovery(const Session& s) { return message(s, "enemyRecovery"); }
  static std::string enemyGain(const Session& s) { return message(s, "enemyGain"); }
  static std::string enemyLoss(const Session& s) { return message(s, "enemyLoss"); }
  static std::string enemyDrain(const Session& s) { return message(s, "enemyDrain"); }
  static std::string enemyNoDamage(const Session& s) { return message(s, "enemyNoDamage"); }
  static std::string enemyNoHit(const Session& s) { return message(s, "enemyNoHit"); }
  static std::string evasion(const Session& s) { return message(s, "evasion"); }
  static std::string magicEvasion(const Session& s) { return message(s, "magicEvasion"); }
  static std::string magicReflection(const Session& s) { return message(s, "magicReflection"); }
  static std::string counterAttack(const Session& s) { return message(s, "counterAttack"); }
  static std::string substitute(const Session& s) { return message(s, "substitute"); }
  static std::string buffAdd(const Session& s) { return message(s, "buffAdd"); }
  static std::string debuffAdd(const Session& s) { return message(s, "debuffAdd"); }
  static std::string buffRemove(const Session& s) { return message(s, "buffRemove"); }
  static std::string actionFailure(const Session& s) { return message(s, "actionFailure"); }
};

class PluginManager {
 public:
  using CommandHandler = std::function<void(Session&, const std::vector<std::string>&)>;

  static void setup(const Value& plugins);
  static const Value& parameters(const std::string& name);
  static void setParameters(const std::string& name, const Value& parameters);
  static const std::vector<std::string>& scripts();
  static void clear();
  static void registerCommand(const std::string& name, CommandHandler handler);
  static bool callCommand(Session& session, const std::string& name, const std::vector<std::string>& args);

 private:
  static std::map<std::string, CommandHandler> commands_;
  static std::map<std::string, Value> parameters_;
  static std::vector<std::string> scripts_;
};

}  // namespace pmjs::mv

