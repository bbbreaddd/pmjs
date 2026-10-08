#include "node_addon_internal.hpp"

#include <SDL.h>

#include <algorithm>
#include <cmath>
#include <cctype>
#include <limits>

namespace pmjs::addon {
napi_value initialize(napi_env env, napi_callback_info info) try {
  auto args = arguments(env, info, 1);
  if (args.size() != 1) throw std::runtime_error("initialize requires one options object");
  napi_valuetype type;
  check(env, napi_typeof(env, args[0], &type), "cannot inspect initialization options");
  if (type != napi_object) throw std::runtime_error("initialize options must be an object");
  const auto options = args[0];
  for (const char* name : {"gameRoot", "width", "height", "windowTitle"}) {
    if (!hasProperty(env, options, name)) {
      throw std::runtime_error(std::string("initialize missing option: ") + name);
    }
  }
  const auto width = asInt32(env, property(env, options, "width"));
  const auto height = asInt32(env, property(env, options, "height"));
  if (width <= 0 || height <= 0 || width > 16384 || height > 16384) {
    throw std::runtime_error("invalid logical dimensions");
  }
  const auto assetRoot = hasProperty(env, options, "assetRoot")
    ? asString(env, property(env, options, "assetRoot")) : std::string();
  std::size_t imageWarmCacheBytes = pmjs::ImageStore::defaultWarmBudgetBytes;
  if (hasProperty(env, options, "imageWarmCacheBytes")) {
    constexpr double maxSafeInteger = 9007199254740991.0;
    const double maxCacheBytes = std::min(maxSafeInteger,
      static_cast<double>(std::numeric_limits<std::size_t>::max()));
    const double configured = asNumber(env, property(env, options,
      "imageWarmCacheBytes"));
    if (!std::isfinite(configured) || configured < 0 ||
        std::floor(configured) != configured ||
        configured > maxCacheBytes) {
      throw std::runtime_error(
        "imageWarmCacheBytes must be a non-negative safe integer");
    }
    imageWarmCacheBytes = static_cast<std::size_t>(configured);
  }
  const auto title = asString(env, property(env, options, "windowTitle"));
  if (title.empty()) throw std::runtime_error("windowTitle must not be empty");
  state = std::make_unique<State>(
    asString(env, property(env, options, "gameRoot")), width, height,
    assetRoot, title, imageWarmCacheBytes);
  return undefined(env);
} catch (const std::exception& error) {
  napi_throw_error(env, nullptr, error.what());
  return nullptr;
}

napi_value pollEvents(napi_env env, napi_callback_info) try {
  return boolean(env, host(env).core.pollEvents());
} catch (const std::exception& error) {
  napi_throw_error(env, nullptr, error.what());
  return nullptr;
} catch (...) {
  napi_throw_error(env, nullptr, "pollEvents failed");
  return nullptr;
}

napi_value finishLogicStep(napi_env env, napi_callback_info) try {
  host(env).platform.finishLogicStep();
  return undefined(env);
} catch (const std::exception& error) {
  napi_throw_error(env, nullptr, error.what());
  return nullptr;
} catch (...) {
  napi_throw_error(env, nullptr, "finishLogicStep failed");
  return nullptr;
}

napi_value monotonicNow(napi_env env, napi_callback_info) try {
  const auto now = std::chrono::steady_clock::now().time_since_epoch();
  return number(env, std::chrono::duration<double, std::milli>(now).count());
} catch (const std::exception& error) {
  napi_throw_error(env, nullptr, error.what());
  return nullptr;
} catch (...) {
  napi_throw_error(env, nullptr, "monotonicNow failed");
  return nullptr;
}

napi_value windowState(napi_env env, napi_callback_info) try {
  const auto& platform = host(env).platform;
  napi_value result;
  check(env, napi_create_object(env, &result), "cannot create window state");
  check(env, napi_set_named_property(env, result, "focused",
    boolean(env, platform.windowFocused())), "cannot set window focus state");
  check(env, napi_set_named_property(env, result, "visible",
    boolean(env, platform.windowVisible())), "cannot set window visibility state");
  napi_set_named_property(env, result, "width", number(env, platform.windowWidth()));
  napi_set_named_property(env, result, "height", number(env, platform.windowHeight()));
  return result;
} catch (const std::exception& error) {
  napi_throw_error(env, nullptr, error.what());
  return nullptr;
} catch (...) {
  napi_throw_error(env, nullptr, "windowState failed");
  return nullptr;
}

napi_value beginFrame(napi_env env, napi_callback_info) try {
  host(env).renderer.beginFrame();
  return undefined(env);
} catch (const std::exception& error) {
  napi_throw_error(env, nullptr, error.what());
  return nullptr;
} catch (...) {
  napi_throw_error(env, nullptr, "beginFrame failed");
  return nullptr;
}

namespace {
std::string fitProgressLine(pmjs::CanvasStore& canvases,
                           const std::vector<std::filesystem::path>& fonts,
                           const std::string& text, float size, float width) {
  auto measured = canvases.measureText(fonts, text, size);
  if (!measured || *measured <= width) return text;
  // Remove whole UTF-8 codepoints from the middle, retaining the filename suffix.
  std::vector<std::size_t> boundaries{0};
  for (std::size_t i = 1; i <= text.size(); ++i) {
    if (i == text.size() || (static_cast<unsigned char>(text[i]) & 0xC0U) != 0x80U)
      boundaries.push_back(i);
  }
  std::size_t low = 0, high = boundaries.size() - 1;
  std::string fitted;
  while (low <= high) {
    const auto count = (low + high) / 2;
    const auto left = (count + 1) / 2;
    const auto right = count / 2;
    const auto candidate = text.substr(0, boundaries[left]) + "..." +
      text.substr(boundaries[boundaries.size() - 1 - right]);
    const auto extent = canvases.measureText(fonts, candidate, size);
    if (extent && *extent <= width) { fitted = candidate; low = count + 1; }
    else { if (count == 0) break; high = count - 1; }
  }
  return fitted;
}

void resolvePreparationFonts(napi_env env, napi_value progress, State& value) {
  if (value.preparationFontsResolved) return;
  value.preparationFontsResolved = true;
  std::vector<std::string> candidates;
  if (hasProperty(env, progress, "fonts")) {
    const auto fonts = property(env, progress, "fonts");
    bool array = false;
    check(env, napi_is_array(env, fonts, &array), "invalid preparation fonts");
    if (!array) throw std::invalid_argument("preparation fonts must be an array");
    std::uint32_t count = 0;
    check(env, napi_get_array_length(env, fonts, &count), "invalid preparation fonts");
    for (std::uint32_t i = 0; i < std::min(count, 32U); ++i) {
      napi_value entry;
      check(env, napi_get_element(env, fonts, i, &entry), "invalid preparation font");
      candidates.push_back(asString(env, entry));
    }
  }
  if (auto files = value.vfs.readDirectory("fonts")) {
    for (const auto& file : *files) {
      std::string extension = std::filesystem::path(file).extension().string();
      std::transform(extension.begin(), extension.end(), extension.begin(),
        [](unsigned char c) { return static_cast<char>(std::tolower(c)); });
      if (extension == ".ttf" || extension == ".otf") candidates.push_back("fonts/" + file);
    }
  }
  for (const auto& candidate : candidates) {
    const auto font = value.vfs.resolve(candidate);
    if (font && std::find(value.preparationFonts.begin(), value.preparationFonts.end(), *font) == value.preparationFonts.end() &&
        value.canvases.canLoadFont(*font)) value.preparationFonts.push_back(*font);
    if (value.preparationFonts.size() >= 8) break;
  }
}
}  // namespace

napi_value preparationProgress(napi_env env, napi_callback_info info) try {
  const auto args = arguments(env, info, 1);
  if (args.empty()) throw std::invalid_argument("preparationProgress requires progress");
  const auto progress = args[0];
  const double completed = asNumber(env, property(env, progress, "completed"));
  const double total = asNumber(env, property(env, progress, "total"));
  if (!std::isfinite(completed) || !std::isfinite(total) || completed < 0 || total < 0)
    throw std::invalid_argument("invalid preparation progress");
  const bool terminal = hasProperty(env, progress, "terminal") ?
    asBoolean(env, property(env, progress, "terminal")) :
    (!hasProperty(env, progress, "phase") && completed >= total);
  auto& value = host(env);
  const auto now = std::chrono::steady_clock::now();
  if (!terminal && now - value.preparationPresentedAt < std::chrono::milliseconds(100))
    return undefined(env);
  value.preparationPresentedAt = now;
  const float width = static_cast<float>(value.width);
  const float height = static_cast<float>(value.height);
  const float amount = total > 0 ? static_cast<float>(std::clamp(completed / total, 0.0, 1.0)) : 0;
  value.renderer.beginFrame();
  value.renderer.queueQuad(0, 0, width, height, {0.04F, 0.04F, 0.05F, 1});
  value.renderer.queueQuad(width * 0.08F, height * 0.45F, width * 0.84F, height * 0.025F,
                           {0.2F, 0.2F, 0.22F, 1});
  value.renderer.queueQuad(width * 0.08F, height * 0.45F, width * 0.84F * amount, height * 0.025F,
                           {0.8F, 0.8F, 0.85F, 1});
  if (hasProperty(env, progress, "lines")) {
    resolvePreparationFonts(env, progress, value);
    if (!value.preparationFonts.empty()) {
      if (!value.preparationSurface) {
        const auto surface = value.canvases.create(value.width, value.height);
        if (!surface) throw std::runtime_error("cannot allocate preparation screen");
        value.preparationSurface = surface->handle;
      }
      value.canvases.clear(value.preparationSurface);
      const auto lines = property(env, progress, "lines");
      bool array = false;
      check(env, napi_is_array(env, lines, &array), "invalid preparation lines");
      if (!array) throw std::invalid_argument("preparation lines must be an array");
      std::uint32_t count = 0;
      check(env, napi_get_array_length(env, lines, &count), "invalid preparation lines");
      const std::array<float, 6> positions{0.22F, 0.31F, 0.38F, 0.56F, 0.64F, 0.72F};
      for (std::uint32_t i = 0; i < std::min(count, 6U); ++i) {
        napi_value entry;
        check(env, napi_get_element(env, lines, i, &entry), "invalid preparation line");
        const float size = std::clamp(height * (i == 0 ? 0.05F : 0.037F), 8.0F, i == 0 ? 32.0F : 24.0F);
        const auto text = fitProgressLine(value.canvases, value.preparationFonts,
          asString(env, entry), size, width * 0.84F);
        value.canvases.drawText(value.preparationSurface, value.preparationFonts,
          text, width * 0.08F, height * positions[i], size,
          i == 0 ? 0xFFFFFFFFU : 0xCACAD4FFU);
      }
      if (const auto image = value.canvases.prepareImage(value.preparationSurface)) {
        value.renderer.queueImage(*image, {1, 0, 0, 1, 0, 0}, {0, 0, width, height},
                                  1, 0xFFFFFFU, pmjs::BlendMode::normal);
      }
    }
  }
  value.core.syncDrawableSize();
  value.renderer.render();
  value.platform.swap();
  if (terminal && value.preparationSurface) {
    value.canvases.release(value.preparationSurface);
    value.preparationSurface = 0;
  }
  return undefined(env);
} catch (const std::exception& error) {
  napi_throw_error(env, nullptr, error.what());
  return nullptr;
}

napi_value renderFrame(napi_env env, napi_callback_info) try {
  State& value = host(env);
  value.canvases.uploadDirty();
  value.core.syncDrawableSize();
  value.renderer.render();
  syncExternalMemory(env);
  return undefined(env);
} catch (const std::exception& error) {
  napi_throw_error(env, nullptr, error.what());
  return nullptr;
} catch (...) {
  napi_throw_error(env, nullptr, "renderFrame failed");
  return nullptr;
}

// Scene-only; never touches the window framebuffer.
napi_value renderScene(napi_env env, napi_callback_info) try {
  State& value = host(env);
  value.canvases.uploadDirty();
  value.renderer.renderScene();
  syncExternalMemory(env);
  return undefined(env);
} catch (const std::exception& error) {
  napi_throw_error(env, nullptr, error.what());
  return nullptr;
} catch (...) {
  napi_throw_error(env, nullptr, "renderScene failed");
  return nullptr;
}

napi_value swapFrame(napi_env env, napi_callback_info) try {
  State& value = host(env);
  auto& timing = value.renderer.presentationTimings();
  PresentationPhaseTimer timer(timing.enabled, timing.phases[5]);
  value.platform.swap();
  return undefined(env);
} catch (const std::exception& error) {
  napi_throw_error(env, nullptr, error.what());
  return nullptr;
} catch (...) {
  napi_throw_error(env, nullptr, "swapFrame failed");
  return nullptr;
}

napi_value rendererStats(napi_env env, napi_callback_info) try {
  const auto& stats = host(env).renderer.stats();
  napi_value result;
  check(env, napi_create_object(env, &result), "cannot create renderer stats");
  check(env, napi_set_named_property(env, result, "diagnostics",
    boolean(env, host(env).renderer.diagnosticsEnabled())), "cannot set renderer diagnostics state");
  check(env, napi_set_named_property(env, result, "frames",
    number(env, static_cast<double>(stats.frames))), "cannot set renderer frames");
  check(env, napi_set_named_property(env, result, "retainedFrames",
    number(env, static_cast<double>(stats.retainedFrames))), "cannot set renderer retained frames");
  check(env, napi_set_named_property(env, result, "commands",
    number(env, static_cast<double>(stats.commands))), "cannot set renderer commands");
  check(env, napi_set_named_property(env, result, "drawCalls",
    number(env, static_cast<double>(stats.drawCalls))), "cannot set renderer draws");
  check(env, napi_set_named_property(env, result, "bufferUploads",
    number(env, static_cast<double>(stats.bufferUploads))), "cannot set renderer uploads");
  check(env, napi_set_named_property(env, result, "baseSpriteDrawCalls",
    number(env, static_cast<double>(stats.baseSpriteDrawCalls))),
    "cannot set renderer base sprite draws");
  check(env, napi_set_named_property(env, result, "effectSpriteDrawCalls",
    number(env, static_cast<double>(stats.effectSpriteDrawCalls))),
    "cannot set renderer effect sprite draws");
  check(env, napi_set_named_property(env, result, "tileDrawCalls",
    number(env, static_cast<double>(stats.tileDrawCalls))),
    "cannot set renderer tile draws");
  check(env, napi_set_named_property(env, result, "nearestTileShaderDrawCalls",
    number(env, static_cast<double>(stats.nearestTileShaderDrawCalls))),
    "cannot set nearest tile shader draws");
  check(env, napi_set_named_property(env, result, "nearestTileShaderFallbackDrawCalls",
    number(env, static_cast<double>(stats.nearestTileShaderFallbackDrawCalls))),
    "cannot set nearest tile shader fallback draws");
  check(env, napi_set_named_property(env, result, "filterDrawCalls",
    number(env, static_cast<double>(stats.filterDrawCalls))),
    "cannot set renderer filter draws");
  const auto& timing = host(env).renderer.presentationTimings();
  napi_value phases;
  check(env, napi_create_object(env, &phases), "cannot create presentation timings");
  check(env, napi_set_named_property(env, phases, "enabled", boolean(env, timing.enabled)), "cannot set timing state");
  check(env, napi_set_named_property(env, phases, "finishBeforeSwap", boolean(env, timing.finishBeforeSwap)), "cannot set completion state");
  constexpr std::array<const char*, 6> phaseNames{"scene", "presentation", "windowBind", "firstWindowWrite", "completion", "swap"};
  for (std::size_t index = 0; index < phaseNames.size(); ++index) {
    napi_value phase;
    check(env, napi_create_object(env, &phase), "cannot create phase timing");
    const auto& sample = timing.phases[index];
    for (const auto& [name, value] : {std::pair{"calls", static_cast<double>(sample.calls)},
        std::pair{"wallMs", sample.wallMs}, std::pair{"cpuMs", sample.cpuMs}})
      check(env, napi_set_named_property(env, phase, name, number(env, value)), "cannot set phase timing");
    check(env, napi_set_named_property(env, phases, phaseNames[index], phase), "cannot set presentation phase");
  }
  check(env, napi_set_named_property(env, result, "presentationTimings", phases), "cannot set presentation timings");
  napi_value filterApplications;
  check(env, napi_create_array_with_length(env, stats.filterApplications.size(),
    &filterApplications), "cannot create filter application stats");
  for (std::size_t index = 0; index < stats.filterApplications.size(); ++index) {
    check(env, napi_set_element(env, filterApplications,
      static_cast<std::uint32_t>(index),
      number(env, static_cast<double>(stats.filterApplications[index]))),
      "cannot set filter application stat");
  }
  check(env, napi_set_named_property(env, result, "filterApplications",
    filterApplications), "cannot set filter application stats");
  check(env, napi_set_named_property(env, result, "filterTargetAcquires",
    number(env, static_cast<double>(stats.filterTargetAcquires))),
    "cannot set filter target acquisitions");
  check(env, napi_set_named_property(env, result, "filterTargetReuses",
    number(env, static_cast<double>(stats.filterTargetReuses))),
    "cannot set filter target reuses");
  check(env, napi_set_named_property(env, result, "rendererTargetCreates",
    number(env, static_cast<double>(stats.rendererTargetCreates))),
    "cannot set renderer target creates");
  check(env, napi_set_named_property(env, result, "rendererTargetDestroys",
    number(env, static_cast<double>(stats.rendererTargetDestroys))),
    "cannot set renderer target destroys");
  for (const auto& [name, value] : {
      std::pair{"rendererTargetBytes", stats.rendererTargetBytes},
      std::pair{"rendererTargetPeakBytes", stats.rendererTargetPeakBytes},
      std::pair{"rendererTargetCacheBytes", stats.rendererTargetCacheBytes},
      std::pair{"rendererTargetCacheHits", stats.rendererTargetCacheHits},
      std::pair{"rendererTargetCacheEvictions", stats.rendererTargetCacheEvictions}}) {
    check(env, napi_set_named_property(env, result, name, number(env, static_cast<double>(value))),
      "cannot set renderer target memory/cache stats");
  }
  napi_set_named_property(env, result, "tileGeometryGpuBytes", number(env, host(env).renderer.tileGeometryGpuBytes()));
  napi_set_named_property(env, result, "tileGeometryCpuBytes", number(env, host(env).renderer.tileGeometryCpuBytes()));
  check(env, napi_set_named_property(env, result, "filterTargetClears",
    number(env, static_cast<double>(stats.filterTargetClears))),
    "cannot set filter target clears");
  check(env, napi_set_named_property(env, result, "filterBoundedApplications",
    number(env, static_cast<double>(stats.filterBoundedApplications))),
    "cannot set bounded filter applications");
  check(env, napi_set_named_property(env, result, "pixiFragmentPrecision",
    string(env, host(env).renderer.pixiFragmentPrecision())),
    "cannot set Pixi fragment precision");
  check(env, napi_set_named_property(env, result, "framebufferChecks",
    number(env, static_cast<double>(stats.framebufferChecks))),
    "cannot set framebuffer checks");
  check(env, napi_set_named_property(env, result, "framebufferCopies",
    number(env, static_cast<double>(stats.framebufferCopies))),
    "cannot set framebuffer copies");
  check(env, napi_set_named_property(env, result, "toneAdjustDrawCalls",
    number(env, static_cast<double>(stats.toneAdjustDrawCalls))),
    "cannot set tone adjust draws");
  check(env, napi_set_named_property(env, result, "toneComposedPresentationFrames",
    number(env, static_cast<double>(stats.toneComposedPresentationFrames))),
    "cannot set tone composed presentation frames");
  check(env, napi_set_named_property(env, result, "scaledPresentationFrames",
    number(env, static_cast<double>(stats.scaledPresentationFrames))),
    "cannot set scaled presentation frames");
  check(env, napi_set_named_property(env, result, "presentationLetterboxedFrames",
    number(env, static_cast<double>(stats.presentationLetterboxedFrames))),
    "cannot set letterboxed presentation frames");
  check(env, napi_set_named_property(env, result, "spriteDrawCalls",
    number(env, static_cast<double>(stats.spriteDrawCalls))),
    "cannot set renderer sprite draws");
  check(env, napi_set_named_property(env, result, "tilingSpriteDrawCalls",
    number(env, static_cast<double>(stats.tilingSpriteDrawCalls))),
    "cannot set renderer tiling sprite draws");
  check(env, napi_set_named_property(env, result, "screenFillDrawCalls",
    number(env, static_cast<double>(stats.screenFillDrawCalls))),
    "cannot set renderer screen fill draws");
  check(env, napi_set_named_property(env, result, "meshDrawCalls",
    number(env, static_cast<double>(stats.meshDrawCalls))),
    "cannot set renderer mesh draws");
  return result;
} catch (const std::exception& error) {
  napi_throw_error(env, nullptr, error.what());
  return nullptr;
}

napi_value quit(napi_env env, napi_callback_info) try {
  host(env).core.requestQuit();
  return undefined(env);
} catch (const std::exception& error) {
  napi_throw_error(env, nullptr, error.what());
  return nullptr;
} catch (...) {
  napi_throw_error(env, nullptr, "quit failed");
  return nullptr;
}

napi_value environment(napi_env env, napi_callback_info info) try {
  auto args = arguments(env, info, 1);
  const char* value = std::getenv(asString(env, args.at(0)).c_str());
  return value ? string(env, value) : undefined(env);
} catch (const std::exception& error) {
  napi_throw_type_error(env, nullptr, error.what());
  return nullptr;
}


napi_value displaySize(napi_env env, napi_callback_info) try {
  const auto& platform = host(env).platform;
  napi_value result;
  check(env, napi_create_object(env, &result), "cannot create display size");
  check(env, napi_set_named_property(env, result, "width",
    number(env, platform.displayWidth())), "cannot set display width");
  check(env, napi_set_named_property(env, result, "height",
    number(env, platform.displayHeight())), "cannot set display height");
  return result;
} catch (const std::exception& error) {
  napi_throw_error(env, nullptr, error.what());
  return nullptr;
}

napi_value windowSize(napi_env env, napi_callback_info) try {
  const auto& platform = host(env).platform;
  napi_value result;
  check(env, napi_create_object(env, &result), "cannot create window size");
  check(env, napi_set_named_property(env, result, "width",
    number(env, platform.windowWidth())), "cannot set window width");
  check(env, napi_set_named_property(env, result, "height",
    number(env, platform.windowHeight())), "cannot set window height");
  return result;
} catch (const std::exception& error) {
  napi_throw_error(env, nullptr, error.what());
  return nullptr;
}

napi_value setWindowTitle(napi_env env, napi_callback_info info) try {
  auto args = arguments(env, info, 1);
  host(env).platform.setWindowTitle(asString(env, args.at(0)));
  return undefined(env);
} catch (const std::exception& error) {
  napi_throw_type_error(env, nullptr, error.what());
  return nullptr;
}

napi_value setFullscreen(napi_env env, napi_callback_info info) try {
  auto args = arguments(env, info, 1);
  host(env).platform.setFullscreen(asBoolean(env, args.at(0)));
  return undefined(env);
} catch (const std::exception& error) {
  napi_throw_error(env, nullptr, error.what());
  return nullptr;
}

napi_value isFullscreen(napi_env env, napi_callback_info) try {
  return boolean(env, host(env).platform.fullscreen());
} catch (const std::exception& error) {
  napi_throw_error(env, nullptr, error.what());
  return nullptr;
}

napi_value openExternal(napi_env env, napi_callback_info info) try {
  auto args = arguments(env, info, 1);
  host(env);
  auto url = asString(env, args.at(0));
  auto scheme = url.substr(0, url.find(':'));
  std::transform(scheme.begin(), scheme.end(), scheme.begin(),
    [](unsigned char ch) { return static_cast<char>(std::tolower(ch)); });
  if ((scheme != "http" && scheme != "https" && scheme != "mailto") ||
      std::any_of(url.begin(), url.end(), [](unsigned char ch) { return ch <= 32; })) {
    return boolean(env, false);
  }
  // SDL_OpenURL was added in SDL 2.0.14; older firmware can still run games.
  using OpenUrl = int (*)(const char*);
  void* library = SDL_LoadObject("libSDL2-2.0.so.0");
  if (!library) return boolean(env, false);
  const auto open = reinterpret_cast<OpenUrl>(SDL_LoadFunction(library, "SDL_OpenURL"));
  const bool opened = open && open(url.c_str()) == 0;
  SDL_UnloadObject(library);
  return boolean(env, opened);
} catch (const std::exception& error) {
  napi_throw_error(env, nullptr, error.what());
  return nullptr;
}

void registerRuntimeBindings(napi_env env, napi_value exports) {
  method(env, exports, "initialize", initialize);
  method(env, exports, "pollEvents", pollEvents);
  method(env, exports, "finishLogicStep", finishLogicStep);
  method(env, exports, "beginFrame", beginFrame);
  method(env, exports, "renderFrame", renderFrame);
  method(env, exports, "renderScene", renderScene);
  method(env, exports, "swapFrame", swapFrame);
  napi_value runtime = moduleObject(env);
  method(env, runtime, "quit", quit);
  method(env, runtime, "preparationProgress", preparationProgress);
  method(env, runtime, "env", environment);
  method(env, runtime, "monotonicNow", monotonicNow);
  method(env, runtime, "windowState", windowState);
  method(env, runtime, "displaySize", displaySize);
  method(env, runtime, "windowSize", windowSize);
  method(env, runtime, "setWindowTitle", setWindowTitle);
  method(env, runtime, "setFullscreen", setFullscreen);
  method(env, runtime, "isFullscreen", isFullscreen);
  method(env, runtime, "openExternal", openExternal);
  check(env, napi_set_named_property(env, exports, "runtime", runtime),
        "cannot export runtime module");
}

}  // namespace pmjs::addon
