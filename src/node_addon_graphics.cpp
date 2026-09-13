#include "node_addon_internal.hpp"

namespace pmjs::addon {
napi_value setClearColor(napi_env env, napi_callback_info info) try {
  auto args = arguments(env, info, 4);
  if (args.size() != 4) throw std::runtime_error("setClearColor requires rgba");
  host(env).renderer.setClearColor(asNumber(env, args[0]), asNumber(env, args[1]),
                                   asNumber(env, args[2]), asNumber(env, args[3]));
  return undefined(env);
} catch (const std::exception& error) {
  napi_throw_type_error(env, nullptr, error.what()); return nullptr;
}

napi_value setRenderTargetSize(napi_env env, napi_callback_info info) try {
  auto args = arguments(env, info, 2);
  if (args.size() != 2 || !host(env).renderer.setRenderTargetSize(
      asInt32(env, args[0]), asInt32(env, args[1]))) {
    throw std::runtime_error("invalid render target dimensions");
  }
  return undefined(env);
} catch (const std::exception& error) {
  napi_throw_range_error(env, nullptr, error.what()); return nullptr;
}

napi_value quad(napi_env env, napi_callback_info info) try {
  auto args = arguments(env, info, 8);
  if (args.size() != 8) throw std::runtime_error("quad requires x,y,w,h,rgba");
  host(env).renderer.queueQuad(asNumber(env, args[0]), asNumber(env, args[1]),
    asNumber(env, args[2]), asNumber(env, args[3]),
    {static_cast<float>(asNumber(env, args[4])), static_cast<float>(asNumber(env, args[5])),
     static_cast<float>(asNumber(env, args[6])), static_cast<float>(asNumber(env, args[7]))});
  return undefined(env);
} catch (const std::exception& error) {
  napi_throw_type_error(env, nullptr, error.what()); return nullptr;
}

napi_value drawImage(napi_env env, napi_callback_info info) try {
  auto args = arguments(env, info, 14);
  if (args.size() < 13) throw std::runtime_error("image requires render arguments");
  State& value = host(env);
  auto image = resolveImage(value, asUint32(env, args[0]));
  bool ok = image && value.renderer.queueImage(*image, floatArray<6>(env, args, 1),
    floatArray<4>(env, args, 7), static_cast<float>(asNumber(env, args[11])),
    asUint32(env, args[12]), args.size() > 13
      ? asBlendMode(env, args[13]) : pmjs::BlendMode::normal);
  if (!ok) throw std::runtime_error("invalid image handle");
  return undefined(env);
} catch (const std::exception& error) {
  napi_throw_range_error(env, nullptr, error.what()); return nullptr;
}

napi_value drawTiled(napi_env env, napi_callback_info info) try {
  auto args = arguments(env, info, 16);
  if (args.size() != 16) throw std::runtime_error("tiled requires render arguments");
  State& value = host(env);
  auto image = resolveImage(value, asUint32(env, args[0]));
  bool ok = image && value.renderer.queueTiled(*image, floatArray<6>(env, args, 1),
    floatArray<4>(env, args, 7), floatArray<2>(env, args, 11),
    static_cast<float>(asNumber(env, args[13])), asUint32(env, args[14]),
    asBlendMode(env, args[15]));
  if (!ok) throw std::runtime_error("invalid tiled image");
  return undefined(env);
} catch (const std::exception& error) {
  napi_throw_range_error(env, nullptr, error.what()); return nullptr;
}

std::vector<float> floatVector(napi_env env, napi_value input) {
  std::uint32_t length = 0;
  check(env, napi_get_array_length(env, input, &length), "expected numeric array");
  std::vector<float> result;
  result.reserve(length);
  for (std::uint32_t index = 0; index < length; ++index) {
    napi_value item; napi_get_element(env, input, index, &item);
    result.push_back(static_cast<float>(asNumber(env, item)));
  }
  return result;
}

std::vector<std::uint32_t> uintVector(napi_env env, napi_value input) {
  std::uint32_t length = 0;
  check(env, napi_get_array_length(env, input, &length), "expected handle array");
  std::vector<std::uint32_t> result;
  result.reserve(length);
  for (std::uint32_t index = 0; index < length; ++index) {
    napi_value item; napi_get_element(env, input, index, &item);
    result.push_back(asUint32(env, item));
  }
  return result;
}

napi_value createTileLayer(napi_env env, napi_callback_info info) try {
  auto args = arguments(env, info, 2);
  auto points = floatVector(env, args.at(0));
  auto handles = uintVector(env, args.at(1));
  if (points.size() % 9 != 0) throw std::runtime_error("invalid tile records");
  State& value = host(env);
  std::vector<pmjs::TileLayerTile> tiles;
  for (std::size_t index = 0; index < points.size(); index += 9) {
    auto texture = static_cast<std::size_t>(points[index + 8]);
    if (texture >= handles.size()) throw std::runtime_error("invalid texture index");
    auto image = resolveImage(value, handles[texture]);
    if (!image) throw std::runtime_error("invalid tile image");
    tiles.push_back({*image, {points[index], points[index + 1], points[index + 4], points[index + 5]},
      {points[index + 2], points[index + 3]}, {points[index + 6], points[index + 7]}});
  }
  return uint32(env, value.renderer.createTileLayer(std::move(tiles)));
} catch (const std::exception& error) {
  napi_throw_range_error(env, nullptr, error.what()); return nullptr;
}

napi_value createMesh(napi_env env, napi_callback_info info) try {
  auto args = arguments(env, info, 5);
  if (args.size() != 5) throw std::runtime_error("createMesh requires five arguments");
  State& value = host(env);
  const auto image = resolveImage(value, asUint32(env, args[0]));
  if (!image) throw std::runtime_error("invalid mesh image");
  const auto mesh = value.renderer.createMesh(*image, floatVector(env, args[1]),
    floatVector(env, args[2]), uintVector(env, args[3]),
    asUint32(env, args[4]) == 0);
  if (!mesh) throw std::runtime_error("invalid mesh geometry");
  return uint32(env, mesh);
} catch (const std::exception& error) {
  napi_throw_range_error(env, nullptr, error.what()); return nullptr;
}

napi_value drawTileLayer(napi_env env, napi_callback_info info) try {
  auto args = arguments(env, info, 12);
  bool ok = host(env).renderer.queueTileLayer(asUint32(env, args.at(0)),
    floatArray<6>(env, args, 1), floatArray<2>(env, args, 7),
    asNumber(env, args.at(9)), asUint32(env, args.at(10)),
    asBlendMode(env, args.at(11)));
  if (!ok) throw std::runtime_error("invalid tile layer");
  return undefined(env);
} catch (const std::exception& error) {
  napi_throw_range_error(env, nullptr, error.what()); return nullptr;
}

napi_value releaseTileLayer(napi_env env, napi_callback_info info) try {
  auto args = arguments(env, info, 1);
  return boolean(env, host(env).renderer.releaseTileLayer(asUint32(env, args.at(0))));
} catch (const std::exception& error) {
  napi_throw_type_error(env, nullptr, error.what()); return nullptr;
}

napi_value releaseMesh(napi_env env, napi_callback_info info) {
  return releaseTileLayer(env, info);
}

napi_value renderToCanvas(napi_env env, napi_callback_info info) try {
  auto args = arguments(env, info, 1);
  State& value = host(env);
  const auto target = value.canvases.info(asUint32(env, args.at(0)));
  if (!target) throw std::runtime_error("invalid render target canvas");
  value.canvases.uploadDirty();
  const bool written = value.canvases.writePixels(
      asUint32(env, args.at(0)), 0, 0, target->width, target->height,
      value.renderer.renderToRgba(target->width, target->height));
  value.renderer.beginFrame();
  if (!written) {
    throw std::runtime_error("could not write native render target");
  }
  return undefined(env);
} catch (const std::exception& error) {
  napi_throw_range_error(env, nullptr, error.what()); return nullptr;
}

napi_value renderToImage(napi_env env, napi_callback_info info) try {
  auto args = arguments(env, info, 2);
  if (args.size() != 2) {
    throw std::runtime_error("renderToImage requires width and height");
  }
  State& value = host(env);
  value.canvases.uploadDirty();
  const auto image = value.renderer.renderToImage(
    asInt32(env, args[0]), asInt32(env, args[1]));
  value.renderer.beginFrame();
  if (!image) throw std::runtime_error("could not create GPU render image");
  return imageInfo(env, image->handle, image->width, image->height);
} catch (const std::exception& error) {
  napi_throw_range_error(env, nullptr, error.what()); return nullptr;
}

napi_value submitScene(napi_env env, napi_callback_info info) try {
  auto args = arguments(env, info, 4);
  if (args.size() != 4) {
    throw std::runtime_error("scene submit requires version, two typed arrays, and count");
  }
  napi_typedarray_type metadataType;
  napi_typedarray_type valueType;
  std::size_t metadataCount = 0;
  std::size_t valueCount = 0;
  void* metadataData = nullptr;
  void* valueData = nullptr;
  napi_value metadataBuffer;
  napi_value valueBuffer;
  std::size_t metadataOffset = 0;
  std::size_t valueOffset = 0;
  const auto packetVersion = asUint32(env, args[0]);
  check(env, napi_get_typedarray_info(env, args[1], &metadataType,
    &metadataCount, &metadataData, &metadataBuffer, &metadataOffset),
    "invalid scene metadata");
  check(env, napi_get_typedarray_info(env, args[2], &valueType,
    &valueCount, &valueData, &valueBuffer, &valueOffset),
    "invalid scene values");
  if (metadataType != napi_uint32_array || valueType != napi_float32_array) {
    throw std::runtime_error("scene submit requires Uint32Array and Float32Array");
  }
  const std::size_t nodeCount = asUint32(env, args[3]);
  if (packetVersion != pmjs::scene_packet::version) {
    throw std::runtime_error("unsupported scene packet version");
  }
  if (metadataCount < nodeCount * pmjs::scene_packet::metadataStride ||
      valueCount < nodeCount * pmjs::scene_packet::valueStride) {
    throw std::runtime_error("scene packet buffers are too short for node count");
  }
  State& value = host(env);
  if (!value.core.submitScene(packetVersion,
      static_cast<const std::uint32_t*>(metadataData), metadataCount,
      static_cast<const float*>(valueData), valueCount, nodeCount)) {
    throw std::runtime_error("invalid native scene packet");
  }
  return undefined(env);
} catch (const std::exception& error) {
  napi_throw_range_error(env, nullptr, error.what());
  return nullptr;
}

napi_value setScreenRenderSize(napi_env env, napi_callback_info info) try {
  auto args=arguments(env,info,2);
  if (args.size()!=2 || !host(env).renderer.setScreenRenderSize(
      asInt32(env,args[0]),asInt32(env,args[1]))) {
    throw std::runtime_error("invalid screen render size");
  }
  return undefined(env);
} catch(const std::exception& error){napi_throw_range_error(env,nullptr,error.what());return nullptr;}

void registerGraphicsBindings(napi_env env, napi_value exports) {
  napi_value render = moduleObject(env);
  method(env, render, "setClearColor", setClearColor);
  method(env, render, "setRenderTargetSize", setRenderTargetSize);
  method(env, render, "setScreenRenderSize", setScreenRenderSize);
  method(env, render, "quad", quad);
  method(env, render, "image", drawImage);
  method(env, render, "tiled", drawTiled);
  method(env, render, "createTileLayer", createTileLayer);
  method(env, render, "drawTileLayer", drawTileLayer);
  method(env, render, "releaseTileLayer", releaseTileLayer);
  method(env, render, "createMesh", createMesh);
  method(env, render, "releaseMesh", releaseMesh);
  method(env, render, "renderToCanvas", renderToCanvas);
  method(env, render, "renderToImage", renderToImage);
  method(env, render, "stats", rendererStats);
  napi_value scene = moduleObject(env);
  method(env, scene, "submit", submitScene);
  napi_set_named_property(env, scene, "packetVersion", uint32(env, pmjs::scene_packet::version));
  napi_value schema = moduleObject(env);
  napi_set_named_property(env, schema, "version", uint32(env, pmjs::scene_packet::version));
  napi_set_named_property(env, schema, "metadataStride", uint32(env, pmjs::scene_packet::metadataStride));
  napi_set_named_property(env, schema, "valueStride", uint32(env, pmjs::scene_packet::valueStride));
  napi_set_named_property(env, schema, "maxNodes", uint32(env, pmjs::scene_packet::maxNodes));
  napi_set_named_property(env, schema, "maxPacketBytes", uint32(env, pmjs::scene_packet::maxPacketBytes));
  napi_set_named_property(env, schema, "transactionalSubmit", boolean(env, true));
  napi_set_named_property(env, scene, "schema", schema);
  check(env, napi_set_named_property(env, exports, "render", render), "cannot export render module");
  check(env, napi_set_named_property(env, exports, "scene", scene), "cannot export scene module");
}

}  // namespace pmjs::addon
