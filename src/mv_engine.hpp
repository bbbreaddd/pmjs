#pragma once

#include <cstdint>
#include <map>
#include <memory>
#include <optional>
#include <array>
#include <string>
#include <variant>
#include <vector>
#include <set>
#include <random>
#include <functional>
#include <algorithm>

namespace pmjs::mv {

struct Value {
  struct Undefined {};
  using Array = std::vector<Value>;
  using Object = std::map<std::string, Value>;
  std::variant<std::monostate, bool, double, std::string, Array, Object, Undefined> data;
  Value() = default;
  static Value undefined(){Value value;value.data=Undefined{};return value;}
  bool isUndefined()const{return std::holds_alternative<Undefined>(data);}
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
  bool null() const { return std::holds_alternative<std::monostate>(data) || isUndefined(); }
};

struct EventCommand {
  int code, indent;
  const Value& parameters;
  EventCommand(int code, int indent, const Value& parameters) : code(code), indent(indent), parameters(parameters) {}
  EventCommand(const Value& entry) : EventCommand(entry["code"].integer(), entry["indent"].integer(), entry["parameters"]) {}
};

class Sprite_Picture;
std::uint64_t nextRuntimeIdentity();
struct RuntimeObject {
  const std::uint64_t identity = nextRuntimeIdentity();
  virtual ~RuntimeObject() = default;
};
struct RuntimeTone : RuntimeObject {
  std::array<double, 4> values{};
  Value snapshot() const;
};
struct RuntimePicture : RuntimeObject {
  Value state;
  std::shared_ptr<RuntimeTone> tone, toneTarget;
  int slot = -1;
  std::shared_ptr<Sprite_Picture> sprite;
  Value snapshot() const;
  void restore(const Value& value);
};
struct RuntimeCommandView;
struct RuntimeCommandList : RuntimeObject, std::enable_shared_from_this<RuntimeCommandList> {
  Value root = Value::Array{};
  std::map<std::vector<std::string>, std::weak_ptr<RuntimeCommandView>> views;
  std::shared_ptr<RuntimeCommandView> view(const std::vector<std::string>& path);
  Value& resolve(const std::vector<std::string>& path);
};
struct RuntimeCommandView : RuntimeObject {
  std::shared_ptr<RuntimeCommandList> list;
  std::vector<std::string> path;
  Value& value() const { return list->resolve(path); }
};
struct RuntimeArray {
  std::shared_ptr<RuntimeCommandList> storage = std::make_shared<RuntimeCommandList>();
  RuntimeArray& operator=(Value::Array values) { storage = std::make_shared<RuntimeCommandList>(); storage->root = std::move(values); return *this; }
  void clear() { storage = std::make_shared<RuntimeCommandList>(); }
  Value::Array& values() { return std::get<Value::Array>(storage->root.data); }
  const Value::Array& values() const { return std::get<Value::Array>(storage->root.data); }
  operator Value::Array() const { return values(); }
  std::size_t size() const { return values().size(); }
  bool empty() const { return values().empty(); }
  Value& operator[](std::size_t index) { return values()[index]; }
  const Value& operator[](std::size_t index) const { return values()[index]; }
  auto begin() const { return values().begin(); }
  auto end() const { return values().end(); }
};
using InterpreterList = RuntimeArray;
struct RuntimeBranches : RuntimeObject { std::map<int, Value> values; };
struct InterpreterBranches {
  std::shared_ptr<RuntimeBranches> storage = std::make_shared<RuntimeBranches>();
  Value& operator[](int key) { return storage->values[key]; }
  const Value& at(int key) const { return storage->values.at(key); }
  bool contains(int key) const { return storage->values.contains(key); }
  void erase(int key) { storage->values.erase(key); }
  auto begin() const { return storage->values.begin(); }
  auto end() const { return storage->values.end(); }
};
struct RuntimeInterpreter : RuntimeObject {
  std::string waitMode;
  std::string comments;
  int indent = 0;
  std::shared_ptr<RuntimeCommandList> parameterList = std::make_shared<RuntimeCommandList>();
  int parameterIndex = -1;
};
struct InterpreterOperation {
  std::vector<std::shared_ptr<RuntimeInterpreter>>& stack;
  InterpreterOperation(std::vector<std::shared_ptr<RuntimeInterpreter>>& operations, const std::shared_ptr<RuntimeInterpreter>& interpreter);
  ~InterpreterOperation();
};
struct RuntimeHooks {
  std::function<bool(const std::shared_ptr<RuntimePicture>&, const std::string&, const Value::Array&)> picture;
  std::function<void(const std::shared_ptr<RuntimePicture>&)> sprite;
  std::function<void()> updateSprites;
  std::function<std::optional<bool>(const std::shared_ptr<RuntimeInterpreter>&, const std::string&)> wait;
  std::function<std::optional<bool>(const std::shared_ptr<RuntimeInterpreter>&, const std::string&)> command;
  std::function<void(const std::shared_ptr<RuntimeInterpreter>&, const std::string&)> script;
  std::function<bool(const std::shared_ptr<RuntimeInterpreter>&, const std::string&)> scriptCondition;
  std::function<bool(const std::shared_ptr<RuntimeInterpreter>&, const std::string&, const std::vector<std::string>&)> pluginCommand;
  std::function<bool(const std::shared_ptr<RuntimeInterpreter>&, const std::string&, const std::shared_ptr<RuntimeCommandList>&, int)> interpreterLifecycle;
  std::function<std::optional<bool>(const std::string&, const Value::Array&)> message;
  std::function<void(const std::shared_ptr<RuntimeCommandList>&)> requestImages;
  std::function<bool(int)> choice;
  std::function<bool(const std::shared_ptr<RuntimeInterpreter>&, const std::string&, const Value::Array&)> interpreterControl;
  std::function<void(const std::shared_ptr<RuntimeInterpreter>&)> setupChoiceCallback;
};

using FormulaResolver = std::function<double(const std::string&, const std::vector<double>&)>;
double formula(const std::string& expression, const std::map<std::string, double>& fields, const FormulaResolver& resolver = {});

struct Input {
  int direction = 0;
  bool ok = false;
  bool cancel = false;
  bool dash = false;
  bool okLongPressed = false;
  std::set<std::string> pressed;
  std::optional<int> destinationX, destinationY;
  std::optional<double> touchX, touchY;
  bool touchTriggered = false, touchPressed = false, touchCancelled = false;
  bool touchRepeated = false, touchLongPressed = false, touchMoved = false, touchReleased = false;
  double wheelX = 0, wheelY = 0;
  double inputDate = 0, touchDate = 0;
  std::optional<bool> okTriggered = {};
  std::optional<bool> cancelTriggered = {};
  std::optional<int> repeatedDirection = {};
  std::optional<bool> okRepeated, cancelRepeated, shiftTriggered, directionTriggered;
  std::optional<bool> pageUpRepeated, pageDownRepeated;
};

struct Character {
  int x = 0, y = 0, direction = 2, pattern = 1, moveSpeed = 4, moveFrequency = 6;
  double realX = 0, realY = 0, animationCount = 0;
  bool through = false, transparent = false, walkAnime = true, stepAnime = false;
  bool directionFix = false, movementSuccess = true;
  int jumpCount = 0, jumpPeak = 0;
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
  std::shared_ptr<RuntimeInterpreter> runtime = std::make_shared<RuntimeInterpreter>();
  int mapId = 0, eventId = 0, index = 0, wait = 0, depth = 0;
  std::uint64_t serial = 0;
  bool running = false, battleEvent = false, waitingAction = false;
  InterpreterList list;
  InterpreterBranches branches;
  bool waitingScroll = false, waitingGather = false, waitingMessage = false;
  int waitingEffect = 0;
  bool waitingVideo = false;
  std::optional<int> scriptCharacter;
  std::optional<int> waitingRoute;
  std::vector<Interpreter> children;
  void clear() {
    auto identity = runtime;
    auto branchState = branches;
    *this = Interpreter{};
    runtime = std::move(identity);
    branches = std::move(branchState);
    runtime->waitMode.clear();
  }
};

struct VisualEffect {
  int serial=0,targetType=0,targetId=0,animationId=0,duration=0,lastTimingFrame=-1;
  std::uint64_t started=0;
  bool mirror=false,balloon=false;
  bool duplicated=false;
  std::array<float,4> flash{};
  int flashDuration=0,hideDuration=0;
  std::array<float,4> screenFlash{};
  int screenFlashDuration=0;
};

struct Event {
  bool locked = false;
  int id = 0, page = -1, trigger = 0, priority = 1, moveType = 0;
  int prelockDirection = 0;
  int originalDirection = -1, originalPattern = -1;
  bool starting = false, erased = false;
  Character character;
  Interpreter parallel;
};

struct Message {
  Value::Array lines;
  RuntimeArray choices;
  int defaultChoice = 0, cancelChoice = -1, choiceIndent = 0;
  int numberVariableId = 0, numberDigits = 0, itemVariableId = 0, itemType = 0;
  int faceIndex = 0, background = 0, position = 2, choicePosition = 2, choiceBackground = 0;
  std::string faceName;
  bool busy = false, scrolling = false, scrollNoFast = false;
  double scrollY = 0, scrollSpeed = 2;
  std::string scrollText;
  int scrollHeight = 0;
  bool scrollStarted = false;
  int firstLine = 0;
  std::vector<int> pauses;
  std::size_t pauseIndex = 0;
  std::set<int> pageBreaks;
  bool revealPrepared = false, revealFinished = false, textPaused = false, finalPause = false;
  bool pauseSkip = false, lineFast = false, showFast = false, goldWindow = false;
  int openness = 0, previousOpenness = 0;
  bool windowStarted = false;
  bool closing = false;
  int revealPage = -1, revealLine = 0, textWait = 0, revealedCount = 0;
  std::size_t revealOffset = 0;
  std::vector<std::string> expandedLines;
  std::vector<std::size_t> revealLengths;
  int pageEnd() const;
};

struct ActionResult {
  bool used = false, missed = false, evaded = false, critical = false, hpAffected = false;
  bool physical = false, drain = false, success = false;
  int tpDamage = 0;
  std::vector<int> addedStates, removedStates, addedBuffs, addedDebuffs, removedBuffs;
  int hpDamage = 0, mpDamage = 0;
};
struct Battler {
  std::string lastCommandSymbol;
  int lastMenuSkill = 0, lastBattleSkill = 0;
  std::string name, nickname, profile, characterName, faceName, battlerName, originalName, letter;
  int characterIndex = 0, faceIndex = 0, classId = 1;
  std::map<int, double> exp;
  int id = 0, level = 1, hp = 0, mp = 0, tp = 0, lastTargetIndex = 0;
  bool enemy = false, hidden = false, guarding = false, escaped = false, plural = false;
  std::vector<int> equips, equipKinds, states;
  std::set<int> skills;
  std::map<int, int> stateTurns, stateSteps;
  std::array<int, 8> buffs{}, buffTurns{}, paramPlus{};
  ActionResult result;
  int requestedMotion = -1, requestedWeapon = 0;
  std::uint64_t motionRequestedAt = 0;
  bool isAlive() const { return !hidden && std::find(states.begin(), states.end(), 1) == states.end(); }
  bool isDead() const { return !hidden && std::find(states.begin(), states.end(), 1) != states.end(); }
};

struct Action {
  bool enemy = false, item = false;
  int subject = 0, id = 1, target = 0;
  double speed = 0;
  bool forced = false;
  int actorId = 0;
};
struct BattleTarget {
  bool enemy = false;
  int index = 0;
  ActionResult result;
  std::uint64_t impact = 0;
  bool aliveAtImpact = true;
  int actorId = 0;
};
struct BattleVisual {
  Action action;
  bool actionVisual = true;
  std::size_t invocationCount = 0;
  std::uint64_t movementStarted = 0, started = 0, impact = 0, returned = 0;
  std::vector<BattleTarget> targets;
  std::vector<BattleTarget> animationTargets;
};

struct Battle {
  bool active = false, canEscape = false, canLose = false, event = false, opening = false, aborting = false;
  int troopId = 0, turn = 0, actorIndex = 0, result = -1, wait = 0;
  int actionStage = 0, currentVisual = -1, encounterEffect = 0;
  int targetIndex = 0, eventIndent = 0;
  std::uint64_t eventSerial = 0;
  double escapeRatio = 0;
  Value mapBgm, mapBgs;
  std::vector<Battler> enemies;
  std::vector<Action> actions, forcedActions;
  bool forcedExecuting = false, forcedTurn = false, turnEnding = false, preemptive = false, surprise = false;
  int forcedResumeWait = 0;
  Interpreter interpreter;
  std::set<int> eventFlags;
  std::map<std::string, int> nameCounts;
  std::vector<int> remainingActions;
  std::vector<std::string> log;
  std::vector<BattleVisual> visuals;
};

enum class Scene { title, map, menu, item, skill, equip, status, formation, options, save, load, battle, gameOver, shop, name, debug };
struct UiHitTarget {
  int x = 0, y = 0, width = 0, height = 0, index = 0, category = 0, action = 0;
  Scene scene = Scene::map;
};
struct Vehicle {
  int type = 0; // 0: boat, 1: ship, 2: airship
  int mapId = 0;
  int altitude = 0;
  bool driving = false;
  Character character;
  Value bgm;
};
struct ShopGood {
  int kind = 0; // 0: item, 1: weapon, 2: armor
  int id = 0;
  int price = 0;
};
struct Ui {
  Scene scene = Scene::map;
  int cursor = 0, actor = 0, category = 0, target = -1, slot = -1, pendingId = 0;
  int commandCursor = 0, listCursor = 0, skillType = 0;
  int listTopRow = 0, listPageRows = 14;
  int targetTopRow = 0;
  int menuStatusTopRow = 0, menuActorTopRow = 0;
  int skillTypeTopRow = 0;
  std::optional<Battler> equipPreview;
  int equipPreviewIndex = -1;
  bool targeting = false, itemAction = false, listMemoryApplied = false;
  int commandActor = -1;
  int age = 0;
  int shopStatusPage = 0;
  bool shopStatusShiftHeld = false;
  int nameActorId = 0, nameMaxLength = 0, namePage = 0;
  std::string nameInput;
  bool shopPurchaseOnly = false;
  std::vector<ShopGood> shopGoods;
  int shopItemCount = 1, shopMaxNumber = 1, shopPrice = 0, shopKind = 0, shopId = 0;
  bool shopSelling = false;
};
struct SystemState {
  bool saveEnabled = true, menuEnabled = true, encounterEnabled = true, formationEnabled = true;
  int battleCount = 0, winCount = 0, escapeCount = 0, saveCount = 0;
  Value storedBgm, battleBgm, victoryMe, defeatMe, windowTone;
  std::array<Value, 3> vehicleBgm;
};

struct MapState {
  int tilesetId = 0;
  int scrollDirection = 2, scrollSpeed = 4;
  double scrollRest = 0;
  bool nameDisplay = true;
  Value battleback1Name, battleback2Name;
  std::string parallaxName;
  bool parallaxZero = false, parallaxLoopX = false, parallaxLoopY = false;
  double parallaxSx = 0, parallaxSy = 0, parallaxX = 0, parallaxY = 0;
  double lastDisplayX = 0, lastDisplayY = 0;
};

class Presentation;
class Window_BattleLog;
class Window_ChoiceList;
class Window_NumberInput;
class Window_EventItem;
class Sprite_Enemy;

class Session {
 public:
  explicit Session(Value database);
  void setRuntimeHooks(std::shared_ptr<RuntimeHooks> hooks) { runtimeHooks_ = std::move(hooks); }
  std::set<std::uint64_t> runtimeObjectIdentities() const;
  std::shared_ptr<RuntimePicture> runtimePicture(int id) const;
  std::shared_ptr<RuntimePicture> createRuntimePicture(int slot = -1);
  bool ownsPictureSprite(const RuntimePicture& picture) const;
  bool inBattle() const { return battle_.active; }
  bool playerTransferring() const { return pendingTransfer_.has_value(); }
  void reservePlayerTransfer(int mapId, int x, int y, int direction, int fadeType);
  void performPlayerTransfer();
  void dispatchPicture(const std::shared_ptr<RuntimePicture>& picture, const std::string& method, const Value::Array& arguments = {});
  void invokePictureBase(const std::shared_ptr<RuntimePicture>& picture, const std::string& method, const Value::Array& arguments = {});
  bool invokeWaitBase(const std::shared_ptr<RuntimeInterpreter>& interpreter);
  bool invokeInterpreterWaitBase(const std::shared_ptr<RuntimeInterpreter>& interpreter, const std::string& method);
  Value runtimeInterpreterField(const std::shared_ptr<RuntimeInterpreter>& interpreter, const std::string& field, const std::optional<Value>& value = {});
  std::shared_ptr<RuntimeObject> runtimeInterpreterCollection(const std::shared_ptr<RuntimeInterpreter>& interpreter, const std::string& field);
  void setRuntimeInterpreterList(const std::shared_ptr<RuntimeInterpreter>& interpreter, const std::shared_ptr<RuntimeCommandList>& list);
  void invokeInterpreterLifecycleBase(const std::shared_ptr<RuntimeInterpreter>& interpreter, const std::string& method,
    const std::shared_ptr<RuntimeCommandList>& list = {}, int eventId = 0);
  bool invokeInterpreterCommandBase(const std::shared_ptr<RuntimeInterpreter>& interpreter, std::optional<int> code);
  Value invokeMessageBase(const std::string& method, const Value::Array& arguments = {});
  Value runtimeMessageField(const std::string& field, const std::optional<Value>& value = {});
  Value imageRequests(const RuntimeCommandList& list);
  std::shared_ptr<RuntimeCommandList> messageChoices() const { return message_.choices.storage; }
  void invokeInterpreterControl(const std::shared_ptr<RuntimeInterpreter>& interpreter, const std::string& method, const Value::Array& arguments);
  double scriptRandom() { return random(); }
  void setRuntimeWaitMode(const std::shared_ptr<RuntimeInterpreter>& interpreter, std::string mode);
  std::string runtimeWaitMode(const std::shared_ptr<RuntimeInterpreter>& interpreter);
  void newGame();
  void setupBattleTest();
  void step(const Input& input);
  void acknowledge(int choice = -1);
  Value snapshot() const;
  int mapId() const { return mapId_; }
  void setMessageTextLayoutResolver(std::function<std::string(const std::string&, bool)> resolver) { messageTextLayoutResolver_ = std::move(resolver); }
  const MapState& mapState() const { return mapState_; }
  std::array<double, 4> screenTone() const;
  std::array<double, 4> screenFlashColor() const;
  double screenBrightness() const { return brightness_; }
  const Character& player() const { return player_; }
  const std::vector<Event>& events() const { return events_; }
  const Message& message() const { return message_; }
  const Value& database() const { return database_; }
  const Value& map() const;
  int screenWidth() const { return screenWidth_; }
  int screenHeight() const { return screenHeight_; }
  void setScreenSize(int width, int height);
  bool mapSceneOnly() const { return database_["sceneContract"]["kind"].text() == "map"; }
  bool finished() const { return finished_; }
  void openTitle();
  void initTitleCommandPosition() { lastTitleCommand_ = -1; }
  void openGameOver();
  void startBattle(int troop, bool canEscape, bool canLose, bool event = false);
  void buildBattleIntro();
  void chooseAction(int actorIndex, int id, int target, bool item = false);
  double parameter(const Battler& battler, int id) const;
  void setRandomStream(std::vector<double> values);
  Value save();
  void load(const Value& contents);
  const Ui& ui() const { return ui_; }
  const Battle& battle() const { return battle_; }
  void setEnemyBitmapHeightResolver(std::function<int(const Battler&)> resolver);
  const Sprite_Enemy* enemySprite(std::size_t index) const;
  bool isBattleEffecting() const;
  void requestEnemyEffect(std::size_t index, const std::string& effect);
  void requestActorMotion(int actorId, int motion, int weaponImageId);
  const Battler& actor(int id) const { return actors_.at(id); }
  int gold() const { return gold_; }
  const SystemState& system() const { return system_; }
  const std::map<int,Battler>& actors() const { return actors_; }
  const std::vector<int>& party() const { return party_; }
  bool saveRequested() const { return saveRequested_; }
  bool loadRequested() const { return loadRequested_; }
  void completeStorage(bool success);
  void configure(const Value& configuration);
  Value configuration() const;
  int configurationRevision() const { return configurationRevision_; }
  const Value::Array& audioCommands() const { return audioCommands_; }
  void setSaveMetadata(Value::Array metadata) { saveMetadata_ = std::move(metadata); }

