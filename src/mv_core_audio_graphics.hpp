#pragma once

#include "mv_core_types.hpp"
#include "resources.hpp"
#include <memory>
#include <optional>
#include <filesystem>
#include <cmath>
#include <limits>

#include <array>
#include <cstdint>
#include <functional>
#include <limits>
#include <string>
#include <vector>

namespace pmjs { class RuntimeCore; }
namespace pmjs::mv { class CacheEntry; }
namespace pmjs::mv::core {
void bindRuntime(RuntimeCore& runtime);
void unbindRuntime(RuntimeCore& runtime);
RuntimeCore* boundRuntime();
void updateServices();
struct BitmapBacking;
struct CoreServiceBinding;
class Container;

// rpg_core.js Bitmap with full RGBA pixel operations
class PixelBitmap {
 public:
  class PaintOpacity {
   public:
    operator double() const { return value_; }
    PaintOpacity& operator=(double value) {
      if (value_ != value) {
        value_ = value;
        contextCreated_ = true;
        const double alpha = value / 255.0;
        if (std::isfinite(alpha) && alpha >= 0 && alpha <= 1) alpha_ = alpha;
      }
      return *this;
    }
    double alpha() const { return alpha_; }
    void resetContext() { alpha_ = 1; contextCreated_ = true; }
    bool hasContext() const { return contextCreated_; }
    void markContext() const { contextCreated_ = true; }
   private:
    double value_ = 255;
    double alpha_ = 1;
    mutable bool contextCreated_ = false;
  };
  int width = 0;
  int height = 0;
  std::string url;
  bool smooth = false;
  mutable bool dirty = false;
  bool loaded = true;
  bool error = false;
  PaintOpacity paintOpacity;
  double fontSize = 28;
  std::string fontFace = "GameFont";
  bool fontItalic = false;
  std::string textColor = "#ffffff";
  std::string outlineColor = "rgba(0, 0, 0, 0.5)";
  double outlineWidth = 4;
  std::vector<std::uint8_t> pixels; // RGBA8888
  std::vector<std::function<void()>> loadListeners;
  std::shared_ptr<::pmjs::mv::CacheEntry> cacheEntry;

  PixelBitmap();
  PixelBitmap(int w, int h);
  PixelBitmap(RuntimeCore& runtime, int w, int h);
  PixelBitmap(const PixelBitmap& source);
  PixelBitmap& operator=(const PixelBitmap& source);
  PixelBitmap(PixelBitmap&& source) noexcept;
  PixelBitmap& operator=(PixelBitmap&& source) noexcept;
  ~PixelBitmap() = default;
  static std::shared_ptr<PixelBitmap> load(const std::string& source);
  static std::shared_ptr<PixelBitmap> request(const std::string& source);
  static std::shared_ptr<PixelBitmap> snap(const std::function<void()>& draw = {});
  static void setImageLoader(std::function<std::optional<ImageInfo>(const std::string&)> loader);
  void startRequest();
  void decode();
  bool isRequestReady() const;
  bool isRequestOnly() const;
  std::string loadingState = "none";
  std::uint64_t touchedAt = 0;
  std::uint32_t nativeCanvas() const;
  int canvasWidth() const { nativeCanvas(); return canvasWidth_; }
  int canvasHeight() const { nativeCanvas(); return canvasHeight_; }
  std::optional<ImageInfo> texture() const;
  void syncPixels();
  void commitPixels();
  void drawText(const std::string& text, double x, double y, double maxWidth, double lineHeight, const std::string& align = "left");
  double measureTextWidth(const std::string& text) const;
  void loadUrl(const std::string& source);

  void resize(int w, int h);
  bool isReady() const;
  bool isError() const { return error; }
  void touch();
  void checkDirty();
  void addLoadListener(std::function<void()> listener);
  void callLoadListeners();

