#include "mv_windows.hpp"
#include "mv_managers.hpp"
#include "mv_core_utils.hpp"

#include <cmath>
#include <sstream>
#include <algorithm>
#include <cctype>
#include <cstdlib>
#include <stdexcept>

namespace pmjs::mv {

int nameInputPageCount(const std::string& locale) { return locale.starts_with("ja") ? 3 : locale.starts_with("ru") ? 1 : 2; }
const std::vector<std::string>& nameInputTable(int page, const std::string& locale) {
  static const std::vector<std::string> LATIN1 = {"A", "B", "C", "D", "E", "a", "b", "c", "d", "e", "F", "G", "H", "I", "J", "f", "g", "h", "i", "j", "K", "L", "M", "N", "O", "k", "l", "m", "n", "o", "P", "Q", "R", "S", "T", "p", "q", "r", "s", "t", "U", "V", "W", "X", "Y", "u", "v", "w", "x", "y", "Z", "[", "]", "^", "_", "z", "{", "}", "|", "~", "0", "1", "2", "3", "4", "!", "#", "$", "%", "&", "5", "6", "7", "8", "9", "(", ")", "*", "+", "-", "/", "=", "@", "<", ">", ":", ";", " ", "Page", "OK"};
  static const std::vector<std::string> LATIN2 = {"Á", "É", "Í", "Ó", "Ú", "á", "é", "í", "ó", "ú", "À", "È", "Ì", "Ò", "Ù", "à", "è", "ì", "ò", "ù", "Â", "Ê", "Î", "Ô", "Û", "â", "ê", "î", "ô", "û", "Ä", "Ë", "Ï", "Ö", "Ü", "ä", "ë", "ï", "ö", "ü", "Ā", "Ē", "Ī", "Ō", "Ū", "ā", "ē", "ī", "ō", "ū", "Ã", "Å", "Æ", "Ç", "Ð", "ã", "å", "æ", "ç", "ð", "Ñ", "Õ", "Ø", "Š", "Ŵ", "ñ", "õ", "ø", "š", "ŵ", "Ý", "Ŷ", "Ÿ", "Ž", "Þ", "ý", "ÿ", "ŷ", "ž", "þ", "Ĳ", "Œ", "ĳ", "œ", "ß", "«", "»", " ", "Page", "OK"};
  static const std::vector<std::string> RUSSIA = {"А", "Б", "В", "Г", "Д", "а", "б", "в", "г", "д", "Е", "Ё", "Ж", "З", "И", "е", "ё", "ж", "з", "и", "Й", "К", "Л", "М", "Н", "й", "к", "л", "м", "н", "О", "П", "Р", "С", "Т", "о", "п", "р", "с", "т", "У", "Ф", "Х", "Ц", "Ч", "у", "ф", "х", "ц", "ч", "Ш", "Щ", "Ъ", "Ы", "Ь", "ш", "щ", "ъ", "ы", "ь", "Э", "Ю", "Я", "^", "_", "э", "ю", "я", "%", "&", "0", "1", "2", "3", "4", "(", ")", "*", "+", "-", "5", "6", "7", "8", "9", ":", ";", " ", "", "OK"};
  static const std::vector<std::string> JAPAN1 = {"あ", "い", "う", "え", "お", "が", "ぎ", "ぐ", "げ", "ご", "か", "き", "く", "け", "こ", "ざ", "じ", "ず", "ぜ", "ぞ", "さ", "し", "す", "せ", "そ", "だ", "ぢ", "づ", "で", "ど", "た", "ち", "つ", "て", "と", "ば", "び", "ぶ", "べ", "ぼ", "な", "に", "ぬ", "ね", "の", "ぱ", "ぴ", "ぷ", "ぺ", "ぽ", "は", "ひ", "ふ", "へ", "ほ", "ぁ", "ぃ", "ぅ", "ぇ", "ぉ", "ま", "み", "む", "め", "も", "っ", "ゃ", "ゅ", "ょ", "ゎ", "や", "ゆ", "よ", "わ", "ん", "ー", "～", "・", "＝", "☆", "ら", "り", "る", "れ", "ろ", "ゔ", "を", "　", "カナ", "決定"};
  static const std::vector<std::string> JAPAN2 = {"ア", "イ", "ウ", "エ", "オ", "ガ", "ギ", "グ", "ゲ", "ゴ", "カ", "キ", "ク", "ケ", "コ", "ザ", "ジ", "ズ", "ゼ", "ゾ", "サ", "シ", "ス", "セ", "ソ", "ダ", "ヂ", "ヅ", "デ", "ド", "タ", "チ", "ツ", "テ", "ト", "バ", "ビ", "ブ", "ベ", "ボ", "ナ", "ニ", "ヌ", "ネ", "ノ", "パ", "ピ", "プ", "ペ", "ポ", "ハ", "ヒ", "フ", "ヘ", "ホ", "ァ", "ィ", "ゥ", "ェ", "ォ", "マ", "ミ", "ム", "メ", "モ", "ッ", "ャ", "ュ", "ョ", "ヮ", "ヤ", "ユ", "ヨ", "ワ", "ン", "ー", "～", "・", "＝", "☆", "ラ", "リ", "ル", "レ", "ロ", "ヴ", "ヲ", "　", "英数", "決定"};
  static const std::vector<std::string> JAPAN3 = {"Ａ", "Ｂ", "Ｃ", "Ｄ", "Ｅ", "ａ", "ｂ", "ｃ", "ｄ", "ｅ", "Ｆ", "Ｇ", "Ｈ", "Ｉ", "Ｊ", "ｆ", "ｇ", "ｈ", "ｉ", "ｊ", "Ｋ", "Ｌ", "Ｍ", "Ｎ", "Ｏ", "ｋ", "ｌ", "ｍ", "ｎ", "ｏ", "Ｐ", "Ｑ", "Ｒ", "Ｓ", "Ｔ", "ｐ", "ｑ", "ｒ", "ｓ", "ｔ", "Ｕ", "Ｖ", "Ｗ", "Ｘ", "Ｙ", "ｕ", "ｖ", "ｗ", "ｘ", "ｙ", "Ｚ", "［", "］", "＾", "＿", "ｚ", "｛", "｝", "｜", "～", "０", "１", "２", "３", "４", "！", "＃", "＄", "％", "＆", "５", "６", "７", "８", "９", "（", "）", "＊", "＋", "－", "／", "＝", "＠", "＜", "＞", "：", "；", "　", "かな", "決定"};
  if (locale.starts_with("ja")) return page == 1 ? JAPAN2 : page == 2 ? JAPAN3 : JAPAN1;
  if (locale.starts_with("ru")) return RUSSIA;
  return page == 1 ? LATIN2 : LATIN1;
}

Window_Base::Window_Base(int x, int y, int w, int h)
  : rect{x, y, w, h} {
  if (core::boundRuntime()) contents.resize(contentsWidth(), contentsHeight());
}

namespace {
std::string colorToHex(Color c) {
  static const char kHex[] = "0123456789abcdef";
  std::string out = "#";
  out.push_back(kHex[(c.r >> 4) & 0xf]);
  out.push_back(kHex[c.r & 0xf]);
  out.push_back(kHex[(c.g >> 4) & 0xf]);
  out.push_back(kHex[c.g & 0xf]);
  out.push_back(kHex[(c.b >> 4) & 0xf]);
  out.push_back(kHex[c.b & 0xf]);
  return out;
}
} // namespace

void Window_Base::createContents() {
  if (core::boundRuntime()) contents.resize(contentsWidth(), contentsHeight());
  drawnTexts.clear();
}

int Window_Base::textWidth(const std::string& text) const {
  return static_cast<int>(text.size()) * (fontSize / 2);
}

void Window_Base::drawText(const std::string& text, int x, int y, int maxWidth, const std::string& align) {
  drawnTexts.push_back({text, x, y, maxWidth, align, textColor});
}

void Window_Base::drawGauge(int x, int y, int width, double rate, Color color1, Color color2) {
  const int fillW = static_cast<int>(std::floor(width * std::clamp(rate, 0.0, 1.0)));
  const int gaugeY = y + lineHeight() - 8;
  if (core::boundRuntime()) {
    if (contents.width != contentsWidth() || contents.height != contentsHeight()) contents.resize(contentsWidth(), contentsHeight());
    contents.fillRect(x, gaugeY, width, 6, colorToHex(gaugeBackColor()));
    contents.gradientFillRect(x, gaugeY, fillW, 6, colorToHex(color1), colorToHex(color2), false);
  }
}

void Window_Base::drawCurrentAndMax(int current, int max, int x, int y, int width, Color color1, Color color2) {
  const int labelWidth = textWidth("HP");
  const int valueWidth = textWidth("0000");
  const int slashWidth = textWidth("/");
  const int x1 = x + width - valueWidth;
  const int x2 = x1 - slashWidth;
  const int x3 = x2 - valueWidth;
  if (x3 >= x + labelWidth) {
    changeTextColor(color1);
    drawText(std::to_string(current), x3, y, valueWidth, "right");
    changeTextColor(color2);
    drawText("/", x2, y, slashWidth, "right");
    drawText(std::to_string(max), x1, y, valueWidth, "right");
  } else {
    changeTextColor(color1);
    drawText(std::to_string(current), x1, y, valueWidth, "right");
  }
}

void Window_Base::drawActorHp(const Battler& actor, const Session& session, int x, int y, int width) {
  const int mhp = static_cast<int>(std::max(1.0, session.parameter(actor, 0)));
  const double rate = static_cast<double>(actor.hp) / static_cast<double>(mhp);
  drawGauge(x, y, width, rate, hpGaugeColor1(), hpGaugeColor2());
  changeTextColor(systemColor());
  const std::string label = TextManager::hpA(session);
  drawText(label.empty() ? "HP" : label, x, y, 44);
  drawCurrentAndMax(actor.hp, mhp, x, y, width, hpColor(actor.hp, mhp), normalColor());
}

void Window_Base::drawActorMp(const Battler& actor, const Session& session, int x, int y, int width) {
  const int mmp = static_cast<int>(session.parameter(actor, 1));
  const double rate = mmp > 0 ? static_cast<double>(actor.mp) / static_cast<double>(mmp) : 0.0;
  drawGauge(x, y, width, rate, mpGaugeColor1(), mpGaugeColor2());
  changeTextColor(systemColor());
  const std::string label = TextManager::mpA(session);
  drawText(label.empty() ? "MP" : label, x, y, 44);
  drawCurrentAndMax(actor.mp, mmp, x, y, width, normalColor(), normalColor());
}

void Window_Base::drawActorTp(const Battler& actor, int x, int y, int width, const Session* session) {
  const double rate = static_cast<double>(actor.tp) / 100.0;
  drawGauge(x, y, width, rate, tpGaugeColor1(), tpGaugeColor2());
  changeTextColor(systemColor());
  const std::string label = session ? TextManager::tpA(*session) : std::string("TP");
  drawText(label.empty() ? "TP" : label, x, y, 44);
  changeTextColor(normalColor());
  drawText(std::to_string(actor.tp), x + width - 64, y, 64, "right");
}

void Window_Base::drawActorName(const Battler& actor, const Session& session, int x, int y, int width) {
  const int mhp = static_cast<int>(std::max(1.0, session.parameter(actor, 0)));
  changeTextColor(hpColor(actor.hp, mhp));
  drawText(actor.name, x, y, width);
}

void Window_Base::drawActorClass(const Battler& actor, const Session& session, int x, int y, int width) {
  resetTextColor();
  drawText(session.database()["classes"][actor.classId]["name"].text(), x, y, width);
}

void Window_Base::drawActorNickname(const Battler& actor, int x, int y, int width) {
  resetTextColor();
  drawText(actor.nickname, x, y, width);
}

void Window_Base::drawActorLevel(const Battler& actor, const Session& session, int x, int y) {
  changeTextColor(systemColor());
  const std::string label = TextManager::levelA(session);
  drawText(label.empty() ? "Lv" : label, x, y, 48);
  resetTextColor();
  drawText(std::to_string(actor.level), x + 84, y, 36, "right");
}

void Window_Base::drawActorSimpleStatus(const Battler& actor, const Session& session, int x, int y, int width) {
  const int lh = lineHeight();
  const int x2 = x + 180;
  const int width2 = std::min(200, width - 180 - textPadding());
  drawActorName(actor, session, x, y);
  drawActorLevel(actor, session, x, y + lh * 1);
  drawActorClass(actor, session, x2, y);
  drawActorHp(actor, session, x2, y + lh * 1, width2);
  drawActorMp(actor, session, x2, y + lh * 2, width2);
}

void Window_Base::drawItemName(const Value& item, int x, int y, int width) {
  if (item.null()) return;
  const int iconBoxWidth = 32 + 4;
  resetTextColor();
  drawText(item["name"].text(), x + iconBoxWidth, y, width - iconBoxWidth);
}

void Window_Base::drawCurrencyValue(int value, const std::string& unit, int x, int y, int width) {
  const int unitWidth = std::min(80, textWidth(unit));
  resetTextColor();
  drawText(std::to_string(value), x, y, width - unitWidth - 6, "right");
  changeTextColor(systemColor());
  drawText(unit, x + width - unitWidth, y, unitWidth, "right");
}

void Window_Base::update() {
  if (openness < 255) openness = std::min(255, openness + 32);
}

Color Window_Base::normalColor() { return {255, 255, 255, 255}; }
Color Window_Base::systemColor() { return {128, 204, 255, 255}; }
Color Window_Base::crisisColor() { return {255, 204, 34, 255}; }
Color Window_Base::deathColor() { return {255, 56, 34, 255}; }
Color Window_Base::gaugeBackColor() { return {32, 32, 64, 255}; }
Color Window_Base::hpGaugeColor1() { return {224, 128, 64, 255}; }
Color Window_Base::hpGaugeColor2() { return {240, 192, 64, 255}; }
Color Window_Base::mpGaugeColor1() { return {128, 128, 240, 255}; }
Color Window_Base::mpGaugeColor2() { return {192, 192, 255, 255}; }
Color Window_Base::mpCostColor() { return {192, 192, 255, 255}; }
Color Window_Base::powerUpColor() { return {128, 255, 128, 255}; }
Color Window_Base::powerDownColor() { return {255, 128, 128, 255}; }
Color Window_Base::tpGaugeColor1() { return {0, 160, 96, 255}; }
Color Window_Base::tpGaugeColor2() { return {0, 224, 128, 255}; }
Color Window_Base::tpCostColor() { return {0, 224, 128, 255}; }

Color Window_Base::hpColor(int hp, int mhp) {
  if (hp == 0) return deathColor();
  if (mhp > 0 && hp < mhp / 4) return crisisColor();
  return normalColor();
}

Color Window_Base::paramchangeTextColor(int change) {
  if (change > 0) return powerUpColor();
  if (change < 0) return powerDownColor();
  return normalColor();
}

Color Window_Base::textColorAt(int idx) {
  static const Color kPalette[32] = {
    {255,255,255,255}, {32,160,214,255}, {255,120,76,255}, {102,204,64,255},
    {153,204,255,255}, {204,192,255,255}, {255,255,160,255}, {128,128,128,255},
    {192,192,192,255}, {32,128,204,255}, {255,56,16,255}, {0,160,16,255},
    {62,154,222,255}, {160,152,255,255}, {255,204,32,255}, {0,0,0,255},
    {132,170,255,255}, {255,255,64,255}, {255,32,32,255}, {32,32,64,255},
    {224,128,64,255}, {240,192,64,255}, {64,128,192,255}, {64,192,240,255},
    {128,255,128,255}, {192,128,128,255}, {128,128,255,255}, {255,128,255,255},
    {0,160,64,255}, {0,224,96,255}, {160,96,224,255}, {192,128,255,255}
  };
  return kPalette[std::clamp(idx, 0, 31)];
}

std::string Window_Base::processEscapeCodes(const std::string& source, const Session& session) {
  std::string result = source;
  for (int pass = 0; pass < 2; ++pass) {
    std::string expanded;
    for (std::size_t index = 0; index < result.size();) {
      if (result[index] != '\\' || index+1 >= result.size()) { expanded += result[index++]; continue; }
      const char code = std::toupper(static_cast<unsigned char>(result[index+1]));
      if (code == '\\') { expanded += '\x1f'; index += 2; continue; }
      if (code == 'G') { expanded += session.database()["system"]["currencyUnit"].text(); index += 2; continue; }
      if ((code == 'V' || code == 'N' || code == 'P') && index+2 < result.size() && result[index+2]=='[') {
        const auto end = result.find(']',index+3);
        if (end != std::string::npos) {
          const int id = std::atoi(result.substr(index+3,end-index-3).c_str());
          if (code == 'V') {
            const auto& value = session.variable(id);
            if (std::holds_alternative<std::string>(value.data)) expanded += value.text();
            else if (std::holds_alternative<bool>(value.data)) expanded += value.boolean() ? "true" : "false";
            else { std::ostringstream text; text << value.number(); expanded += text.str(); }
          } else {
            const int actor = code == 'P' ? (id > 0 && id <= static_cast<int>(session.party_.size()) ? session.party_[id-1] : 0) : id;
            if (session.actors().contains(actor)) expanded += session.actors().at(actor).name;
            else expanded += session.database_["actors"][actor]["name"].text();
          }
          index = end+1; continue;
        }
      }
      expanded += result[index++];
    }
    result = std::move(expanded);
  }
  std::replace(result.begin(),result.end(),'\\','\x1b');
  std::replace(result.begin(),result.end(),'\x1f','\\');
  return result;
}

Window_Selectable::Window_Selectable(int x, int y, int w, int h)
  : Window_Base(x, y, w, h) {}

int Window_Selectable::maxRows() const {
  return std::max(1, static_cast<int>(std::ceil(static_cast<double>(maxItems()) / std::max(1, maxCols))));
}

Rect Window_Selectable::itemRectFor(int itemIndex, int contentsWidth, int columns, int itemHeight, int spacing, int topRow) {
  columns = std::max(1, columns);
  const int width = static_cast<int>(std::floor((contentsWidth + spacing) / static_cast<double>(columns) - spacing));
  return {itemIndex % columns * (width + spacing), (itemIndex / columns - topRow) * itemHeight, width, itemHeight};
}

int Window_Selectable::clampTopRow(int row, int itemCount, int columns, int pageRows) {
  const int rows = std::max(1, static_cast<int>(std::ceil(itemCount / static_cast<double>(std::max(1, columns)))));
  return std::clamp(row, 0, std::max(0, rows - pageRows));
}

int Window_Selectable::visibleTopRow(int index, int topRow, int itemCount, int columns, int pageRows) {
  const int row = static_cast<int>(std::floor(index / static_cast<double>(std::max(1, columns))));
  if (row < topRow) topRow = row;
  else if (row > topRow + pageRows - 1) topRow = row - pageRows + 1;
  return clampTopRow(topRow, itemCount, columns, pageRows);
}

int Window_Selectable::wheelTopRow(int topRow, int itemCount, int columns, int pageRows, double wheelY) {
  if (wheelY >= 20) ++topRow;
  if (wheelY <= -20) --topRow;
  return clampTopRow(topRow, itemCount, columns, pageRows);
}

void Window_Selectable::moveCursor(int& index, int& topRow, int itemCount, int columns, int pageRows, int direction, bool wrap) {
  if (itemCount <= 0) { topRow = 0; return; }
  columns = std::max(1, columns);
  if (direction == 2 && (index < itemCount - columns || (wrap && columns == 1))) index = (index + columns) % itemCount;
  else if (direction == 8 && (index >= columns || (wrap && columns == 1))) index = (index - columns + itemCount) % itemCount;
  else if (direction == 6 && columns >= 2 && (index < itemCount - 1 || (wrap && pageRows == 1))) index = (index + 1) % itemCount;
  else if (direction == 4 && columns >= 2 && (index > 0 || (wrap && pageRows == 1))) index = (index - 1 + itemCount) % itemCount;
  topRow = visibleTopRow(index, topRow, itemCount, columns, pageRows);
}

void Window_Selectable::pageCursor(int& index, int& topRow, int itemCount, int columns, int pageRows, bool down) {
  if (itemCount <= 0) { topRow = 0; return; }
  const int rows = std::max(1, static_cast<int>(std::ceil(itemCount / static_cast<double>(std::max(1, columns)))));
  if (down && topRow + pageRows < rows) {
    topRow = clampTopRow(topRow + pageRows, itemCount, columns, pageRows);
    index = std::min(index + pageRows * std::max(1, columns), itemCount - 1);
  } else if (!down && topRow > 0) {
    topRow = clampTopRow(topRow - pageRows, itemCount, columns, pageRows);
    index = std::max(index - pageRows * std::max(1, columns), 0);
  }
  topRow = visibleTopRow(index, topRow, itemCount, columns, pageRows);
}

int Window_Selectable::maxPageRows() const {
  return static_cast<int>(std::floor(static_cast<double>(contentsHeight()) / itemHeight()));
}

int Window_Selectable::maxPageItems() const {
  return maxPageRows() * std::max(1, maxCols);
}

void Window_Selectable::setTopRow(int rowVal) {
  topRow = clampTopRow(rowVal, maxItems(), maxCols, maxPageRows());
}

void Window_Selectable::setBottomRow(int rowVal) {
  setTopRow(rowVal - (maxPageRows() - 1));
}

void Window_Selectable::select(int newIndex) {
  index = newIndex;
  ensureCursorVisible();
}

void Window_Selectable::ensureCursorVisible() {
  topRow = visibleTopRow(index, topRow, maxItems(), maxCols, maxPageRows());
}

Rect Window_Selectable::itemRect(int itemIndex) const {
  return itemRectFor(itemIndex, contentsWidth(), maxCols, itemHeight(), spacing, topRow);
}

Rect Window_Selectable::itemRectForText(int itemIndex) const {
  Rect r = itemRect(itemIndex);
  r.x += textPadding();
  r.width = std::max(0, r.width - textPadding() * 2);
  return r;
}

bool Window_Selectable::isCursorMovable() const {
  return visible && active && openness == 255 && maxItems() > 0;
}

void Window_Selectable::cursorDown(bool wrap) {
  moveCursor(index, topRow, maxItems(), maxCols, maxPageRows(), 2, wrap);
}

void Window_Selectable::cursorUp(bool wrap) {
  moveCursor(index, topRow, maxItems(), maxCols, maxPageRows(), 8, wrap);
}

void Window_Selectable::cursorRight(bool wrap) {
  moveCursor(index, topRow, maxItems(), maxCols, maxPageRows(), 6, wrap);
}

void Window_Selectable::cursorLeft(bool wrap) {
  moveCursor(index, topRow, maxItems(), maxCols, maxPageRows(), 4, wrap);
}

void Window_Selectable::cursorPagedown() {
  pageCursor(index, topRow, maxItems(), maxCols, maxPageRows(), true);
}

void Window_Selectable::cursorPageup() {
  pageCursor(index, topRow, maxItems(), maxCols, maxPageRows(), false);
}

void Window_Selectable::processCursorMove(bool downRep, bool downTrig, bool upRep, bool upTrig,
                                          bool rightRep, bool rightTrig, bool leftRep, bool leftTrig,
                                          bool pageDownTrig, bool pageUpTrig,
                                          bool pageDownHandled, bool pageUpHandled) {
  if (!isCursorMovable()) return;
  if (downRep) cursorDown(downTrig);
  if (upRep) cursorUp(upTrig);
  if (rightRep) cursorRight(rightTrig);
  if (leftRep) cursorLeft(leftTrig);
  if (!pageDownHandled && pageDownTrig) cursorPagedown();
  if (!pageUpHandled && pageUpTrig) cursorPageup();
}

void Window_Selectable::processWheel(double wheelY) {
  if (!isOpenAndActive()) return;
  topRow = wheelTopRow(topRow, maxItems(), maxCols, maxPageRows(), wheelY);
}

Window_Command::Window_Command(int x, int y, int w, int h)
  : Window_Selectable(x, y, w, h) {}

void Window_Command::addCommand(std::string name, std::string symbol, bool enabled, int ext) {
  commands.push_back({std::move(name), std::move(symbol), enabled, ext});
}

std::string Window_Command::currentSymbol() const {
  return index >= 0 && index < static_cast<int>(commands.size()) ? commands[index].symbol : "";
}

int Window_Command::currentExt() const {
  return index >= 0 && index < static_cast<int>(commands.size()) ? commands[index].ext : 0;
}

bool Window_Command::isCurrentItemEnabled() const {
  return index >= 0 && index < static_cast<int>(commands.size()) && commands[index].enabled;
}

Window_ItemList::Window_ItemList(int x, int y, int w, int h)
  : Window_Selectable(x, y, w, h) {
  maxCols = 2;
}

bool Window_ItemList::includes(int kind, int id, const Session& session) const {
  return includes(session, category, kind, id);
}

bool Window_ItemList::includes(const Session& session, const std::string& category, int kind, int id) {
  const auto& item = session.database()[kind == 0 ? "items" : kind == 1 ? "weapons" : "armors"][id];
  if (item.null()) return false;
  if (kind == 0) { // item
    if (category == "item") return item["itypeId"].integer(1) == 1;
    if (category == "keyItem") return item["itypeId"].integer(1) == 2;
    return false;
  }
  if (kind == 1 && category == "weapon") return true;
  if (kind == 2 && category == "armor") return true;
  return false;
}

void Window_ItemList::refresh(const Session& session) {
  data = makeItemList(session, category);
}

std::vector<int> Window_ItemList::makeItemList(const Session& session, const std::string& category) {
  std::vector<int> data;
  for (const auto& [itemKey, count] : session.inventory_) {
    if (count <= 0) continue;
    const int kind = itemKey / 100000;
    const int id = itemKey % 100000;
    if (includes(session, category, kind, id)) data.push_back(itemKey);
  }
  return data;
}

bool Window_ItemList::isCurrentItemEnabled() const {
  return index >= 0 && index < static_cast<int>(data.size());
}

Window_SkillList::Window_SkillList(int x, int y, int w, int h)
  : Window_Selectable(x, y, w, h) {
  maxCols = 2;
}

void Window_SkillList::refresh(const Session& session) {
  data = makeSkillList(session, actorId, skillType);
}

std::vector<int> Window_SkillList::makeSkillList(const Session& session, int actorId, int skillType) {
  std::vector<int> data;
  if (!session.actors().contains(actorId)) return data;
  const auto& actor = session.actors().at(actorId);
  for (int skillId : session.battlerSkills(actor)) {
    const auto& skill = session.database()["skills"][skillId];
    if (!skill.null() && skill["stypeId"].integer() == skillType) {
      data.push_back(skillId);
    }
  }
  return data;
}

bool Window_SkillList::isCurrentItemEnabled() const {
  return index >= 0 && index < static_cast<int>(data.size());
}

std::vector<int> Window_BattleItem::makeItemList(const Session& session) {
  std::vector<int> entries;
  for (const auto& [id, count] : session.inventory_) {
    if (id <= 0 || id >= 100000 || count <= 0) continue;
    const auto& item = session.database()["items"][id];
    if (item.null()) continue;
    for (std::size_t index = 0; index < session.battleMemberCount(); ++index) {
      if (session.canUse(session.actor(session.party()[index]), item)) {
        entries.push_back(id);
        break;
      }
    }
  }
  return entries;
}

void Window_BattleItem::refresh(const Session& session) {
  data = makeItemList(session);
}

Window_EquipSlot::Window_EquipSlot(int x, int y, int w, int h)
  : Window_Selectable(x, y, w, h) {}

int Window_EquipSlot::maxItems() const {
  return session_ && session_->actors().contains(actorId) ? static_cast<int>(session_->actor(actorId).equips.size()) : 0;
}
bool Window_EquipSlot::isCurrentItemEnabled() const {
  return session_ && session_->actors().contains(actorId) && index >= 0 && index < maxItems() && session_->canChangeEquip(session_->actor(actorId),index);
}

std::string Window_EquipSlot::slotName(int slotIndex, const Session& session) const {
  const auto& equipTypes = session.database()["system"]["equipTypes"];
  if (!session.actors().contains(actorId)) return {};
  return equipTypes[session.equipSlotType(session.actor(actorId),slotIndex)].text();
}

Window_BattleStatus::Window_BattleStatus(int x, int y, int w, int h)
  : Window_Selectable(x, y, w, h) {
  maxCols = 4;
}

int Window_BattleStatus::maxItems() const { return 4; }

Window_BattleLog::Window_BattleLog(int x, int y, int w, int h)
  : Window_Base(x, y, w, h) {}

void Window_BattleLog::tick(Session& session, bool fastForward, bool effecting, bool moving) {
  if (waitCount > 0) {
    waitCount = std::max(0, waitCount - (fastForward ? 3 : 1));
    return;
  }
  const bool waiting = (waitMode == "effect" && effecting) || (waitMode == "movement" && moving);
  if (waiting) return;
  waitMode.clear();
  callNextMethod(session);
}

Window_BattleLog::MethodCall Window_BattleLog::popMethod() {
  if (methods.empty()) return {};
  MethodCall call = std::move(methods.front());
  methods.erase(methods.begin());
  return call;
}

bool Window_BattleLog::callNextMethod(Session& session) {
  if (methods.empty()) return false;
  MethodCall method = popMethod();
  if (method.name == "wait") {
    wait();
    return true;
  }
  if (method.name == "waitForEffect") {
    waitForEffect();
    return true;
  }
  if (method.name == "waitForMovement") {
    waitForMovement();
    return true;
  }
  if (method.name == "setWaitMode") {
    setWaitMode(method.text);
    return true;
  }
  if (method.name == "addText") {
    addText(method.text);
    return true;
  }
  if (method.name == "pushBaseLine") {
    pushBaseLine();
    return true;
  }
  if (method.name == "popBaseLine") {
    popBaseLine();
    return true;
  }
  if (method.name == "waitForNewLine") {
    waitForNewLine();
    return true;
  }
  if (method.name == "clear") {
    clear();
    return true;
  }
  if (method.name == "popupDamage") {
    if (method.subjectId >= 0 && method.subjectId < static_cast<int>(session.battle_.visuals.size())) {
      auto& visual = session.battle_.visuals[method.subjectId];
      if (method.value >= 0 && method.value < static_cast<int>(visual.targets.size())) {
        visual.targets[method.value].impact = session.ticks_;
        if (!visual.impact) visual.impact = session.ticks_;
        queuedBattler(session,method.targetId).result = {};
      }
    }
    return true;
  }
  if (method.name == "showAnimation") { showAnimation(session,method.value); return true; }
  if (method.name.starts_with("perform")) {
    auto* target = &queuedBattler(session,method.targetId);
    if (method.name == "performActionStart") {
      session.battle_.visuals.at(method.value).movementStarted = session.ticks_;
      performActionStart(session,*target,{});
    }
    else if (method.name == "performAction") {
      session.battle_.visuals.at(method.value).started = session.ticks_;
      performAction(*target,{});
    }
    else if (method.name == "performSubstitute") {
      performSubstitute(queuedBattler(session,method.subjectId),*target);
    }
    else if (method.name == "performDamage") performDamage(session,*target);
    else if (method.name == "performMiss") performMiss(session,*target);
    else if (method.name == "performRecovery") performRecovery(session,*target);
    else if (method.name == "performEvasion") performEvasion(session,*target);
    else if (method.name == "performMagicEvasion") performMagicEvasion(session,*target);
    else if (method.name == "performCounter") performCounter(session,*target);
    else if (method.name == "performReflection") performReflection(session,*target);
    else if (method.name == "performCollapse") performCollapse(session,*target);
    else throw std::invalid_argument("unknown battle log method: " + method.name);
    return true;
  }
  throw std::invalid_argument("unknown battle log method: " + method.name);
}

void Window_BattleLog::popBaseLine() {
  if (baseLineStack.empty()) return;
  const int baseLine = baseLineStack.back();
  baseLineStack.pop_back();
  auto& output = logLines();
  while (static_cast<int>(output.size()) > baseLine) {
    output.pop_back();
  }
}

void Window_BattleLog::waitForNewLine() {
  const int baseLine = baseLineStack.empty() ? 0 : baseLineStack.back();
  if (static_cast<int>(logLines().size()) > baseLine) {
    wait();
  }
}

void Window_BattleLog::addText(std::string text) {
  logLines().push_back(std::move(text));
  wait();
}

void Window_BattleLog::clear() {
  logLines().clear();
  baseLineStack.clear();
}

void Window_BattleLog::waitForEffect() {
  setWaitMode("effect");
}

void Window_BattleLog::performActionStart(Session& session, Battler& subject, const Value& action) {
  if (subject.enemy) session.requestEnemyEffect(static_cast<std::size_t>(-battlerId(session,subject)-1),"whiten");
  (void)action;
}

void Window_BattleLog::performAction(Battler& subject, const Value& action) {
  (void)subject;
  (void)action;
}

void Window_BattleLog::performActionEnd(Battler& subject) {
  (void)subject;
}

int Window_BattleLog::battlerId(const Session& session, const Battler& target) {
  return target.enemy ? -1-static_cast<int>(&target-session.battle_.enemies.data()) : target.id;
}
Battler& Window_BattleLog::queuedBattler(Session& session, int id) {
  return id < 0 ? session.battle_.enemies.at(static_cast<std::size_t>(-id-1)) : session.actors_.at(id);
}
void Window_BattleLog::showAnimation(Session& session, int visualIndex) {
  const auto& visual = session.battle_.visuals.at(visualIndex);
  const auto& action = visual.action;
  const auto& item = session.database()[action.item ? "items" : "skills"][action.id];
  const int animationId = item["animationId"].integer();
  std::vector<int> animations;
  if (animationId >= 0) animations.push_back(animationId);
  else if (action.enemy) { SoundManager::playEnemyAttack(session); return; }
  else {
    const auto& actor = session.actors_.at(session.party_.at(action.subject));
    for (std::size_t slot = 0; slot < actor.equips.size(); ++slot)
      if (actor.equips[slot] && actor.equipKinds[slot] == 1) animations.push_back(session.database()["weapons"][actor.equips[slot]]["animationId"].integer());
    if (animations.empty()) animations.push_back(1);
    if (animations.size() > 2) animations.resize(2);
  }
  for (std::size_t pass = 0; pass < animations.size(); ++pass)
    for (std::size_t index = 0; index < visual.animationTargets.size(); ++index) {
      const auto& target = visual.animationTargets[index];
      session.requestAnimation(target.enemy ? 2 : 1,target.enemy ? target.index : session.party_.at(target.index),
        animations[pass],pass == 1,false,8+static_cast<int>(index)*12);
    }
}
void Window_BattleLog::queuePopup(Session& session, const Battler& target, int visualIndex, int recordIndex) {
  if (recordIndex < 0) {
    const auto& result = target.result;
    if (!result.hpAffected && result.mpDamage == 0 && result.tpDamage == 0 && !result.missed) return;
    if (visualIndex < 0) {
      BattleVisual visual; visual.actionVisual = false;
      session.battle_.visuals.push_back(std::move(visual));
      visualIndex = static_cast<int>(session.battle_.visuals.size())-1;
    }
    auto& visual = session.battle_.visuals.at(visualIndex);
    BattleTarget entry; entry.enemy = target.enemy;
    entry.index = target.enemy ? -battlerId(session,target)-1 : static_cast<int>(std::find(session.party_.begin(),session.party_.end(),target.id)-session.party_.begin());
    entry.result = result; entry.aliveAtImpact = target.hp > 0;
    recordIndex = static_cast<int>(visual.targets.size());
    visual.targets.push_back(std::move(entry));
  }
  push({"popupDamage",visualIndex,battlerId(session,target),recordIndex});
}

void Window_BattleLog::performDamage(Session& session, Battler& target) {
  if (target.enemy) {
    SoundManager::playEnemyDamage(session);
    session.requestEnemyEffect(static_cast<std::size_t>(-battlerId(session,target)-1),"blink");
  } else SoundManager::playActorDamage(session);
}
void Window_BattleLog::performMiss(Session& session, Battler&) { SoundManager::playMiss(session); }
void Window_BattleLog::performRecovery(Session& session, Battler&) { SoundManager::playRecovery(session); }
void Window_BattleLog::performEvasion(Session& session, Battler&) { SoundManager::playEvasion(session); }
void Window_BattleLog::performMagicEvasion(Session& session, Battler&) { SoundManager::playMagicEvasion(session); }
void Window_BattleLog::performCounter(Session& session, Battler& target) {
  SoundManager::playEvasion(session);
  if (target.enemy) return;
  int weapon = 0;
  for (std::size_t slot = 0; slot < target.equips.size(); ++slot)
    if (target.equips[slot] && target.equipKinds[slot] == 1) { weapon = target.equips[slot]; break; }
  const auto& attack = session.database()["system"]["attackMotions"][session.database()["weapons"][weapon]["wtypeId"].integer()];
  if (!attack.null()) session.requestActorMotion(target.id,6+attack["type"].integer(),attack["weaponImageId"].integer());
}
void Window_BattleLog::performReflection(Session& session, Battler&) { SoundManager::playReflection(session); }
void Window_BattleLog::performSubstitute(Battler& substitute, Battler& target) {
  (void)substitute; (void)target;
}
void Window_BattleLog::performCollapse(Session& session, Battler& target) {
  if (!target.enemy) { SoundManager::playActorCollapse(session); return; }
  int type = 0;
  for (const auto* object : session.traitObjects(target)) for (const auto& trait : (*object)["traits"].array())
    if (trait["code"].integer() == 63) type = std::max(type,trait["dataId"].integer());
  session.requestEnemyEffect(static_cast<std::size_t>(-battlerId(session,target)-1),
    type == 1 ? "bossCollapse" : type == 2 ? "instantCollapse" : "collapse");
}

void Window_BattleLog::displayAction(const Session& session, const Battler& subject, const Value& item) {
  const auto count = methods.size();
  if (!item["stypeId"].null()) {
    if (!item["message1"].text().empty()) push({"addText",0,0,0,subject.name+TextManager::format(item["message1"].text(),{item["name"].text()})});
    if (!item["message2"].text().empty()) push({"addText",0,0,0,TextManager::format(item["message2"].text(),{item["name"].text()})});
  } else push({"addText",0,0,0,TextManager::format(TextManager::useItem(session),{subject.name,item["name"].text()})});
  if (methods.size() == count) push({"wait"});
}
void Window_BattleLog::displayCounter(const Session& session, const Battler& target) {
  push({"performCounter",0,battlerId(session,target)});
  push({"addText",0,0,0,TextManager::format(TextManager::message(session,"counterAttack"),{target.name})});
}
void Window_BattleLog::displayReflection(const Session& session, const Battler& target) {
  push({"performReflection",0,battlerId(session,target)});
  push({"addText",0,0,0,TextManager::format(TextManager::message(session,"magicReflection"),{target.name})});
}
void Window_BattleLog::displaySubstitute(const Session& session, const Battler& substitute, const Battler& target) {
  push({"performSubstitute",battlerId(session,substitute),battlerId(session,target)});
  push({"addText",0,0,0,TextManager::format(TextManager::message(session,"substitute"),{substitute.name,target.name})});
}
void Window_BattleLog::displayActionResults(Session& session, const Battler& subject, const Battler& target) {
  if (!target.result.used) return;
  push({"pushBaseLine"});
  displayCritical(session,target);
  queuePopup(session,target,session.battle_.currentVisual,session.battle_.targetIndex-1);
  if (&subject != &target) queuePopup(session,subject,session.battle_.currentVisual);
  if (target.result.missed) displayMiss(session,target);
  else if (target.result.evaded) displayEvasion(session,target);
  else {
    displayHpDamage(session,target);
    displayMpDamage(session,target);
    displayTpDamage(session,target);
  }
  displayAffectedStatus(session,target);
  displayFailure(session,target);
  push({"waitForNewLine"});
  push({"popBaseLine"});
}
void Window_BattleLog::displayAutoAffectedStatus(const Session& session, const Battler& target) {
  const auto count = methods.size();
  displayAffectedStatus(session,target);
  if (methods.size() != count) push({"clear"});
}
void Window_BattleLog::displayCurrentState(const Session& session, const Battler& subject) {
  for (int state : subject.states) {
    const auto message = session.database()["states"][state]["message3"].text();
    if (!message.empty()) {
      push({"addText",0,0,0,subject.name+message}); push({"wait"}); push({"clear"});
      break;
    }
  }
}
void Window_BattleLog::displayRegeneration(Session& session, const Battler& target) { queuePopup(session,target); }
void Window_BattleLog::displayFailure(const Session& session, const Battler& target) {
  if (!target.result.missed && !target.result.evaded && !target.result.success)
    push({"addText",0,0,0,TextManager::format(TextManager::message(session,"actionFailure"),{target.name})});
}
void Window_BattleLog::displayCritical(const Session& session, const Battler& target) {
  if (target.result.critical) push({"addText",0,0,0,TextManager::message(session,target.enemy ? "criticalToEnemy" : "criticalToActor")});
}
void Window_BattleLog::displayMiss(const Session& session, const Battler& target) {
  if (target.result.physical) push({"performMiss",0,battlerId(session,target)});
  push({"addText",0,0,0,TextManager::format(TextManager::message(session,
    target.result.physical ? (target.enemy ? "enemyNoHit" : "actorNoHit") : "actionFailure"),{target.name})});
}
void Window_BattleLog::displayEvasion(const Session& session, const Battler& target) {
  push({target.result.physical ? "performEvasion" : "performMagicEvasion",0,battlerId(session,target)});
  push({"addText",0,0,0,TextManager::format(TextManager::message(session,target.result.physical ? "evasion" : "magicEvasion"),{target.name})});
}
void Window_BattleLog::displayHpDamage(const Session& session, const Battler& target) {
  const auto& result = target.result;
  if (!result.hpAffected) return;
  const int damage = result.hpDamage;
  if (damage > 0 && !result.drain) push({"performDamage",0,battlerId(session,target)});
  if (damage < 0) push({"performRecovery",0,battlerId(session,target)});
  const auto prefix = target.enemy ? "enemy" : "actor";
  std::string message;
  if (damage > 0 && !result.drain) message = TextManager::format(TextManager::message(session,std::string(prefix)+"Damage"),{target.name,std::to_string(damage)});
  else if (damage != 0) message = TextManager::format(TextManager::message(session,std::string(prefix)+(damage > 0 ? "Drain" : "Recovery")),{target.name,TextManager::hp(session),std::to_string(std::abs(damage))});
  else message = TextManager::format(TextManager::message(session,std::string(prefix)+"NoDamage"),{target.name});
  push({"addText",0,0,0,std::move(message)});
}
void Window_BattleLog::displayMpDamage(const Session& session, const Battler& target) {
  const auto& result = target.result;
  if (target.hp <= 0 || result.mpDamage == 0) return;
  const int damage = result.mpDamage;
  if (damage < 0) push({"performRecovery",0,battlerId(session,target)});
  const auto key = std::string(target.enemy ? "enemy" : "actor")+(damage > 0 ? (result.drain ? "Drain" : "Loss") : "Recovery");
  push({"addText",0,0,0,TextManager::format(TextManager::message(session,key),{target.name,TextManager::mp(session),std::to_string(std::abs(damage))})});
}
void Window_BattleLog::displayTpDamage(const Session& session, const Battler& target) {
  if (target.hp <= 0 || target.result.tpDamage == 0) return;
  const int damage = target.result.tpDamage;
  if (damage < 0) push({"performRecovery",0,battlerId(session,target)});
  const auto key = std::string(target.enemy ? "enemy" : "actor")+(damage > 0 ? "Loss" : "Gain");
  push({"addText",0,0,0,TextManager::format(TextManager::message(session,key),{target.name,TextManager::tp(session),std::to_string(std::abs(damage))})});
}
void Window_BattleLog::displayAffectedStatus(const Session& session, const Battler& target) {
  const auto& result = target.result;
  if (result.addedStates.empty() && result.removedStates.empty() && result.addedBuffs.empty() && result.addedDebuffs.empty() && result.removedBuffs.empty()) return;
  push({"pushBaseLine"});
  for (int stateId : result.addedStates) {
    const auto& state = session.database()["states"][stateId];
    if (stateId == 1) push({"performCollapse",0,battlerId(session,target)});
    const auto message = state[target.enemy ? "message2" : "message1"].text();
    if (!message.empty()) {
      push({"popBaseLine"}); push({"pushBaseLine"});
      push({"addText",0,0,0,target.name+message}); push({"waitForEffect"});
    }
  }
  for (int stateId : result.removedStates) {
    const auto message = session.database()["states"][stateId]["message4"].text();
    if (!message.empty()) {
      push({"popBaseLine"}); push({"pushBaseLine"}); push({"addText",0,0,0,target.name+message});
    }
  }
  const auto buffs = [&](const std::vector<int>& values, const std::string& key) {
    for (int parameter : values) {
      push({"popBaseLine"}); push({"pushBaseLine"});
      push({"addText",0,0,0,TextManager::format(TextManager::message(session,key),{target.name,TextManager::param(session,parameter)})});
    }
  };
  buffs(result.addedBuffs,"buffAdd"); buffs(result.addedDebuffs,"debuffAdd"); buffs(result.removedBuffs,"buffRemove");
  push({"waitForNewLine"}); push({"popBaseLine"});
}

Window_Help::Window_Help(int numLines)
  : Window_Base(0, 0, 816, numLines * 36 + 36) {}
void Window_Help::setText(std::string value) { text = std::move(value); }
void Window_Help::clear() { text.clear(); }

Window_Gold::Window_Gold(int x, int y)
  : Window_Base(x, y, 240, 72) {}
void Window_Gold::refresh(const Session& session) {
  value = session.gold();
  currencyUnit = session.database()["system"]["currencyUnit"].text();
}

Window_MenuCommand::Window_MenuCommand(int x, int y)
  : Window_Command(x, y, 240, 324) {}
void Window_MenuCommand::makeCommandList(const Session& session) {
  commands = makeCommands(session);
}

std::vector<CommandItem> Window_MenuCommand::makeCommands(const Session& session) {
  std::vector<CommandItem> result;
  const auto& flags = session.database()["system"]["menuCommands"];
  const auto needed = [&](int index) { return !flags.boolean() || flags[index].boolean(); };
  const bool enabled = !session.party().empty();
  if (needed(0)) result.push_back({TextManager::item(session), "item", enabled});
  if (needed(1)) result.push_back({TextManager::skill(session), "skill", enabled});
  if (needed(2)) result.push_back({TextManager::equip(session), "equip", enabled});
  if (needed(3)) result.push_back({TextManager::status(session), "status", enabled});
  if (needed(4)) result.push_back({TextManager::formation(session), "formation", session.party().size() >= 2 && session.system().formationEnabled});
  result.push_back({TextManager::options(session), "options"});
  if (needed(5)) result.push_back({TextManager::save(session), "save", !DataManager::isEventTest(session) && session.system().saveEnabled});
  result.push_back({TextManager::gameEnd(session), "gameEnd"});
  return result;
}

Window_MenuStatus::Window_MenuStatus(int x, int y)
  : Window_Selectable(x, y, 576, 624) {}
void Window_MenuStatus::refresh(const Session& session) {
  actorIds = session.party();
}

Window_MenuActor::Window_MenuActor()
  : Window_MenuStatus(0, 0) {}

Window_ItemCategory::Window_ItemCategory()
  : Window_Command(0, 0, 816, 72) {
  maxCols = 4;
}
void Window_ItemCategory::makeCommandList() {
  commands.clear();
  addCommand("Item", "item");
  addCommand("Weapon", "weapon");
  addCommand("Armor", "armor");
  addCommand("Key Item", "keyItem");
}

Window_SkillType::Window_SkillType(int x, int y)
  : Window_Command(x, y, 240, 144) {}
void Window_SkillType::makeCommandList(const Session& session) {
  commands.clear();
  if (!session.actors().contains(actorId)) return;
  const auto& skillTypes = session.database()["system"]["skillTypes"].array();
  for (std::size_t i = 1; i < skillTypes.size(); ++i) {
    if (!skillTypes[i].text().empty()) {
      addCommand(skillTypes[i].text(), "skill", true, static_cast<int>(i));
    }
  }
}

Window_SkillStatus::Window_SkillStatus(int x, int y, int w, int h)
  : Window_Base(x, y, w, h) {}

Window_EquipStatus::Window_EquipStatus(int x, int y)
  : Window_Base(x, y, 312, 288) {}

void Window_EquipStatus::setTempActor(int newTempActorId, const Session* session) {
  tempActorId = newTempActorId;
  tempActor.reset();
  if (session && session->actors().contains(newTempActorId)) tempActor = session->actor(newTempActorId);
  refresh(session);
}

void Window_EquipStatus::setTempActor(const Battler* actor, const Session* session) {
  tempActorId = actor ? actor->id : 0;
  tempActor = actor ? std::optional<Battler>(*actor) : std::nullopt;
  refresh(session);
}

void Window_EquipStatus::refresh(const Session* session) {
  paramDiffs.fill(0);
  if (!session || actorId <= 0 || !tempActor) return;
  const auto& actors = session->actors();
  auto curIt = actors.find(actorId);
  if (curIt == actors.end()) return;
  paramDiffs = parameterDifferences(*session, curIt->second, *tempActor);
}

std::array<int,6> Window_EquipStatus::parameterDifferences(const Session& session, const Battler& actor, const Battler& preview) {
  std::array<int,6> differences{};
  for (int i = 0; i < 6; ++i) {
    differences[i] = static_cast<int>(session.parameter(preview, 2 + i) - session.parameter(actor, 2 + i));
  }
  return differences;
}

Window_EquipCommand::Window_EquipCommand(int x, int y, int width)
  : Window_Command(x, y, width, 72) {
  maxCols = 3;
}
void Window_EquipCommand::makeCommandList(const Session& session) {
  commands = makeCommands(session);
}
std::vector<CommandItem> Window_EquipCommand::makeCommands(const Session& session) {
  return {{TextManager::equip2(session),"equip"},{TextManager::optimize(session),"optimize"},{TextManager::clear(session),"clear"}};
}

Window_EquipItem::Window_EquipItem(int x, int y, int w, int h)
  : Window_ItemList(x, y, w, h) {}
bool Window_EquipItem::includesEquip(int kind, int id, const Session& session) const {
  return includesEquip(session,actorId,slotId,kind,id);
}
bool Window_EquipItem::includesEquip(const Session& session, int actorId, int slotId, int kind, int id) {
  if (!id) return true;
  if (!session.actors().contains(actorId)) return false;
  const auto& actor = session.actor(actorId);
  if (slotId < 0 || slotId >= static_cast<int>(actor.equips.size())) return false;
  const int desired = session.equipSlotType(actor,slotId);
  if ((desired == 1 ? 1 : 2) != kind) return false;
  return session.canEquip(actor,session.database()[kind == 1 ? "weapons" : "armors"][id],slotId);
}
std::vector<int> Window_EquipItem::makeItemList(const Session& session, int actorId, int slotId) {
  std::vector<int> result;
  for (const auto& [encoded,count] : session.inventory_) {
    if (count > 0 && includesEquip(session,actorId,slotId,encoded/100000,encoded%100000)) result.push_back(encoded);
  }
  result.push_back(0);
  return result;
}
void Window_EquipItem::refresh(const Session& session) {
  data = makeItemList(session,actorId,slotId);
}

Window_Status::Window_Status()
  : Window_Selectable(0, 0, 816, 624) {}

Window_Options::Window_Options()
  : Window_Command(0, 0, 400, 324) {}
void Window_Options::makeCommandList(const Session& session) {
  commands = makeCommands(session);
}
std::vector<CommandItem> Window_Options::makeCommands(const Session& session) {
  return {{TextManager::alwaysDash(session),"alwaysDash"},
    {TextManager::commandRemember(session),"commandRemember"},
    {TextManager::bgmVolume(session),"bgmVolume"}, {TextManager::bgsVolume(session),"bgsVolume"},
    {TextManager::meVolume(session),"meVolume"}, {TextManager::seVolume(session),"seVolume"}};
}
bool Window_Options::changeValue(const std::string& symbol, const Value& value, Session& session) {
  const auto settings = session.configuration();
  if (symbol == "alwaysDash" || symbol == "commandRemember") {
    if (settings[symbol].boolean() == value.boolean()) return false;
    session.configure(Value::Object{{symbol,value.boolean()}});
  } else if (symbol == "bgmVolume" || symbol == "bgsVolume" || symbol == "meVolume" || symbol == "seVolume") {
    const int volume = std::clamp(value.integer(),0,100);
    if (settings[symbol].integer() == volume) return false;
    session.configure(Value::Object{{symbol,volume}});
  } else return false;
  return true;
}
bool Window_Options::processInput(const std::string& symbol, int direction, bool confirm, Session& session) {
  if (!confirm && direction != 4 && direction != 6) return false;
  const auto settings = session.configuration();
  if (symbol == "alwaysDash" || symbol == "commandRemember")
    return changeValue(symbol,confirm ? !settings[symbol].boolean() : direction == 6,session);
  int volume = settings[symbol].integer() + (confirm || direction == 6 ? 20 : -20);
  if (confirm && volume > 100) volume = 0;
  return changeValue(symbol,std::clamp(volume,0,100),session);
}

Window_SavefileList::Window_SavefileList(int x, int y, int w, int h)
  : Window_Selectable(x, y, w, h) {}
int Window_SavefileList::fileCount() { return DataManager::maxSavefiles(); }
int Window_SavefileList::rowHeight(int height, int padding) { return std::max(0,height-padding*2)/visibleItems(); }
const Value& Window_SavefileList::metadata(const Session& session, int savefileId) {
  static const Value empty;
  return savefileId > 0 && savefileId < static_cast<int>(session.saveMetadata_.size()) ? session.saveMetadata_[savefileId] : empty;
}
bool Window_SavefileList::isEnabled(const Session& session, int savefileId, bool loading) {
  return savefileId > 0 && savefileId <= fileCount() && (!loading || DataManager::isThisGameFile(session,savefileId));
}
std::string Window_SavefileList::fileLabel(const Session& session, int savefileId) {
  return TextManager::file(session)+" "+std::to_string(savefileId);
}

Window_ShopCommand::Window_ShopCommand(int width, bool purchaseOnlyFlag)
  : Window_Command(0, 0, width, 72), purchaseOnly(purchaseOnlyFlag) {
  maxCols = 3;
}
void Window_ShopCommand::makeCommandList(const Session& session) {
  commands = makeCommands(session, purchaseOnly);
}
std::vector<CommandItem> Window_ShopCommand::makeCommands(const Session& session, bool purchaseOnly) {
  return {{TextManager::buy(session), "buy"}, {TextManager::sell(session), "sell", !purchaseOnly}, {TextManager::cancel(session), "cancel"}};
}

Window_ShopBuy::Window_ShopBuy(int x, int y, int h, std::vector<ShopGood> shopGoods)
  : Window_Selectable(x, y, 456, h), goods(std::move(shopGoods)) {}
int Window_ShopBuy::price(int itemIndex, const Session& session) const {
  if (itemIndex < 0 || itemIndex >= static_cast<int>(goods.size())) return 0;
  const auto& good = goods[itemIndex];
  (void)session;
  const auto first = std::find_if(goods.begin(), goods.end(), [&](const ShopGood& other) { return other.kind == good.kind && other.id == good.id; });
  return first->price;
}
bool Window_ShopBuy::isEnabled(int itemIndex, const Session& session) const {
  if (itemIndex < 0 || itemIndex >= static_cast<int>(goods.size())) return false;
  auto good = goods[itemIndex]; good.price = price(itemIndex, session);
  return session.shopMaximum(good, false, money) > 0;
}

Window_ShopSell::Window_ShopSell(int x, int y, int w, int h)
  : Window_ItemList(x, y, w, h) {}
bool Window_ShopSell::isEnabled(int itemIndex, const Session& session) const {
  if (itemIndex < 0 || itemIndex >= static_cast<int>(data.size())) return false;
  const int encoded = data[itemIndex];
  return session.shopMaximum({encoded / 100000, encoded % 100000, 0}, true, session.gold()) > 0;
}

Window_ShopNumber::Window_ShopNumber(int x, int y, int h)
  : Window_Selectable(x, y, 456, h) {}
void Window_ShopNumber::changeNumber(int amount) {
  number = changeNumber(number, amount, max);
}
int Window_ShopNumber::changeNumber(int number, int amount, int maximum) {
  return std::min(std::max(number + amount, 1), maximum);
}

Window_ShopStatus::Window_ShopStatus(int x, int y, int w, int h)
  : Window_Base(x, y, w, h) {}

int Window_ShopStatus::maxPages(const Session& session) const {
  const int total = static_cast<int>(session.party().size());
  return std::max(1, (total + pageSize() - 1) / pageSize());
}

std::vector<int> Window_ShopStatus::statusMembers(const Session& session) const {
  const auto& party = session.party();
  const int start = pageIndex * pageSize();
  const int end = std::min(static_cast<int>(party.size()), start + pageSize());
  std::vector<int> out;
  for (int i = start; i < end; ++i) {
    out.push_back(party[static_cast<std::size_t>(i)]);
  }
  return out;
}

int Window_ShopStatus::currentEquippedItemId(const Battler& actor, int etypeId, const Session& session) const {
  int worstParam = 0x7fffffff;
  int worstItemId = 0;
  const int pId = paramId();
  const Value& db = session.database();
  const Value& container = (itemKind == 1) ? db["weapons"] : db["armors"];
  for (std::size_t i = 0; i < actor.equips.size(); ++i) {
    const int eqId = actor.equips[i];
    const int eqKind = i < actor.equipKinds.size() ? actor.equipKinds[i] : 0;
    if (eqId <= 0 || eqKind != itemKind) continue;
    const Value& item = container[eqId];
    if (item["etypeId"].integer(0) != etypeId) continue;
    const int val = item["params"][pId].integer(0);
    if (val < worstParam) {
      worstParam = val;
      worstItemId = eqId;
    }
  }
  return worstItemId;
}

void Window_ShopStatus::drawEquipInfo(int x, int y, const Session& session) {
  drawnTexts.clear();
  const auto members = statusMembers(session);
  const Value& db = session.database();
  const Value& container = (itemKind == 1) ? db["weapons"] : db["armors"];
  const Value& shopItem = container[itemId];
  const int etypeId = shopItem["etypeId"].integer(0);
  const int pId = paramId();
  const int newParam = shopItem["params"][pId].integer(0);
  const auto& actors = session.actors();
  for (std::size_t i = 0; i < members.size(); ++i) {
    auto it = actors.find(members[i]);
    if (it == actors.end()) continue;
    const Battler& actor = it->second;
    const int iy = y + static_cast<int>(lineHeight() * (i * 2.4));
    resetTextColor();
    drawText(actor.name, x, iy, 168);
    const int curId = currentEquippedItemId(actor, etypeId, session);
    const int curParam = curId > 0 ? container[curId]["params"][pId].integer(0) : 0;
    const int change = newParam - curParam;
    changeTextColor(paramchangeTextColor(change));
    drawText((change > 0 ? "+" : "") + std::to_string(change), x, iy, contentsWidth() - textPadding() - x, "right");
  }
}

void Window_ShopStatus::nextPage(const Session& session) {
  const int pages = maxPages(session);
  if (pages >= 2) {
    pageIndex = (pageIndex + 1) % pages;
  }
}

Window_NameEdit::Window_NameEdit(int actorIdVal, int maxLen, std::string initialName)
  : Window_Base(168, 72, 480, 144),
    actorId(actorIdVal),
    maxLength(std::max(1, maxLen)),
    name(Window_NameEdit::initialName(initialName, maxLength)),
    defaultName(name) {
  index = static_cast<int>(core::utf16Length(name));
}

std::string Window_NameEdit::initialName(const std::string& text, int maxLength) {
  auto units = core::utf16Units(text);
  units.resize(std::min(units.size(), static_cast<std::size_t>(std::max(0, maxLength))));
  return core::stringFromUtf16(units);
}

bool Window_NameEdit::addCharacter(std::string& name, int maxLength, const std::string& character) {
  if (core::utf16Length(name) >= static_cast<std::size_t>(std::max(0, maxLength))) return false;
  name += character;
  return true;
}

bool Window_NameEdit::removeCharacter(std::string& name) {
  auto units = core::utf16Units(name);
  if (units.empty()) return false;
  units.pop_back();
  name = core::stringFromUtf16(units);
  return true;
}

int Window_NameEdit::charWidth(bool isJapanese) const {
  return isJapanese ? fontSize : std::max(1, fontSize / 2);
}

int Window_NameEdit::left(bool isJapanese) const {
  const int nameCenter = (contentsWidth() + faceWidth()) / 2;
  const int nameWidth = (maxLength + 1) * charWidth(isJapanese);
  return std::min(nameCenter - nameWidth / 2, contentsWidth() - nameWidth);
}

Rect Window_NameEdit::itemRect(int charIndex, bool isJapanese) const {
  const int cw = charWidth(isJapanese);
  return {left(isJapanese) + charIndex * cw, 54, cw, lineHeight()};
}

Rect Window_NameEdit::underlineRect(int charIndex, bool isJapanese) const {
  Rect r = itemRect(charIndex, isJapanese);
  r.x += 1;
  r.y += r.height - 4;
  r.width -= 2;
  r.height = 2;
  return r;
}
bool Window_NameEdit::add(const std::string& ch) {
  if (!addCharacter(name, maxLength, ch)) return false;
  index = static_cast<int>(core::utf16Length(name));
  return true;
}
bool Window_NameEdit::back() {
  if (!removeCharacter(name)) return false;
  index = static_cast<int>(core::utf16Length(name));
  return true;
}
void Window_NameEdit::restoreDefault() {
  name = defaultName;
  index = static_cast<int>(core::utf16Length(name));
}

Window_NameInput::Window_NameInput()
  : Window_Selectable(168, 224, 480, 324) {
  maxCols = 10;
}
std::string Window_NameInput::character() const {
  if (index < 0 || index >= 88) return "";
  return nameInputTable(page)[index];
}

Window_ChoiceList::Window_ChoiceList()
  : Window_Command(0, 0, 240, 144) {}
void Window_ChoiceList::makeCommandList(const Session& session) {
  commands.clear();
  for (std::size_t i = 0; i < session.message().choices.size(); ++i) {
    addCommand(session.message().choices[i].text(), "choice", true, static_cast<int>(i));
  }
}

Window_NumberInput::Window_NumberInput()
  : Window_Selectable(0, 0, 240, 72) {}
void Window_NumberInput::changeDigit(bool up) {
  number = changeDigit(number, maxDigits, index, up);
}

int Window_NumberInput::changeDigit(int number, int maxDigits, int index, bool up) {
  const int place = static_cast<int>(std::pow(10, std::max(0, maxDigits - 1 - std::max(0, index))));
  const int digit = (number / place) % 10;
  const int nextDigit = (digit + (up ? 1 : 9)) % 10;
  return number + (nextDigit - digit) * place;
}

Rect Window_NumberInput::buttonFrame(int index, bool hot) {
  static constexpr std::array<int, 3> columns{1, 2, 4};
  if (index < 0 || index >= 3) return {};
  return {columns[index] * 48, hot ? 48 : 0, index == 2 ? 96 : 48, 48};
}

std::array<Rect, 3> Window_NumberInput::buttonBounds(Rect window, bool messageBottom) {
  std::array<Rect, 3> bounds;
  int x = window.x + (window.width - 224) / 2;
  const int y = window.y + (messageBottom ? -56 : window.height + 8);
  for (int index = 0; index < 3; ++index) {
    const auto frame = buttonFrame(index, false);
    bounds[index] = {x, y, frame.width, frame.height};
    x += frame.width + 16;
  }
  return bounds;
}

Window_EventItem::Window_EventItem()
  : Window_ItemList(0, 0, 816, 180) {}

std::vector<int> Window_EventItem::makeItemList(const Session& session, int itemType) {
  std::vector<int> entries;
  for (const auto& [id, count] : session.inventory_) {
    if (id <= 0 || id >= 100000 || count <= 0) continue;
    const auto& item = session.database()["items"][id];
    if (!item.null() && item["itypeId"].integer() == itemType) entries.push_back(id);
  }
  return entries;
}

void Window_EventItem::refresh(const Session& session) {
  data = makeItemList(session, itypeId);
}

Window_ScrollText::Window_ScrollText()
  : Window_Base(0, 0, 816, 624) {}

Window_Message::Window_Message()
  : Window_Base(0, 444, 816, 180) {}
void Window_Message::clearFlags() {
  lineShowFast = false;
  showFast = false;
  pauseSign = false;
  waitCount = 0;
}

Window_PartyCommand::Window_PartyCommand()
  : Window_Command(0, 444, 192, 180) {}
void Window_PartyCommand::makeCommandList(const Session& session, bool canEscape) {
  commands = makeCommands(session, canEscape);
}
std::vector<CommandItem> Window_PartyCommand::makeCommands(const Session& session, bool canEscape) {
  return {{TextManager::fight(session),"fight"}, {TextManager::escape(session),"escape",canEscape}};
}

Window_ActorCommand::Window_ActorCommand()
  : Window_Command(0, 444, 192, 180) {}
void Window_ActorCommand::makeCommandList(const Session& session) {
  commands = makeCommands(session, actorId);
}
std::vector<int> Window_ActorCommand::skillTypes(const Session& session, int actorId) {
  if (!session.actors().contains(actorId)) return {};
  std::set<int> types;
  for (const auto* object : session.traitObjects(session.actors().at(actorId)))
    for (const auto& entry : (*object)["traits"].array())
      if (entry["code"].integer() == 41) types.insert(entry["dataId"].integer());
  return {types.begin(), types.end()};
}
std::vector<CommandItem> Window_ActorCommand::makeCommands(const Session& session, int actorId) {
  if (!session.actors().contains(actorId)) return {};
  const auto& actor = session.actors().at(actorId);
  std::vector<CommandItem> result{{TextManager::attack(session),"attack",session.canUse(actor,session.database()["skills"][1])}};
  for (int type : skillTypes(session,actorId)) result.push_back({session.database()["system"]["skillTypes"][type].text(),"skill",true,type});
  result.push_back({TextManager::guard(session),"guard",session.canUse(actor,session.database()["skills"][2])});
  result.push_back({TextManager::item(session),"item"});
  return result;
}

Window_BattleActor::Window_BattleActor(int x, int y)
  : Window_BattleStatus(x, y, 624, 180) {}
int Window_BattleActor::maxItems() const { return 4; }

Window_BattleEnemy::Window_BattleEnemy(int x, int y)
  : Window_Selectable(x, y, 624, 180) {
  maxCols = 2;
}
void Window_BattleEnemy::refresh(const Session& session) {
  enemyIndices.clear();
  const auto& enemies = session.battle().enemies;
  for (std::size_t i = 0; i < enemies.size(); ++i) {
    if (!enemies[i].hidden && !enemies[i].escaped && enemies[i].hp > 0) {
      enemyIndices.push_back(static_cast<int>(i));
    }
  }
}

Window_BattleSkill::Window_BattleSkill(int x, int y, int w, int h)
  : Window_SkillList(x, y, w, h) {}

Window_BattleItem::Window_BattleItem(int x, int y, int w, int h)
  : Window_ItemList(x, y, w, h) {}

Window_TitleCommand::Window_TitleCommand()
  : Window_Command(288, 360, 240, 144) {}
void Window_TitleCommand::makeCommandList(const Session& session) {
  commands = makeCommands(session);
}
std::vector<CommandItem> Window_TitleCommand::makeCommands(const Session& session) {
  return {{TextManager::newGame(session),"newGame"},
    {TextManager::continueCmd(session),"continue",DataManager::isAnySavefileExists(session)},
    {TextManager::options(session),"options"}};
}

Window_GameEnd::Window_GameEnd()
  : Window_Command(288, 252, 240, 108) {}
void Window_GameEnd::makeCommandList(const Session& session) {
  commands = makeCommands(session);
}
std::vector<CommandItem> Window_GameEnd::makeCommands(const Session& session) {
  return {{TextManager::toTitle(session),"toTitle"}, {TextManager::cancel(session),"cancel"}};
}

Window_DebugRange::Window_DebugRange(int x, int y)
  : Window_Selectable(x, y, 240, 624) {}
int Window_DebugRange::maxItems() const {
  return pageCount(maxSwitches)+pageCount(maxVariables);
}
std::string Window_DebugRange::mode() const {
  return modeFor(index,maxSwitches);
}
int Window_DebugRange::topId() const {
  return topIdFor(index,maxSwitches);
}
int Window_DebugRange::pageCount(int count) { return (std::max(0,count)+9)/10; }
int Window_DebugRange::itemCount(const Session& session) {
  return pageCount(static_cast<int>(session.database()["system"]["switches"].array().size())-1)+pageCount(static_cast<int>(session.database()["system"]["variables"].array().size())-1);
}
std::string Window_DebugRange::modeFor(int index, int switchCount) { return index < pageCount(switchCount) ? "switch" : "variable"; }
std::string Window_DebugRange::modeFor(const Session& session, int index) {
  return modeFor(index,static_cast<int>(session.database()["system"]["switches"].array().size())-1);
}
int Window_DebugRange::topIdFor(int index, int switchCount) {
  const int pages = pageCount(switchCount);
  return (index < pages ? index : index-pages)*10+1;
}
int Window_DebugRange::topIdFor(const Session& session, int index) {
  return topIdFor(index,static_cast<int>(session.database()["system"]["switches"].array().size())-1);
}
std::string Window_DebugRange::labelFor(const Session& session, int index) {
  const int first = topIdFor(session,index);
  return std::string(modeFor(session,index) == "switch" ? "S" : "V")+" ["+core::numberPadZero(first,4)+"-"+core::numberPadZero(first+9,4)+"]";
}

Window_DebugEdit::Window_DebugEdit(int x, int y, int width)
  : Window_Selectable(x, y, width, 624) {}
std::string Window_DebugEdit::itemName(const Session& session, const std::string& mode, int id) {
  return session.database()["system"][mode == "switch" ? "switches" : "variables"][id].text();
}
std::string Window_DebugEdit::itemStatus(const Session& session, const std::string& mode, int id) {
  if (mode != "switch") return core::stringValue(session.variable(id));
  const auto found = session.switches_.find(id);
  return found != session.switches_.end() && found->second ? "[ON]" : "[OFF]";
}
bool Window_DebugEdit::processInput(Session& session, const std::string& mode, int id, bool confirm, int direction, bool pageUp, bool pageDown) {
  const auto& table = session.database()["system"][mode == "switch" ? "switches" : "variables"].array();
  if (id <= 0 || id >= static_cast<int>(table.size())) return false;
  if (mode == "switch") {
    if (!confirm) return false;
    session.switches_[id] = !session.switches_[id]; session.refreshNeeded_ = true;
    return true;
  }
  const auto& value = session.variable(id);
  if (!std::holds_alternative<double>(value.data)) return false;
  const int amount = (direction == 6 ? 1 : direction == 4 ? -1 : 0)+(pageDown ? 10 : 0)-(pageUp ? 10 : 0);
  if (!amount) return false;
  session.operateVariable(id,0,value.number()+amount);
  return true;
}

Window_HorzCommand::Window_HorzCommand(int x, int y, int w, int h)
  : Window_Command(x, y, w, h) {
  maxCols = 4;
}

Window_MapName::Window_MapName()
  : Window_Base(0, 0, 360, 72) { contentsOpacity = 0; }

void Window_MapName::open(std::string name) {
  mapName = std::move(name);
  showCount = 150;
  refresh();
}

void Window_MapName::close() {
  showCount = 0;
}

void Window_MapName::update() {
  Window_Base::update();
  advance(1, true);
}

void Window_MapName::advance(std::uint64_t ticks, bool nameDisplay) {
  const auto fadeIn = nameDisplay ? std::min<std::uint64_t>(ticks, std::max(0, showCount)) : 0;
  showCount -= static_cast<int>(fadeIn);
  contentsOpacity = std::min(255, contentsOpacity + static_cast<int>(std::min<std::uint64_t>(fadeIn, 16)) * 16);
  const auto fadeOut = ticks - fadeIn;
  contentsOpacity = std::max(0, contentsOpacity - static_cast<int>(std::min<std::uint64_t>(fadeOut, 16)) * 16);
}

void Window_MapName::refresh() {
  if (!core::boundRuntime()) return;
  if (contents.width != contentsWidth() || contents.height != contentsHeight()) contents.resize(contentsWidth(), contentsHeight());
  contents.clear();
  if (mapName.empty()) return;
  const double width = contentsWidth(), half = width / 2;
  contents.gradientFillRect(0, 0, half, lineHeight(), "rgba(0,0,0,0)", "rgba(0,0,0,0.6)");
  contents.gradientFillRect(half, 0, half, lineHeight(), "rgba(0,0,0,0.6)", "rgba(0,0,0,0)");
  contents.drawText(mapName, 0, 0, width, lineHeight(), "center");
}

}  // namespace pmjs::mv