 private:
  friend class Presentation;
  friend class Spriteset_Base;
  friend class Spriteset_Map;
  friend class Spriteset_Battle;
  friend class BattleMechanics;
  friend class MapMechanics;
  friend class SceneManager;
  friend class SoundManager;
  friend class DataManager;
  friend class AudioManager;
  friend class ConfigManager;
  friend class Window_Base;
  friend class Window_ItemList;
  friend class Window_EventItem;
  friend class Window_SkillList;
  friend class Window_BattleItem;
  friend class Window_BattleActor;
  friend class Window_BattleEnemy;
  friend class Window_BattleLog;
  friend class Window_ShopBuy;
  friend class Window_ShopSell;
  friend class Window_ShopStatus;
  friend class Window_SavefileList;
  friend class Window_DebugEdit;
  friend class Window_EquipSlot;
  friend class Window_EquipStatus;
  friend class Window_MenuActor;
  friend class Window_Message;
  friend class Window_EquipItem;
  friend class Window_SkillType;
  friend class Window_ActorCommand;
  double evaluateExpression(const std::string& expression, const Battler* subject = nullptr, const Battler* target = nullptr);
  int requestAnimation(int targetType,int targetId,int animationId,bool mirror=false,bool balloon=false,int delayFrames=0);
  void updateVisualEffects();
  std::array<float,4> effectColor(int targetType,int targetId) const;
  bool effectHidden(int targetType,int targetId) const;
  std::vector<VisualEffect> visualEffects_;
  int nextVisualEffect_ = 0;
  void executeNativeScript(const std::string& source, Interpreter& context);
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
  void apply(Battler& subject, Battler& target, const Value& item, Battler* drainTarget = nullptr);
  std::vector<int> battleSkillTypes(int actorIndex) const;
  std::set<int> battlerSkills(const Battler& actor) const;
  std::size_t battleMemberCount() const { return party_.size() < 4 ? party_.size() : 4; }
  std::vector<int> partyMembers() const;
  std::vector<int> battleSelectableTargets(const Value& item) const;
  void makeEnemyActions();
  void beginTurn();
  void executeAction(const Action& action);
  int battleActionCount(const Battler& battler);
  int selectEnemySkill(const Battler& enemy);
  std::vector<Battler*> actionTargets(const Action& action, Battler& subject, const Value& item);
  int damageValue(Battler& subject, Battler& target, const Value& item, bool critical);
  double evaluateAutoAction(Battler& subject, const Value& item, int& targetIndex);
  void applyItemEffect(Battler& subject, Battler& target, const Value& item, const Value& effect);
  void applyGlobalEffects(const Value& item);
  bool updateTroopEvents();
  void forceBattleAction(bool enemy, int subject, int skill, int target, int actorId = 0);
  void forceActorAction(int actorId, int skill, int target);
  bool hasSpecialFlag(const Battler& battler, int flag) const;
  bool hasPartyAbility(int ability) const;
  void resolveAction();
  void endTurn();
  void endBattlerTurn(Battler& battler);
  void endBattlerActions(Battler& battler);
  void actorWalk(Battler& actor);
  void makeAutoBattleActions(int actorIndex);
  void updateBattle();
  void performMapDamage();
  int findDirectionTo(const Character& c, int goalX, int goalY) const;
  void updateMapTouch(const Input& input);
  bool triggerDestinationAction();
  void finishBattle(int result);
  void abortBattle();
  void leaveBattle();
  Interpreter* findInterpreter(std::uint64_t serial);
  void setBattleEventResult(int result);
  std::string battleMessage(const std::string& key, const std::vector<std::string>& arguments = {}) const;
  std::string partyName() const;
  bool updateMessageText(bool ok, bool cancel);
  void updateMessageWindow();
  void dispatchMessage(const std::string& method, const Value::Array& arguments = {});
  bool messageBusy();
  void setupChoices(Interpreter& interpreter, const Value& parameters);
  void setupChoicesBase(Interpreter& interpreter, const Value& parameters);
  void jumpTo(Interpreter& interpreter, int index);
  void jumpToBase(Interpreter& interpreter, int index);
  void dispatchInterpreterControl(Interpreter& interpreter, const std::string& method, const Value::Array& arguments);
  void updateUi(const Input& input, bool ok, bool cancel, int direction);
  bool useItem(int id, int target, bool skill);
  bool useItemUntargeted(int id, bool skill);
  void changeEquipment(int actor, int slot, int item);
  bool canEquip(const Battler& actor, const Value& item, int slot) const;
  bool canEquipItem(const Battler& actor, const Value& item) const;
  int equipSlotType(const Battler& actor, int slot) const;
  bool canChangeEquip(const Battler& actor, int slot) const;
  void releaseEquipment(Battler& actor, bool forcing = false);
  void updatePlayerGraphic();
  void advanceEncounter();
  void advanceEncounterEffect();
  int makeEncounterTroopId();
  void audio(const std::string& kind, const Value& sound, bool restart = false);
  void transfer(int mapId, int x, int y, int direction);
  void refresh();
  bool pageEligible(const Value& page, int eventId) const;
  bool passable(int x, int y, int direction, const Character& character) const;
  bool tilePassage(int x, int y, int bit) const;
  bool tileFlag(int x, int y, int flag) const;
  bool move(Character& character, int direction);
  bool moveDiagonal(Character& character, int horizontal, int vertical);
  void increaseCharacterSteps(Character& character);
  void updateCharacter(Character& character, bool dash, int idlePattern = 1);
  void locateCharacter(Character& character, double x, double y);
  void jumpCharacter(Character& character, int xPlus, int yPlus);
  Character* routeCharacter(int id, const Interpreter& context);
  void updateRoute(Character& character);
  void startEvent(int x, int y, bool action);
  void startInterpreter(const Event& event);
  void setupInterpreter(Interpreter& interpreter, Value::Array list, int eventId = 0);
  void dispatchInterpreterLifecycle(Interpreter& interpreter, const std::string& method,
    const std::shared_ptr<RuntimeCommandList>& list = {}, int eventId = 0);
  void interpreterLifecycleBase(Interpreter& interpreter, const std::string& method,
    const std::shared_ptr<RuntimeCommandList>& list, int eventId);
  void assignInterpreterList(Interpreter& interpreter, const std::shared_ptr<RuntimeCommandList>& list);
  std::vector<std::shared_ptr<RuntimeInterpreter>> activeInterpreterOperations_;
  void updateInterpreter();
  bool setupStartingMapEvent();
  void refreshCommonEvents();
  void updateCommonEvents();
  void advanceInterpreter(Interpreter& context);
  bool updateWaitModeBase(Interpreter& context);
  bool updateWaitCountBase(Interpreter& context);
  bool updateWaitBase(Interpreter& context);
  Interpreter* findRuntimeInterpreter(const std::shared_ptr<RuntimeInterpreter>& interpreter);
  bool command(const EventCommand& entry, Interpreter& context);
  bool executeCommandBase(Interpreter& context);
  bool actorEventCommand(const EventCommand& entry);
  bool enemyEventCommand(const EventCommand& entry);
  double actorExpForLevel(const Battler& actor, int level) const;
  void changeActorExp(Battler& actor, double exp, bool show);
  bool systemEventCommand(const EventCommand& entry);
  bool screenEventCommand(const EventCommand& entry, Interpreter& context);
  bool dialogEventCommand(const EventCommand& entry, Interpreter& context);
  bool shopEventCommand(const EventCommand& entry, Interpreter& context);
  bool vehicleEventCommand(const EventCommand& entry, Interpreter& context);
  bool animationEventCommand(const EventCommand& entry, Interpreter& context);
  void ensureScreenEffects();
  void updateScreenState();
  Value screenState() const;
  bool characterEventCommand(const EventCommand& entry, Interpreter& context);
  void setupMapState();
  void updateMapState();
  void updateMapScroll();
  void updateMapDisplay();
  void updateSelfMovement(Event& event);
  bool loopHorizontal() const;
  bool loopVertical() const;
  int roundMapX(int x) const;
  int roundMapY(int y) const;
  double deltaMapX(double x1, double x2) const;
  double deltaMapY(double y1, double y2) const;
  void chaseCharacter(Character& follower, const Character& leader);
  void synchronizeFollowers(double x, double y);
  void updateFollowers();
  void setupVehicles();
  void updateVehicles();
  void updateMapVehicles();
  bool toggleVehicle();
  bool vehicleLandingOk(int type) const;
  void checkEventTouch(Event& event, int x, int y);
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
  std::array<Vehicle, 3> vehicles_{};
  int vehicleType_ = -1;
  bool vehicleGettingOn_ = false, vehicleGettingOff_ = false, followersGathering_ = false;
  int vehicleWalkSpeed_ = 4;
  Value vehicleWalkingBgm_;
  std::vector<Event> events_;
  Interpreter interpreter_;
  std::map<int, std::shared_ptr<Interpreter>> commonInterpreters_;
  Message message_;
  std::optional<Message> closingMessage_;
  std::function<std::string(const std::string&, bool)> messageTextLayoutResolver_;
  std::uint64_t messageOwnerSerial_ = 0, nextInterpreterSerial_ = 0;
  int reservedCommonEvent_ = 0;
  std::map<int, bool> switches_;
  std::map<int, Value> variables_;
  std::map<std::string, bool> selfSwitches_;
  std::map<int, int> inventory_;
  std::vector<int> party_;
  std::map<int, Battler> actors_;
  Battle battle_;
  std::shared_ptr<Window_BattleLog> battleLog_;
  std::shared_ptr<Window_ChoiceList> choiceWindow_;
  std::shared_ptr<Window_NumberInput> numberWindow_;
  std::shared_ptr<Window_EventItem> eventItemWindow_;
  std::vector<std::shared_ptr<Sprite_Enemy>> enemySprites_;
  std::function<int(const Battler&)> enemyBitmapHeightResolver_;
  void updateEnemySprites();
  void resetEnemySprites();
  Battler previewEquipment(const Battler& actor, int slot, int item) const;
  std::vector<std::pair<int,int>> stripEquipment(Battler& actor) const;
  std::vector<ShopGood> shopItems(bool selling) const;
  int shopMaximum(const ShopGood& good, bool selling, int money) const;
  void updateShop(bool ok, bool cancel, int direction, bool pageUp, bool pageDown);
  Ui ui_;
  std::vector<Ui> sceneStack_;
  std::vector<UiHitTarget> uiHitTargets_;
  std::set<std::string> previousUiButtons_;
  int lastItemId_ = 0, menuActorId_ = 0, targetActorId_ = 0, touchHoldFrames_ = 0;
  SystemState system_;
  MapState mapState_;
  int timerFrames_ = 0;
  bool timerWorking_ = false;
  void updateTimer();
  int gold_ = 0, steps_ = 0, fadeOut_ = 0;
  double encounterCount_ = 0;
  double brightness_ = 255;
  int directionAge_ = 0, previousDirection_ = 0, messageAge_ = 0;
  std::string movieName_;
  bool moviePlaying_ = false;
  bool movieExplicitSource_ = false;
  std::uint64_t movieRequest_ = 0;
  Input currentInput_;
  bool resourcesStopped_ = false;
  bool previousDebug_ = false;
  bool previousCancel_ = false, saveRequested_ = false, loadRequested_ = false, menuCalling_ = false;
  Value::Array audioCommands_;
  Value savedBgm_, savedBgs_;
  std::vector<std::shared_ptr<RuntimePicture>> pictures_;
  std::map<int, std::shared_ptr<Sprite_Picture>> pictureSprites_;
  std::shared_ptr<RuntimeHooks> runtimeHooks_;
  Value screenEffects_;
  Value ambience_;
  Value unsupportedAction_;
  std::optional<std::array<double, 2>> savedCamera_;
  bool alwaysDash_ = false, commandRemember_ = false;
  std::array<int, 4> volumes_{100, 100, 100, 100};
  int configurationRevision_ = 0;
  Value::Array saveMetadata_;
  int lastAccessedSavefileId_ = 1;
  int lastTitleCommand_ = -1;
  bool newGamePending_ = false;
  std::optional<Scene> pendingScene_;
  Value pendingLoadBgm_, pendingLoadBgs_;
  std::uint64_t pendingLoadFrames_ = 0;
  bool pendingLoadMapUpdated_ = false;
  double sceneFadeOpacity_ = 0;
  int sceneFadeDuration_ = 0;
  bool sceneFadeOut_ = false;
  bool sceneFadeWhite_ = false;
  void startSceneFade(bool fadeOut, int duration, bool white = false);
  void updateSceneFade();
  void beginSceneTransition(Scene scene, int duration);
  bool updateSceneTransition(bool fadeComplete);
  int titleWindowOpenness_ = 255;
  std::mt19937 randomGenerator_{std::random_device{}()};
  std::vector<double> randomStream_;
  std::size_t randomOffset_ = 0;
  std::uint64_t randomCalls_ = 0;
  std::uint64_t ticks_ = 0;
  std::uint64_t presentationRevision_ = 0;
  int screenWidth_ = 816, screenHeight_ = 624;
  int mapId_ = 0;
  bool refreshNeeded_ = true, previousOk_ = false, finished_ = false;
  int okAge_ = 0;
  bool playerDashing_ = false, battleTest_ = false;
  bool followersVisible_ = false;
  std::optional<std::array<int, 2>> destination_;
  int mapTouchCount_ = 0;
  std::optional<std::array<int, 5>> pendingTransfer_;
  bool transferFadeStarted_ = false;
  void centerPlayer();
  void locatePlayer(double x, double y);
  bool eventMovementAllowed_ = true;
};

}  // namespace pmjs::mv
