#pragma once

#include "mv_engine.hpp"
#include "mv_core_audio_graphics.hpp"
#include <array>
#include <string>
#include <vector>
#include <functional>

namespace pmjs::mv {
const std::vector<std::string>& nameInputTable(int page, const std::string& locale = "en");
int nameInputPageCount(const std::string& locale);

struct Rect {
  int x = 0, y = 0, width = 0, height = 0;
  bool contains(int px, int py) const {
    return px >= x && py >= y && px < x + width && py < y + height;
  }
};

struct Color {
  uint8_t r = 255, g = 255, b = 255, a = 255;
  uint32_t rgba() const {
    return (static_cast<uint32_t>(r) << 24) |
           (static_cast<uint32_t>(g) << 16) |
           (static_cast<uint32_t>(b) << 8) |
           static_cast<uint32_t>(a);
  }
};

class Window_Base {
 public:
  Rect rect;
  int padding = 18;
  int standardBackOpacity = 192;
  int openness = 255;
  bool active = true;
  bool visible = true;
  int fontSize = 28;
  Color textColor{255, 255, 255, 255};

  Window_Base(int x, int y, int w, int h);
  virtual ~Window_Base() = default;

  virtual void update();
  int contentsWidth() const { return std::max(0, rect.width - padding * 2); }
  int contentsHeight() const { return std::max(0, rect.height - padding * 2); }
  int lineHeight() const { return 36; }
  int standardFontSize() const { return 28; }
  int standardPadding() const { return 18; }
  int textPadding() const { return 6; }
  int translucentOpacity() const { return 160; }
  int fittingHeight(int numLines) const { return numLines * lineHeight() + standardPadding() * 2; }
  int contentsOpacity = 255;
  core::PixelBitmap contents;

  struct TextDrawRecord {
    std::string text;
    int x = 0;
    int y = 0;
    int maxWidth = 0;
    std::string align = "left";
    Color color{255, 255, 255, 255};
  };
  std::vector<TextDrawRecord> drawnTexts;

  void createContents();
  void changeTextColor(Color color) { textColor = color; }
  void resetTextColor() { textColor = normalColor(); }
  int textWidth(const std::string& text) const;
  void drawText(const std::string& text, int x, int y, int maxWidth = 0, const std::string& align = "left");
  void drawGauge(int x, int y, int width, double rate, Color color1, Color color2);
  void drawCurrentAndMax(int current, int max, int x, int y, int width, Color color1, Color color2);
  void drawActorHp(const Battler& actor, const Session& session, int x, int y, int width = 186);
  void drawActorMp(const Battler& actor, const Session& session, int x, int y, int width = 186);
  void drawActorTp(const Battler& actor, int x, int y, int width = 96, const Session* session = nullptr);
  void drawActorName(const Battler& actor, const Session& session, int x, int y, int width = 168);
  void drawActorClass(const Battler& actor, const Session& session, int x, int y, int width = 168);
  void drawActorNickname(const Battler& actor, int x, int y, int width = 270);
  void drawActorLevel(const Battler& actor, const Session& session, int x, int y);
  void drawActorSimpleStatus(const Battler& actor, const Session& session, int x, int y, int width);
  void drawItemName(const Value& item, int x, int y, int width = 312);
  void drawCurrencyValue(int value, const std::string& unit, int x, int y, int width);

  static Color normalColor();
  static Color systemColor();
  static Color crisisColor();
  static Color deathColor();
  static Color gaugeBackColor();
  static Color hpGaugeColor1();
  static Color hpGaugeColor2();
  static Color mpGaugeColor1();
  static Color mpGaugeColor2();
  static Color mpCostColor();
  static Color powerUpColor();
  static Color powerDownColor();
  static Color tpGaugeColor1();
  static Color tpGaugeColor2();
  static Color tpCostColor();
  static Color hpColor(int hp, int mhp);
  static Color paramchangeTextColor(int change);
  static Color textColorAt(int index);

  // Escape codes parser: \C[n], \I[n], \V[n], \N[n], \P[n], \G, \{, \}
  static std::string processEscapeCodes(const std::string& text, const Session& session);
};

class Window_Selectable : public Window_Base {
 public:
  int index = -1;
  int topRow = 0;
  int maxCols = 1;
  int spacing = 12;
  bool cursorFixed = false, cursorAll = false;

