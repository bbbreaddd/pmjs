#include "node_addon_internal.hpp"

#include <SDL.h>

#include <algorithm>
#include <cmath>
#include <cctype>
#include <limits>
#if defined(__GLIBC__)
#include <dlfcn.h>
#endif

namespace pmjs::addon {
namespace {
#if defined(__GLIBC__)
struct AllocatorInfo {
  std::size_t arena, ordblks, smblks, hblks, hblkhd, usmblks, fsmblks, uordblks, fordblks, keepcost;
};
std::optional<AllocatorInfo> allocatorInfo() {
  // Keep the minimum libc requirement unchanged when built with an older SDK.
  using Query = AllocatorInfo (*)();
  static const auto query = reinterpret_cast<Query>(dlsym(RTLD_DEFAULT, "mallinfo2"));
  return query ? std::optional<AllocatorInfo>(query()) : std::nullopt;
}
#endif
std::optional<int> trimAllocatorMemory(std::size_t pad) {
#if defined(__GLIBC__)
  using Trim = int (*)(std::size_t);
  static const auto trim = reinterpret_cast<Trim>(dlsym(RTLD_DEFAULT, "malloc_trim"));
  if (trim) return trim(pad);
#else
  (void)pad;
#endif
  return std::nullopt;
}
}

void trimPreparationMemory() noexcept {
#if defined(__GLIBC__)
  const auto info = allocatorInfo();
  if (info && info->fordblks < 32U * 1024U * 1024U) return;
  // Preparation frees large temporary buffers that worker arenas otherwise retain.
  trimAllocatorMemory(128U * 1024U);
#endif
}

napi_value trimAllocator(napi_env env, napi_callback_info) {
  const auto released = trimAllocatorMemory(0);
  return released ? boolean(env, *released != 0) : undefined(env);
}

napi_value allocatorStats(napi_env env, napi_callback_info) try {
#if defined(__GLIBC__)
  const auto snapshot = allocatorInfo();
  if (!snapshot) return undefined(env);
  const auto& info = *snapshot;
  const auto result = moduleObject(env);
  for (const auto& [name, value] : {
      std::pair{"arenaBytes", info.arena},
      std::pair{"allocatedArenaBytes", info.uordblks},
      std::pair{"freeArenaBytes", info.fordblks},
      std::pair{"mappedBytes", info.hblkhd},
      std::pair{"mappedChunks", info.hblks},
      std::pair{"topReleasableBytes", info.keepcost}})
    check(env, napi_set_named_property(env, result, name, number(env, static_cast<double>(value))),
      "cannot set allocator statistics");
  return result;
#else
  return undefined(env);
#endif
} catch (const std::exception& error) {
  return throwException(env, error);
}

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
  std::size_t preparedFrameCacheBytes = pmjs::ImageStore::defaultPreparedFrameCacheBytes;
  if (hasProperty(env, options, "preparedFrameCacheBytes")) {
    constexpr double maxSafeInteger = 9007199254740991.0;
    const double maxCacheBytes = std::min(maxSafeInteger,
      static_cast<double>(std::numeric_limits<std::size_t>::max()));
    const double configured = asNumber(env, property(env, options,
      "preparedFrameCacheBytes"));
    if (!std::isfinite(configured) || configured < 0 ||
        std::floor(configured) != configured ||
        configured > maxCacheBytes) {
      throw std::runtime_error(
        "preparedFrameCacheBytes must be a non-negative safe integer");
    }
    preparedFrameCacheBytes = static_cast<std::size_t>(configured);
  }
  const auto imageOption = [&](const char* name) {
    return !hasProperty(env, options, name) || asBoolean(env, property(env, options, name));
  };
  const bool compactSampling = imageOption("preparedCompactSampling");
  const bool cropUploads = imageOption("preparedCropUploads");
  const auto title = asString(env, property(env, options, "windowTitle"));
  if (title.empty()) throw std::runtime_error("windowTitle must not be empty");
  state = std::make_unique<State>(
    asString(env, property(env, options, "gameRoot")), width, height,
    assetRoot, title, imageWarmCacheBytes);
  state->images.setPreparedFrameCacheBudget(preparedFrameCacheBytes);
  state->images.setCompactSamplingEnabled(compactSampling);
  state->images.setPreparedCropUploadsEnabled(cropUploads);
  return undefined(env);
} catch (const std::exception& error) {
  return throwException(env, error);
}

