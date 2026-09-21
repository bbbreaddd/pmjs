#include "node_addon_internal.hpp"

namespace pmjs::addon {
napi_value createCanvas(napi_env env, napi_callback_info info) try {
  auto args = arguments(env, info, 2);
  auto canvas = host(env).canvases.create(asInt32(env, args.at(0)), asInt32(env, args.at(1)));
  if (!canvas) throw std::runtime_error("invalid canvas dimensions");
  return imageInfo(env, canvas->handle, canvas->width, canvas->height);
} catch (const std::exception& error) {
  napi_throw_range_error(env, nullptr, error.what()); return nullptr;
}

napi_value captureScene(napi_env env, napi_callback_info) try {
  State& value = host(env);
  auto canvas = value.canvases.createRgba(value.width, value.height,
                                           value.renderer.captureSceneRgba());
  if (!canvas) throw std::runtime_error("capture failed");
  return imageInfo(env, canvas->handle, canvas->width, canvas->height);
} catch (const std::exception& error) {
  napi_throw_error(env, nullptr, error.what()); return nullptr;
}

napi_value captureDrawable(napi_env env, napi_callback_info) try {
  State& value = host(env);
  value.core.syncDrawableSize();
  const auto geometry = value.renderer.presentationGeometry();
  auto canvas = value.canvases.createRgba(geometry.drawableWidth,
    geometry.drawableHeight, value.renderer.captureDrawableRgba());
  if (!canvas) throw std::runtime_error("drawable capture failed");
  return imageInfo(env, canvas->handle, canvas->width, canvas->height);
} catch (const std::exception& error) {
  napi_throw_error(env, nullptr, error.what()); return nullptr;
}

napi_value fillRect(napi_env env, napi_callback_info info) try {
  auto a = arguments(env, info, 6);
  if (!host(env).canvases.fillRect(asUint32(env,a.at(0)),asInt32(env,a.at(1)),asInt32(env,a.at(2)),asInt32(env,a.at(3)),asInt32(env,a.at(4)),asUint32(env,a.at(5)))) throw std::runtime_error("invalid canvas");
  return undefined(env);
} catch (const std::exception& error) { napi_throw_range_error(env,nullptr,error.what()); return nullptr; }

napi_value fillRadialGradient(napi_env env, napi_callback_info info) try {
  auto a = arguments(env, info, 12);
  bool offsetsArray = false, colorsArray = false;
  check(env, napi_is_array(env, a.at(9), &offsetsArray), "cannot inspect gradient stops");
  check(env, napi_is_array(env, a.at(10), &colorsArray), "cannot inspect gradient colors");
  if (!offsetsArray || !colorsArray) throw std::runtime_error("gradient stops must be arrays");
  std::uint32_t offsetCount = 0, colorCount = 0;
  check(env, napi_get_array_length(env, a.at(9), &offsetCount), "cannot read gradient stops");
  check(env, napi_get_array_length(env, a.at(10), &colorCount), "cannot read gradient colors");
  if (!offsetCount || offsetCount != colorCount || offsetCount > 64)
    throw std::runtime_error("invalid gradient stops");
  std::vector<float> offsets;
  std::vector<std::uint32_t> colors;
  offsets.reserve(offsetCount); colors.reserve(colorCount);
  for (std::uint32_t index = 0; index < offsetCount; ++index) {
    napi_value offset, color;
    check(env, napi_get_element(env, a.at(9), index, &offset), "cannot read gradient stop");
    check(env, napi_get_element(env, a.at(10), index, &color), "cannot read gradient color");
    offsets.push_back(static_cast<float>(asNumber(env, offset)));
    colors.push_back(asUint32(env, color));
  }
  if (!host(env).canvases.fillRadialGradient(
        asUint32(env, a.at(0)), asInt32(env, a.at(1)), asInt32(env, a.at(2)),
        asInt32(env, a.at(3)), asInt32(env, a.at(4)),
        static_cast<float>(asNumber(env, a.at(5))),
        static_cast<float>(asNumber(env, a.at(6))),
        static_cast<float>(asNumber(env, a.at(7))),
        static_cast<float>(asNumber(env, a.at(8))), offsets, colors,
        asBoolean(env, a.at(11))))
    throw std::runtime_error("invalid radial gradient");
  return undefined(env);
} catch (const std::exception& error) {
  napi_throw_range_error(env, nullptr, error.what()); return nullptr;
}

napi_value clearCanvas(napi_env env, napi_callback_info info) try {
  auto a=arguments(env,info,1); if(!host(env).canvases.clear(asUint32(env,a.at(0)))) throw std::runtime_error("invalid canvas"); return undefined(env);
} catch(const std::exception& error){napi_throw_range_error(env,nullptr,error.what());return nullptr;}

napi_value clearRect(napi_env env, napi_callback_info info) try {
  auto a=arguments(env,info,5); if(!host(env).canvases.clearRect(asUint32(env,a.at(0)),asInt32(env,a.at(1)),asInt32(env,a.at(2)),asInt32(env,a.at(3)),asInt32(env,a.at(4)))) throw std::runtime_error("invalid canvas"); return undefined(env);
} catch(const std::exception& error){napi_throw_range_error(env,nullptr,error.what());return nullptr;}

napi_value canvasDrawImage(napi_env env, napi_callback_info info) try {
  auto a=arguments(env,info,11); if(!host(env).canvases.drawImage(asUint32(env,a.at(0)),asUint32(env,a.at(1)),asInt32(env,a.at(2)),asInt32(env,a.at(3)),asInt32(env,a.at(4)),asInt32(env,a.at(5)),asInt32(env,a.at(6)),asInt32(env,a.at(7)),asInt32(env,a.at(8)),asInt32(env,a.at(9)),asNumber(env,a.at(10)))) throw std::runtime_error("invalid canvas image"); return undefined(env);
} catch(const std::exception& error){napi_throw_range_error(env,nullptr,error.what());return nullptr;}

napi_value drawText(napi_env env, napi_callback_info info) try {
  auto a=arguments(env,info,8); State& value=host(env); auto path=value.vfs.resolve(asString(env,a.at(1))); if(!path||!value.canvases.drawText(asUint32(env,a.at(0)),*path,asString(env,a.at(2)),asInt32(env,a.at(3)),asInt32(env,a.at(4)),asInt32(env,a.at(5)),asUint32(env,a.at(6)),a.size()>7?asInt32(env,a.at(7)):0)) throw std::runtime_error("text draw failed"); return undefined(env);
} catch(const std::exception& error){napi_throw_error(env,nullptr,error.what());return nullptr;}

napi_value measureText(napi_env env, napi_callback_info info) try {
  auto a=arguments(env,info,3); State& value=host(env); auto path=value.vfs.resolve(asString(env,a.at(0))); auto width=path?value.canvases.measureText(*path,asString(env,a.at(1)),asInt32(env,a.at(2))):std::nullopt; if(!width) throw std::runtime_error("text measurement failed"); return number(env,*width);
} catch(const std::exception& error){napi_throw_error(env,nullptr,error.what());return nullptr;}

napi_value canLoadFont(napi_env env, napi_callback_info info) try {
  auto a = arguments(env, info, 1);
  State& value = host(env);
  auto path = value.vfs.resolve(asString(env, a.at(0)));
  return boolean(env, path ? value.canvases.canLoadFont(*path) : false);
} catch (const std::exception& error) {
  napi_throw_error(env, nullptr, error.what()); return nullptr;
}

napi_value pixel(napi_env env, napi_callback_info info) try {
  auto a=arguments(env,info,3); auto value=host(env).canvases.pixel(asUint32(env,a.at(0)),asInt32(env,a.at(1)),asInt32(env,a.at(2))); if(!value) throw std::runtime_error("invalid pixel"); return uint32(env,*value);
} catch(const std::exception& error){napi_throw_range_error(env,nullptr,error.what());return nullptr;}

napi_value readCanvasPixels(napi_env env, napi_callback_info info) try {
  auto args = arguments(env, info, 5);
  if (args.size() != 5) throw std::runtime_error("readPixels requires handle and rectangle");
  const auto pixels = host(env).canvases.readPixels(asUint32(env, args[0]),
    asInt32(env, args[1]), asInt32(env, args[2]), asInt32(env, args[3]),
    asInt32(env, args[4]));
  if (!pixels) throw std::runtime_error("invalid canvas pixel rectangle");
  void* data = nullptr;
  napi_value buffer;
  check(env, napi_create_arraybuffer(env, pixels->rgba.size(), &data, &buffer),
        "cannot allocate pixel buffer");
  std::memcpy(data, pixels->rgba.data(), pixels->rgba.size());
  napi_value result;
  check(env, napi_create_typedarray(env, napi_uint8_clamped_array,
    pixels->rgba.size(), buffer, 0, &result), "cannot create pixel array");
  return result;
} catch(const std::exception& error){napi_throw_range_error(env,nullptr,error.what());return nullptr;}

napi_value encodeCanvasPng(napi_env env, napi_callback_info info) try {
  auto args = arguments(env, info, 1);
  const auto encoded = host(env).canvases.encodePng(asUint32(env, args.at(0)));
  if (!encoded) throw std::runtime_error("invalid canvas");
  void* data = nullptr;
  napi_value buffer;
  check(env, napi_create_arraybuffer(env, encoded->size(), &data, &buffer),
        "cannot allocate PNG buffer");
  std::memcpy(data, encoded->data(), encoded->size());
  napi_value result;
  check(env, napi_create_typedarray(env, napi_uint8_array, encoded->size(),
    buffer, 0, &result), "cannot create PNG byte array");
  return result;
} catch(const std::exception& error){napi_throw_range_error(env,nullptr,error.what());return nullptr;}

napi_value writeCanvasPixels(napi_env env, napi_callback_info info) try {
  auto args = arguments(env, info, 6);
  if (args.size() != 6) throw std::runtime_error("writePixels requires handle, rectangle, and pixels");
  napi_typedarray_type type;
  std::size_t length = 0;
  void* data = nullptr;
  napi_value buffer;
  std::size_t offset = 0;
  check(env, napi_get_typedarray_info(env, args[5], &type, &length, &data,
    &buffer, &offset), "pixels must be a typed array");
  if (type != napi_uint8_array && type != napi_uint8_clamped_array) {
    throw std::runtime_error("pixels must be Uint8Array or Uint8ClampedArray");
  }
  std::vector<std::uint8_t> pixels(static_cast<std::uint8_t*>(data),
                                   static_cast<std::uint8_t*>(data) + length);
  if (!host(env).canvases.writePixels(asUint32(env, args[0]),
      asInt32(env, args[1]), asInt32(env, args[2]), asInt32(env, args[3]),
      asInt32(env, args[4]), pixels)) {
    throw std::runtime_error("invalid canvas pixel data");
  }
  return undefined(env);
} catch(const std::exception& error){napi_throw_range_error(env,nullptr,error.what());return nullptr;}

napi_value releaseCanvas(napi_env env, napi_callback_info info) try {
  auto a=arguments(env,info,1); if(!host(env).canvases.release(asUint32(env,a.at(0)))) throw std::runtime_error("invalid canvas"); return undefined(env);
} catch(const std::exception& error){napi_throw_range_error(env,nullptr,error.what());return nullptr;}

napi_value canvasMemory(napi_env env, napi_callback_info) try {
  const auto& canvases = host(env).canvases;
  napi_value result;
  check(env, napi_create_object(env, &result), "cannot create canvas memory state");
  check(env, napi_set_named_property(env, result, "liveCount",
    number(env, canvases.liveCount())), "cannot set live canvas count");
  check(env, napi_set_named_property(env, result, "liveBytes",
    number(env, canvases.cpuBytes())), "cannot set live canvas bytes");
  check(env, napi_set_named_property(env, result, "cpuPixelBytes",
    number(env, canvases.cpuBytes())), "cannot set cpu pixel bytes");
  check(env, napi_set_named_property(env, result, "capacityBytes",
    number(env, canvases.capacityBytes())), "cannot set canvas capacity bytes");
  check(env, napi_set_named_property(env, result, "peakLiveBytes",
    number(env, canvases.peakCpuBytes())), "cannot set peak canvas bytes");
  check(env, napi_set_named_property(env, result, "peakLiveCount",
    number(env, canvases.peakLiveCount())), "cannot set peak canvas count");
  check(env, napi_set_named_property(env, result, "deferredCanvasCount",
    number(env, canvases.deferredCanvasCount())), "cannot set deferred canvas count");
  check(env, napi_set_named_property(env, result, "realizedCanvasCount",
    number(env, canvases.realizedCanvasCount())), "cannot set realized canvas count");
  check(env, napi_set_named_property(env, result, "deferredCommandCount",
    number(env, canvases.deferredCommandCount())), "cannot set deferred command count");
  check(env, napi_set_named_property(env, result, "deferredCommandBytes",
    number(env, canvases.deferredCommandBytes())), "cannot set deferred command bytes");
  const auto gStats = canvases.glyphCacheStats();
  check(env, napi_set_named_property(env, result, "glyphEntries",
    number(env, gStats.glyphEntries)), "cannot set glyph entries");
  check(env, napi_set_named_property(env, result, "glyphBytes",
    number(env, gStats.glyphBytes)), "cannot set glyph bytes");
  syncExternalMemory(env);
  return result;
} catch (const std::exception& error) {
  napi_throw_error(env, nullptr, "cannot create canvas memory state");
  return nullptr;
}

napi_value canvasGlyphStats(napi_env env, napi_callback_info) try {
  const auto stats = host(env).canvases.glyphCacheStats();
  napi_value result;
  check(env, napi_create_object(env, &result), "cannot create glyph stats object");
  check(env, napi_set_named_property(env, result, "fontFaces",
    number(env, stats.fontFaces)), "cannot set fontFaces");
  check(env, napi_set_named_property(env, result, "fontStrikes",
    number(env, stats.fontStrikes)), "cannot set fontStrikes");
  check(env, napi_set_named_property(env, result, "glyphEntries",
    number(env, stats.glyphEntries)), "cannot set glyphEntries");
  check(env, napi_set_named_property(env, result, "glyphBytes",
    number(env, stats.glyphBytes)), "cannot set glyphBytes");
  check(env, napi_set_named_property(env, result, "maxGlyphBytes",
    number(env, stats.maxGlyphBytes)), "cannot set maxGlyphBytes");
  check(env, napi_set_named_property(env, result, "maxGlyphEntries",
    number(env, stats.maxGlyphEntries)), "cannot set maxGlyphEntries");
  check(env, napi_set_named_property(env, result, "glyphMetricHits",
    number(env, stats.glyphMetricHits)), "cannot set glyphMetricHits");
  check(env, napi_set_named_property(env, result, "glyphMetricMisses",
    number(env, stats.glyphMetricMisses)), "cannot set glyphMetricMisses");
  check(env, napi_set_named_property(env, result, "glyphMaskHits",
    number(env, stats.glyphMaskHits)), "cannot set glyphMaskHits");
  check(env, napi_set_named_property(env, result, "glyphMaskMisses",
    number(env, stats.glyphMaskMisses)), "cannot set glyphMaskMisses");
  check(env, napi_set_named_property(env, result, "strokeMaskHits",
    number(env, stats.strokeMaskHits)), "cannot set strokeMaskHits");
  check(env, napi_set_named_property(env, result, "strokeMaskMisses",
    number(env, stats.strokeMaskMisses)), "cannot set strokeMaskMisses");
  check(env, napi_set_named_property(env, result, "glyphEvictions",
    number(env, stats.glyphEvictions)), "cannot set glyphEvictions");
  check(env, napi_set_named_property(env, result, "freetypeLoadUs",
    number(env, stats.freetypeLoadUs)), "cannot set freetypeLoadUs");
  check(env, napi_set_named_property(env, result, "freetypeRenderUs",
    number(env, stats.freetypeRenderUs)), "cannot set freetypeRenderUs");
  check(env, napi_set_named_property(env, result, "strokeBuildUs",
    number(env, stats.strokeBuildUs)), "cannot set strokeBuildUs");
  check(env, napi_set_named_property(env, result, "glyphBlendUs",
    number(env, stats.glyphBlendUs)), "cannot set glyphBlendUs");
  return result;
} catch (const std::exception& error) {
  napi_throw_error(env, nullptr, "cannot get glyph stats");
  return nullptr;
}

napi_value setGlyphCacheLimits(napi_env env, napi_callback_info info) try {
  auto a = arguments(env, info, 2);
  host(env).canvases.setGlyphCacheLimits(asUint32(env, a.at(0)), asUint32(env, a.at(1)));
  return undefined(env);
} catch (const std::exception& error) {
  napi_throw_error(env, nullptr, error.what());
  return nullptr;
}

napi_value measureTextMetrics(napi_env env, napi_callback_info info) try {
  auto a = arguments(env, info, 3); State& value = host(env);
  auto path = value.vfs.resolve(asString(env, a.at(0)));
  auto metrics = path ? value.canvases.measureTextMetrics(*path,
    asString(env, a.at(1)), asInt32(env, a.at(2))) : std::nullopt;
  if (!metrics) throw std::runtime_error("text measurement failed");
  napi_value result; napi_create_object(env, &result);
  const auto set = [&](const char* name, int metric) {
    napi_set_named_property(env, result, name, number(env, metric));
  };
  set("width", metrics->width); set("actualBoundingBoxLeft", metrics->actualLeft);
  set("actualBoundingBoxRight", metrics->actualRight);
  set("actualBoundingBoxAscent", metrics->actualAscent);
  set("actualBoundingBoxDescent", metrics->actualDescent);
  set("fontBoundingBoxAscent", metrics->fontAscent);
  set("fontBoundingBoxDescent", metrics->fontDescent);
  return result;
} catch (const std::exception& error) {
  napi_throw_type_error(env, nullptr, error.what()); return nullptr;
}

napi_value blurCanvas(napi_env env, napi_callback_info info) try {
  auto a=arguments(env,info,1); if(!host(env).canvases.blur(asUint32(env,a.at(0)))) throw std::runtime_error("invalid canvas"); return undefined(env);
} catch(const std::exception& error){napi_throw_range_error(env,nullptr,error.what());return nullptr;}


void registerCanvasBindings(napi_env env, napi_value exports) {
  napi_value canvas = moduleObject(env);
  method(env, canvas, "create", createCanvas);
  method(env, canvas, "captureScene", captureScene);
  method(env, canvas, "captureDrawable", captureDrawable);
  method(env, canvas, "fillRect", fillRect);
  method(env, canvas, "fillRadialGradient", fillRadialGradient);
  method(env, canvas, "clear", clearCanvas);
  method(env, canvas, "clearRect", clearRect);
  method(env, canvas, "drawImage", canvasDrawImage);
  method(env, canvas, "drawText", drawText);
  method(env, canvas, "measureText", measureText);
  method(env, canvas, "measureTextMetrics", measureTextMetrics);
  method(env, canvas, "canLoadFont", canLoadFont);
  method(env, canvas, "pixel", pixel);
  method(env, canvas, "readPixels", readCanvasPixels);
  method(env, canvas, "encodePng", encodeCanvasPng);
  method(env, canvas, "writePixels", writeCanvasPixels);
  method(env, canvas, "blur", blurCanvas);
  method(env, canvas, "release", releaseCanvas);
  method(env, canvas, "memory", canvasMemory);
  method(env, canvas, "glyphStats", canvasGlyphStats);
  method(env, canvas, "setGlyphCacheLimits", setGlyphCacheLimits);
  check(env, napi_set_named_property(env, exports, "canvas", canvas), "cannot export canvas module");
}

}  // namespace pmjs::addon