  Window_Selectable(int x, int y, int w, int h);
  static Rect itemRectFor(int itemIndex, int contentsWidth, int columns, int itemHeight, int spacing, int topRow);
  static int clampTopRow(int row, int itemCount, int columns, int pageRows);
  static int visibleTopRow(int index, int topRow, int itemCount, int columns, int pageRows);
  static int wheelTopRow(int topRow, int itemCount, int columns, int pageRows, double wheelY);
  static void moveCursor(int& index, int& topRow, int itemCount, int columns, int pageRows, int direction, bool wrap = false);
  static void pageCursor(int& index, int& topRow, int itemCount, int columns, int pageRows, bool down);
  virtual int maxItems() const = 0;
  virtual int itemHeight() const { return lineHeight(); }
  int maxRows() const;
  int maxPageRows() const;
  int maxPageItems() const;
  int row() const { return static_cast<int>(std::floor(index / static_cast<double>(std::max(1, maxCols)))); }
  int topIndex() const { return topRow * std::max(1, maxCols); }
  int bottomRow() const { return std::max(0, topRow + maxPageRows() - 1); }
  void setTopRow(int row);
  void setBottomRow(int row);
  int maxTopRow() const { return std::max(0, maxRows() - maxPageRows()); }
  void select(int newIndex);
  void deselect() { select(-1); }
  void activate() { active = true; }
  void deactivate() { active = false; }
  void ensureCursorVisible();
  bool isOpenAndActive() const { return openness >= 255 && active; }
  Rect itemRect(int itemIndex) const;
  Rect itemRectForText(int itemIndex) const;
  bool isCursorMovable() const;
  void cursorDown(bool wrap = false);
  void cursorUp(bool wrap = false);
  void cursorRight(bool wrap = false);
  void cursorLeft(bool wrap = false);
  void cursorPagedown();
  void cursorPageup();
  void processCursorMove(bool downRep, bool downTrig, bool upRep, bool upTrig,
                         bool rightRep, bool rightTrig, bool leftRep, bool leftTrig,
                         bool pageDownTrig, bool pageUpTrig,
                         bool pageDownHandled = false, bool pageUpHandled = false);
  void processWheel(double wheelY);
  void scrollDown() { setTopRow(topRow + 1); }
  void scrollUp() { setTopRow(topRow - 1); }
  virtual bool isCurrentItemEnabled() const { return true; }
};

struct CommandItem {
  std::string name;
  std::string symbol;
  bool enabled = true;
  int ext = 0;
};

class Window_Command : public Window_Selectable {
 public:
  std::vector<CommandItem> commands;

  Window_Command(int x, int y, int w, int h);
  int maxItems() const override { return static_cast<int>(commands.size()); }
  void addCommand(std::string name, std::string symbol, bool enabled = true, int ext = 0);
  std::string currentSymbol() const;
  int currentExt() const;
  bool isCurrentItemEnabled() const override;
};

class Window_ItemList : public Window_Selectable {
 public:
  std::string category = "item"; // item, weapon, armor, keyItem
  std::vector<int> data;

  Window_ItemList(int x, int y, int w, int h);
  int maxItems() const override { return static_cast<int>(data.size()); }
  virtual void refresh(const Session& session);
  bool includes(int kind, int id, const Session& session) const;
  static bool includes(const Session& session, const std::string& category, int kind, int id);
  static std::vector<int> makeItemList(const Session& session, const std::string& category);
  static bool isEnabled(const Session& session, int encodedItem);
  bool isCurrentItemEnabled() const override;
};

class Window_SkillList : public Window_Selectable {
 public:
  int actorId = 0;
  int skillType = 0;
  std::vector<int> data;

  Window_SkillList(int x, int y, int w, int h);
  int maxItems() const override { return static_cast<int>(data.size()); }
  void refresh(const Session& session);
  static std::vector<int> makeSkillList(const Session& session, int actorId, int skillType);
  static bool isEnabled(const Session& session, int actorId, int skillId);
  static std::pair<int,int> displayedCost(const Session& session, int actorId, int skillId);
  bool isCurrentItemEnabled() const override;
};

class Window_EquipSlot : public Window_Selectable {
 public:
  int actorId = 0;

