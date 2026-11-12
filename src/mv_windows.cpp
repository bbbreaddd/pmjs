#include "mv_windows.hpp"
#include "mv_managers.hpp"

#include <cmath>
#include <sstream>
#include <algorithm>
#include <cctype>
#include <cstdlib>

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
  return static_cast<int>(std::ceil(static_cast<double>(maxItems()) / std::max(1, maxCols)));
}

int Window_Selectable::maxPageRows() const {
  return static_cast<int>(std::floor(static_cast<double>(contentsHeight()) / lineHeight()));
}

int Window_Selectable::maxPageItems() const {
  return maxPageRows() * std::max(1, maxCols);
}

void Window_Selectable::setTopRow(int rowVal) {
  topRow = std::clamp(rowVal, 0, maxTopRow());
}

void Window_Selectable::setBottomRow(int rowVal) {
  setTopRow(rowVal - (maxPageRows() - 1));
}

void Window_Selectable::select(int newIndex) {
  index = newIndex;
  ensureCursorVisible();
}

void Window_Selectable::ensureCursorVisible() {
  const int r = row();
  if (r < topRow) {
    setTopRow(r);
  } else if (r > bottomRow()) {
    setBottomRow(r);
  }
}

Rect Window_Selectable::itemRect(int itemIndex) const {
  const int w = (contentsWidth() - spacing * (maxCols - 1)) / maxCols;
  const int h = lineHeight();
  const int col = itemIndex % maxCols;
  const int r = itemIndex / maxCols - topRow;
  return {padding + col * (w + spacing), padding + r * h, w, h};
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
  if (index < maxItems() - maxCols || (wrap && maxCols == 1)) {
    index = (index + maxCols) % maxItems();
  }
}

void Window_Selectable::cursorUp(bool wrap) {
  if (index >= maxCols || (wrap && maxCols == 1)) {
    index = (index - maxCols + maxItems()) % maxItems();
  }
}

void Window_Selectable::cursorRight(bool wrap) {
  if (maxCols >= 2 && (index % maxCols < maxCols - 1 || wrap)) {
    index = (index + 1) % maxItems();
  }
}

void Window_Selectable::cursorLeft(bool wrap) {
  if (maxCols >= 2 && (index % maxCols > 0 || wrap)) {
    index = (index - 1 + maxItems()) % maxItems();
  }
}

void Window_Selectable::cursorPagedown() {
  const int rowsPerPage = contentsHeight() / lineHeight();
  if (topRow + rowsPerPage < maxRows()) {
    topRow += rowsPerPage;
    index = std::min(index + rowsPerPage * maxCols, maxItems() - 1);
  }
}

void Window_Selectable::cursorPageup() {
  const int rowsPerPage = contentsHeight() / lineHeight();
  if (topRow > 0) {
    topRow = std::max(0, topRow - rowsPerPage);
    index = std::max(0, index - rowsPerPage * maxCols);
  }
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
  constexpr double threshold = 20.0;
  if (wheelY >= threshold) scrollDown();
  if (wheelY <= -threshold) scrollUp();
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
  if (kind == 0) { // item
    const auto& item = session.database()["items"][id];
    if (category == "item") return item["itypeId"].integer(1) == 1;
    if (category == "keyItem") return item["itypeId"].integer(1) == 2;
    return false;
  }
  if (kind == 1 && category == "weapon") return true;
  if (kind == 2 && category == "armor") return true;
  return false;
}

void Window_ItemList::refresh(const Session& session) {
  data.clear();
  for (const auto& [itemKey, count] : session.inventory_) {
    if (count <= 0) continue;
    const int kind = itemKey / 100000;
    const int id = itemKey % 100000;
    if (includes(kind, id, session)) data.push_back(itemKey);
  }
}

bool Window_ItemList::isCurrentItemEnabled() const {
  return index >= 0 && index < static_cast<int>(data.size());
}

Window_SkillList::Window_SkillList(int x, int y, int w, int h)
  : Window_Selectable(x, y, w, h) {
  maxCols = 2;
}

void Window_SkillList::refresh(const Session& session) {
  data.clear();
  if (!session.actors().contains(actorId)) return;
  const auto& actor = session.actors().at(actorId);
  for (int skillId : session.battlerSkills(actor)) {
    const auto& skill = session.database()["skills"][skillId];
    if (skillType == 0 || skill["stypeId"].integer() == skillType) {
      data.push_back(skillId);
    }
  }
}

bool Window_SkillList::isCurrentItemEnabled() const {
  return index >= 0 && index < static_cast<int>(data.size());
}