napi_value vfsIndexStats(napi_env env, napi_callback_info) try {
  const auto& scan = host(env).vfs.scanStats();
  const auto result = moduleObject(env);
  check(env, napi_set_named_property(env, result, "paths", number(env, scan.paths)), "cannot set scan statistics");
  check(env, napi_set_named_property(env, result, "directories", number(env, scan.directories)), "cannot set scan statistics");
  check(env, napi_set_named_property(env, result, "canonicalizations", number(env, scan.canonicalizations)), "cannot set scan statistics");
  check(env, napi_set_named_property(env, result, "durationMs", number(env, scan.durationMs)), "cannot set scan statistics");
  return result;
} catch (const std::exception& error) {
  return throwException(env, error);
}

napi_value pollEvents(napi_env env, napi_callback_info) try {
  return boolean(env, host(env).core.pollEvents());
} catch (const std::exception& error) {
  return throwException(env, error);
} catch (...) {
  return throwError(env, "pollEvents failed");
}

napi_value finishLogicStep(napi_env env, napi_callback_info) try {
  host(env).platform.finishLogicStep();
  return undefined(env);
} catch (const std::exception& error) {
  return throwException(env, error);
} catch (...) {
  return throwError(env, "finishLogicStep failed");
}

napi_value monotonicNow(napi_env env, napi_callback_info) try {
  const auto now = std::chrono::steady_clock::now().time_since_epoch();
  return number(env, std::chrono::duration<double, std::milli>(now).count());
} catch (const std::exception& error) {
  return throwException(env, error);
} catch (...) {
  return throwError(env, "monotonicNow failed");
}

napi_value windowState(napi_env env, napi_callback_info) try {
  const auto& platform = host(env).platform;
  napi_value result;
  check(env, napi_create_object(env, &result), "cannot create window state");
  check(env, napi_set_named_property(env, result, "focused",
    boolean(env, platform.windowFocused())), "cannot set window focus state");
  check(env, napi_set_named_property(env, result, "visible",
    boolean(env, platform.windowVisible())), "cannot set window visibility state");
  const auto [x, y] = platform.windowPosition();
  check(env, napi_set_named_property(env, result, "x", number(env, x)), "cannot set property");
  check(env, napi_set_named_property(env, result, "y", number(env, y)), "cannot set property");
  check(env, napi_set_named_property(env, result, "fullscreen", boolean(env, platform.fullscreen())), "cannot set property");
  check(env, napi_set_named_property(env, result, "width", number(env, platform.windowWidth())), "cannot set property");
  check(env, napi_set_named_property(env, result, "height", number(env, platform.windowHeight())), "cannot set property");
  return result;
} catch (const std::exception& error) {
  return throwException(env, error);
} catch (...) {
  return throwError(env, "windowState failed");
}

