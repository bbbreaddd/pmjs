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

  Window_Selectable(int x, int y, int w, int h);
  virtual int maxItems() const = 0;
  int maxRows() const;
  int maxPageRows() const;
  int maxPageItems() const;
  int row() const { return index / std::max(1, maxCols); }
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
  void refresh(const Session& session);
  bool includes(int kind, int id, const Session& session) const;
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
  bool isCurrentItemEnabled() const override;
};

class Window_EquipSlot : public Window_Selectable {
 public:
  int actorId = 0;

  Window_EquipSlot(int x, int y, int w, int h);
  int maxItems() const override;
  std::string slotName(int slotIndex, const Session& session) const;
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
  int messageSpeed() const { return 16; }
  void setWaitMode(std::string mode) { waitMode = std::move(mode); }
  void push(MethodCall call) { methods.push_back(std::move(call)); }
  MethodCall popMethod();
  bool callNextMethod(Session& session);
  void wait() { waitCount = messageSpeed(); }
  void pushBaseLine() { baseLineStack.push_back(static_cast<int>(lines.size())); }
  void popBaseLine();
  void waitForNewLine();
  void addText(std::string text);
  void clear();
  void waitForEffect();
  void waitForMovement() { setWaitMode("movement"); }
  void performActionStart(Battler& subject, const Value& action);
  void performAction(Battler& subject, const Value& action);
  void performActionEnd(Battler& subject);
  void performDamage(Battler& target);
  void performMiss(Battler& target);
  void performRecovery(Battler& target);
  void performEvasion(Battler& target);
  void performMagicEvasion(Battler& target);
  void performCounter(Battler& target);
  void performReflection(Battler& target);
  void performSubstitute(Battler& substitute, Battler& target);
  void performCollapse(Battler& target);
  void displayAction(const Battler& subject, const Value& item);
  void displayCounter(const Battler& target);
  void displayReflection(const Battler& target);
  void displaySubstitute(const Battler& substitute, const Battler& target);
  void displayActionResults(const Battler& subject, const Battler& target);
  void displayFailure(const Battler& target);
  void displayCritical(const Battler& target);
  void displayMiss(const Battler& target);
  void displayEvasion(const Battler& target);
  void displayHpDamage(const Battler& target);
  void displayMpDamage(const Battler& target);
  void displayTpDamage(const Battler& target);
};

class Window_Help : public Window_Base {
 public:
  std::string text;
  Window_Help(int numLines = 2);
  void setText(std::string value);
  void clear();
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
};

class Window_MenuStatus : public Window_Selectable {
 public:
  int formationMode = 0;
  int pendingIndex = -1;
  std::vector<int> actorIds;
  Window_MenuStatus(int x, int y);
  int maxItems() const override { return static_cast<int>(actorIds.size()); }
  void refresh(const Session& session);
};

class Window_MenuActor : public Window_MenuStatus {
 public:
  Window_MenuActor();
};

class Window_ItemCategory : public Window_Command {
 public:
  Window_ItemCategory();
  void makeCommandList();
};

class Window_SkillType : public Window_Command {
 public:
  int actorId = 0;
  Window_SkillType(int x, int y);
  void makeCommandList(const Session& session);
};

class Window_SkillStatus : public Window_Base {
 public:
  int actorId = 0;
  Window_SkillStatus(int x, int y, int w, int h);
};

class Window_EquipStatus : public Window_Base {
 public:
  int actorId = 0;
  int tempActorId = 0;
  std::array<int, 6> paramDiffs{};
  Window_EquipStatus(int x, int y);
  void setTempActor(int newTempActorId, const Session* session = nullptr);
  void refresh(const Session* session = nullptr);
};

class Window_EquipCommand : public Window_Command {
 public:
  Window_EquipCommand(int x, int y, int width);
  void makeCommandList();
};

