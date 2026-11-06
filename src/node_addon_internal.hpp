#pragma once

#include "runtime_core.hpp"
#include "scene_packet.hpp"

#include <node_api.h>

#include <algorithm>
#include <array>
#include <chrono>
#include <cstdint>
#include <cstdlib>
#include <cstring>
#include <filesystem>
#include <iostream>
#include <memory>
#include <mutex>
#include <optional>
#include <stdexcept>
#include <string>
#include <unordered_map>
#include <vector>
#include <utility>

namespace pmjs::addon {

void trimPreparationMemory() noexcept;

struct AsyncImageLoad;
struct Video;
struct AudioView {
  std::string source;
  AudioEncryptionKey key;
};
struct State {
  State(const std::string& root, int initWidth, int initHeight,
        const std::string& assetRoot, const std::string& windowTitle,
        std::size_t imageWarmCacheBytes, const std::string& programCacheRoot);
  ~State();

  pmjs::RuntimeCore core;
  int width;
  int height;
  pmjs::Platform& platform;
  pmjs::ImageStore& images;
  pmjs::CanvasStore& canvases;
  pmjs::Renderer& renderer;
  pmjs::Vfs& vfs;
  std::unique_ptr<pmjs::Vfs> assets;
  std::unordered_map<std::string, AudioView> audioViews;
  std::int64_t reportedExternalBytes = 0;
  double frameUploadMs = 0;
  double frameDrawMs = 0;
  double frameMemoryMs = 0;
  std::chrono::steady_clock::time_point preparationPresentedAt{};
  bool preparationFontsResolved = false;
  std::vector<std::filesystem::path> preparationFonts;
  pmjs::CanvasHandle preparationSurface = 0;
  pmjs::CanvasHandle settingsSurface = 0;
  std::unordered_map<std::uint32_t, std::unique_ptr<Video>> videos;
  std::unordered_map<std::string, AsyncImageLoad*> pendingImageLoads;
  std::uint64_t imageDecodeJobs = 0;
  std::uint64_t imageDecodeRequestsCoalesced = 0;
  std::uint32_t nextVideo = 1;
};

extern std::shared_ptr<State> state;

napi_value throwTypeError(napi_env env, const char* message);
napi_value throwRangeError(napi_env env, const char* message);
napi_value throwError(napi_env env, const char* message);
napi_value throwException(napi_env env, const std::exception& error);
void check(napi_env env, napi_status status, const char* message);
napi_value undefined(napi_env env);
napi_value null(napi_env env);
napi_value boolean(napi_env env, bool input);
napi_value number(napi_env env, double input);
napi_value uint32(napi_env env, std::uint32_t input);
napi_value string(napi_env env, const std::string& input);
std::vector<napi_value> arguments(napi_env env, napi_callback_info info,
                                  std::size_t limit = 20);
double asNumber(napi_env env, napi_value value);
std::int32_t asInt32(napi_env env, napi_value value);
std::uint32_t asUint32(napi_env env, napi_value value);
bool asBoolean(napi_env env, napi_value value);
pmjs::BlendMode asBlendMode(napi_env env, napi_value value);
std::string asString(napi_env env, napi_value value);
napi_value property(napi_env env, napi_value object, const char* name);
bool hasProperty(napi_env env, napi_value object, const char* name);
State& host(napi_env env);
void syncExternalMemory(napi_env env);
napi_value imageInfo(napi_env env, std::uint32_t handle, int width, int height);
std::optional<pmjs::ImageHandle> resolveImage(State& value, std::uint32_t handle);
napi_value rendererStats(napi_env env, napi_callback_info info);

template <std::size_t Size>
std::array<float, Size> floatArray(napi_env env,
                                   const std::vector<napi_value>& args,
                                   std::size_t offset) {
  if (args.size() < offset + Size) throw std::runtime_error("missing arguments");
  std::array<float, Size> result{};
  for (std::size_t index = 0; index < Size; ++index) {
    result[index] = static_cast<float>(asNumber(env, args[offset + index]));
  }
  return result;
}

void method(napi_env env, napi_value object, const char* name, napi_callback callback);
napi_value moduleObject(napi_env env);
struct PreparationInstallReport {
  std::vector<std::string> accepted;
  std::vector<std::pair<std::string, std::string>> rejected;
  void reject(napi_env env, const std::string& id, const std::string& reason) {
    bool pending = false;
    if (napi_is_exception_pending(env, &pending) == napi_ok && pending) {
      napi_value exception;
      napi_get_and_clear_last_exception(env, &exception);
    }
    rejected.emplace_back(id, reason);
  }
  napi_value result(napi_env env) const {
    auto output = moduleObject(env);
    napi_value good, bad;
    check(env, napi_create_array_with_length(env, accepted.size(), &good), "cannot create accepted preparation list");
    check(env, napi_create_array_with_length(env, rejected.size(), &bad), "cannot create rejected preparation list");
    for (std::size_t i = 0; i < accepted.size(); ++i)
      check(env, napi_set_element(env, good, i, string(env, accepted[i])), "cannot set accepted preparation");
    for (std::size_t i = 0; i < rejected.size(); ++i) {
      auto item = moduleObject(env);
      check(env, napi_set_named_property(env, item, "id", string(env, rejected[i].first)), "cannot set preparation id");
      check(env, napi_set_named_property(env, item, "reason", string(env, rejected[i].second)), "cannot set preparation reason");
      check(env, napi_set_element(env, bad, i, item), "cannot set rejected preparation");
    }
    check(env, napi_set_named_property(env, output, "accepted", good), "cannot set accepted preparation list");
    check(env, napi_set_named_property(env, output, "rejected", bad), "cannot set rejected preparation list");
    return output;
  }
};

void registerRuntimeBindings(napi_env env, napi_value exports);
void registerPlatformBindings(napi_env env, napi_value exports);
void registerGraphicsBindings(napi_env env, napi_value exports);
void registerResourceBindings(napi_env env, napi_value exports);
void registerCanvasBindings(napi_env env, napi_value exports);
void registerDialogBindings(napi_env env, napi_value exports);
void registerMediaBindings(napi_env env, napi_value exports);
void registerEffectBindings(napi_env env, napi_value exports);

}  // namespace pmjs::addon