napi_value beginFrame(napi_env env, napi_callback_info) try {
  host(env).renderer.beginFrame();
  return undefined(env);
} catch (const std::exception& error) {
  return throwException(env, error);
} catch (...) {
  return throwError(env, "beginFrame failed");
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

napi_value settingsOverlay(napi_env env, napi_callback_info info) try {
  const auto args = arguments(env, info, 1);
  if (args.empty()) throw std::invalid_argument("settings overlay requires options");
  auto& value = host(env);
  resolvePreparationFonts(env, args[0], value);
  const int selected = hasProperty(env, args[0], "selected") ? asInt32(env, property(env, args[0], "selected")) : 0;
  const bool confirming = hasProperty(env, args[0], "confirming") && asBoolean(env, property(env, args[0], "confirming"));
  const bool confirmYes = hasProperty(env, args[0], "confirmYes") && asBoolean(env, property(env, args[0], "confirmYes"));
  const auto rowsArg = property(env, args[0], "rows");
  bool array = false;
  check(env, napi_is_array(env, rowsArg, &array), "invalid settings rows");
  if (!array) throw std::invalid_argument("settings rows must be an array");
  std::uint32_t count = 0;
  check(env, napi_get_array_length(env, rowsArg, &count), "invalid settings rows");
  if (count == 0 || count > 16) throw std::range_error("invalid settings row count");
  std::vector<std::pair<std::string, std::string>> rows;
  for (std::uint32_t i = 0; i < count; ++i) {
    napi_value row;
    check(env, napi_get_element(env, rowsArg, i, &row), "invalid settings row");
    rows.emplace_back(asString(env, property(env, row, "label")), asString(env, property(env, row, "value")));
  }
  const auto title = asString(env, property(env, args[0], "title"));
  const auto question = asString(env, property(env, args[0], "question"));
  const auto yes = asString(env, property(env, args[0], "yes"));
  const auto no = asString(env, property(env, args[0], "no"));
  const auto footerArg = property(env, args[0], "footer");
  std::array<std::string, 2> footer;
  for (std::uint32_t i = 0; i < footer.size(); ++i) {
    napi_value line;
    check(env, napi_get_element(env, footerArg, i, &line), "invalid settings footer");
    footer[i] = asString(env, line);
  }
  value.core.syncDrawableSize();
  const auto geometry = value.renderer.presentationGeometry();
  const int sw = std::max(1, geometry.drawableWidth);
  const int sh = std::max(1, geometry.drawableHeight);
  const float width = static_cast<float>(sw), height = static_cast<float>(sh);
  constexpr float scale = 1.0F;
  const auto current = value.canvases.info(value.settingsSurface);
  if (!value.settingsSurface || !current || current->width != sw || current->height != sh) {
    if (value.settingsSurface) value.canvases.release(value.settingsSurface);
    const auto surface = value.canvases.create(sw, sh);
    if (!surface) throw std::runtime_error("cannot allocate settings surface");
    value.settingsSurface = surface->handle;
  }
  const auto rect = [&](float x, float y, float w, float h, std::uint32_t color) {
    value.canvases.fillRect(value.settingsSurface, x * sw, y * sh, w * sw, h * sh, color);
  };
  rect(0, 0, 1, 1, 0x090E17FFU);
  rect(0.07F, 0.06F, 0.86F, 0.88F, 0x131C2BFFU);
  rect(0.07F, 0.06F, 0.012F, 0.88F, 0x59B8D1FFU);
  const float rowStep = 0.51F / rows.size();
  const float rowY = 0.24F + static_cast<float>(std::clamp(selected, 0, static_cast<int>(rows.size()) - 1)) * rowStep;
  if (!confirming) {
    rect(0.11F, rowY, 0.78F, rowStep * 0.85F, 0x294D66FFU);
    rect(0.11F, rowY, 0.008F, rowStep * 0.85F, 0x75D9E8FFU);
  } else {
    rect(0.15F, 0.24F, 0.70F, 0.43F, 0x1C2C3CFFU);
    rect(confirmYes ? 0.21F : 0.54F, 0.46F, 0.25F, 0.13F, 0x426B83FFU);
  }
  rect(0.12F, 0.78F, 0.76F, 0.003F, 0x526979FFU);
  napi_value fallbackLines;
  check(env, napi_create_array(env, &fallbackLines), "cannot create settings text lines");
  std::uint32_t fallbackCount = 0;
  {
    const float bodySize = std::clamp(height * 0.045F, 10.0F, 27.0F);
    const auto text = [&](const std::string& label, float x, float y, float maxWidth,
                          float size, std::uint32_t color, bool right = false) {
      x *= scale; y *= scale; maxWidth *= scale; size *= scale;
      const auto measured = value.preparationFonts.empty() ?
        std::optional<double>{label.size() * size * 0.75} :
        value.canvases.measureText(value.preparationFonts, label, size);
      if (measured && *measured > maxWidth) size *= maxWidth / *measured;
      const auto actual = value.preparationFonts.empty() ?
        std::optional<double>{label.size() * size * 0.75} :
        value.canvases.measureText(value.preparationFonts, label, size);
      const float left = right && actual ? x - *actual : x;
      if (!value.preparationFonts.empty()) {
        value.canvases.drawText(value.settingsSurface, value.preparationFonts, label, left, y, size, color);
      } else {
        napi_value line = moduleObject(env);
        check(env, napi_set_named_property(env, line, "text", string(env, label)), "cannot set property");
        check(env, napi_set_named_property(env, line, "x", number(env, left)), "cannot set property");
        check(env, napi_set_named_property(env, line, "y", number(env, y - size)), "cannot set property");
        check(env, napi_set_named_property(env, line, "pixel", number(env, size / 16)), "cannot set property");
        check(env, napi_set_named_property(env, line, "color", uint32(env, color)), "cannot set property");
        check(env, napi_set_element(env, fallbackLines, fallbackCount++, line), "cannot set array element");
      }
    };
    constexpr std::uint32_t primary = 0xFFFFFFFFU;
    constexpr std::uint32_t secondary = 0xB4C8D5FFU;
    text(title, width * 0.15F, height * 0.17F, width * 0.70F, bodySize * 1.35F, primary);
    if (confirming) {
      text(question, width * 0.20F, height * 0.36F, width * 0.60F, bodySize * 1.05F, primary);
      const auto centered = [&](const std::string& label, float center) {
        const auto measured = value.preparationFonts.empty() ?
          std::optional<double>{label.size() * bodySize * 0.75} :
          value.canvases.measureText(value.preparationFonts, label, bodySize);
        text(label, width * center + (measured ? *measured / 2 : 0), height * 0.545F,
             width * 0.21F, bodySize, primary, true);
      };
      centered(yes, 0.335F);
      centered(no, 0.665F);
      text(footer[0], width * 0.15F, height * 0.85F, width * 0.70F, bodySize * 0.76F, secondary);
      text(footer[1], width * 0.15F, height * 0.91F, width * 0.70F, bodySize * 0.76F, secondary);
    } else {
      const bool stacked = width < 480.0F;
      for (std::size_t i = 0; i < rows.size(); ++i) {
        const float top = 0.24F + i * rowStep;
        const bool hasValue = !rows[i].second.empty();
        const float labelY = height * (top + rowStep * (stacked && hasValue ? 0.32F : 0.54F));
        text(rows[i].first, width * 0.15F, labelY, width * (stacked || !hasValue ? 0.68F : 0.31F), bodySize, primary);
        if (hasValue) {
          const auto valueText = "<  " + rows[i].second + "  >";
          if (stacked) text(valueText, width * 0.15F, height * (top + rowStep * 0.71F), width * 0.68F, bodySize * 0.88F, secondary);
          else text(valueText, width * 0.85F, labelY, width * 0.38F, bodySize, secondary, true);
        }
      }
      text(footer[0], width * 0.15F, height * 0.85F, width * 0.70F, bodySize * 0.76F, secondary);
      text(footer[1], width * 0.15F, height * 0.91F,
           width * 0.70F, bodySize * 0.76F, secondary);
    }
  }
  napi_value result = moduleObject(env);
  check(env, napi_set_named_property(env, result, "canvas", uint32(env, value.settingsSurface)), "cannot set property");
  check(env, napi_set_named_property(env, result, "hasFont", boolean(env, !value.preparationFonts.empty())), "cannot set property");
  check(env, napi_set_named_property(env, result, "scale", number(env, scale)), "cannot set property");
  check(env, napi_set_named_property(env, result, "width", uint32(env, sw)), "cannot set property");
  check(env, napi_set_named_property(env, result, "height", uint32(env, sh)), "cannot set property");
  check(env, napi_set_named_property(env, result, "lines", fallbackLines), "cannot set property");
  return result;
} catch (const std::exception& error) {
  return throwException(env, error);
}

napi_value settingsPresent(napi_env env, napi_callback_info info) try {
  const auto args = arguments(env, info, 1);
  auto& value = host(env);
  const bool visible = !args.empty() && asBoolean(env, args[0]);
  const auto image = visible ? value.canvases.prepareImage(value.settingsSurface) : std::optional<pmjs::ImageHandle>{0};
  if (!image || !value.renderer.setRuntimeOverlay(*image)) throw std::runtime_error("cannot present settings");
  if (!visible && value.settingsSurface) {
    value.canvases.release(value.settingsSurface);
    value.settingsSurface = 0;
  }
  return undefined(env);
} catch (const std::exception& error) {
  return throwException(env, error);
}

napi_value preparationProgress(napi_env env, napi_callback_info info) try {
  const auto args = arguments(env, info, 1);
  if (args.empty()) throw std::invalid_argument("preparationProgress requires progress");
  const auto progress = args[0];
  const double completed = asNumber(env, property(env, progress, "completed"));
  const double total = asNumber(env, property(env, progress, "total"));
  if (!std::isfinite(completed) || !std::isfinite(total) || completed < 0 || total < 0)
    throw std::range_error("invalid preparation progress");
  const bool terminal = hasProperty(env, progress, "terminal") ?
    asBoolean(env, property(env, progress, "terminal")) :
    (!hasProperty(env, progress, "phase") && completed >= total);
  auto& value = host(env);
  const auto now = std::chrono::steady_clock::now();
  const bool present = !hasProperty(env, progress, "present") || asBoolean(env, property(env, progress, "present"));
  const bool force = hasProperty(env, progress, "force") && asBoolean(env, property(env, progress, "force"));
  if (!terminal && !force && now - value.preparationPresentedAt < std::chrono::milliseconds(500))
    return undefined(env);
  value.preparationPresentedAt = now;
  value.core.syncDrawableSize();
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
      const auto geometry = value.renderer.presentationGeometry();
      double fitScale = 1.0;
      if (geometry.viewportWidth > 0 && geometry.viewportHeight > 0 &&
          value.width > 0 && value.height > 0) {
        fitScale = std::min(static_cast<double>(geometry.viewportWidth) / value.width,
                            static_cast<double>(geometry.viewportHeight) / value.height);
      }
      // Rasterize for the physical viewport instead of supersampling the logical screen.
      const double textScale = std::clamp(fitScale, 0.25, 2.0);
      const float scale = static_cast<float>(textScale);
      const int surfaceWidth = std::max(1, static_cast<int>(std::lround(width * scale)));
      const int surfaceHeight = std::max(1, static_cast<int>(std::lround(height * scale)));
      const auto current = value.canvases.info(value.preparationSurface);
      if (!value.preparationSurface || !current ||
          current->width != surfaceWidth || current->height != surfaceHeight) {
        if (value.preparationSurface) value.canvases.release(value.preparationSurface);
        const auto surface = value.canvases.create(surfaceWidth, surfaceHeight);
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
        const float size = std::clamp(height * (i == 0 ? 0.07F : 0.05F), i == 0 ? 12.0F : 10.0F,
                                        i == 0 ? 44.0F : 32.0F) * scale;
        const auto text = fitProgressLine(value.canvases, value.preparationFonts,
          asString(env, entry), size, width * 0.84F * scale);
        value.canvases.drawText(value.preparationSurface, value.preparationFonts,
          text, width * 0.08F * scale, height * positions[i] * scale, size,
          i == 0 ? 0xFFFFFFFFU : 0xCACAD4FFU);
      }
      if (const auto image = value.canvases.prepareImage(value.preparationSurface)) {
        const float inverse = 1.0F / scale;
        value.renderer.queueImage(*image, {inverse, 0, 0, inverse, 0, 0},
                                  {0, 0, static_cast<float>(surfaceWidth),
                                   static_cast<float>(surfaceHeight)},
                                  1, 0xFFFFFFU, pmjs::BlendMode::normal);
      }
    }
  }
  value.core.syncDrawableSize();
  if (present) {
    value.renderer.render();
    value.platform.swap();
  }
  if (terminal && value.preparationSurface) {
    value.canvases.release(value.preparationSurface);
    value.preparationSurface = 0;
  }
  return undefined(env);
} catch (const std::exception& error) {
  return throwException(env, error);
}

