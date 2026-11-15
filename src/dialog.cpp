#include "dialog.hpp"

#include <SDL.h>

#include <algorithm>
#include <cstddef>
#include <cmath>
#include <stdexcept>

#include "canvas.hpp"
#include "platform.hpp"
#include "renderer.hpp"
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

}  // namespace

Dialog::Dialog(Platform& platform, Renderer& renderer, CanvasStore& canvases,
               Vfs& vfs, int gameWidth, int gameHeight)
    : platform_(platform),
      renderer_(renderer),
      canvases_(canvases),
      vfs_(vfs),
      gameWidth_(gameWidth),
      gameHeight_(gameHeight) {}

void Dialog::setFontOverride(const std::string& path) { fontOverride_ = path; }

void Dialog::alert(const std::string& message) {
  runModal(message, false);
}

bool Dialog::confirm(const std::string& message) {
  return runModal(message, true) == 1;
}

Dialog::ModalGuard::~ModalGuard() {
  dialog.platform_.consumePressed();
  dialog.platform_.clearPointerEvents();
  dialog.releaseSurface();
}

std::optional<std::string> Dialog::resolveFont() const {
  // CanvasStore needs the VFS-resolved absolute path, not the game-relative
  // candidate: returning the unresolved string silently disables all text.
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
  const auto width = canvases_.measureText(font, line, kFontSize);
  if (!width) throw std::runtime_error("dialog text measurement failed");
  return static_cast<int>(std::ceil(*width));
}

Dialog::Layout Dialog::buildLayout(const std::string& message, bool withCancel,
                                   const std::string& font) const {
  Layout layout;
  const double scale = std::min({1.0, gameWidth_ / 400.0, gameHeight_ / 480.0});
  if (scale <= 0) throw std::runtime_error("invalid dialog viewport");
  layout.canvasWidth = static_cast<int>(std::ceil(gameWidth_ / scale));
  layout.canvasHeight = static_cast<int>(std::ceil(gameHeight_ / scale));
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
  if (wrapped.size() > kMaxLines) {
    throw std::runtime_error(
      "dialog message exceeds native modal capacity");
  }
  layout.lines = wrapped;
  layout.lineHeight = kLineHeight;

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
      static_cast<int>(wrapped.size()) * kLineHeight;
  layout.boxX = (layout.canvasWidth - layout.boxWidth) / 2;
  layout.boxY = (layout.canvasHeight - layout.boxHeight) / 2;
  layout.textTop = kPadding;

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

void Dialog::paint(const Layout& layout, int selected,
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
  for (const std::string& line : layout.lines) {
    canvases_.drawText(surface_, font, line, layout.boxX + kPadding, y, kFontSize,
                       kTextColor, 0);
    y += layout.lineHeight;
  }
  for (std::size_t i = 0; i < layout.buttons.size(); ++i) {
    const auto& button = layout.buttons[i];
    canvases_.fillRect(surface_, button.x, button.y, button.width, button.height,
                       static_cast<int>(i) == selected ? kButtonSelectedColor
                                                       : kButtonColor);
    const auto width = canvases_.measureText(font, button.label, kFontSize);
    const int labelWidth = width ? *width : 0;
    canvases_.drawText(surface_, font, button.label,
                       button.x + (button.width - labelWidth) / 2,
                       button.y + (kButtonHeight + kFontSize) / 2, kFontSize,
                       kTextColor, 0);
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

int Dialog::pollDecision(bool withCancel) {
  const bool running = platform_.pollEvents();
  platform_.clearPointerEvents();
  if (!running || platform_.windowClosePending()) return -3;
  if (withCancel && (platform_.consumePress("left") ||
                     platform_.consumePress("right"))) {
    return -2;
  }
  if (platform_.consumePress("ok")) return -4;
  if (platform_.consumePress("escape")) return -3;
  return -1;
}

int Dialog::runModal(const std::string& message, bool withCancel) {
  const auto font = resolveFont();
  if (!font) {
    throw std::runtime_error(
      "dialog cannot be rendered: no game typeface resolved");
  }
  Layout layout = buildLayout(message, withCancel, *font);
  if (!ensureSurface(layout)) {
    releaseSurface();
    throw std::runtime_error("dialog surface allocation failed");
  }
  ModalGuard guard{*this};
  int selected = withCancel ? 0 : static_cast<int>(layout.buttons.size()) - 1;
  int decision = armInput() ? -1 : -3;
  paint(layout, selected, *font);
  while (decision == -1) {
    const int step = pollDecision(withCancel);
    if (step == -2) {
      selected = (selected + 1) % static_cast<int>(layout.buttons.size());
      paint(layout, selected, *font);
      continue;
    }
    if (step == -4 || step == -3) {
      decision = (step == -4) ? selected : -3;
      break;
    }
    presentOverlay();
    if (platform_.swapInterval() == 0) SDL_Delay(16);
  }
  if (!withCancel) return 1;
  constexpr int okButtonIndex = 1;
  return decision == okButtonIndex ? 1 : 0;
}

}  // namespace pmjs
