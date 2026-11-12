#pragma once

#include <cstdint>
#include <map>
#include <optional>
#include <array>
#include <string>
#include <variant>
#include <vector>
#include <set>
#include <random>

namespace pmjs::mv {

struct Value {
  using Array = std::vector<Value>;
  using Object = std::map<std::string, Value>;
  std::variant<std::monostate, bool, double, std::string, Array, Object> data;
  Value() = default;
  Value(bool v) : data(v) {}
  Value(int v) : data(static_cast<double>(v)) {}
  Value(double v) : data(v) {}
  Value(const char* v) : data(std::string(v)) {}
  Value(std::string v) : data(std::move(v)) {}
  Value(Array v) : data(std::move(v)) {}
  Value(Object v) : data(std::move(v)) {}
  const Value& operator[](const std::string& key) const;
  const Value& operator[](std::size_t index) const;
  const Array& array() const;
  double number(double fallback = 0) const;
  int integer(int fallback = 0) const;
  bool boolean() const;
  std::string text() const;
  bool null() const { return std::holds_alternative<std::monostate>(data); }
};

double formula(const std::string& expression, const std::map<std::string, double>& fields);

struct Input {
  int direction = 0;
  bool ok = false;
  bool cancel = false;
  bool dash = false;
  std::optional<bool> okTriggered = {};
  std::optional<bool> cancelTriggered = {};
  std::optional<int> repeatedDirection = {};
};

struct Character {
  int x = 0, y = 0, direction = 2, pattern = 1, moveSpeed = 4;
  double realX = 0, realY = 0, animationCount = 0;
  bool through = false, transparent = false, walkAnime = true, stepAnime = false;
  bool directionFix = false;
  int stopCount = 0, tileId = 0, characterIndex = 0;
  int bushDepth = 0, opacity = 255, blendMode = 0;
  bool singleFrame = false;
  double spriteOffsetX = 0, spriteOffsetY = 0;
  int customFrameX = -1, customFrameY = -1, customFrameWidth = -1, customFrameHeight = -1;
  std::string characterName;
  Value::Array route;
  Value originalRoute;
  int originalRouteIndex = 0;
  int routeIndex = 0, routeWait = 0;
  bool routeForcing = false, routeRepeat = false, routeSkippable = false;
  bool moving() const { return realX != x || realY != y; }
};

struct Interpreter {
  int mapId = 0, eventId = 0, index = 0, wait = 0, depth = 0;
  bool running = false;
  Value::Array list;
  std::map<int, int> branches;
  std::optional<int> waitingRoute;
  std::vector<Interpreter> children;
};

struct Event {
  int id = 0, page = -1, trigger = 0, priority = 1;
  int prelockDirection = 0;
  int originalDirection = -1, originalPattern = -1;
  bool starting = false, erased = false;
  Character character;
  Interpreter parallel;
};

struct Message {
  Value::Array lines, choices;
  int defaultChoice = 0, cancelChoice = -1, choiceIndent = 0;
  int faceIndex = 0, background = 0, position = 2;
  std::string faceName;
  bool busy = false;
  int firstLine = 0;
  std::vector<int> pauses;
  std::size_t pauseIndex = 0;
  std::set<int> pageBreaks;
  int pageEnd() const;
};

struct ActionResult {
  bool used = false, missed = false, evaded = false, critical = false, hpAffected = false;
  int hpDamage = 0, mpDamage = 0;
};
struct Battler {
  int id = 0, level = 1, hp = 0, mp = 0, tp = 0;
  bool enemy = false, hidden = false, guarding = false, escaped = false;
  std::vector<int> equips, states;
  std::set<int> skills;
  std::map<int, int> stateTurns;
  std::array<int, 8> buffs{}, buffTurns{}, paramPlus{};
  ActionResult result;
};

struct Action {
  bool enemy = false, item = false;
  int subject = 0, id = 1, target = 0, speed = 0;
};
struct BattleTarget {
  bool enemy = false;
  int index = 0;
  ActionResult result;
};
struct BattleVisual {
  Action action;
  std::uint64_t movementStarted = 0, started = 0, impact = 0, returned = 0;
  std::vector<int> lastAudioFrames;
  std::vector<BattleTarget> targets;
};

struct Battle {
  bool active = false, canEscape = false, canLose = false, event = false, opening = false;
  int troopId = 0, turn = 0, actorIndex = 0, result = -1, wait = 0;
  int actionStage = 0, currentVisual = -1;
  double escapeRatio = 0;
  Value mapBgm, mapBgs;
  std::vector<Battler> enemies;
  std::vector<Action> actions;
  std::vector<std::string> log;
  std::vector<BattleVisual> visuals;
};

enum class Scene { title, map, menu, item, skill, equip, status, formation, options, save, load, battle, gameOver };
struct Ui {
  Scene scene = Scene::map;
  int cursor = 0, actor = 0, category = 0, target = -1, slot = -1, pendingId = 0;
  int commandCursor = 0, listCursor = 0, skillType = 0;
  bool targeting = false, itemAction = false;
  int age = 0;
};
struct SystemState {
  bool saveEnabled = true, menuEnabled = true, encounterEnabled = true, formationEnabled = true;
  int battleCount = 0, winCount = 0, escapeCount = 0, saveCount = 0;
};

class Presentation;

class Session {
 public:
  explicit Session(Value database);
  void newGame();
  void step(const Input& input);
  void acknowledge(int choice = -1);
  Value snapshot() const;
  int mapId() const { return mapId_; }
  const Character& player() const { return player_; }
  const std::vector<Event>& events() const { return events_; }
  const Message& message() const { return message_; }
  const Value& database() const { return database_; }
  const Value& map() const;
  bool mapSceneOnly() const { return database_["sceneContract"]["kind"].text() == "map"; }
  bool finished() const { return finished_; }
  void openTitle();
  void openGameOver();
  void startBattle(int troop, bool canEscape, bool canLose, bool event = false);
  void chooseAction(int actorIndex, int id, int target, bool item = false);
  double parameter(const Battler& battler, int id) const;
  void setRandomStream(std::vector<double> values);
  Value save();
  void load(const Value& contents);
  const Ui& ui() const { return ui_; }
  const Battle& battle() const { return battle_; }
  const Battler& actor(int id) const { return actors_.at(id); }
  int gold() const { return gold_; }
  const std::vector<int>& party() const { return party_; }
  bool saveRequested() const { return saveRequested_; }
  bool loadRequested() const { return loadRequested_; }
  void completeStorage(bool success);
  void configure(const Value& configuration);
  Value configuration() const;
  int configurationRevision() const { return configurationRevision_; }
  void setSaveMetadata(Value::Array metadata) { saveMetadata_ = std::move(metadata); }

