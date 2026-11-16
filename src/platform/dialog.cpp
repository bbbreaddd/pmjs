#include "dialog.hpp"

#include <SDL.h>

#include <algorithm>
#include <cstddef>
#include <cmath>
#include <memory>
#include <stdexcept>

#include "canvas/canvas.hpp"
#include "fallback_font.hpp"
#include "platform.hpp"
#include "graphics/renderer.hpp"
#include "vfs.hpp"

namespace pmjs {

namespace {

constexpr int kFontSize = 22;
constexpr int kLineHeight = 30;
constexpr int kPadding = 24;
constexpr int kButtonHeight = 44;
constexpr int kButtonWidth = 150;
constexpr int kButtonGap = 20;
constexpr int kMaxLines = 10;

constexpr std::uint32_t kBoxColor = 0x101418F2U;
constexpr std::uint32_t kBorderColor = 0xFFFFFFFFU;
constexpr std::uint32_t kTextColor = 0xFFFFFFFFU;
constexpr std::uint32_t kButtonColor = 0x2A2E33FFU;
constexpr std::uint32_t kButtonSelectedColor = 0x3A6EA5FFU;

const char* kFontCandidates[] = {
  "fonts/mplus-1m-regular.ttf",
  "fonts/mplus-1mn-regular.ttf",
  "fonts/gamefont.ttf",
};

std::vector<std::string> splitLines(const std::string& text) {
  std::vector<std::string> lines;
  std::string current;
  std::size_t column = 0;
  for (std::size_t i = 0; i < text.size(); ++i) {
    const char c = text[i];
    if (c == '\n' || c == '\r') {
      lines.push_back(current);
      current.clear();
      column = 0;
      if (c == '\r' && i + 1 < text.size() && text[i + 1] == '\n') ++i;
    } else if (c == '\t') {
      const auto spaces = 8 - column % 8;
      current.append(spaces, ' ');
      column += spaces;
    } else {
      current.push_back(c);
      if ((static_cast<unsigned char>(c) & 0xC0U) != 0x80U) ++column;
    }
  }
  lines.push_back(current);
  return lines;
}

std::vector<std::string> splitCodepoints(const std::string& text) {
  std::vector<std::string> out;
  for (std::size_t i = 0; i < text.size();) {
    const unsigned char lead = static_cast<unsigned char>(text[i]);
    std::size_t length = 1;
    if ((lead & 0xE0U) == 0xC0U) {
      length = 2;
    } else if ((lead & 0xF0U) == 0xE0U) {
      length = 3;
    } else if ((lead & 0xF8U) == 0xF0U) {
      length = 4;
    }
    length = std::min(length, text.size() - i);
    out.push_back(text.substr(i, length));
    i += length;
  }
  return out;
}

std::size_t previousCharacter(const std::string& text, std::size_t at) {
  if (!at) return 0;
  do { --at; } while (at && (static_cast<unsigned char>(text[at]) & 0xC0U) == 0x80U);
  return at;
}

std::size_t nextCharacter(const std::string& text, std::size_t at) {
  if (at == text.size()) return at;
  do { ++at; } while (at < text.size() && (static_cast<unsigned char>(text[at]) & 0xC0U) == 0x80U);
  return at;
}

int wordClass(const std::string& text, std::size_t at) {
  const auto code = static_cast<unsigned char>(text[at]);
  if (code == ' ' || (code >= 9 && code <= 13)) return 0;
  if (code >= 128 || (code >= 'a' && code <= 'z') || (code >= 'A' && code <= 'Z') ||
      (code >= '0' && code <= '9') || code == '_') return 1;
  return 2;
}

std::size_t previousWord(const std::string& text, std::size_t at) {
  while (at && wordClass(text, previousCharacter(text, at)) == 0) at = previousCharacter(text, at);
  if (!at) return 0;
  const int category = wordClass(text, previousCharacter(text, at));
  while (at && wordClass(text, previousCharacter(text, at)) == category) at = previousCharacter(text, at);
  return at;
}

std::size_t nextWord(const std::string& text, std::size_t at) {
  while (at < text.size() && wordClass(text, at) == 0) at = nextCharacter(text, at);
  if (at == text.size()) return at;
  const int category = wordClass(text, at);
  while (at < text.size() && wordClass(text, at) == category) at = nextCharacter(text, at);
  return at;
}

bool pasteWhitespace(const std::string& character) {
  if (character.size() > 3) return false;
  std::uint32_t code = static_cast<unsigned char>(character[0]);
  if (character.size() > 1) {
    code &= character.size() == 2 ? 0x1F : 0x0F;
    for (std::size_t i = 1; i < character.size(); ++i)
      code = (code << 6) | (static_cast<unsigned char>(character[i]) & 0x3F);
  }
  return (code >= 9 && code <= 13) || code == 0x20 || code == 0x85 || code == 0xA0 ||
    code == 0x1680 || (code >= 0x2000 && code <= 0x200A) || code == 0x2028 ||
    code == 0x2029 || code == 0x202F || code == 0x205F || code == 0x3000;
}

std::string pastedText(const std::string& text) {
  std::string result;
  bool space = false;
  for (const auto& character : splitCodepoints(text)) {
    if (pasteWhitespace(character)) space = !result.empty();
    else {
      if (space) result += ' ';
      result += character;
      space = false;
    }
  }
  return result.empty() && !text.empty() ? " " : result;
}

std::string limitText(const std::string& text, std::size_t maxRows) {
  std::string result;
  std::size_t row = 0, column = 0;
  bool suppressed = false;
  for (std::size_t at = 0; at < text.size();) {
    const auto end = nextCharacter(text, at);
    const auto character = text.substr(at, end - at);
    at = end;
    if (column == 132) { result += '\n'; ++row; column = 0; }
    if (row >= maxRows) { suppressed = true; break; }
    result += character;
    if (character == "\n" || character == "\r") {
      ++row; column = 0;
      if (character == "\r" && at < text.size() && text[at] == '\n') { result += '\n'; ++at; }
    } else ++column;
  }
  if (suppressed) result += "...";
  return result;
}

}  // namespace

Dialog::Dialog(Platform& platform, Renderer& renderer, CanvasStore& canvases,
               Vfs& vfs)
    : platform_(platform),
      renderer_(renderer),
      canvases_(canvases),
      vfs_(vfs) {}

void Dialog::setFontOverride(const std::string& path) { fontOverride_ = path; }

void Dialog::alert(const std::string& message) {
  runModal(message, false);
}

bool Dialog::confirm(const std::string& message) {
  return runModal(message, true) == 1;
}

std::optional<std::string> Dialog::prompt(const std::string& message, const std::string& defaultValue) {
  PromptState input;
  input.value = limitText(defaultValue, 24);
  input.cursor = input.value.size();
  return runModal(message, true, &input) ? std::optional<std::string>{input.value} : std::nullopt;
}

Dialog::ModalGuard::~ModalGuard() {
  dialog.platform_.consumePressed();
  dialog.platform_.clearPointerEvents();
  if (dialog.platform_.textInputEnabled() != textInputEnabled)
    dialog.platform_.setTextInput(textInputEnabled);
  dialog.releaseSurface();
}

std::optional<std::string> Dialog::resolveFont() const {
  if (!fontOverride_.empty()) {
    if (auto resolved = vfs_.resolve(fontOverride_); resolved && canvases_.canLoadFont(*resolved))
      return resolved->string();
  }
  for (const char* candidate : kFontCandidates) {
    if (auto resolved = vfs_.resolve(candidate); resolved && canvases_.canLoadFont(*resolved))
      return resolved->string();
  }
  return std::nullopt;
}

int Dialog::measureLine(const std::string& line,
                        const std::string& font) const {
  if (font.empty()) {
    std::size_t units = 0;
    for (const auto& character : splitCodepoints(line)) units += character.size() == 4 ? 2 : 1;
    return static_cast<int>(std::ceil(units * 12.0 * kFontSize / 16.0));
  }
  const auto width = canvases_.measureText(font, line, kFontSize);
  if (!width) throw std::runtime_error("dialog text measurement failed");
  return static_cast<int>(std::ceil(*width));
}

void Dialog::drawText(const std::string& font, const std::string& text, int x, int y,
                      int size, std::uint32_t color) {
  if (!font.empty()) {
    canvases_.drawText(surface_, font, text, x, y, size, color, 0);
    return;
  }
  const double pixel = size / 16.0;
  const int extent = std::max(1, static_cast<int>(std::ceil(pixel)));
  std::size_t index = 0;
  for (const auto& character : splitCodepoints(text)) {
    const auto code = character.size() == 1 ? static_cast<unsigned char>(character[0]) : 0;
    const auto& rows = detail::fallbackGlyphs[code >= 32 && code < 127 ? code - 32 : 31];
    const int units = character.size() == 4 ? 2 : 1;
    for (int unit = 0; unit < units; ++unit, ++index) {
      for (int row = 0; row < 16; ++row) for (int column = 0; column < 12; ++column) {
        if (rows[row] & (1 << column)) canvases_.fillRect(surface_,
          static_cast<int>(std::lround(x + (index * 12 + column) * pixel)),
          static_cast<int>(std::lround(y - size + row * pixel)), extent, extent, color);
      }
    }
  }
}

Dialog::Layout Dialog::buildLayout(const std::string& message, bool withCancel,
                                   const std::string& font, bool withPrompt) const {
  Layout layout;
  const auto [gameWidth, gameHeight] = renderer_.screenRenderSize();
  const double scale = std::min({1.0, gameWidth / 400.0, gameHeight / 480.0});
  if (scale <= 0) throw std::runtime_error("invalid dialog viewport");
  layout.canvasWidth = static_cast<int>(std::ceil(gameWidth / scale));
  layout.canvasHeight = static_cast<int>(std::ceil(gameHeight / scale));
  const int maxTextWidth =
      std::min(560, layout.canvasWidth - 60) - kPadding * 2;
  std::vector<std::string> wrapped;
  for (const std::string& raw : splitLines(message)) {
    std::string line;
    for (const std::string& codepoint : splitCodepoints(raw)) {
      if (!line.empty() && measureLine(line + codepoint, font) > maxTextWidth) {
        const auto lastSpace = line.find_last_of(' ');
        const auto firstWord = line.find_first_not_of(' ');
        if (lastSpace != std::string::npos && firstWord != std::string::npos &&
            lastSpace >= firstWord) {
          wrapped.push_back(line.substr(0, lastSpace + 1));
          line.erase(0, lastSpace + 1);
        } else {
          wrapped.push_back(line);
          line.clear();
        }
      }
      line += codepoint;
    }
    wrapped.push_back(line);
  }
  layout.lines = wrapped;
  layout.lineHeight = kLineHeight;
  layout.visibleLines = std::min(kMaxLines, static_cast<int>(wrapped.size()));

  const int buttonCount = withCancel ? 2 : 1;
  const int buttonsWidth =
      buttonCount * kButtonWidth + (buttonCount - 1) * kButtonGap;
  int textWidth = 0;
  for (const std::string& line : wrapped) {
    textWidth = std::max(textWidth, measureLine(line, font));
  }
  layout.boxWidth =
      std::min(std::max(textWidth, buttonsWidth) + kPadding * 2,
               layout.canvasWidth - 40);
  layout.boxHeight =
      kPadding * 3 + kButtonHeight +
      layout.visibleLines * kLineHeight + (withPrompt ? 60 : 0);
  layout.boxX = (layout.canvasWidth - layout.boxWidth) / 2;
  layout.boxY = (layout.canvasHeight - layout.boxHeight) / 2;
  layout.textTop = kPadding;
  layout.inputY = layout.boxY + kPadding + layout.visibleLines * kLineHeight + 12;

  const int buttonsY =
      layout.boxY + layout.boxHeight - kPadding - kButtonHeight;
  int cursorX = layout.boxX + (layout.boxWidth - buttonsWidth) / 2;
  if (withCancel) {
    layout.buttons.push_back(
        {"Cancel", cursorX, buttonsY, kButtonWidth, kButtonHeight});
    cursorX += kButtonWidth + kButtonGap;
  }
  layout.buttons.push_back(
      {"OK", cursorX, buttonsY, kButtonWidth, kButtonHeight});
  return layout;
}

bool Dialog::ensureSurface(const Layout& layout) {
  if (!surfaceLive_) {
    auto created = canvases_.create(layout.canvasWidth, layout.canvasHeight);
    if (!created) return false;
    surface_ = created->handle;
    surfaceLive_ = true;
  }
  return canvases_.realize(surface_) && canvases_.prepareImage(surface_);
}

void Dialog::paint(const Layout& layout, const ModalState& state,
                   const std::string& font) {
  canvases_.clear(surface_);
  canvases_.fillRect(surface_, 0, 0, layout.canvasWidth, layout.canvasHeight,
                     0x00000099U);
  const auto fill = [&](int x, int y, int width, int height, std::uint32_t color) {
    canvases_.fillRect(surface_, layout.boxX + x, layout.boxY + y, width, height, color);
  };
  fill(0, 0, layout.boxWidth, layout.boxHeight, kBoxColor);
  const int border = 2;
  fill(0, 0, layout.boxWidth, border, kBorderColor);
  fill(0, layout.boxHeight - border, layout.boxWidth, border, kBorderColor);
  fill(0, 0, border, layout.boxHeight, kBorderColor);
  fill(layout.boxWidth - border, 0, border, layout.boxHeight, kBorderColor);
  int y = layout.boxY + layout.textTop + kFontSize;
  for (std::size_t i = state.firstLine;
       i < layout.lines.size() && i < state.firstLine + layout.visibleLines; ++i) {
    drawText(font, layout.lines[i], layout.boxX + kPadding, y, kFontSize,
                       kTextColor);
    y += layout.lineHeight;
  }
  if (state.firstLine) drawText(font, "^", layout.boxX + layout.boxWidth - 20,
    layout.boxY + 20, 16, kTextColor);
  if (state.firstLine + layout.visibleLines < layout.lines.size())
    drawText(font, "v", layout.boxX + layout.boxWidth - 20,
      layout.boxY + kPadding + layout.visibleLines * kLineHeight, 16, kTextColor);
  if (state.prompt) {
    auto& input = *state.prompt;
    const int x = layout.boxX + kPadding;
    const int width = layout.boxWidth - kPadding * 2;
    canvases_.fillRect(surface_, x, layout.inputY, width, 40, 0xFFFFFFFFU);
    canvases_.fillRect(surface_, x + 2, layout.inputY + 2, width - 4, 36, 0x202428FFU);
    std::size_t start = 0, end = input.value.size();
    while (start < input.cursor && measureLine(input.value.substr(start, input.cursor - start), font) > width - 20)
      start = nextCharacter(input.value, start);
    while (end > start && measureLine(input.value.substr(start, end - start), font) > width - 20)
      end = previousCharacter(input.value, end);
    input.visibleStart = start;
    const auto left = std::clamp(std::min(input.anchor, input.cursor), start, end);
    const auto right = std::clamp(std::max(input.anchor, input.cursor), start, end);
    if (input.focused && left != right) {
      const int selectionX = measureLine(input.value.substr(start, left - start), font);
      const int selectionWidth = measureLine(input.value.substr(left, right - left), font);
      canvases_.fillRect(surface_, x + 8 + selectionX, layout.inputY + 5, selectionWidth, 30, kButtonSelectedColor);
    }
    drawText(font, input.value.substr(start, end - start), x + 8,
      layout.inputY + 28, kFontSize, kTextColor);
    if (input.focused) {
      const int cursorX = measureLine(input.value.substr(start, input.cursor - start), font);
      canvases_.fillRect(surface_, x + 8 + cursorX, layout.inputY + 6, 1, 28, kTextColor);
    }
  }
  for (std::size_t i = 0; i < layout.buttons.size(); ++i) {
    const auto& button = layout.buttons[i];
    canvases_.fillRect(surface_, button.x, button.y, button.width, button.height,
                       static_cast<int>(i) == state.selected && (!state.prompt || !state.prompt->focused) ? kButtonSelectedColor
                                                       : kButtonColor);
    const int labelWidth = measureLine(button.label, font);
    drawText(font, button.label,
                       button.x + (button.width - labelWidth) / 2,
                       button.y + (kButtonHeight + kFontSize) / 2, kFontSize,
                       kTextColor);
  }
}

void Dialog::releaseSurface() {
  if (!surfaceLive_) return;
  canvases_.release(surface_);
  surfaceLive_ = false;
}

void Dialog::presentOverlay() {
  canvases_.uploadDirty();
  const auto image = canvases_.imageHandle(surface_);
  if (!image) throw std::runtime_error("dialog image unavailable");
  renderer_.presentModalOverlay(*image);
  platform_.swap();
}

bool Dialog::armInput() {
  const bool running = platform_.pollEvents();
  platform_.consumePressed();
  platform_.clearPointerEvents();
  return running && !platform_.windowClosePending();
}

int Dialog::pollDecision(const Layout& layout, ModalState& state, const std::string& font) {
  const bool running = platform_.pollEvents();
  if (!running || platform_.windowClosePending()) return -3;
  const auto drawable = platform_.drawableSize();
  renderer_.setDrawableSize(drawable.first, drawable.second);
  const auto scroll = [&](int amount) {
    const int last = std::max(0, static_cast<int>(layout.lines.size()) - layout.visibleLines);
    state.firstLine = static_cast<std::size_t>(std::clamp(static_cast<int>(state.firstLine) + amount, 0, last));
    state.dirty = true;
  };
  const auto moveFocus = [&](bool backwards) {
    if (!state.prompt) state.selected = (state.selected + 1) % static_cast<int>(layout.buttons.size());
    else if (state.prompt->focused) { state.prompt->focused = false; state.selected = backwards ? 1 : 0; }
    else if (state.selected == (backwards ? 0 : 1)) state.prompt->focused = true;
    else state.selected = backwards ? 0 : 1;
    state.dirty = true;
  };
  const auto pointers = platform_.pointerEvents();
  platform_.clearPointerEvents();
  const auto geometry = renderer_.presentationGeometry();
  for (const auto& event : pointers) {
    if (event.type == "wheel") { if (event.deltaY) scroll(event.deltaY > 0 ? 3 : -3); continue; }
    if (event.button != 0) continue;
    const double x = (event.x * geometry.drawableWidth / platform_.windowWidth() - geometry.viewportX) *
      layout.canvasWidth / geometry.viewportWidth;
    const double y = (event.y * geometry.drawableHeight / platform_.windowHeight() - geometry.viewportY) *
      layout.canvasHeight / geometry.viewportHeight;
    int hit = -1;
    for (std::size_t i = 0; i < layout.buttons.size(); ++i) {
      const auto& button = layout.buttons[i];
      if (x >= button.x && x < button.x + button.width && y >= button.y && y < button.y + button.height)
        hit = static_cast<int>(i);
    }
    if (event.type == "mousedown") {
      state.pressedButton = hit;
      if (hit >= 0) { state.selected = hit; if (state.prompt) state.prompt->focused = false; state.dirty = true; }
      else if (state.prompt && x >= layout.boxX + kPadding && x < layout.boxX + layout.boxWidth - kPadding &&
               y >= layout.inputY && y < layout.inputY + 40) {
        auto& input = *state.prompt;
        input.focused = true;
        input.cursor = input.visibleStart;
        while (input.cursor < input.value.size()) {
          const auto next = nextCharacter(input.value, input.cursor);
          if (measureLine(input.value.substr(input.visibleStart, next - input.visibleStart), font) > x - layout.boxX - kPadding - 8) break;
          input.cursor = next;
        }
        input.anchor = input.cursor;
        state.dirty = true;
      }
    } else if (event.type == "mouseup") {
      const bool activate = hit >= 0 && hit == state.pressedButton && !event.cancelled;
      state.pressedButton = -1;
      if (activate) return -4;
    }
  }
  const auto keys = platform_.keyEvents();
  platform_.clearKeyEvents();
  for (const auto& key : keys) {
    if (!key.down && key.text.empty()) continue;
    if (key.keyCode == 27) return -3;
    if (key.keyCode == 13) {
      if (state.prompt && state.prompt->focused) state.selected = 1;
      return -4;
    }
    if (key.keyCode == 9) { moveFocus(key.shift); continue; }
    if (state.prompt && state.prompt->focused) {
      auto& input = *state.prompt;
      const auto eraseSelection = [&] {
        const auto first = std::min(input.cursor, input.anchor);
        const auto last = std::max(input.cursor, input.anchor);
        input.value.erase(first, last - first); input.cursor = input.anchor = first;
      };
      if (key.ctrl && key.keyCode == 65) { input.anchor = 0; input.cursor = input.value.size(); }
      else if (key.ctrl && (key.keyCode == 67 || key.keyCode == 88)) {
        const auto first = std::min(input.cursor, input.anchor);
        const auto count = std::max(input.cursor, input.anchor) - first;
        if (count && SDL_SetClipboardText(input.value.substr(first, count).c_str()) == 0 && key.keyCode == 88)
          eraseSelection();
      } else if (key.ctrl && key.keyCode == 86) {
        std::unique_ptr<char, decltype(&SDL_free)> clipboard(SDL_GetClipboardText(), SDL_free);
        if (clipboard && clipboard.get()[0]) {
          const auto text = pastedText(clipboard.get());
          eraseSelection();
          input.value.insert(input.cursor, text);
          input.cursor += text.size();
          input.anchor = input.cursor;
        }
      } else if (key.keyCode == 37 || key.keyCode == 39 || key.keyCode == 36 || key.keyCode == 35) {
        if (!key.shift && input.cursor != input.anchor && (key.keyCode == 37 || key.keyCode == 39))
          input.cursor = key.keyCode == 37 ? std::min(input.cursor, input.anchor) : std::max(input.cursor, input.anchor);
        else if (key.keyCode == 37) input.cursor = key.ctrl ? previousWord(input.value, input.cursor) : previousCharacter(input.value, input.cursor);
        else if (key.keyCode == 39) input.cursor = key.ctrl ? nextWord(input.value, input.cursor) : nextCharacter(input.value, input.cursor);
        else input.cursor = key.keyCode == 36 ? 0 : input.value.size();
        if (!key.shift) input.anchor = input.cursor;
      } else if (key.keyCode == 8 || key.keyCode == 46) {
        if (input.cursor == input.anchor) {
          if (key.keyCode == 8) input.anchor = key.ctrl ? previousWord(input.value, input.cursor) : previousCharacter(input.value, input.cursor);
          else input.anchor = key.ctrl ? nextWord(input.value, input.cursor) : nextCharacter(input.value, input.cursor);
        }
        eraseSelection();
      } else if (!key.text.empty()) {
        eraseSelection(); input.value.insert(input.cursor, key.text); input.cursor += key.text.size(); input.anchor = input.cursor;
      }
      state.dirty = true;
      continue;
    }
    if (key.keyCode == 32) return -4;
    if ((key.keyCode == 37 || key.keyCode == 39) && layout.buttons.size() > 1) {
      state.selected = (state.selected + 1) % static_cast<int>(layout.buttons.size()); state.dirty = true;
    }
    else if (key.keyCode == 38 || key.keyCode == 33) scroll(-layout.visibleLines);
    else if (key.keyCode == 40 || key.keyCode == 34) scroll(layout.visibleLines);
  }
  for (const auto& pad : platform_.gamepads()) {
    for (int button : pad.buttonsPressed) {
      if (button == 1) return -3;
      if (button == 0) {
        if (state.prompt && state.prompt->focused) state.selected = 1;
        return -4;
      }
      if ((button == 14 || button == 15) && layout.buttons.size() > 1) moveFocus(false);
      if (button == 12) scroll(-layout.visibleLines);
      if (button == 13) scroll(layout.visibleLines);
    }
  }
  platform_.consumePressed();
  return -1;
}

int Dialog::runModal(const std::string& message, bool withCancel, PromptState* input) {
  const auto font = resolveFont().value_or("");
  Layout layout = buildLayout(limitText(message, 32), withCancel, font, input != nullptr);
  if (!ensureSurface(layout)) {
    releaseSurface();
    throw std::runtime_error("dialog surface allocation failed");
  }
  ModalGuard guard{*this, platform_.textInputEnabled()};
  if (input) platform_.setTextInput(true);
  ModalState state;
  state.selected = static_cast<int>(layout.buttons.size()) - 1;
  state.prompt = input;
  int decision = armInput() ? -1 : -3;
  paint(layout, state, font);
  state.dirty = false;
  while (decision == -1) {
    const int step = pollDecision(layout, state, font);
    if (step == -4 || step == -3) {
      decision = (step == -4) ? state.selected : -3;
      break;
    }
    if (state.dirty) { paint(layout, state, font); state.dirty = false; }
    presentOverlay();
    if (platform_.swapInterval() == 0) SDL_Delay(16);
  }
  if (!withCancel) return 1;
  constexpr int okButtonIndex = 1;
  return decision == okButtonIndex ? 1 : 0;
}

}  // namespace pmjs
