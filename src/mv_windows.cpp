#include "mv_windows.hpp"
#include "mv_managers.hpp"
#include "mv_core_utils.hpp"
#include "mv_sprites.hpp"

#include <cmath>
#include <sstream>
#include <algorithm>
#include <cctype>
#include <cstdlib>
#include <limits>
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
  contents.width = std::max(1,contentsWidth());
  contents.height = std::max(1,contentsHeight());
}

namespace {
std::string colorToCss(Color c) {
  if (c.a != 255) return "rgba("+std::to_string(c.r)+","+std::to_string(c.g)+","+std::to_string(c.b)+","+std::to_string(c.a/255.0)+")";
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
  contents.resize(contentsWidth(), contentsHeight());
}

double Window_Base::textWidth(const std::string& text) const {
  core::PixelBitmap metrics;
  metrics.fontFace = contents.fontFace; metrics.fontItalic = contents.fontItalic; metrics.fontSize = fontSize;
  return metrics.measureTextWidth(text);
}

void Window_Base::drawText(const std::string& text, double x, double y, double maxWidth, const std::string& align) {
  if (contents.width != contentsWidth() || contents.height != contentsHeight()) contents.resize(contentsWidth(),contentsHeight());
  contents.fontSize = fontSize; contents.textColor = colorToCss(textColor);
  contents.drawText(text,x,y,maxWidth,lineHeight(),align);
}

void Window_Base::drawGauge(int x, int y, int width, double rate, Color color1, Color color2) {
  const int fillW = static_cast<int>(std::floor(width * std::clamp(rate, 0.0, 1.0)));
  const int gaugeY = y + lineHeight() - 8;
  if (contents.width != contentsWidth() || contents.height != contentsHeight()) contents.resize(contentsWidth(), contentsHeight());
  contents.fillRect(x, gaugeY, width, 6, colorToCss(gaugeBackColor()));
  contents.gradientFillRect(x, gaugeY, fillW, 6, colorToCss(color1), colorToCss(color2), false);
}

void Window_Base::drawCurrentAndMax(int current, int max, int x, int y, int width, Color color1, Color color2) {
  const double labelWidth = textWidth("HP");
  const double valueWidth = textWidth("0000");
  const double slashWidth = textWidth("/");
  const double x1 = x + width - valueWidth;
  const double x2 = x1 - slashWidth;
  const double x3 = x2 - valueWidth;
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

void Window_Base::drawCurrencyValue(int value, const std::string& unit, int x, int y, int width, Color valueColor, Color unitColor) {
  const double unitWidth = std::min(80.0, textWidth(unit));
  changeTextColor(valueColor);
  drawText(std::to_string(value), x, y, width - unitWidth - 6, "right");
  changeTextColor(unitColor);
  drawText(unit, x + width - unitWidth, y, unitWidth, "right");
}

void Window_Base::update() {
  if (opening) { openness = advanceOpenness(openness,true); opening = openness < 255; }
  if (closing) { openness = advanceOpenness(openness,false); closing = openness > 0; }
}
int Window_Base::advanceOpenness(int openness, bool opening) { return std::clamp(openness + (opening ? 32 : -32),0,255); }

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
  const auto replaceVariables = [&](const std::string& input) {
    std::string expanded;
    for (std::size_t index = 0; index < input.size();) {
      if (input[index] == '\\' && index + 1 < input.size() && input[index + 1] == '\\') {
        expanded += '\x1f';
        index += 2;
        continue;
      }
      if (input[index] == '\\' && index + 3 < input.size() &&
          std::toupper(static_cast<unsigned char>(input[index + 1])) == 'V' && input[index + 2] == '[') {
        const auto end = input.find(']', index + 3);
        if (end != std::string::npos) {
          const int id = std::atoi(input.substr(index + 3, end - index - 3).c_str());
          const auto& value = session.variable(id);
          if (std::holds_alternative<std::string>(value.data)) expanded += value.text();
          else if (std::holds_alternative<bool>(value.data)) expanded += value.boolean() ? "true" : "false";
          else { std::ostringstream text; text << value.number(); expanded += text.str(); }
          index = end + 1;
          continue;
        }
      }
      expanded += input[index++];
    }
    return expanded;
  };
  result = replaceVariables(result);
  result = replaceVariables(result);
  std::string expanded;
  for (std::size_t index = 0; index < result.size();) {
    if (result[index] != '\\' || index + 1 >= result.size()) { expanded += result[index++]; continue; }
    const char code = std::toupper(static_cast<unsigned char>(result[index + 1]));
    if (code == 'G') { expanded += session.database()["system"]["currencyUnit"].text(); index += 2; continue; }
    if ((code == 'N' || code == 'P') && index + 2 < result.size() && result[index + 2] == '[') {
      const auto end = result.find(']', index + 3);
      if (end != std::string::npos) {
        const int id = std::atoi(result.substr(index + 3, end - index - 3).c_str());
        const int actor = code == 'P' ? (id > 0 && id <= static_cast<int>(session.party_.size()) ? session.party_[id - 1] : 0) : id;
        if (session.actors().contains(actor)) expanded += session.actors().at(actor).name;
        else expanded += session.database_["actors"][actor]["name"].text();
        index = end + 1;
        continue;
      }
    }
    expanded += result[index++];
  }
  result = std::move(expanded);
  std::replace(result.begin(), result.end(), '\\', '\x1b');
  std::replace(result.begin(), result.end(), '\x1f', '\\');
  return result;
}

namespace {
int measureTextLine(const std::string& text, std::size_t start, std::size_t end, int& fontSize) {
  int maximum = fontSize;
  for (std::size_t index = start; index + 1 < end; ++index) {
    if (text[index] != '\x1b') continue;
    const char code = text[index + 1];
    if (code == '{' && fontSize <= 96) fontSize += 12;
    else if (code == '}' && fontSize >= 24) fontSize -= 12;
    maximum = std::max(maximum, fontSize);
  }
  return maximum + 8;
}
}

int Window_Base::textLineHeight(const std::string& preparedText, std::size_t start, int fontSize) {
  const auto newline = preparedText.find('\n', start);
  return measureTextLine(preparedText, start, newline == std::string::npos ? preparedText.size() : newline, fontSize);
}

int Window_Base::textHeight(const std::string& preparedText, int fontSize) {
  int height = 0;
  std::size_t start = 0;
  for (;;) {
    const auto newline = preparedText.find('\n', start);
    height += measureTextLine(preparedText, start, newline == std::string::npos ? preparedText.size() : newline, fontSize);
    if (newline == std::string::npos) return height;
    start = newline + 1;
  }
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
  return visible && active && openness == 255 && !cursorFixed && !cursorAll && maxItems() > 0;
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
bool Window_ItemList::isEnabled(const Session& session, int encodedItem) {
  if (encodedItem <= 0 || encodedItem >= 100000) return false;
  const auto& item = session.database()["items"][encodedItem];
  if (item.null()) return false;
  const auto count = session.battle_.active ? session.battleMemberCount() : session.party_.size();
  for (std::size_t index = 0; index < count; ++index)
    if (session.canUse(session.actors_.at(session.party_[index]),item)) return true;
  return false;
}

Window_SkillList::Window_SkillList(int x, int y, int w, int h)
  : Window_Selectable(x, y, w, h) {
  maxCols = 2;
}
bool Window_SkillList::isEnabled(const Session& session, int actorId, int skillId) {
  const auto& skill = session.database()["skills"][skillId];
  return !skill.null() && session.actors().contains(actorId) && session.canUse(session.actors().at(actorId),skill);
}
std::pair<int,int> Window_SkillList::displayedCost(const Session& session, int actorId, int skillId) {
  const auto& skill = session.database()["skills"][skillId];
  if (skill["tpCost"].integer() > 0) return {skill["tpCost"].integer(),29};
  const int cost = static_cast<int>(std::floor(skill["mpCost"].number()*session.trait(session.actors().at(actorId),23,4,true)));
  return {cost,cost > 0 ? 23 : 0};
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
  : Window_Base(0, 0, core::Graphics::boxWidth, placement(core::Graphics::boxWidth,numLines).height) {}
void Window_Help::setText(std::string value) { text = std::move(value); }
void Window_Help::clear() { text.clear(); }
Rect Window_Help::placement(int width, int numLines) { return {0,0,width,numLines*36+36}; }
std::string Window_Help::itemDescription(const Value& item) { return item["description"].text(); }

Window_Gold::Window_Gold(int x, int y)
  : Window_Base(x, y, 240, 72) {}
void Window_Gold::refresh(const Session& session) {
  value = session.gold();
  currencyUnit = session.database()["system"]["currencyUnit"].text();
  if (!core::boundRuntime()) return;
  contents.clear();
  drawCurrencyValue(value,currencyUnit,textPadding(),0,contentsWidth()-textPadding()*2,valueColor,unitColor);
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
  : Window_Selectable(x, y, std::max(0,core::Graphics::boxWidth-240), core::Graphics::boxHeight) {}

int Window_MenuStatus::rowHeight(int windowHeight, int padding) {
  return static_cast<int>(std::floor((windowHeight-padding*2)/4.0));
}

Rect Window_MenuStatus::rowRect(int index, int windowWidth, int windowHeight, int topRow, int padding) {
  return Window_Selectable::itemRectFor(index,std::max(0,windowWidth-padding*2),1,rowHeight(windowHeight,padding),12,topRow);
}

Window_MenuStatus::RowLayout Window_MenuStatus::rowLayout(const Rect& row) {
  const double x = row.x + 162;
  return {{row.x+1,row.y+1,144,144},{x,row.y+row.height/2.0-54,row.width-x-6,108}};
}

Rect Window_MenuStatus::placement(int viewportWidth, int viewportHeight, int x, int y) {
  return {x,y,std::max(0,viewportWidth-240),viewportHeight};
}
void Window_MenuStatus::refresh(const Session& session) {
  actorIds = session.party();
}

Window_MenuActor::Window_MenuActor()
  : Window_MenuStatus(0, 0) { visible = false; }

Rect Window_MenuActor::placement(int viewportWidth, int viewportHeight, int itemIndex) {
  auto bounds = Window_MenuStatus::placement(viewportWidth,viewportHeight,0,0);
  if (itemIndex % 2 == 0) bounds.x = viewportWidth-bounds.width;
  return bounds;
}

Window_MenuActor::Selection Window_MenuActor::selection(const Session& session, const Value& item, int userIndex) {
  const int scope = item["scope"].integer();
  if (scope == 11 && DataManager::isSkill(item)) return {userIndex,true,false};
  if (scope == 2 || scope == 8 || scope == 10) return {0,false,true};
  const auto& members = session.party();
  const auto found = std::find(members.begin(),members.end(),session.targetActorId_);
  return {found == members.end() ? 0 : static_cast<int>(found-members.begin()),false,false};
}

void Window_MenuActor::rememberTarget(Session& session, int index) {
  if (index >= 0 && index < static_cast<int>(session.party().size())) session.targetActorId_ = session.party()[index];
}

void Window_MenuActor::selectForItem(const Session& session, const Value& item, int userIndex) {
  refresh(session);
  const auto target = selection(session,item,userIndex);
  cursorFixed = target.fixed; cursorAll = target.all; select(target.index);
}

Window_ItemCategory::Window_ItemCategory()
  : Window_Command(0, 0, core::Graphics::boxWidth, 72) {
  maxCols = 4;
}
void Window_ItemCategory::makeCommandList(const Session& session) {
  commands = makeCommands(session);
}
std::vector<CommandItem> Window_ItemCategory::makeCommands(const Session& session) {
  return {{TextManager::item(session),"item"}, {TextManager::weapon(session),"weapon"},
    {TextManager::armor(session),"armor"}, {TextManager::keyItem(session),"keyItem"}};
}

Window_SkillType::Window_SkillType(int x, int y)
  : Window_Command(x, y, 240, 180) {}
void Window_SkillType::makeCommandList(const Session& session) {
  commands = makeCommands(session, actorId);
}
std::vector<CommandItem> Window_SkillType::makeCommands(const Session& session, int actorId) {
  std::vector<CommandItem> commands;
  for (int type : Window_ActorCommand::skillTypes(session,actorId)) commands.push_back({session.database()["system"]["skillTypes"][type].text(),"skill",true,type});
  return commands;
}

Window_SkillStatus::Window_SkillStatus(int x, int y, int w, int h)
  : Window_Base(x, y, w, h) {}
Rect Window_SkillStatus::placement(int width) { return {240,Window_Help::placement(width).height,std::max(0,width-240),180}; }

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
  : Window_Selectable(0, 0, core::Graphics::boxWidth, core::Graphics::boxHeight) {}

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

int Window_ShopStatus::maxPages(const Session& session) {
  return (static_cast<int>(session.party().size())+pageSize()-1)/pageSize();
}

std::vector<int> Window_ShopStatus::statusMembers(const Session& session) const {
  return statusMembers(session,pageIndex);
}

std::vector<int> Window_ShopStatus::statusMembers(const Session& session, int pageIndex) {
  const auto& party = session.party();
  const int start = pageIndex*pageSize(), end = std::min(static_cast<int>(party.size()),start+pageSize());
  return start < end ? std::vector<int>(party.begin()+start,party.begin()+end) : std::vector<int>{};
}

int Window_ShopStatus::possession(const Session& session, int kind, int id) {
  const auto found = session.inventory_.find(kind*100000+id);
  return found == session.inventory_.end() ? 0 : found->second;
}

int Window_ShopStatus::currentEquippedItem(const Session& session, const Battler& actor, int etypeId, int paramId) {
  double worstParam = std::numeric_limits<double>::max();
  int worstItem = 0;
  for (std::size_t slot = 0; slot < actor.equips.size(); ++slot) {
    if (session.equipSlotType(actor,static_cast<int>(slot)) != etypeId || !actor.equips[slot]) continue;
    const int kind = actor.equipKinds[slot];
    const auto& item = session.database()[kind == 1 ? "weapons" : "armors"][actor.equips[slot]];
    if (!item.null() && item["params"][paramId].number() < worstParam) {
      worstParam = item["params"][paramId].number(); worstItem = kind*100000+actor.equips[slot];
    }
  }
  return worstItem;
}

int Window_ShopStatus::currentEquippedItemId(const Battler& actor, int etypeId, const Session& session) const {
  return currentEquippedItem(session,actor,etypeId,paramId())%100000;
}

std::vector<Window_ShopStatus::EquipInfo> Window_ShopStatus::equipInfo(const Session& session, int kind, int id, int pageIndex) {
  std::vector<EquipInfo> rows;
  if (kind != 1 && kind != 2) return rows;
  const auto& item = session.database()[kind == 1 ? "weapons" : "armors"][id];
  if (item.null()) return rows;
  const int parameter = paramId(kind);
  for (int actorId : statusMembers(session,pageIndex)) {
    const auto& actor = session.actor(actorId);
    const int equipped = currentEquippedItem(session,actor,item["etypeId"].integer(),parameter);
    const auto& previous = session.database()[equipped/100000 == 1 ? "weapons" : "armors"][equipped%100000];
    const int change = static_cast<int>(item["params"][parameter].number()-previous["params"][parameter].number());
    rows.push_back({actorId,equipped,change,session.canEquipItem(actor,item)});
  }
  return rows;
}

void Window_ShopStatus::drawEquipInfo(int x, int y, const Session& session) {
  const auto rows = equipInfo(session,itemKind,itemId,pageIndex);
  for (std::size_t index = 0; index < rows.size(); ++index) {
    const auto& row = rows[index]; const int iy = y+static_cast<int>(lineHeight()*(index*2.4));
    contents.paintOpacity = row.enabled ? 255 : translucentOpacity();
    resetTextColor(); drawText(session.actor(row.actorId).name,x,iy,168);
    if (row.enabled) {
      changeTextColor(paramchangeTextColor(row.paramChange));
      drawText((row.paramChange > 0 ? "+" : "")+std::to_string(row.paramChange),x,iy,contentsWidth()-textPadding()-x,"right");
    }
    const auto& equipped = session.database()[row.equippedItem/100000 == 1 ? "weapons" : "armors"][row.equippedItem%100000];
    resetTextColor(); drawItemName(equipped,x,iy+lineHeight());
    contents.paintOpacity = 255;
  }
}

int Window_ShopStatus::nextPage(const Session& session, int pageIndex) {
  const int pages = maxPages(session);
  return pages >= 2 ? (pageIndex+1)%pages : pageIndex;
}

void Window_ShopStatus::nextPage(const Session& session) {
  pageIndex = nextPage(session,pageIndex);
}

Window_NameEdit::Window_NameEdit(int actorIdVal, int maxLen, std::string initialName)
  : Window_Base(0, 0, 480, 180),
    actorId(actorIdVal),
    maxLength(std::max(1, maxLen)),
    name(Window_NameEdit::initialName(initialName, maxLength)),
    defaultName(name) {
  index = static_cast<int>(core::utf16Length(name));
  active = false;
  rect = placement(core::Graphics::boxWidth,core::Graphics::boxHeight);
}

Rect Window_NameEdit::placement(int screenWidth, int screenHeight) {
  return {(screenWidth-480)/2,(screenHeight-548)/2,480,180};
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

double Window_NameEdit::charWidth(bool isJapanese) const {
  return core::boundRuntime() ? contents.measureTextWidth(isJapanese ? "Ａ" : "A") : 0;
}

double Window_NameEdit::left(bool isJapanese) const {
  const double nameCenter = (contentsWidth() + faceWidth()) / 2.0;
  const double nameWidth = (maxLength + 1) * charWidth(isJapanese);
  return std::min(nameCenter - nameWidth / 2, contentsWidth() - nameWidth);
}

core::Rectangle Window_NameEdit::itemRect(int charIndex, bool isJapanese) const {
  const double cw = charWidth(isJapanese);
  return {left(isJapanese) + charIndex * cw, 54, cw, static_cast<double>(lineHeight())};
}

core::Rectangle Window_NameEdit::underlineRect(int charIndex, bool isJapanese) const {
  auto r = itemRect(charIndex, isJapanese);
  r.x += 1;
  r.y += r.height - 4;
  r.width -= 2;
  r.height = 2;
  return r;
}

void Window_NameEdit::refresh(const core::PixelBitmap* face, int faceIndex, bool isJapanese) {
  contents.clear();
  contents.fontSize = fontSize;
  contents.paintOpacity = 255;
  if (face && face->isReady()) contents.blt(*face,faceIndex%4*144,faceIndex/4*144,144,144,0,0);
  contents.paintOpacity = 48;
  for (int character = 0; character < maxLength; ++character) {
    const auto rect = underlineRect(character,isJapanese);
    contents.fillRect(rect.x,rect.y,rect.width,rect.height,contents.textColor);
  }
  contents.paintOpacity = 255;
  const auto units = core::utf16Units(name);
  for (std::size_t character = 0; character < units.size(); ++character) {
    const auto rect = itemRect(static_cast<int>(character),isJapanese);
    contents.drawText(core::stringFromUtf16({units[character]}),rect.x,rect.y,std::numeric_limits<double>::infinity(),rect.height);
  }
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
bool Window_NameEdit::restoreDefault() {
  name = defaultName;
  index = static_cast<int>(core::utf16Length(name));
  return !name.empty();
}

Window_NameInput::Window_NameInput()
  : Window_Selectable(0, 0, 480, 360) {
  maxCols = 10;
  spacing = 0;
  index = 0;
  const auto edit = Window_NameEdit::placement(core::Graphics::boxWidth,core::Graphics::boxHeight);
  rect.x = edit.x; rect.y = edit.y + edit.height + 8;
}
std::string Window_NameInput::character() const {
  if (index < 0 || index >= 88) return "";
  return nameInputTable(page,locale)[index];
}

Rect Window_NameInput::cellRect(int index) {
  const int column = index % 10;
  return {column * 42 + column / 5 * 24,index / 10 * 36,42,36};
}

int Window_NameInput::moveGridCursor(int index, int direction, bool wrap) {
  if (direction == 2 && (index < 80 || wrap)) return (index + 10) % 90;
  if (direction == 8 && (index >= 10 || wrap)) return (index + 80) % 90;
  if (direction == 6) return index % 10 < 9 ? index + 1 : wrap ? index - 9 : index;
  if (direction == 4) return index % 10 > 0 ? index - 1 : wrap ? index + 9 : index;
  return index;
}

int Window_NameInput::changePage(int page, bool down, const std::string& locale) {
  const int count = nameInputPageCount(locale);
  return (page + count + (down ? 1 : -1)) % count;
}

void Window_NameInput::refresh() {
  contents.clear();
  contents.fontSize = fontSize;
  const auto& table = nameInputTable(page,locale);
  for (int cell = 0; cell < 90; ++cell) {
    const auto rect = cellRect(cell);
    contents.drawText(table[cell],rect.x+3,rect.y,rect.width-6,rect.height,"center");
  }
}

Window_ChoiceList::Window_ChoiceList()
  : Window_Command(0, 0, 240, 144) { openness = 0; active = false; }
void Window_ChoiceList::makeCommandList(const Session& session) {
  commands.clear();
  for (std::size_t i = 0; i < session.message().choices.size(); ++i) {
    addCommand(session.message().choices[i].text(), "choice", true, static_cast<int>(i));
  }
}

int Window_ChoiceList::visibleRows(int count, const Rect& message, int screenHeight) {
  const int center = screenHeight / 2;
  return std::min(count, message.y < center && message.y + message.height > center ? 4 : 8);
}
Rect Window_ChoiceList::placement(int count, int choiceWidth, int position, const Rect& message, int screenWidth, int screenHeight) {
  const int width = std::min(screenWidth,choiceWidth+36);
  const int height = visibleRows(count,message,screenHeight)*36+36;
  return {position == 0 ? 0 : position == 1 ? (screenWidth-width)/2 : screenWidth-width,
    message.y >= screenHeight/2 ? message.y-height : message.y+message.height,width,height};
}

Window_NumberInput::Window_NumberInput()
  : Window_Selectable(0, 0, 240, 72) { openness = 0; active = false; }
void Window_NumberInput::changeDigit(bool up) {
  number = changeDigit(number, maxDigits, index, up);
  contentsDirty = true;
}
void Window_NumberInput::refresh() {
  if (contents.width != contentsWidth() || contents.height != contentsHeight()) contents.resize(contentsWidth(),contentsHeight());
  contents.clear();
  const auto digits = core::numberPadZero(number,maxDigits);
  for (int digit = 0; digit < maxDigits; ++digit) drawText(digits.substr(digit,1),digit*32,0,32,"center");
  contentsDirty = false;
}
Rect Window_NumberInput::placement(int digits, const Rect& message, int screenWidth, int screenHeight) {
  const int width = digits*32+36;
  return {(screenWidth-width)/2,message.y >= screenHeight/2 ? message.y-80 : message.y+message.height+8,width,72};
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
  : Window_ItemList(0, 0, core::Graphics::boxWidth, 180) { openness = 0; active = false; }
Rect Window_EventItem::placement(const Rect& message, int screenWidth, int screenHeight) {
  return {0,message.y >= screenHeight/2 ? 0 : screenHeight-180,screenWidth,180};
}

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
  : Window_Base(0, 0, core::Graphics::boxWidth, core::Graphics::boxHeight) {}

Window_Message::Window_Message()
  : Window_Base(0, core::Graphics::boxHeight - 180, core::Graphics::boxWidth, 180) {}
void Window_Message::clearFlags(Message& message) {
  message.lineFast = false; message.showFast = false;
  message.pauseSkip = false;
}
bool Window_ScrollText::updateMessage(Message& message, const Input& input, const Session& session) {
  if (!message.scrollStarted) {
    std::string text;
    for (std::size_t index = 0; index < message.lines.size(); ++index) {
      if (index) text += '\n';
      text += message.lines[index].text();
    }
    message.scrollText = Window_Base::processEscapeCodes(text, session);
    message.scrollHeight = Window_Base::textHeight(message.scrollText);
    message.scrollStarted = true;
    return false;
  }
  const bool fast = !message.scrollNoFast && (input.ok || input.dash || input.pressed.contains("shift") || input.touchPressed);
  message.scrollY += message.scrollSpeed * (fast ? 3 : 1);
  return message.scrollY >= std::max(message.scrollHeight, 1);
}
void Window_Message::updateState(Session& session) {
  if (session.choiceWindow_) session.choiceWindow_->update();
  if (session.numberWindow_) session.numberWindow_->update();
  if (session.eventItemWindow_) session.eventItemWindow_->update();
  auto& message = session.message_;
  message.previousOpenness = message.openness;
  if (message.scrolling) return;
  if (message.busy && !message.lines.empty()) message.openness = advanceOpenness(message.openness,true);
  else if (message.closing) {
    message.openness = advanceOpenness(message.openness,false);
    if (!message.openness) { message = {}; session.messageOwnerSerial_ = 0; }
  }
}
void Window_Message::terminate(Session& session) {
  auto& message = session.message_;
  message.busy = false; message.closing = message.openness > 0;
  message.choices.clear(); message.numberVariableId = message.numberDigits = 0;
  message.itemVariableId = message.itemType = 0;
  session.messageOwnerSerial_ = 0;
  const auto close = [](auto& window) { if (window && window->active) { window->close(); window->deactivate(); } };
  close(session.choiceWindow_); close(session.numberWindow_); close(session.eventItemWindow_);
}
bool Window_Message::startInput(Session& session) {
  auto& message = session.message_;
  const int width = session.screenWidth_;
  const int height = session.screenHeight_;
  const Rect bounds{0,message.position*(height-180)/2,width,180};
  if (!message.choices.empty()) {
    if (!session.choiceWindow_) session.choiceWindow_ = std::make_shared<Window_ChoiceList>();
    auto& window = *session.choiceWindow_;
    if (!window.active) {
      window.makeCommandList(session); window.background = message.choiceBackground; window.positionType = message.choicePosition;
      window.rect = Window_ChoiceList::placement(window.maxItems(),96,window.positionType,bounds,width,height);
      window.topRow = 0; window.select(message.defaultChoice); window.open(); window.activate();
    }
    return true;
  }
  if (message.numberDigits > 0) {
    if (!session.numberWindow_) session.numberWindow_ = std::make_shared<Window_NumberInput>();
    auto& window = *session.numberWindow_;
    if (!window.active) {
      window.maxDigits = message.numberDigits;
      const int maximum = static_cast<int>(std::pow(10,window.maxDigits))-1;
      window.number = std::clamp(session.variable(message.numberVariableId).integer(),0,maximum);
      window.rect = Window_NumberInput::placement(window.maxDigits,bounds,width,height);
      window.buttonsAbove = bounds.y >= height/2;
      window.select(0); window.button = window.buttonFrameIndex = -1;
      window.buttonsVisible = session.currentInput_.touchDate > session.currentInput_.inputDate;
      window.contentsDirty = true; window.open(); window.activate();
    }
    return true;
  }
  if (message.itemVariableId > 0) {
    if (!session.eventItemWindow_) session.eventItemWindow_ = std::make_shared<Window_EventItem>();
    auto& window = *session.eventItemWindow_;
    if (!window.active) {
      window.itypeId = message.itemType; window.refresh(session);
      window.rect = Window_EventItem::placement(bounds,width,height);
      window.topRow = 0; window.select(0); window.open(); window.activate();
    }
    return true;
  }
  return false;
}
bool Window_Message::updateInput(Session& session, const Input& input, bool ok, bool cancel, int direction, bool pageUp, bool pageDown) {
  const auto sound = [&](int id) { SoundManager::playSystemSound(session,id); };
  if (session.choiceWindow_ && session.choiceWindow_->active) {
    auto& window = *session.choiceWindow_;
    if (!window.isOpenAndActive()) return true;
    const int previous = window.index;
    if (direction) Window_Selectable::moveCursor(window.index,window.topRow,window.maxItems(),1,window.maxPageRows(),direction,input.directionTriggered.value_or(session.directionAge_ == 0));
    if (pageUp || pageDown) Window_Selectable::pageCursor(window.index,window.topRow,window.maxItems(),1,window.maxPageRows(),pageDown);
    window.processWheel(input.wheelY);
    if (window.index != previous) sound(0);
    if (ok) {
      if (window.index < 0 || window.index >= window.maxItems()) sound(3);
      else { session.acknowledge(window.index); sound(1); }
    } else if ((input.cancelRepeated.value_or(cancel) || input.touchCancelled) && session.message_.cancelChoice != -1) {
      session.acknowledge(-2); sound(2);
    }
    return true;
  }
  if (session.numberWindow_ && session.numberWindow_->active) {
    auto& window = *session.numberWindow_;
    if (!window.isOpenAndActive()) return true;
    window.buttonFrameIndex = window.button;
    if (window.buttonsVisible && input.touchX && input.touchY) {
      int touching = -1;
      for (int index = 0; index < 3; ++index) {
        const auto target = std::find_if(session.uiHitTargets_.rbegin(),session.uiHitTargets_.rend(),[&](const auto& target) {
          return target.scene == session.ui_.scene && target.category == session.ui_.category && target.action == 8+index;
        });
        if (target == session.uiHitTargets_.rend()) continue;
        Sprite_Button button;
        const auto cold = Window_NumberInput::buttonFrame(index,false), hot = Window_NumberInput::buttonFrame(index,true);
        button.setColdFrame(cold.x,cold.y,cold.width,cold.height); button.setHotFrame(hot.x,hot.y,hot.width,hot.height);
        button.position = {float(target->x),float(target->y)}; button.touching = window.button == index;
        const bool clicked = button.updateTouch(input.touchTriggered,input.touchReleased,*input.touchX,*input.touchY);
        if (button.touching) touching = index;
        if (clicked) { if (index == 2) ok = true; else { window.changeDigit(index == 1); sound(0); } }
      }
      window.button = touching;
    }
    if (ok) { session.operateVariable(session.message_.numberVariableId,0,window.number); terminate(session); sound(1); return true; }
    if (direction == 6 || direction == 4) { window.index = (window.index+window.maxDigits+(direction == 6 ? 1 : -1))%window.maxDigits; sound(0); }
    if (direction == 8 || direction == 2) { window.changeDigit(direction == 8); sound(0); }
    return true;
  }
  if (session.eventItemWindow_ && session.eventItemWindow_->active) {
    auto& window = *session.eventItemWindow_;
    if (!window.isOpenAndActive()) return true;
    const int previous = window.index;
    if (direction) Window_Selectable::moveCursor(window.index,window.topRow,window.maxItems(),2,4,direction,input.directionTriggered.value_or(session.directionAge_ == 0));
    if (pageUp || pageDown) Window_Selectable::pageCursor(window.index,window.topRow,window.maxItems(),2,4,pageDown);
    window.processWheel(input.wheelY);
    if (window.index != previous) sound(0);
    const bool confirm = input.okRepeated.value_or(ok), cancelInput = input.cancelRepeated.value_or(cancel) || input.touchCancelled;
    if (confirm || cancelInput) {
      const int item = confirm && window.index >= 0 && window.index < window.maxItems() ? window.data[window.index] : 0;
      session.operateVariable(session.message_.itemVariableId,0,item); terminate(session); sound(confirm ? 1 : 2);
    }
    return true;
  }
  return false;
}

Window_PartyCommand::Window_PartyCommand()
  : Window_Command(0, core::Graphics::boxHeight - 180, 192, 180) {}
void Window_PartyCommand::makeCommandList(const Session& session, bool canEscape) {
  commands = makeCommands(session, canEscape);
}
std::vector<CommandItem> Window_PartyCommand::makeCommands(const Session& session, bool canEscape) {
  return {{TextManager::fight(session),"fight"}, {TextManager::escape(session),"escape",canEscape}};
}

Window_ActorCommand::Window_ActorCommand()
  : Window_Command(0, core::Graphics::boxHeight - 180, 192, 180) {}
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
  : Window_BattleStatus(x, y, std::max(0,core::Graphics::boxWidth-192), 180) {}
int Window_BattleActor::maxItems() const { return static_cast<int>(actorIndices.size()); }
void Window_BattleActor::refresh(const Session& session) { actorIndices = makeTargets(session); }
bool Window_BattleActor::includes(const Battler& actor) { return !actor.hidden && !actor.escaped; }
std::vector<int> Window_BattleActor::makeTargets(const Session& session) {
  std::vector<int> targets;
  for (std::size_t index = 0; index < session.battleMemberCount(); ++index)
    if (includes(session.actors().at(session.party()[index]))) targets.push_back(static_cast<int>(index));
  return targets;
}
const std::string& Window_BattleActor::nameFor(const Session& session, int partyIndex) { return session.actors().at(session.party().at(partyIndex)).name; }
Rect Window_BattleActor::placement(int width, int height) { return {0,height-180,std::max(0,width-192),180}; }

Window_BattleEnemy::Window_BattleEnemy(int x, int y)
  : Window_Selectable(x, y, std::max(0,core::Graphics::boxWidth-192), 180) {
  maxCols = columns();
}
void Window_BattleEnemy::refresh(const Session& session) {
  enemyIndices = makeTargets(session);
}
bool Window_BattleEnemy::includes(const Battler& enemy) { return !enemy.hidden && !enemy.escaped && enemy.hp > 0; }
std::vector<int> Window_BattleEnemy::makeTargets(const Session& session) {
  std::vector<int> targets;
  const auto& enemies = session.battle().enemies;
  for (std::size_t i = 0; i < enemies.size(); ++i) if (includes(enemies[i])) targets.push_back(static_cast<int>(i));
  return targets;
}
const std::string& Window_BattleEnemy::nameFor(const Session& session, int enemyIndex) { return session.battle().enemies.at(enemyIndex).name; }
Rect Window_BattleEnemy::placement(int width, int height) { return {192,height-180,std::max(0,width-192),180}; }

Window_BattleSkill::Window_BattleSkill(int x, int y, int w, int h)
  : Window_SkillList(x, y, w, h) {}

Window_BattleItem::Window_BattleItem(int x, int y, int w, int h)
  : Window_ItemList(x, y, w, h) {}

Window_TitleCommand::Window_TitleCommand()
  : Window_Command((core::Graphics::boxWidth - 240) / 2, core::Graphics::boxHeight - 144 - 96, 240, 144) {}
void Window_TitleCommand::makeCommandList(const Session& session) {
  commands = makeCommands(session);
}
std::vector<CommandItem> Window_TitleCommand::makeCommands(const Session& session) {
  return {{TextManager::newGame(session),"newGame"},
    {TextManager::continueCmd(session),"continue",DataManager::isAnySavefileExists(session)},
    {TextManager::options(session),"options"}};
}

Window_GameEnd::Window_GameEnd()
  : Window_Command((core::Graphics::boxWidth - 240) / 2, (core::Graphics::boxHeight - 108) / 2, 240, 108) {}
void Window_GameEnd::makeCommandList(const Session& session) {
  commands = makeCommands(session);
}
std::vector<CommandItem> Window_GameEnd::makeCommands(const Session& session) {
  return {{TextManager::toTitle(session),"toTitle"}, {TextManager::cancel(session),"cancel"}};
}

Window_DebugRange::Window_DebugRange(int x, int y)
  : Window_Selectable(x, y, 246, core::Graphics::boxHeight) {}
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
  : Window_Selectable(x, y, width, 396) {}
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
  contents.fontSize = fontSize;
  if (mapName.empty()) return;
  const double width = contentsWidth(), half = width / 2;
  contents.gradientFillRect(0, 0, half, lineHeight(), "rgba(0,0,0,0)", "rgba(0,0,0,0.6)");
  contents.gradientFillRect(half, 0, half, lineHeight(), "rgba(0,0,0,0.6)", "rgba(0,0,0,0)");
  contents.drawText(mapName, 0, 0, width, lineHeight(), "center");
}

}  // namespace pmjs::mv