class Window_EquipItem : public Window_ItemList {
 public:
  int actorId = 0;
  int slotId = 0;
  Window_EquipItem(int x, int y, int w, int h);
  bool includesEquip(int kind, int id, const Session& session) const;
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
  void makeCommandList();
  void changeValue(const std::string& symbol, bool forward, Session& session);
};

class Window_SavefileList : public Window_Selectable {
 public:
  std::string mode = "load";
  int maxFiles = 20;
  Window_SavefileList(int x, int y, int w, int h);
  int maxItems() const override { return maxFiles; }
};

class Window_ShopCommand : public Window_Command {
 public:
  bool purchaseOnly = false;
  Window_ShopCommand(int width, bool purchaseOnlyFlag);
  void makeCommandList();
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
};

class Window_ShopStatus : public Window_Base {
 public:
  int itemKind = 0;
  int itemId = 0;
  int pageIndex = 0;
  Window_ShopStatus(int x, int y, int w, int h);
  int pageSize() const { return 4; }
  int maxPages(const Session& session) const;
  std::vector<int> statusMembers(const Session& session) const;
  int paramId() const { return itemKind == 1 ? 2 : 3; } // 1=weapon -> atk(2), 2=armor -> def(3)
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
  Window_NameEdit(int actorIdVal, int maxLen, std::string initialName);
  int faceWidth() const { return 144; }
  int charWidth(bool isJapanese = false) const;
  int left(bool isJapanese = false) const;
  Rect itemRect(int charIndex, bool isJapanese = false) const;
  Rect underlineRect(int charIndex, bool isJapanese = false) const;
  bool add(const std::string& ch);
  bool back();
  void restoreDefault();
};

class Window_NameInput : public Window_Selectable {
 public:
  int page = 0;
  Window_NameInput();
  int maxItems() const override { return 90; }
  bool isOk() const { return index == 89; }
  bool isPageChange() const { return index == 88; }
  std::string character() const;
};

class Window_ChoiceList : public Window_Command {
 public:
  Window_ChoiceList();
  void makeCommandList(const Session& session);
};

class Window_NumberInput : public Window_Selectable {
 public:
  int maxDigits = 1;
  int number = 0;
  Window_NumberInput();
  int maxItems() const override { return maxDigits; }
  void changeDigit(bool up);
};

class Window_EventItem : public Window_ItemList {
 public:
  int itypeId = 2;
  Window_EventItem();
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
  void makeCommandList(bool canEscape);
};

class Window_ActorCommand : public Window_Command {
 public:
  int actorId = 0;
  Window_ActorCommand();
  void makeCommandList(const Session& session);
};

class Window_BattleActor : public Window_BattleStatus {
 public:
  Window_BattleActor(int x, int y);
  int maxItems() const override;
};

class Window_BattleEnemy : public Window_Selectable {
 public:
  std::vector<int> enemyIndices;
  Window_BattleEnemy(int x, int y);
  int maxItems() const override { return static_cast<int>(enemyIndices.size()); }
  void refresh(const Session& session);
};

class Window_BattleSkill : public Window_SkillList {
 public:
  Window_BattleSkill(int x, int y, int w, int h);
};

class Window_BattleItem : public Window_ItemList {
 public:
  Window_BattleItem(int x, int y, int w, int h);
};

class Window_TitleCommand : public Window_Command {
 public:
  Window_TitleCommand();
  void makeCommandList(bool continueEnabled);
};

class Window_GameEnd : public Window_Command {
 public:
  Window_GameEnd();
  void makeCommandList();
};

class Window_DebugRange : public Window_Selectable {
 public:
  int maxSwitches = 0;
  int maxVariables = 0;
  Window_DebugRange(int x, int y);
  int maxItems() const override;
  std::string mode() const;
  int topId() const;
};

class Window_DebugEdit : public Window_Selectable {
 public:
  std::string mode = "switch";
  int topId = 1;
  Window_DebugEdit(int x, int y, int width);
  int maxItems() const override { return 10; }
  int currentId() const { return topId + std::max(0, index); }
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
  void update();
};

}  // namespace pmjs::mv