  Window_EquipSlot(int x, int y, int w, int h);
  void setActor(int id, const Session& session) { actorId = id; session_ = &session; }
  int maxItems() const override;
  std::string slotName(int slotIndex, const Session& session) const;
  bool isCurrentItemEnabled() const override;
 private:
  const Session* session_ = nullptr;
};

class Window_BattleStatus : public Window_Selectable {
 public:
  Window_BattleStatus(int x, int y, int w, int h);
  int maxItems() const override;
};

class Window_BattleLog : public Window_Base {
 public:
  struct MethodCall {
    std::string name;
    int subjectId = 0;
    int targetId = 0;
    int value = 0;
    std::string text;
  };
  std::vector<std::string> lines;
  std::vector<int> baseLineStack;
  std::vector<MethodCall> methods;
  std::string waitMode;
  int waitCount = 0;

  Window_BattleLog(int x, int y, int w, int h);
  void bindLines(std::vector<std::string>& value) { boundLines_ = &value; }
  std::vector<std::string>& logLines() { return boundLines_ ? *boundLines_ : lines; }
  const std::vector<std::string>& logLines() const { return boundLines_ ? *boundLines_ : lines; }
  void tick(Session& session, bool fastForward, bool effecting, bool moving);
  bool isBusy() const { return waitCount > 0 || !waitMode.empty() || !methods.empty(); }
  static constexpr int messageSpeed() { return 16; }
  static constexpr int maxLines() { return 10; }
  void setWaitMode(std::string mode) { waitMode = std::move(mode); }
  void push(MethodCall call) { methods.push_back(std::move(call)); }
  MethodCall popMethod();
  bool callNextMethod(Session& session);
  void wait() { waitCount = messageSpeed(); }
  void pushBaseLine() { baseLineStack.push_back(static_cast<int>(logLines().size())); }
  void popBaseLine();
  void waitForNewLine();
  void addText(std::string text);
  void clear();
  void waitForEffect();
  void waitForMovement() { setWaitMode("movement"); }
  void performActionStart(Session& session, Battler& subject, const Value& action);
  void performAction(Battler& subject, const Value& action);
  void performActionEnd(Battler& subject);
  void performDamage(Session& session, Battler& target);
  void performMiss(Session& session, Battler& target);
  void performRecovery(Session& session, Battler& target);
  void performEvasion(Session& session, Battler& target);
  void performMagicEvasion(Session& session, Battler& target);
  void performCounter(Session& session, Battler& target);
  void performReflection(Session& session, Battler& target);
  void performSubstitute(Battler& substitute, Battler& target);
  void performCollapse(Session& session, Battler& target);
  void displayAction(const Session& session, const Battler& subject, const Value& item);
  void displayCounter(const Session& session, const Battler& target);
  void displayReflection(const Session& session, const Battler& target);
  void displaySubstitute(const Session& session, const Battler& substitute, const Battler& target);
  void displayActionResults(Session& session, const Battler& subject, const Battler& target);
  void displayAutoAffectedStatus(const Session& session, const Battler& target);
  void displayCurrentState(const Session& session, const Battler& subject);
  void displayRegeneration(Session& session, const Battler& target);
  void displayFailure(const Session& session, const Battler& target);
  void displayCritical(const Session& session, const Battler& target);
  void displayMiss(const Session& session, const Battler& target);
  void displayEvasion(const Session& session, const Battler& target);
  void displayHpDamage(const Session& session, const Battler& target);
  void displayMpDamage(const Session& session, const Battler& target);
  void displayTpDamage(const Session& session, const Battler& target);
  void displayAffectedStatus(const Session& session, const Battler& target);
 private:
  static int battlerId(const Session& session, const Battler& target);
  static Battler& queuedBattler(Session& session, int id);
  void queuePopup(Session& session, const Battler& target, int visualIndex = -1, int recordIndex = -1);
  void showAnimation(Session& session, int visualIndex);
  std::vector<std::string>* boundLines_ = nullptr;
};

class Window_Help : public Window_Base {
 public:
  std::string text;
  Window_Help(int numLines = 2);
  void setText(std::string value);
  void clear();
  static Rect placement(int width, int numLines = 2);
  static std::string itemDescription(const Value& item);
};

class Window_Gold : public Window_Base {
 public:
  int value = 0;
  std::string currencyUnit;
  Window_Gold(int x, int y);
  void refresh(const Session& session);
};

class Window_MenuCommand : public Window_Command {
 public:
  Window_MenuCommand(int x, int y);
  void makeCommandList(const Session& session);
  static std::vector<CommandItem> makeCommands(const Session& session);
};

class Window_MenuStatus : public Window_Selectable {
 public:
  struct RowLayout { Rect face; core::Rectangle status; };
  int formationMode = 0;
  int pendingIndex = -1;
  std::vector<int> actorIds;
  Window_MenuStatus(int x, int y);
  int maxItems() const override { return static_cast<int>(actorIds.size()); }
  int itemHeight() const override { return rowHeight(rect.height,padding); }
  static int rowHeight(int windowHeight, int padding = 18);
  static Rect rowRect(int index, int windowWidth, int windowHeight, int topRow, int padding = 18);
  static RowLayout rowLayout(const Rect& row);
  static Rect placement(int viewportWidth, int viewportHeight, int x = 240, int y = 0);
  void refresh(const Session& session);
};

class Window_MenuActor : public Window_MenuStatus {
 public:
  Window_MenuActor();
  struct Selection { int index = 0; bool fixed = false, all = false; };
  static Selection selection(const Session& session, const Value& item, int userIndex);
  static void rememberTarget(Session& session, int index);
  void selectForItem(const Session& session, const Value& item, int userIndex);
  static Rect placement(int viewportWidth, int viewportHeight, int itemIndex);
};

class Window_ItemCategory : public Window_Command {
 public:
  Window_ItemCategory();
  void makeCommandList(const Session& session);
  static std::vector<CommandItem> makeCommands(const Session& session);
};

class Window_SkillType : public Window_Command {
 public:
  int actorId = 0;
  Window_SkillType(int x, int y);
  void makeCommandList(const Session& session);
  static std::vector<CommandItem> makeCommands(const Session& session, int actorId);
};

class Window_SkillStatus : public Window_Base {
 public:
  int actorId = 0;
  Window_SkillStatus(int x, int y, int w, int h);
  static Rect placement(int width);
};

class Window_EquipStatus : public Window_Base {
 public:
  int actorId = 0;
  int tempActorId = 0;
  std::optional<Battler> tempActor;
  std::array<int, 6> paramDiffs{};
  Window_EquipStatus(int x, int y);
  void setTempActor(int newTempActorId, const Session* session = nullptr);
  void setTempActor(const Battler* actor, const Session* session = nullptr);
  void refresh(const Session* session = nullptr);
  static std::array<int,6> parameterDifferences(const Session& session, const Battler& actor, const Battler& preview);
};

class Window_EquipCommand : public Window_Command {
 public:
  Window_EquipCommand(int x, int y, int width);
  void makeCommandList(const Session& session);
  static std::vector<CommandItem> makeCommands(const Session& session);
};

class Window_EquipItem : public Window_ItemList {
 public:
  int actorId = 0;
  int slotId = 0;
  Window_EquipItem(int x, int y, int w, int h);
  bool includesEquip(int kind, int id, const Session& session) const;
  static bool includesEquip(const Session& session, int actorId, int slotId, int kind, int id);
  static std::vector<int> makeItemList(const Session& session, int actorId, int slotId);
  void refresh(const Session& session) override;
};

class Window_Status : public Window_Selectable {
 public:
  int actorId = 0;
  Window_Status();
  int maxItems() const override { return 0; }
};

class Window_Options : public Window_Command {
 public:
  Window_Options();
  void makeCommandList(const Session& session);
  static std::vector<CommandItem> makeCommands(const Session& session);
  static bool changeValue(const std::string& symbol, const Value& value, Session& session);
  static bool processInput(const std::string& symbol, int direction, bool confirm, Session& session);
};

class Window_SavefileList : public Window_Selectable {
 public:
  std::string mode = "load";
  Window_SavefileList(int x, int y, int w, int h);
  int maxItems() const override { return fileCount(); }
  int itemHeight() const override { return rowHeight(rect.height,padding); }
  static int fileCount();
  static constexpr int visibleItems() { return 5; }
  static int rowHeight(int height, int padding = 18);
  static const Value& metadata(const Session& session, int savefileId);
  static bool isEnabled(const Session& session, int savefileId, bool loading);
  static std::string fileLabel(const Session& session, int savefileId);
};

class Window_ShopCommand : public Window_Command {
 public:
  bool purchaseOnly = false;
  Window_ShopCommand(int width, bool purchaseOnlyFlag);
  void makeCommandList(const Session& session);
  static std::vector<CommandItem> makeCommands(const Session& session, bool purchaseOnly);
};

class Window_ShopBuy : public Window_Selectable {
 public:
  std::vector<ShopGood> goods;
  int money = 0;
  Window_ShopBuy(int x, int y, int h, std::vector<ShopGood> shopGoods);
  int maxItems() const override { return static_cast<int>(goods.size()); }
  int price(int itemIndex, const Session& session) const;
  bool isEnabled(int itemIndex, const Session& session) const;
};

class Window_ShopSell : public Window_ItemList {
 public:
  Window_ShopSell(int x, int y, int w, int h);
  bool isEnabled(int itemIndex, const Session& session) const;
};

class Window_ShopNumber : public Window_Selectable {
 public:
  int number = 1;
  int max = 1;
  int price = 0;
  int maxDigits = 2;
  Window_ShopNumber(int x, int y, int h);
  int maxItems() const override { return 1; }
  void changeNumber(int amount);
  static int changeNumber(int number, int amount, int maximum);
};

class Window_ShopStatus : public Window_Base {
 public:
  struct EquipInfo {
    int actorId = 0, equippedItem = 0, paramChange = 0;
    bool enabled = false;
  };
  int itemKind = 0;
  int itemId = 0;
  int pageIndex = 0;
  Window_ShopStatus(int x, int y, int w, int h);
  static constexpr int pageSize() { return 4; }
  static int maxPages(const Session& session);
  std::vector<int> statusMembers(const Session& session) const;
  static std::vector<int> statusMembers(const Session& session, int pageIndex);
  static int possession(const Session& session, int kind, int id);
  static int paramId(int kind) { return kind == 1 ? 2 : 3; }
  int paramId() const { return paramId(itemKind); }
  static int currentEquippedItem(const Session& session, const Battler& actor, int etypeId, int paramId);
  static std::vector<EquipInfo> equipInfo(const Session& session, int kind, int id, int pageIndex);
  static int nextPage(const Session& session, int pageIndex);
  int currentEquippedItemId(const Battler& actor, int etypeId, const Session& session) const;
  void drawEquipInfo(int x, int y, const Session& session);
  void nextPage(const Session& session);
};

class Window_NameEdit : public Window_Base {
 public:
  int actorId = 0;
  int maxLength = 8;
  std::string name;
  std::string defaultName;
  int index = 0;
  static std::string initialName(const std::string& name, int maxLength);
  static bool addCharacter(std::string& name, int maxLength, const std::string& character);
  static bool removeCharacter(std::string& name);
  static Rect placement(int screenWidth, int screenHeight);
  Window_NameEdit(int actorIdVal, int maxLen, std::string initialName);
  int faceWidth() const { return 144; }
  double charWidth(bool isJapanese = false) const;
  double left(bool isJapanese = false) const;
  core::Rectangle itemRect(int charIndex, bool isJapanese = false) const;
  core::Rectangle underlineRect(int charIndex, bool isJapanese = false) const;
  void refresh(const core::PixelBitmap* face, int faceIndex, bool isJapanese);
  bool add(const std::string& ch);
  bool back();
  bool restoreDefault();
};

class Window_NameInput : public Window_Selectable {
 public:
  int page = 0;
  std::string locale = "en";
  Window_NameInput();
  int maxItems() const override { return 90; }
  bool isOk() const { return index == 89; }
  bool isPageChange() const { return index == 88; }
  std::string character() const;
  static Rect cellRect(int index);
  static int moveGridCursor(int index, int direction, bool wrap);
  static int changePage(int page, bool down, const std::string& locale);
  void refresh();
};

class Window_ChoiceList : public Window_Command {
 public:
  Window_ChoiceList();
  void makeCommandList(const Session& session);
  static int visibleRows(int count, const Rect& message, int screenHeight);
  static Rect placement(int count, int choiceWidth, int position, const Rect& message, int screenWidth, int screenHeight);
};

class Window_NumberInput : public Window_Selectable {
 public:
  int maxDigits = 1;
  int number = 0;
  Window_NumberInput();
  int maxItems() const override { return maxDigits; }
  void changeDigit(bool up);
  static int changeDigit(int number, int maxDigits, int index, bool up);
  static Rect buttonFrame(int index, bool hot);
  static std::array<Rect, 3> buttonBounds(Rect window, bool messageBottom);
};

class Window_EventItem : public Window_ItemList {
 public:
  int itypeId = 2;
  Window_EventItem();
  static std::vector<int> makeItemList(const Session& session, int itemType);
  void refresh(const Session& session) override;
};

class Window_ScrollText : public Window_Base {
 public:
  std::string text;
  double scrollY = 0.0;
  int scrollSpeed = 2;
  bool noFastForward = false;
  Window_ScrollText();
};

class Window_Message : public Window_Base {
 public:
  std::string textState;
  int positionType = 2;
  int background = 0;
  int waitCount = 0;
  bool pauseSign = false;
  bool lineShowFast = false;
  bool showFast = false;
  Window_Message();
  void clearFlags();
};

class Window_PartyCommand : public Window_Command {
 public:
  Window_PartyCommand();
  void makeCommandList(const Session& session, bool canEscape);
  static std::vector<CommandItem> makeCommands(const Session& session, bool canEscape);
};

class Window_ActorCommand : public Window_Command {
 public:
  int actorId = 0;
  Window_ActorCommand();
  void makeCommandList(const Session& session);
  static std::vector<CommandItem> makeCommands(const Session& session, int actorId);
  static std::vector<int> skillTypes(const Session& session, int actorId);
};

class Window_BattleActor : public Window_BattleStatus {
 public:
  std::vector<int> actorIndices;
  Window_BattleActor(int x, int y);
  int maxItems() const override;
  void refresh(const Session& session);
  static constexpr int columns() { return 1; }
  static constexpr int visibleRows() { return 4; }
  static bool includes(const Battler& actor);
  static std::vector<int> makeTargets(const Session& session);
  static const std::string& nameFor(const Session& session, int partyIndex);
  static Rect placement(int width, int height);
};

class Window_BattleEnemy : public Window_Selectable {
 public:
  std::vector<int> enemyIndices;
  Window_BattleEnemy(int x, int y);
  int maxItems() const override { return static_cast<int>(enemyIndices.size()); }
  void refresh(const Session& session);
  static constexpr int columns() { return 2; }
  static constexpr int visibleRows() { return 4; }
  static bool includes(const Battler& enemy);
  static std::vector<int> makeTargets(const Session& session);
  static const std::string& nameFor(const Session& session, int enemyIndex);
  static Rect placement(int width, int height);
};

class Window_BattleSkill : public Window_SkillList {
 public:
  Window_BattleSkill(int x, int y, int w, int h);
};

class Window_BattleItem : public Window_ItemList {
 public:
  Window_BattleItem(int x, int y, int w, int h);
  static std::vector<int> makeItemList(const Session& session);
  void refresh(const Session& session) override;
};

class Window_TitleCommand : public Window_Command {
 public:
  Window_TitleCommand();
  void makeCommandList(const Session& session);
  static std::vector<CommandItem> makeCommands(const Session& session);
};

class Window_GameEnd : public Window_Command {
 public:
  Window_GameEnd();
  void makeCommandList(const Session& session);
  static std::vector<CommandItem> makeCommands(const Session& session);
};

class Window_DebugRange : public Window_Selectable {
 public:
  int maxSwitches = 0;
  int maxVariables = 0;
  Window_DebugRange(int x, int y);
  int maxItems() const override;
  std::string mode() const;
  int topId() const;
  static int pageCount(int entryCount);
  static int itemCount(const Session& session);
  static std::string modeFor(int index, int switchCount);
  static std::string modeFor(const Session& session, int index);
  static int topIdFor(int index, int switchCount);
  static int topIdFor(const Session& session, int index);
  static std::string labelFor(const Session& session, int index);
};

class Window_DebugEdit : public Window_Selectable {
 public:
  std::string mode = "switch";
  int topId = 1;
  Window_DebugEdit(int x, int y, int width);
  int maxItems() const override { return 10; }
  int currentId() const { return topId + index; }
  static std::string itemName(const Session& session, const std::string& mode, int id);
  static std::string itemStatus(const Session& session, const std::string& mode, int id);
  static bool processInput(Session& session, const std::string& mode, int id, bool confirm, int direction, bool pageUp, bool pageDown);
};

class Window_HorzCommand : public Window_Command {
 public:
  Window_HorzCommand(int x, int y, int w, int h);
};

class Window_MapName : public Window_Base {
 public:
  std::string mapName;
  int showCount = 0;

  Window_MapName();
  void open(std::string name);
  void close();
  void update() override;
  void advance(std::uint64_t ticks, bool nameDisplay);
  void refresh();
};

}  // namespace pmjs::mv