Window_EquipSlot::Window_EquipSlot(int x, int y, int w, int h)
  : Window_Selectable(x, y, w, h) {}

int Window_EquipSlot::maxItems() const { return 5; }

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
  (void)session;
  return true;
}

void Window_BattleLog::popBaseLine() {
  if (baseLineStack.empty()) return;
  const int baseLine = baseLineStack.back();
  baseLineStack.pop_back();
  while (static_cast<int>(lines.size()) > baseLine) {
    lines.pop_back();
  }
}

void Window_BattleLog::waitForNewLine() {
  const int baseLine = baseLineStack.empty() ? 0 : baseLineStack.back();
  if (static_cast<int>(lines.size()) > baseLine) {
    wait();
  }
}

void Window_BattleLog::addText(std::string text) {
  lines.push_back(std::move(text));
  wait();
}

void Window_BattleLog::clear() {
  lines.clear();
  baseLineStack.clear();
}

void Window_BattleLog::waitForEffect() {
  setWaitMode("effect");
  waitCount = messageSpeed();
}

void Window_BattleLog::performActionStart(Battler& subject, const Value& action) {
  (void)subject;
  (void)action;
}

void Window_BattleLog::performAction(Battler& subject, const Value& action) {
  (void)subject;
  (void)action;
}

void Window_BattleLog::performActionEnd(Battler& subject) {
  subject.guarding = false;
}

void Window_BattleLog::performDamage(Battler& target) {
  target.result.hpAffected = true;
}

void Window_BattleLog::performMiss(Battler& target) {
  target.result.missed = true;
}

void Window_BattleLog::performRecovery(Battler& target) {
  (void)target;
}

void Window_BattleLog::performEvasion(Battler& target) {
  target.result.evaded = true;
}

void Window_BattleLog::performMagicEvasion(Battler& target) {
  target.result.evaded = true;
}

void Window_BattleLog::performCounter(Battler& target) {
  (void)target;
}

void Window_BattleLog::performReflection(Battler& target) {
  (void)target;
}

void Window_BattleLog::performSubstitute(Battler& substitute, Battler& target) {
  (void)substitute;
  (void)target;
}

void Window_BattleLog::performCollapse(Battler& target) {
  (void)target;
}

void Window_BattleLog::displayAction(const Battler& subject, const Value& item) {
  addText(subject.name + " casts " + item["name"].text() + "!");
}

void Window_BattleLog::displayCounter(const Battler& target) {
  addText(target.name + " counterattacks!");
}

void Window_BattleLog::displayReflection(const Battler& target) {
  addText(target.name + " reflected the magic!");
}

void Window_BattleLog::displaySubstitute(const Battler& substitute, const Battler& target) {
  addText(substitute.name + " protected " + target.name + "!");
}

void Window_BattleLog::displayActionResults(const Battler&, const Battler& target) {
  if (target.result.missed) displayMiss(target);
  else if (target.result.evaded) displayEvasion(target);
  else {
    if (target.result.critical) displayCritical(target);
    if (target.result.hpAffected) displayHpDamage(target);
    if (target.result.mpDamage != 0) displayMpDamage(target);
    if (target.result.tpDamage != 0) displayTpDamage(target);
  }
}

void Window_BattleLog::displayFailure(const Battler& target) {
  addText("There was no effect on " + target.name + "!");
}

void Window_BattleLog::displayCritical(const Battler&) {
  addText("A critical hit!!");
}

void Window_BattleLog::displayMiss(const Battler& target) {
  addText(target.name + " dodged the attack!");
}

void Window_BattleLog::displayEvasion(const Battler& target) {
  addText(target.name + " evaded!");
}

void Window_BattleLog::displayHpDamage(const Battler& target) {
  if (target.result.hpDamage > 0) {
    addText(target.name + " took " + std::to_string(target.result.hpDamage) + " damage!");
  } else if (target.result.hpDamage < 0) {
    addText(target.name + " recovered " + std::to_string(-target.result.hpDamage) + " HP!");
  }
}

void Window_BattleLog::displayMpDamage(const Battler& target) {
  if (target.result.mpDamage > 0) {
    addText(target.name + " lost " + std::to_string(target.result.mpDamage) + " MP!");
  } else if (target.result.mpDamage < 0) {
    addText(target.name + " recovered " + std::to_string(-target.result.mpDamage) + " MP!");
  }
}

