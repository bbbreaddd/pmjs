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
         Vfs& vfs, int gameWidth, int gameHeight);

  Dialog(const Dialog&) = delete;
  Dialog& operator=(const Dialog&) = delete;

  void setFontOverride(const std::string& path);

  void alert(const std::string& message);
  bool confirm(const std::string& message);

 private:
  struct Layout {
    int boxWidth = 0;
    int boxHeight = 0;
    int boxX = 0;
    int boxY = 0;
    std::vector<std::string> lines;
    int textTop = 0;
    int lineHeight = 0;
    struct Button {
      std::string label;
      int x = 0;
      int y = 0;
      int width = 0;
      int height = 0;
    };
    std::vector<Button> buttons;
  };

  struct ModalGuard {
    Dialog& dialog;
    Renderer& renderer;
    std::size_t baseCommands;
    ~ModalGuard();
  };

  int runModal(const std::string& message, bool withCancel);
  Layout buildLayout(const std::string& message, bool withCancel,
                     const std::string& font) const;
  int measureLine(const std::string& line, const std::string& font) const;
  std::optional<std::string> resolveFont() const;
  bool ensureSurface(const Layout& layout);
  void paint(const Layout& layout, int selected, const std::string& font);
  void releaseSurface();
  void presentOverlay();
  // Flush the SDL queue, not just latched edges: the opening press may
  // still sit queued.
  bool armInput();
  // -1 undecided, -2 move selection, -3 cancel/quit, -4 activate selection.
  int pollDecision(bool withCancel);

  Platform& platform_;
  Renderer& renderer_;
  CanvasStore& canvases_;
  Vfs& vfs_;
  int gameWidth_;
  int gameHeight_;
  std::uint32_t surface_ = 0;
  bool surfaceLive_ = false;
  std::string fontOverride_;
};

}  // namespace pmjs