napi_value preparationClear(napi_env env, napi_callback_info) try {
  auto& value = host(env);
  if (value.preparationSurface) {
    value.canvases.release(value.preparationSurface);
    value.preparationSurface = 0;
  }
  return undefined(env);
} catch (const std::exception& error) {
  return throwException(env, error);
}

napi_value renderFrame(napi_env env, napi_callback_info) try {
  State& value = host(env);
  const auto start = std::chrono::steady_clock::now();
  value.canvases.uploadDirty();
  const auto uploaded = std::chrono::steady_clock::now();
  value.core.syncDrawableSize();
  value.renderer.render();
  const auto drawn = std::chrono::steady_clock::now();
  syncExternalMemory(env);
  const auto accounted = std::chrono::steady_clock::now();
  value.frameUploadMs = std::chrono::duration<double, std::milli>(uploaded - start).count();
  value.frameDrawMs = std::chrono::duration<double, std::milli>(drawn - uploaded).count();
  value.frameMemoryMs = std::chrono::duration<double, std::milli>(accounted - drawn).count();
  return undefined(env);
} catch (const std::exception& error) {
  return throwException(env, error);
} catch (...) {
  return throwError(env, "renderFrame failed");
}

// Scene-only; never touches the window framebuffer.
napi_value renderScene(napi_env env, napi_callback_info) try {
  State& value = host(env);
  value.canvases.uploadDirty();
  value.renderer.renderScene();
  syncExternalMemory(env);
  return undefined(env);
} catch (const std::exception& error) {
  return throwException(env, error);
} catch (...) {
  return throwError(env, "renderScene failed");
}