  void clearRect(double x, double y, double w, double h);
  void clear();
  void fillRect(double x, double y, double w, double h, const std::string& color);
  void fillAll(const std::string& color);
  void gradientFillRect(double x, double y, double w, double h, const std::string& color1, const std::string& color2, bool vertical = false);
  void drawCircle(double x, double y, double radius, const std::string& color);
  Rectangle rect() const { return {0,0,double(width),double(height)}; }
  void bltImage(const PixelBitmap& source, double sx, double sy, double sw, double sh, double dx, double dy, double dw = std::numeric_limits<double>::quiet_NaN(), double dh = std::numeric_limits<double>::quiet_NaN());
  void blt(const PixelBitmap& source, double sx, double sy, double sw, double sh, double dx, double dy, double dw = std::numeric_limits<double>::quiet_NaN(), double dh = std::numeric_limits<double>::quiet_NaN());

  std::string getPixel(int x, int y) const;
  std::uint8_t getAlphaPixel(int x, int y) const;

  void adjustTone(double r, double g, double b);
  void rotateHue(double offset);
  void blur();
  std::string makeFontNameText() const;

  static std::array<std::uint8_t, 4> parseCssColor(const std::string& color);
 private:
  mutable std::shared_ptr<BitmapBacking> backing_;
  mutable int canvasWidth_ = 0, canvasHeight_ = 0;
  std::shared_ptr<BitmapBacking> requestedImage_, originalImage_;
  std::function<void()> failure_;
  bool decodeAfterRequest_ = false;
  struct LoadOwner { PixelBitmap* bitmap; };
  std::shared_ptr<LoadOwner> lifetime_ = std::make_shared<LoadOwner>(LoadOwner{this});
  static PixelBitmap* loadTarget(const std::weak_ptr<LoadOwner>& owner);
  void enableDecode();
  void changed();
  void loadNow();
};

using Bitmap = PixelBitmap;

// rpg_core.js Graphics
class Graphics {
 public:
  static inline int width = 816;
  static inline int height = 624;
  static inline int boxWidth = 816;
  static inline int boxHeight = 624;
  static inline double scale = 1.0, realScale = 1.0;
  static inline bool stretchEnabled = true;
  static inline int fpsMode = 0;
  static void updateScale();
  static void onKeyDown(int keyCode, bool control = false, bool alt = false);
  static bool onPointerDown(double x, double y);
  static inline std::uint64_t frameCount = 0;
  static inline int skipCount = 0, maxSkip = 3;
  static inline bool rendered = false;
  static inline bool webgl = true;
  static inline bool fpsVisible = false;
  static inline bool loading = false;
  static inline int loadingCount = 0;
  static inline bool videoPlaying = false;
  static inline double videoVolume = 1.0;
  static inline std::string loadingImage;
  static inline std::vector<std::string> loadedFonts;
  static inline std::string errorName, errorMessage, loadingError;
  static inline double fps = 0, frameTime = 0;
  static void resize(int w, int h);
  static void presentOverlay();
  static std::vector<std::filesystem::path> fonts(const std::string& family);
  static void setVideoCallbacks(std::function<void(const std::string&)> play, std::function<bool()> playing, std::function<void(double)> volume);
  static void setLoadingCallbacks(std::function<void()> stop, std::function<void()> resume);

  static bool initialize(int w = 800, int h = 600, const std::string& type = "auto");
  static void tickStart();
  static void tickEnd();
  static bool render(const std::function<void()>& stage = {}, const std::function<void()>& drawFrame = {});
  static bool render(Container& stage);
  static bool isWebGL() { return webgl && boundRuntime(); }
  static bool canUseCssFontLoading() { return false; }
  static std::string canPlayVideoType(const std::string& type);
  static bool hasWebGL() { return boundRuntime() != nullptr; }
  static bool canUseDifferenceBlend() { return boundRuntime() != nullptr; }
  static bool canUseSaturationBlend() { return boundRuntime() != nullptr; }
  static void setLoadingImage(const std::string& src);
  static void startLoading();
  static void updateLoading();
  static void endLoading();
  static void printLoadingError(const std::string& url);
  static void eraseLoadingError();
  static void printError(const std::string& name, const std::string& message);
  static void showFps() { fpsVisible = true; fpsMode = 1; }
  static void hideFps() { fpsVisible = false; fpsMode = 0; }
  static void loadFont(const std::string& name, const std::string& url);
  static bool isFontLoaded(const std::string& name);
  static void playVideo(const std::string& src);
  static bool isVideoPlaying();
  static void setVideoVolume(double value);
  static double pageToCanvasX(double x, double canvasLeft = std::numeric_limits<double>::quiet_NaN());
  static double pageToCanvasY(double y, double canvasTop = std::numeric_limits<double>::quiet_NaN());
  static bool isInsideCanvas(double x, double y);
  static void callGC();
};

// rpg_core.js WebAudio
class WebAudio {
 public:
  std::string url;
  double volume = 1.0;
  double pitch = 1.0;
  double pan = 0.0;
  bool loop = false;
  double loopStart = 0.0;
  double loopLength = 0.0;
  int sampleRate = 0;
  double totalTime = 0;
  bool ready = false;
  bool error = false;
  bool playing = false;
  double startTime = 0.0;
  double pauseTime = 0.0;
  std::vector<std::function<void()>> loadListeners;
  std::vector<std::function<void()>> stopListeners;