void Window_BattleLog::displayTpDamage(const Battler& target) {
  if (target.hp <= 0 || target.result.tpDamage == 0) return;
  const int damage = target.result.tpDamage;
  addText(target.name+(damage > 0 ? " lost " : " gained ")+std::to_string(std::abs(damage))+" TP!");
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
  commands.clear();
  const bool partyEmpty = session.party().empty();
  addCommand("Item", "item", true);
  addCommand("Skill", "skill", !partyEmpty);
  addCommand("Equip", "equip", !partyEmpty);
  addCommand("Status", "status", !partyEmpty);
  addCommand("Formation", "formation", session.party().size() >= 2 && session.system().formationEnabled);
  addCommand("Options", "options", true);
  addCommand("Save", "save", session.system().saveEnabled);
  addCommand("Game End", "gameEnd", true);
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
  if (tempActorId != newTempActorId) {
    tempActorId = newTempActorId;
    refresh(session);
  }
}

void Window_EquipStatus::refresh(const Session* session) {
  paramDiffs.fill(0);
  if (!session || actorId <= 0 || tempActorId <= 0) return;
  const auto& actors = session->actors();
  auto curIt = actors.find(actorId);
  auto tmpIt = actors.find(tempActorId);
  if (curIt == actors.end() || tmpIt == actors.end()) return;
  for (int i = 0; i < 6; ++i) {
    paramDiffs[i] = static_cast<int>(session->parameter(tmpIt->second, 2 + i) -
                                     session->parameter(curIt->second, 2 + i));
  }
}

Window_EquipCommand::Window_EquipCommand(int x, int y, int width)
  : Window_Command(x, y, width, 72) {
  maxCols = 3;
}
void Window_EquipCommand::makeCommandList() {
  commands.clear();
  addCommand("Equip", "equip");
  addCommand("Optimize", "optimize");
  addCommand("Clear", "clear");
}

Window_EquipItem::Window_EquipItem(int x, int y, int w, int h)
  : Window_ItemList(x, y, w, h) {}
bool Window_EquipItem::includesEquip(int kind, int id, const Session& session) const {
  if (!session.actors().contains(actorId)) return false;
  const auto& actor = session.actor(actorId);
  const int desired = session.equipSlotType(actor,slotId);
  if ((desired == 1 ? 1 : 2) != kind) return false;
  return session.canChangeEquip(actor,slotId) && session.canEquip(actor,session.database()[kind == 1 ? "weapons" : "armors"][id],slotId);
}

Window_Status::Window_Status()
  : Window_Selectable(0, 0, 816, 624) {}

Window_Options::Window_Options()
  : Window_Command(0, 0, 400, 324) {}
void Window_Options::makeCommandList() {
  commands.clear();
  addCommand("Always Dash", "alwaysDash");
  addCommand("Command Remember", "commandRemember");
  addCommand("BGM Volume", "bgmVolume");
  addCommand("BGS Volume", "bgsVolume");
  addCommand("ME Volume", "meVolume");
  addCommand("SE Volume", "seVolume");
}
void Window_Options::changeValue(const std::string& symbol, bool forward, Session& session) {
  auto settings = std::get<Value::Object>(session.configuration().data);
  if (symbol == "alwaysDash" || symbol == "commandRemember") settings[symbol] = !settings[symbol].boolean();
  else if (symbol == "bgmVolume" || symbol == "bgsVolume" || symbol == "meVolume" || symbol == "seVolume")
    settings[symbol] = std::clamp(settings[symbol].integer()+(forward ? 20 : -20),0,100);
  session.configure(settings);
}

Window_SavefileList::Window_SavefileList(int x, int y, int w, int h)
  : Window_Selectable(x, y, w, h) {}

Window_ShopCommand::Window_ShopCommand(int width, bool purchaseOnlyFlag)
  : Window_Command(0, 0, width, 72), purchaseOnly(purchaseOnlyFlag) {
  maxCols = 3;
}
void Window_ShopCommand::makeCommandList() {
  commands.clear();
  addCommand("Buy", "buy");
  addCommand("Sell", "sell", !purchaseOnly);
  addCommand("Cancel", "cancel");
}

Window_ShopBuy::Window_ShopBuy(int x, int y, int h, std::vector<ShopGood> shopGoods)
  : Window_Selectable(x, y, 456, h), goods(std::move(shopGoods)) {}
int Window_ShopBuy::price(int itemIndex, const Session& session) const {
  if (itemIndex < 0 || itemIndex >= static_cast<int>(goods.size())) return 0;
  const auto& good = goods[itemIndex];
  (void)session; return good.price;
}
bool Window_ShopBuy::isEnabled(int itemIndex, const Session& session) const {
  return price(itemIndex, session) <= money && itemIndex >= 0 && itemIndex < static_cast<int>(goods.size());
}