napi_value swapFrame(napi_env env, napi_callback_info) try {
  State& value = host(env);
  value.platform.swap();
  return undefined(env);
} catch (const std::exception& error) {
  return throwException(env, error);
} catch (...) {
  return throwError(env, "swapFrame failed");
}

napi_value rendererStats(napi_env env, napi_callback_info) try {
  const auto& stats = host(env).renderer.stats();
  napi_value result;
  check(env, napi_create_object(env, &result), "cannot create renderer stats");
  napi_value frameCosts;
  check(env, napi_create_object(env, &frameCosts), "cannot create frame costs");
  check(env, napi_set_named_property(env, frameCosts, "uploadMs",
    number(env, host(env).frameUploadMs)), "cannot set frame upload time");
  check(env, napi_set_named_property(env, frameCosts, "drawMs",
    number(env, host(env).frameDrawMs)), "cannot set frame draw time");
  check(env, napi_set_named_property(env, frameCosts, "memoryMs",
    number(env, host(env).frameMemoryMs)), "cannot set frame memory time");
  check(env, napi_set_named_property(env, result, "frameCosts", frameCosts), "cannot set frame costs");
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
  check(env, napi_set_named_property(env, result, "spriteTextureChangesBatched",
    number(env, static_cast<double>(stats.spriteTextureChangesBatched))),
    "cannot set renderer batched sprite texture changes");
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
  check(env, napi_set_named_property(env, result, "filterIntermediateCacheHits",
    number(env, static_cast<double>(stats.filterIntermediateCacheHits))),
    "cannot set filterIntermediateCacheHits");
  check(env, napi_set_named_property(env, result, "constantBlackGroups",
    number(env, static_cast<double>(stats.constantBlackGroups))),
    "cannot set constantBlackGroups");
  check(env, napi_set_named_property(env, result, "constantBlackGroupsSkipped",
    number(env, static_cast<double>(stats.constantBlackGroupsSkipped))),
    "cannot set constantBlackGroupsSkipped");
  check(env, napi_set_named_property(env, result, "constantBlackSourceDraws",
    number(env, static_cast<double>(stats.constantBlackSourceDraws))),
    "cannot set constantBlackSourceDraws");
  check(env, napi_set_named_property(env, result, "constantBlackBorderDraws",
    number(env, static_cast<double>(stats.constantBlackBorderDraws))),
    "cannot set constantBlackBorderDraws");
  check(env, napi_set_named_property(env, result, "identityFilterShaderDrawCalls",
    number(env, static_cast<double>(stats.identityFilterShaderDrawCalls))),
    "cannot set identity filter shader draws");
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
  check(env, napi_set_named_property(env, result, "tileGeometryGpuBytes", number(env, host(env).renderer.tileGeometryGpuBytes())), "cannot set property");
  check(env, napi_set_named_property(env, result, "tileGeometryCpuBytes", number(env, host(env).renderer.tileGeometryCpuBytes())), "cannot set property");
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
  return throwException(env, error);
}

