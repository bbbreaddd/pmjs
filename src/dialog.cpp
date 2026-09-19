#include "dialog.hpp"

#include <SDL.h>

#include <algorithm>
#include <array>
#include <cstddef>
#include <iostream>
#include <sstream>
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
  for (char c : text) {
    if (c == '\n') {
      lines.push_back(current);
      current.clear();
    } else if (c != '\r') {
      current.push_back(c);
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
  renderer.discardCommandsFrom(baseCommands);
  dialog.releaseSurface();
}

std::optional<std::string> Dialog::resolveFont() const {
  // CanvasStore needs the VFS-resolved absolute path, not the game-relative
  // candidate: returning the unresolved string silently disables all text.
  if (!fontOverride_.empty()) {
    if (auto resolved = vfs_.resolve(fontOverride_)) return resolved->string();
  }
  for (const char* candidate : kFontCandidates) {
    if (auto resolved = vfs_.resolve(candidate)) return resolved->string();
  }
  return std::nullopt;
}

int Dialog::measureLine(const std::string& line,
                        const std::string& font) const {
  const auto width = canvases_.measureText(font, line, kFontSize);
  return width ? *width : 0;
}

Dialog::Layout Dialog::buildLayout(const std::string& message, bool withCancel,
                                   const std::string& font) const {
  Layout layout;
  const int maxTextWidth =
      std::min(560, gameWidth_ - 60) - kPadding * 2;
  std::vector<std::string> wrapped;
  for (const std::string& raw : splitLines(message)) {
    std::string line;
    std::istringstream words(raw);
    std::string word;
    bool sawWord = false;
    while (words >> word) {
      sawWord = true;
      std::string next = line.empty() ? word : line + " " + word;
      if (measureLine(next, font) <= maxTextWidth) {
        line = next;
        continue;
      }
      if (!line.empty()) wrapped.push_back(line);
      line.clear();
      if (measureLine(word, font) <= maxTextWidth) {
        line = word;
        continue;
      }
      std::string chunk;
      for (const std::string& codepoint : splitCodepoints(word)) {
        if (!chunk.empty() &&
            measureLine(chunk + codepoint, font) > maxTextWidth) {
          wrapped.push_back(chunk);
          chunk.clear();
        }
        chunk += codepoint;
      }
      line = chunk;
    }
    if (!line.empty() || !sawWord) wrapped.push_back(line);
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
               gameWidth_ - 40);
  layout.boxHeight =
      kPadding * 3 + kButtonHeight +
      static_cast<int>(wrapped.size()) * kLineHeight;
  layout.boxX = (gameWidth_ - layout.boxWidth) / 2;
  layout.boxY = (gameHeight_ - layout.boxHeight) / 2;
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
    auto created = canvases_.create(layout.boxWidth, layout.boxHeight);
    if (!created) return false;
    surface_ = created->handle;
    surfaceLive_ = true;
  }
  return canvases_.realize(surface_) && canvases_.prepareImage(surface_);
}

void Dialog::paint(const Layout& layout, int selected,
                   const std::string& font) {
  canvases_.fillRect(surface_, 0, 0, layout.boxWidth, layout.boxHeight,
                     kBoxColor);
  const int border = 2;
  canvases_.fillRect(surface_, 0, 0, layout.boxWidth, border, kBorderColor);
  canvases_.fillRect(surface_, 0, layout.boxHeight - border, layout.boxWidth,
                     border, kBorderColor);
  canvases_.fillRect(surface_, 0, 0, border, layout.boxHeight, kBorderColor);
  canvases_.fillRect(surface_, layout.boxWidth - border, 0, border,
                     layout.boxHeight, kBorderColor);
  int y = layout.textTop + kFontSize;
  for (const std::string& line : layout.lines) {
    canvases_.drawText(surface_, font, line, kPadding, y, kFontSize,
                       kTextColor, 0);
    y += layout.lineHeight;
  }
  for (std::size_t i = 0; i < layout.buttons.size(); ++i) {
    const auto& button = layout.buttons[i];
    const int localX = button.x - layout.boxX;
    const int localY = button.y - layout.boxY;
    canvases_.fillRect(surface_, localX, localY, button.width, button.height,
                       static_cast<int>(i) == selected ? kButtonSelectedColor
                                                       : kButtonColor);
    const auto width = canvases_.measureText(font, button.label, kFontSize);
    const int labelWidth = width ? *width : 0;
    canvases_.drawText(surface_, font, button.label,
                       localX + (button.width - labelWidth) / 2,
                       localY + (kButtonHeight + kFontSize) / 2, kFontSize,
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
  renderer_.render();
  platform_.swap();
}

bool Dialog::armInput() {
  if (!platform_.pollEvents()) return false;
  platform_.consumePressed();
  return true;
}

int Dialog::pollDecision(bool withCancel) {
  if (!platform_.pollEvents()) return -3;
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
  const std::array<float, 6> place = {
    1.0F, 0.0F, 0.0F, 1.0F, static_cast<float>(layout.boxX),
    static_cast<float>(layout.boxY)};
  const std::array<float, 4> source = {0.0F, 0.0F,
                                       static_cast<float>(layout.boxWidth),
                                       static_cast<float>(layout.boxHeight)};
  ModalGuard guard{*this, renderer_, renderer_.commandCount()};
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
    renderer_.discardCommandsFrom(guard.baseCommands);
    renderer_.queueQuad(0.0F, 0.0F, static_cast<float>(gameWidth_),
                        static_cast<float>(gameHeight_),
                        {0.0F, 0.0F, 0.0F, 0.6F});
    auto image = canvases_.imageHandle(surface_);
    if (image) {
      renderer_.queueImage(*image, place, source, 1.0F, 0xFFFFFFU,
                           BlendMode::normal);
    }
    presentOverlay();
    if (platform_.swapInterval() == 0) SDL_Delay(16);
  }
  platform_.consumePressed();
  if (!withCancel) return 1;
  constexpr int okButtonIndex = 1;
  return decision == okButtonIndex ? 1 : 0;
}

}  // namespace pmjs
