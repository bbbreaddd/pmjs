#pragma once

#include <cstddef>
#include <cstdint>
#include <optional>
#include <string>
#include <vector>

namespace pmjs {

class CanvasStore;
class Platform;
class Renderer;
class Vfs;

class Dialog {
 public:
  Dialog(Platform& platform, Renderer& renderer, CanvasStore& canvases,
         Vfs& vfs);

  Dialog(const Dialog&) = delete;
  Dialog& operator=(const Dialog&) = delete;

  void setFontOverride(const std::string& path);

  void alert(const std::string& message);
  bool confirm(const std::string& message);
  std::optional<std::string> prompt(const std::string& message, const std::string& defaultValue);

 private:
  struct Layout {
    int canvasWidth = 0;
    int canvasHeight = 0;
    int boxWidth = 0;
    int boxHeight = 0;
    int boxX = 0;
    int boxY = 0;
    std::vector<std::string> lines;
    int textTop = 0;
    int lineHeight = 0;
    int visibleLines = 0;
    int inputY = 0;
    struct Button {
      std::string label;
      int x = 0;
      int y = 0;
      int width = 0;
      int height = 0;
    };
    std::vector<Button> buttons;
  };

  struct PromptState {
    std::string value;
    std::size_t cursor = 0;
    std::size_t anchor = 0;
    std::size_t visibleStart = 0;
    bool focused = true;
  };
  struct ModalState {
    int selected = 0;
    int pressedButton = -1;
    std::size_t firstLine = 0;
    PromptState* prompt = nullptr;
    bool dirty = true;
  };
  struct ModalGuard {
    Dialog& dialog;
    bool textInputEnabled;
    ~ModalGuard();
  };

  int runModal(const std::string& message, bool withCancel, PromptState* prompt = nullptr);
  Layout buildLayout(const std::string& message, bool withCancel,
                     const std::string& font, bool withPrompt) const;
  int measureLine(const std::string& line, const std::string& font) const;
  std::optional<std::string> resolveFont() const;
  void drawText(const std::string& font, const std::string& text, int x, int y,
                int size, std::uint32_t color);
  bool ensureSurface(const Layout& layout);
  void paint(const Layout& layout, const ModalState& state, const std::string& font);
  void releaseSurface();
  void presentOverlay();
  bool armInput();
  int pollDecision(const Layout& layout, ModalState& state, const std::string& font);

  Platform& platform_;
  Renderer& renderer_;
  CanvasStore& canvases_;
  Vfs& vfs_;
  std::uint32_t surface_ = 0;
  bool surfaceLive_ = false;
  std::string fontOverride_;
};

}  // namespace pmjs
