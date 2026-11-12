#pragma once
#include "mv_engine.hpp"
#include "runtime_core.hpp"
#include <functional>

namespace pmjs::mv {
class Presentation {
 public:
  Presentation(RuntimeCore& core, Session& session, Value settings);
  ~Presentation();
  void render();
  void captureAudioState();
 private:
  ImageInfo image(const std::string& file, int hue = 0);
  void quad(ImageHandle handle, float sx, float sy, float sw, float sh, float x, float y, float width, float height, float alpha = 1);
  void tile(int id, int x, int y);
  void character(const Character& value, double cameraX, double cameraY);
  void map();
  void tiledMap(const Value& data);
  void mapPictures();
  void mapAmbience();
  void window(int x, int y, int width, int height, int selected = -1, int rows = 0, int openness = 255);
  void text(const std::string& value, int x, int y, int width = 0, int color = 0, int size = 28, bool right = false, float opacity = 1);
  void face(int actorId, int x, int y);
  void gauge(const Battler& actor, int stat, int x, int y, int width);
  void actorStatus(int actorId, int x, int y, int width, bool portrait);
  void message();
  void menu();
  enum class BattleWindow { commands, status, log, selection };
  struct RetainedContents {
    CanvasHandle canvas = 0;
    std::vector<std::string> key;
    bool valid = false, visible = false;
  };
  void retainBattleContents(BattleWindow part, std::vector<std::string> key, const std::function<void()>& draw);
  void clearBattleContents();
  void battle();
  void battleEffects();
  void processAudio();
  Value audioState(const std::string& kind);
  RuntimeCore& core_;
  Session& session_;
  Value settings_;
  CanvasHandle textCanvas_ = 0;
  std::array<RetainedContents, 4> battleContents_;
  std::map<std::string, ImageInfo> images_;
  std::map<std::pair<int, int>, std::pair<CanvasHandle, CanvasHandle>> windows_;
  std::vector<std::filesystem::path> fonts_;
  std::array<std::uint32_t, 32> colors_{};
  std::map<std::string, std::pair<std::string, std::uint32_t>> audio_;
  std::map<std::string, Value> audioSettings_;
  std::uint32_t musicEffect_ = 0;
  int lastScene_ = -1, lastMap_ = -1;
  std::vector<std::uint32_t> sounds_;
  double cameraX_ = 0, cameraY_ = 0;
  double sceneTickOrigin_ = 0;
};
}