 private:
  friend class Presentation;
  void initializeActor(int id);
  std::vector<const Value*> traitObjects(const Battler& battler) const;
  double trait(const Battler& battler, int code, int id, bool product) const;
  double random();
  int randomInt(int maximum);
  int restriction(const Battler& battler) const;
  void recover(Battler& battler);
  void refreshBattler(Battler& battler);
  void addState(Battler& battler, int state);
  void removeState(Battler& battler, int state);
  bool canUse(const Battler& battler, const Value& item) const;
  bool canApply(const Battler& target, const Value& item) const;
  int menuItemUser() const;
  void apply(Battler& subject, Battler& target, const Value& item);
  std::vector<int> battleSkillTypes(int actorIndex) const;
  std::vector<int> battleSelectableTargets(const Value& item) const;
  void makeEnemyActions();
  void beginTurn();
  void executeAction(const Action& action);
  void resolveAction();
  void endTurn();
  void endBattlerTurn(Battler& battler);
  void updateBattle();
  void finishBattle(int result);
  void leaveBattle();
  std::string battleMessage(const std::string& key, const std::vector<std::string>& arguments = {}) const;
  std::string partyName() const;
  void updateUi(const Input& input, bool ok, bool cancel, int direction);
  bool useItem(int id, int target, bool skill);
  void changeEquipment(int actor, int slot, int item);
  bool canEquip(const Battler& actor, const Value& item, int slot) const;
  void updatePlayerGraphic();
  void advanceEncounter();
  void audio(const std::string& kind, const Value& sound, bool restart = false);
  void transfer(int mapId, int x, int y, int direction);
  void refresh();
  bool pageEligible(const Value& page, int eventId) const;
  bool passable(int x, int y, int direction, const Character& character) const;
  bool tilePassage(int x, int y, int bit) const;
  bool tileFlag(int x, int y, int flag) const;
  bool move(Character& character, int direction);
  void updateCharacter(Character& character, bool dash, int idlePattern = 1);
  Character* routeCharacter(int id, const Interpreter& context);
  void updateRoute(Character& character);
  void startEvent(int x, int y, bool action);
  void startInterpreter(const Event& event);
  void updateInterpreter();
  void advanceInterpreter(Interpreter& context);
  bool command(const Value& entry, Interpreter& context);
  void skipBranch(int indent, Interpreter& context);
  bool condition(const Value& parameters, const Interpreter& context);
  const Value& variable(int id) const;
  void operateVariable(int id, int operation, const Value& operand);
  Value gameDataOperand(int type, int first, int second, const Interpreter& context);
  void gainItem(int kind, int id, double amount, bool includeEquipped);
  void refreshIfNeeded();
  Value database_;
  Character player_;
  std::array<Character, 3> followers_;
  std::vector<Event> events_;
  Interpreter interpreter_;
  Message message_;
  std::map<int, bool> switches_;
  std::map<int, Value> variables_;
  std::map<std::string, bool> selfSwitches_;
  std::map<int, int> inventory_;
  std::vector<int> party_;
  std::map<int, Battler> actors_;
  Battle battle_;
  Ui ui_;
  SystemState system_;
  int gold_ = 0, steps_ = 0, encounterCount_ = 0, brightness_ = 255, fadeOut_ = 0;
  int directionAge_ = 0, previousDirection_ = 0, messageAge_ = 0;
  bool previousCancel_ = false, saveRequested_ = false, loadRequested_ = false;
  Value::Array audioCommands_;
  Value savedBgm_, savedBgs_;
  Value::Array pictures_;
  Value ambience_;
  Value unsupportedAction_;
  std::optional<std::array<double, 2>> savedCamera_;
  bool alwaysDash_ = false, commandRemember_ = false;
  std::array<int, 4> volumes_{100, 100, 100, 100};
  int configurationRevision_ = 0;
  Value::Array saveMetadata_;
  int lastTitleCommand_ = -1;
  std::mt19937 randomGenerator_{std::random_device{}()};
  std::vector<double> randomStream_;
  std::size_t randomOffset_ = 0;
  std::uint64_t randomCalls_ = 0;
  std::uint64_t ticks_ = 0;
  int mapId_ = 0;
  bool refreshNeeded_ = true, previousOk_ = false, finished_ = false;
  bool playerDashing_ = false;
  std::optional<std::array<int, 4>> pendingTransfer_;
  bool eventMovementAllowed_ = true;
};

}  // namespace pmjs::mv