napi_value quit(napi_env env, napi_callback_info) try {
  host(env).core.requestQuit();
  return undefined(env);
} catch (const std::exception& error) {
  return throwException(env, error);
} catch (...) {
  return throwError(env, "quit failed");
}

napi_value environment(napi_env env, napi_callback_info info) try {
  auto args = arguments(env, info, 1);
  const char* value = std::getenv(asString(env, args.at(0)).c_str());
  return value ? string(env, value) : undefined(env);
} catch (const std::exception& error) {
  return throwException(env, error);
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
  return throwException(env, error);
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
  return throwException(env, error);
}

napi_value setWindowTitle(napi_env env, napi_callback_info info) try {
  auto args = arguments(env, info, 1);
  host(env).platform.setWindowTitle(asString(env, args.at(0)));
  return undefined(env);
} catch (const std::exception& error) {
  return throwException(env, error);
}

napi_value setFullscreen(napi_env env, napi_callback_info info) try {
  auto args = arguments(env, info, 1);
  host(env).platform.setFullscreen(asBoolean(env, args.at(0)));
  return undefined(env);
} catch (const std::exception& error) {
  return throwException(env, error);
}

napi_value isFullscreen(napi_env env, napi_callback_info) try {
  return boolean(env, host(env).platform.fullscreen());
} catch (const std::exception& error) {
  return throwException(env, error);
}