Window_ShopSell::Window_ShopSell(int x, int y, int w, int h)
  : Window_ItemList(x, y, w, h) {}

Window_ShopNumber::Window_ShopNumber(int x, int y, int h)
  : Window_Selectable(x, y, 456, h) {}
void Window_ShopNumber::changeNumber(int amount) {
  number = std::clamp(number + amount, 1, std::max(1, max));
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
    name(initialName),
    defaultName(std::move(initialName)) {
  index = static_cast<int>(name.size());
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
  if (static_cast<int>(std::count_if(name.begin(),name.end(),[](unsigned char ch){return (ch&0xc0)!=0x80;})) >= maxLength) return false;
  name += ch;
  index = static_cast<int>(name.size());
  return true;
}
bool Window_NameEdit::back() {
  if (name.empty()) return false;
  auto end = name.size()-1; while (end && (static_cast<unsigned char>(name[end])&0xc0)==0x80) --end; name.erase(end);
  index = static_cast<int>(name.size());
  return true;
}
void Window_NameEdit::restoreDefault() {
  name = defaultName;
  index = static_cast<int>(name.size());
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
  const int place = static_cast<int>(std::pow(10, std::max(0, maxDigits - 1 - std::max(0, index))));
  const int digit = (number / place) % 10;
  const int nextDigit = (digit + (up ? 1 : 9)) % 10;
  number += (nextDigit - digit) * place;
}

Window_EventItem::Window_EventItem()
  : Window_ItemList(0, 0, 816, 180) {}

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
void Window_PartyCommand::makeCommandList(bool canEscape) {
  commands.clear();
  addCommand("Fight", "fight");
  addCommand("Escape", "escape", canEscape);
}

Window_ActorCommand::Window_ActorCommand()
  : Window_Command(0, 444, 192, 180) {}
void Window_ActorCommand::makeCommandList(const Session& session) {
  commands.clear();
  if (!session.actors().contains(actorId)) return;
  addCommand("Attack", "attack");
  const auto& skillTypes = session.database()["system"]["skillTypes"].array();
  for (std::size_t i = 1; i < skillTypes.size(); ++i) {
    if (!skillTypes[i].text().empty()) {
      addCommand(skillTypes[i].text(), "skill", true, static_cast<int>(i));
    }
  }
  addCommand("Guard", "guard");
  addCommand("Item", "item");
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
void Window_TitleCommand::makeCommandList(bool continueEnabled) {
  commands.clear();
  addCommand("New Game", "newGame");
  addCommand("Continue", "continue", continueEnabled);
  addCommand("Options", "options");
}

Window_GameEnd::Window_GameEnd()
  : Window_Command(288, 252, 240, 108) {}
void Window_GameEnd::makeCommandList() {
  commands.clear();
  addCommand("To Title", "toTitle");
  addCommand("Cancel", "cancel");
}

Window_DebugRange::Window_DebugRange(int x, int y)
  : Window_Selectable(x, y, 240, 624) {}
int Window_DebugRange::maxItems() const {
  return (maxSwitches + 9) / 10 + (maxVariables + 9) / 10;
}
std::string Window_DebugRange::mode() const {
  const int switchPages = (maxSwitches + 9) / 10;
  return index < switchPages ? "switch" : "variable";
}
int Window_DebugRange::topId() const {
  const int switchPages = (maxSwitches + 9) / 10;
  const int rel = index < switchPages ? index : index - switchPages;
  return rel * 10 + 1;
}

Window_DebugEdit::Window_DebugEdit(int x, int y, int width)
  : Window_Selectable(x, y, width, 624) {}

Window_HorzCommand::Window_HorzCommand(int x, int y, int w, int h)
  : Window_Command(x, y, w, h) {
  maxCols = 4;
}

Window_MapName::Window_MapName()
  : Window_Base(0, 0, 360, 72) {}

void Window_MapName::open(std::string name) {
  mapName = std::move(name);
  showCount = mapName.empty() ? 0 : 150;
  openness = showCount > 0 ? 255 : 0;
}

void Window_MapName::close() {
  showCount = 0;
}

void Window_MapName::update() {
  if (showCount > 0) {
    --showCount;
    if (showCount > 134) {
      contentsOpacity = std::min(255, contentsOpacity + 16);
    } else if (showCount < 16) {
      contentsOpacity = std::max(0, contentsOpacity - 16);
    } else {
      contentsOpacity = 255;
    }
  } else {
    contentsOpacity = 0;
  }
}

}  // namespace pmjs::mv