  static inline double masterVolume = 1.0;
  static inline bool initialized = false;
  static inline bool standAlone = false;
  static inline bool canPlayOggFlag = true;
  static inline bool canPlayM4aFlag = true;

  explicit WebAudio(std::string audioUrl = "", bool deferLoad = true, bool reportResourceErrors = true);
  ~WebAudio();
  WebAudio(const WebAudio&) = delete;
  WebAudio& operator=(const WebAudio&) = delete;
  void update();
  std::uint32_t nativeHandle() const { return handle_; }
  double playbackPosition() const;
  void setVolume(double value);
  void setPitch(double value);
  void setPan(double value);
  static bool initialize(bool noAudio = false);
  static bool canPlayOgg() { return canPlayOggFlag; }
  static bool canPlayM4a() { return canPlayM4aFlag; }
  static void setMasterVolume(double value);
  static void setEncryptionKey(const std::string& hexadecimal);

  void clear();
  bool isReady() const;
  bool isError() const { return error; }
  bool isPlaying() const;
  void play(bool loopFlag, double offset = 0.0);
  void stop();
  void fadeIn(double duration);
  void fadeOut(double duration);
  double seek() const;
  void addLoadListener(std::function<void()> listener);
  void addStopListener(std::function<void()> listener);

  void readLoopComments(const std::vector<std::uint8_t>& data);
  void readOgg(const std::vector<std::uint8_t>& data);
  void readMp4(const std::vector<std::uint8_t>& data);
  void readMetaData(const std::vector<std::uint8_t>& data, std::size_t index, std::size_t size);
  static std::uint32_t readLittleEndian(const std::vector<std::uint8_t>& data, std::size_t index);
  static std::uint32_t readBigEndian(const std::vector<std::uint8_t>& data, std::size_t index);
  static std::string readFourCharacters(const std::vector<std::uint8_t>& data, std::size_t index);
 private:
  std::shared_ptr<CoreServiceBinding> services_;
  std::uint32_t handle_ = 0;
  bool autoPlay_ = false, loading_ = false, useResourceHandler_ = true;
  std::function<void()> failure_;
  std::shared_ptr<int> lifetime_ = std::make_shared<int>(0);
  void failLoad();
  void loadNow();
  void release();
  friend void unbindRuntime(RuntimeCore& runtime);
};

// rpg_core.js Html5Audio
class Html5Audio {
 public:
  static inline std::string url;
  static inline std::string staticSeUrl;
  static inline double volume = 1.0;
  static inline bool initialized = false;
  static inline bool ready = false;
  static inline bool error = false;
  static inline bool playing = false;
  static inline bool loop = false;
  static inline double currentTime = 0.0;

  static void setup(const std::string& audioUrl);
  static bool initialize();
  static void clear();
  static void setStaticSe(const std::string& audioUrl);
  static bool isReady();
  static bool isError();
  static bool isPlaying();
  static void play(bool loopFlag, double offset = 0.0);
  static void stop();
  static void fadeIn(double duration);
  static void fadeOut(double duration);
  static double seek();
  static void addLoadListener(std::function<void()> listener);
};

class Window;
class Sprite;
using CoreWindow = Window;
using CoreSprite = Sprite;

// rpg_core.js Tilemap core state
class Tilemap;
using CoreTilemap = Tilemap;

}  // namespace pmjs::mv::core