napi_value screens(napi_env env, napi_callback_info) try {
  napi_value result;
  const int count = SDL_GetNumVideoDisplays();
  if (count < 0) throw std::runtime_error(SDL_GetError());
  check(env, napi_create_array_with_length(env, count, &result), "cannot create array");
  for (int index = 0; index < count; ++index) {
    SDL_Rect bounds{}, work{};
    if (SDL_GetDisplayBounds(index, &bounds) != 0) throw std::runtime_error(SDL_GetError());
    if (SDL_GetDisplayUsableBounds(index, &work) != 0) work = bounds;
    auto rectangle = [&](const SDL_Rect& value) {
      napi_value object = moduleObject(env);
      check(env, napi_set_named_property(env, object, "x", number(env, value.x)), "cannot set property");
      check(env, napi_set_named_property(env, object, "y", number(env, value.y)), "cannot set property");
      check(env, napi_set_named_property(env, object, "width", number(env, value.w)), "cannot set property");
      check(env, napi_set_named_property(env, object, "height", number(env, value.h)), "cannot set property");
      return object;
    };
    napi_value screen = moduleObject(env);
    check(env, napi_set_named_property(env, screen, "id", number(env, index)), "cannot set property");
    check(env, napi_set_named_property(env, screen, "bounds", rectangle(bounds)), "cannot set property");
    check(env, napi_set_named_property(env, screen, "work_area", rectangle(work)), "cannot set property");
    check(env, napi_set_named_property(env, screen, "scaleFactor", number(env, 1)), "cannot set property");
    check(env, napi_set_element(env, result, index, screen), "cannot set array element");
  }
  return result;
} catch (const std::exception& error) {
  return throwException(env, error);
}

