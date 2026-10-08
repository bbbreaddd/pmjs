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

namespace pmjs::addon {

struct AsyncImageLoad;
struct Video;
struct State {
  State(const std::string& root, int initWidth, int initHeight,
        const std::string& assetRoot, const std::string& windowTitle,
        std::size_t imageWarmCacheBytes);
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
  std::int64_t reportedExternalBytes = 0;
  std::chrono::steady_clock::time_point preparationPresentedAt{};
  bool preparationFontsResolved = false;
  std::vector<std::filesystem::path> preparationFonts;
  pmjs::CanvasHandle preparationSurface = 0;
  std::unordered_map<std::uint32_t, std::unique_ptr<Video>> videos;
  std::unordered_map<std::string, AsyncImageLoad*> pendingImageLoads;
  std::uint64_t imageDecodeJobs = 0;
  std::uint64_t imageDecodeRequestsCoalesced = 0;
  std::uint32_t nextVideo = 1;
};

extern std::unique_ptr<State> state;

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
void registerRuntimeBindings(napi_env env, napi_value exports);
void registerPlatformBindings(napi_env env, napi_value exports);
void registerGraphicsBindings(napi_env env, napi_value exports);
void registerResourceBindings(napi_env env, napi_value exports);
void registerCanvasBindings(napi_env env, napi_value exports);
void registerDialogBindings(napi_env env, napi_value exports);
void registerMediaBindings(napi_env env, napi_value exports);
void registerEffectBindings(napi_env env, napi_value exports);

}  // namespace pmjs::addon
