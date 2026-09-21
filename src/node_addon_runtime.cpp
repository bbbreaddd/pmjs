#include "node_addon_internal.hpp"

#include <algorithm>
#include <cmath>
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
  return result;
} catch (const std::exception& error) {
  napi_throw_error(env, nullptr, error.what());
  return nullptr;
} catch (...) {
  napi_throw_error(env, nullptr, "windowState failed");
  return nullptr;
}

napi_value presentation(napi_env env, napi_callback_info) try {
  State& value = host(env);
  napi_value result;
  check(env, napi_create_object(env, &result), "cannot create presentation state");
  check(env, napi_set_named_property(env, result, "requested",
    number(env, value.platform.requestedSwapInterval())),
        "cannot set requested swap interval");
  check(env, napi_set_named_property(env, result, "accepted",
    boolean(env, value.platform.swapIntervalAccepted())),
    "cannot set swap acceptance");
  check(env, napi_set_named_property(env, result, "driver",
    number(env, value.platform.swapInterval())), "cannot set driver swap interval");
  return result;
} catch (const std::exception& error) {
  napi_throw_error(env, nullptr, error.what());
  return nullptr;
}

napi_value waitUntil(napi_env env, napi_callback_info info) try {
  const auto args = arguments(env, info, 1);
  if (args.size() != 1) throw std::runtime_error("waitUntil requires a deadline");
  const auto deadline = std::chrono::duration<double, std::milli>(
    asNumber(env, args[0]));
  std::this_thread::sleep_until(std::chrono::steady_clock::time_point(
    std::chrono::duration_cast<std::chrono::steady_clock::duration>(deadline)));
  return undefined(env);
} catch (const std::exception& error) {
  napi_throw_range_error(env, nullptr, error.what());
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

napi_value present(napi_env env, napi_callback_info) try {
  State& value = host(env);
  value.canvases.uploadDirty();
  value.core.syncDrawableSize();
  value.renderer.render();
  value.platform.swap();
  syncExternalMemory(env);
  return undefined(env);
} catch (const std::exception& error) {
  napi_throw_error(env, nullptr, error.what());
  return nullptr;
} catch (...) {
  napi_throw_error(env, nullptr, "present failed");
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
  host(env).platform.swap();
  return undefined(env);
} catch (const std::exception& error) {
  napi_throw_error(env, nullptr, error.what());
  return nullptr;
} catch (...) {
  napi_throw_error(env, nullptr, "swapFrame failed");
  return nullptr;
}

napi_value finishGpuWork(napi_env env, napi_callback_info) try {
  host(env).platform.finishGpuWork();
  return undefined(env);
} catch (const std::exception& error) {
  napi_throw_error(env, nullptr, error.what());
  return nullptr;
} catch (...) {
  napi_throw_error(env, nullptr, "finishGpuWork failed");
  return nullptr;
}

napi_value rendererStats(napi_env env, napi_callback_info) try {
  const auto& stats = host(env).renderer.stats();
  napi_value result;
  check(env, napi_create_object(env, &result), "cannot create renderer stats");
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
  check(env, napi_set_named_property(env, result, "filterDrawCalls",
    number(env, static_cast<double>(stats.filterDrawCalls))),
    "cannot set renderer filter draws");
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
  check(env, napi_set_named_property(env, result, "filterTargetClears",
    number(env, static_cast<double>(stats.filterTargetClears))),
    "cannot set filter target clears");
  check(env, napi_set_named_property(env, result, "filterBoundedApplications",
    number(env, static_cast<double>(stats.filterBoundedApplications))),
    "cannot set bounded filter applications");
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


void registerRuntimeBindings(napi_env env, napi_value exports) {
  method(env, exports, "initialize", initialize);
  method(env, exports, "pollEvents", pollEvents);
  method(env, exports, "finishLogicStep", finishLogicStep);
  method(env, exports, "beginFrame", beginFrame);
  method(env, exports, "present", present);
  method(env, exports, "renderFrame", renderFrame);
  method(env, exports, "renderScene", renderScene);
  method(env, exports, "finishGpuWork", finishGpuWork);
  method(env, exports, "swapFrame", swapFrame);
  napi_value runtime = moduleObject(env);
  method(env, runtime, "quit", quit);
  method(env, runtime, "env", environment);
  method(env, runtime, "monotonicNow", monotonicNow);
  method(env, runtime, "waitUntil", waitUntil);
  method(env, runtime, "presentation", presentation);
  method(env, runtime, "windowState", windowState);
  check(env, napi_set_named_property(env, exports, "runtime", runtime),
        "cannot export runtime module");
}

}  // namespace pmjs::addon