napi_value windowCommand(napi_env env, napi_callback_info info) try {
  auto args = arguments(env, info, 3);
  const auto command = asString(env, args.at(0));
  const auto x = asNumber(env, args.at(1)), y = asNumber(env, args.at(2));
  if (!std::isfinite(x) || !std::isfinite(y) || x < -32768 || x > 32767 || y < -32768 || y > 32767)
    throw std::runtime_error("invalid window coordinates");
  host(env).platform.windowCommand(command, static_cast<int>(x), static_cast<int>(y));
  return undefined(env);
} catch (const std::exception& error) {
  return throwException(env, error);
}

napi_value interceptWindowClose(napi_env env, napi_callback_info info) try {
  auto args = arguments(env, info, 1);
  host(env).platform.interceptWindowClose(asBoolean(env, args.at(0)));
  return undefined(env);
} catch (const std::exception& error) {
  return throwException(env, error);
}

napi_value windowEvents(napi_env env, napi_callback_info) try {
  const auto events = host(env).platform.takeWindowEvents();
  napi_value result;
  check(env, napi_create_array_with_length(env, events.size(), &result), "cannot create array");
  for (std::size_t index = 0; index < events.size(); ++index) {
    napi_value event = moduleObject(env);
    check(env, napi_set_named_property(env, event, "type", string(env, events[index].type)), "cannot set property");
    check(env, napi_set_named_property(env, event, "x", number(env, events[index].x)), "cannot set property");
    check(env, napi_set_named_property(env, event, "y", number(env, events[index].y)), "cannot set property");
    check(env, napi_set_element(env, result, index, event), "cannot set array element");
  }
  return result;
} catch (const std::exception& error) {
  return throwException(env, error);
}

napi_value clipboardText(napi_env env, napi_callback_info info) try {
  auto args = arguments(env, info, 1);
  if (!args.empty()) {
    const auto text = asString(env, args[0]);
    if (SDL_SetClipboardText(text.c_str()) != 0) throw std::runtime_error(SDL_GetError());
    return undefined(env);
  }
  char* text = SDL_GetClipboardText();
  if (!text) throw std::runtime_error(SDL_GetError());
  const std::string value(text);
  SDL_free(text);
  return string(env, value);
} catch (const std::exception& error) {
  return throwException(env, error);
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
  return throwException(env, error);
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
  method(env, runtime, "vfsIndexStats", vfsIndexStats);
  method(env, runtime, "allocatorStats", allocatorStats);
  method(env, runtime, "trimAllocator", trimAllocator);
  method(env, runtime, "preparationProgress", preparationProgress);
  method(env, runtime, "preparationClear", preparationClear);
  method(env, runtime, "settingsOverlay", settingsOverlay);
  method(env, runtime, "settingsPresent", settingsPresent);
  method(env, runtime, "env", environment);
  method(env, runtime, "monotonicNow", monotonicNow);
  method(env, runtime, "windowState", windowState);
  method(env, runtime, "displaySize", displaySize);
  method(env, runtime, "windowSize", windowSize);
  method(env, runtime, "windowCommand", windowCommand);
  method(env, runtime, "windowEvents", windowEvents);
  method(env, runtime, "interceptWindowClose", interceptWindowClose);
  method(env, runtime, "screens", screens);
  method(env, runtime, "clipboardText", clipboardText);
  method(env, runtime, "setWindowTitle", setWindowTitle);
  method(env, runtime, "setFullscreen", setFullscreen);
  method(env, runtime, "isFullscreen", isFullscreen);
  method(env, runtime, "openExternal", openExternal);
  check(env, napi_set_named_property(env, exports, "runtime", runtime),
        "cannot export runtime module");
}

}  // namespace pmjs::addon
