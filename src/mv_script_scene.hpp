#pragma once
#include "mv_core_display.hpp"
#include <functional>

namespace pmjs::mv {
class ScriptScene : public core::Stage {
 public:
  bool active = false;
  int fadeSign = 0, fadeDuration = 0;
  std::shared_ptr<core::ScreenSprite> fadeSprite;
  void startFade(bool out, int duration, bool white);
  void updateFade();
};

class ScriptSceneManager {
 public:
  using Dispatch = std::function<bool(const std::shared_ptr<ScriptScene>&, const std::string&)>;
  std::shared_ptr<ScriptScene> scene, nextScene;
  bool started = false, changing = false, stopped = false;
  void goTo(std::shared_ptr<ScriptScene> next, const Dispatch& dispatch);
  void update(const Dispatch& dispatch);
 private:
  bool updating_ = false;
};
}
