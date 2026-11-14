#include "mv_script_scene.hpp"
#include <algorithm>
#include <stdexcept>

namespace pmjs::mv {
void ScriptScene::startFade(bool out, int duration, bool white) {
  if (!fadeSprite) { fadeSprite = std::make_shared<core::ScreenSprite>(); addChild(fadeSprite); }
  if (white) fadeSprite->setWhite(); else fadeSprite->setBlack();
  fadeSign = out ? -1 : 1;
  fadeDuration = std::max(1, duration);
  fadeSprite->setOpacity(out ? 0 : 255);
}
void ScriptScene::updateFade() {
  if (fadeDuration <= 0 || !fadeSprite) return;
  const double opacity = fadeSprite->opacity();
  fadeSprite->setOpacity(fadeSign > 0 ? opacity - opacity / fadeDuration : opacity + (255 - opacity) / fadeDuration);
  --fadeDuration;
}
void ScriptSceneManager::goTo(std::shared_ptr<ScriptScene> next, const Dispatch& dispatch) {
  nextScene = std::move(next); changing = true;
  if (scene) dispatch(scene, "stop");
}
void ScriptSceneManager::update(const Dispatch& dispatch) {
  if (updating_) throw std::runtime_error("scene update is already running");
  struct Guard { bool& flag; explicit Guard(bool& value) : flag(value) { flag = true; } ~Guard() { flag = false; } } guard(updating_);
  if (stopped) return;
  if (changing && (!scene || !dispatch(scene, "transitionBusy"))) {
    if (scene) { dispatch(scene, "terminate"); dispatch(scene, "detachReservation"); }
    scene = std::move(nextScene); changing = false; started = false;
    if (scene) { dispatch(scene, "attachReservation"); dispatch(scene, "create"); }
  }
  if (!scene) return;
  if (!started && dispatch(scene, "isReady")) { dispatch(scene, "start"); started = true; }
  if (started) dispatch(scene, "update");
}
}
