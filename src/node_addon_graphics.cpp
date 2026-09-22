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

std::vector<float> floatVector(napi_env env, napi_value input) {
  bool typed = false;
  check(env, napi_is_typedarray(env, input, &typed), "expected numeric array");
  if (typed) {
    napi_typedarray_type type;
    std::size_t length = 0;
    void* data = nullptr;
    napi_value arrayBuffer;
    std::size_t byteOffset = 0;
    check(env, napi_get_typedarray_info(env, input, &type, &length, &data,
      &arrayBuffer, &byteOffset), "invalid numeric typed array");
    if (type != napi_float32_array) {
      throw std::runtime_error("expected Float32Array");
    }
    const auto* values = static_cast<const float*>(data);
    return std::vector<float>(values, values + length);
  }
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
  std::vector<pmjs::ImageHandle> images;
  images.reserve(handles.size());
  for (const auto handle : handles) {
    auto image = resolveImage(value, handle);
    if (!image) throw std::runtime_error("invalid tile image");
    images.push_back(*image);
  }
  std::vector<pmjs::TileLayerTile> tiles;
  tiles.reserve(points.size() / 9U);
  for (std::size_t index = 0; index < points.size(); index += 9) {
    auto texture = static_cast<std::size_t>(points[index + 8]);
    if (texture >= images.size()) throw std::runtime_error("invalid texture index");
    tiles.push_back({images[texture], {points[index], points[index + 1], points[index + 4], points[index + 5]},
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

napi_value releaseTileLayer(napi_env env, napi_callback_info info) try {
  auto args = arguments(env, info, 1);
  return boolean(env, host(env).renderer.releaseTileLayer(asUint32(env, args.at(0))));
} catch (const std::exception& error) {
  napi_throw_type_error(env, nullptr, error.what()); return nullptr;
}

napi_value releaseMesh(napi_env env, napi_callback_info info) {
  return releaseTileLayer(env, info);
}

napi_value createPrimitiveSurface(napi_env env, napi_callback_info info) try {
  auto args = arguments(env, info, 2);
  if (args.size() != 2) throw std::runtime_error("primitive surface requires width and height");
  const auto surface = host(env).renderer.createPrimitiveSurface(
    asInt32(env, args[0]), asInt32(env, args[1]));
  if (!surface) throw std::runtime_error("invalid primitive surface dimensions");
  napi_value result;
  check(env, napi_create_object(env, &result), "cannot create primitive surface result");
  check(env, napi_set_named_property(env, result, "handle",
    uint32(env, surface->handle)), "cannot set primitive surface handle");
  check(env, napi_set_named_property(env, result, "image",
    imageInfo(env, surface->image.handle, surface->image.width,
      surface->image.height)), "cannot set primitive surface image");
  return result;
} catch (const std::exception& error) {
  napi_throw_range_error(env, nullptr, error.what()); return nullptr;
}

napi_value renderPrimitiveSurface(napi_env env, napi_callback_info info) try {
  auto args = arguments(env, info, 3);
  if (args.size() != 3) {
    throw std::runtime_error("primitive surface render requires handle, clear color, and records");
  }
  const auto clear = floatVector(env, args[1]);
  const auto records = floatVector(env, args[2]);
  constexpr std::size_t stride = 26;
  if (clear.size() != 4 || records.size() % stride != 0 ||
      records.size() / stride > 4096) {
    throw std::runtime_error("invalid primitive surface records");
  }
  std::vector<pmjs::PrimitiveSurfacePrimitive> primitives;
  primitives.reserve(records.size() / stride);
  for (std::size_t offset = 0; offset < records.size(); offset += stride) {
    pmjs::PrimitiveSurfacePrimitive primitive;
    const int kind = static_cast<int>(records[offset]);
    const int stopCount = static_cast<int>(records[offset + 9]);
    const int blendMode = static_cast<int>(records[offset + 25]);
    if (kind < 0 || kind > 1 || stopCount < 1 || stopCount > 3 ||
        blendMode < 0 || blendMode > 1) {
      throw std::runtime_error("invalid primitive surface primitive");
    }
    primitive.kind = static_cast<pmjs::PrimitiveSurfacePrimitive::Kind>(kind);
    std::copy_n(records.begin() + offset + 1, 4, primitive.bounds.begin());
    std::copy_n(records.begin() + offset + 5, 2, primitive.center.begin());
    std::copy_n(records.begin() + offset + 7, 2, primitive.radii.begin());
    primitive.stopCount = static_cast<std::uint8_t>(stopCount);
    std::copy_n(records.begin() + offset + 10, 3, primitive.offsets.begin());
    for (std::size_t stop = 0; stop < 3; ++stop) {
      std::copy_n(records.begin() + offset + 13 + stop * 4, 4,
                  primitive.colors[stop].begin());
    }
    primitive.composition = static_cast<pmjs::PrimitiveComposition>(blendMode);
    primitives.push_back(primitive);
  }
  if (!host(env).renderer.renderPrimitiveSurface(asUint32(env, args[0]),
      {clear[0], clear[1], clear[2], clear[3]}, primitives)) {
    throw std::runtime_error("cannot render primitive surface");
  }
  return undefined(env);
} catch (const std::exception& error) {
  napi_throw_range_error(env, nullptr, error.what()); return nullptr;
}

napi_value releasePrimitiveSurface(napi_env env, napi_callback_info info) try {
  auto args = arguments(env, info, 1);
  return boolean(env,
    host(env).renderer.releasePrimitiveSurface(asUint32(env, args.at(0))));
} catch (const std::exception& error) {
  napi_throw_type_error(env, nullptr, error.what()); return nullptr;
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
  auto args = arguments(env, info, 2);
  if (args.size() != 2) throw std::runtime_error("invalid screen render size");
  const int width = asInt32(env, args[0]);
  const int height = asInt32(env, args[1]);
  State& value = host(env);
  if (!value.renderer.setScreenRenderSize(width, height)) {
    throw std::runtime_error("invalid screen render size");
  }
  value.width = width;
  value.height = height;
  return undefined(env);
} catch (const std::exception& error) {
  napi_throw_range_error(env, nullptr, error.what());
  return nullptr;
}

napi_value presentationGeometry(napi_env env, napi_callback_info) try {
  State& value = host(env);
  value.core.syncDrawableSize();
  const auto geometry = value.renderer.presentationGeometry();
  napi_value result;
  check(env, napi_create_object(env, &result), "cannot create presentation geometry");
  check(env, napi_set_named_property(env, result, "sourceWidth",
    number(env, geometry.sourceWidth)), "cannot set source width");
  check(env, napi_set_named_property(env, result, "sourceHeight",
    number(env, geometry.sourceHeight)), "cannot set source height");
  check(env, napi_set_named_property(env, result, "drawableWidth",
    number(env, geometry.drawableWidth)), "cannot set drawable width");
  check(env, napi_set_named_property(env, result, "drawableHeight",
    number(env, geometry.drawableHeight)), "cannot set drawable height");
  check(env, napi_set_named_property(env, result, "viewportX",
    number(env, geometry.viewportX)), "cannot set viewport x");
  check(env, napi_set_named_property(env, result, "viewportY",
    number(env, geometry.viewportY)), "cannot set viewport y");
  check(env, napi_set_named_property(env, result, "viewportWidth",
    number(env, geometry.viewportWidth)), "cannot set viewport width");
  check(env, napi_set_named_property(env, result, "viewportHeight",
    number(env, geometry.viewportHeight)), "cannot set viewport height");
  check(env, napi_set_named_property(env, result, "scale",
    string(env, geometry.scaleMode == PresentScaleMode::integer ?
      "integer" : "fit")), "cannot set scale mode");
  check(env, napi_set_named_property(env, result, "filter",
    string(env, geometry.filter == PresentFilter::linear ?
      "linear" : "nearest")), "cannot set present filter");
  const bool letterboxed = geometry.viewportWidth < geometry.drawableWidth ||
      geometry.viewportHeight < geometry.drawableHeight;
  check(env, napi_set_named_property(env, result, "letterboxed",
    boolean(env, letterboxed)), "cannot set letterboxed flag");
  return result;
} catch(const std::exception& error){napi_throw_error(env,nullptr,error.what());return nullptr;}

void registerGraphicsBindings(napi_env env, napi_value exports) {
  napi_value render = moduleObject(env);
  method(env, render, "setClearColor", setClearColor);
  method(env, render, "setRenderTargetSize", setRenderTargetSize);
  method(env, render, "setScreenRenderSize", setScreenRenderSize);
  method(env, render, "quad", quad);
  method(env, render, "image", drawImage);
  method(env, render, "createTileLayer", createTileLayer);
  method(env, render, "releaseTileLayer", releaseTileLayer);
  method(env, render, "createMesh", createMesh);
  method(env, render, "releaseMesh", releaseMesh);
  method(env, render, "createPrimitiveSurface", createPrimitiveSurface);
  method(env, render, "renderPrimitiveSurface", renderPrimitiveSurface);
  method(env, render, "releasePrimitiveSurface", releasePrimitiveSurface);
  napi_value primitiveSurfaceSchema = moduleObject(env);
  napi_set_named_property(env, primitiveSurfaceSchema, "recordStride", uint32(env, 26));
  napi_set_named_property(env, primitiveSurfaceSchema, "maxStops", uint32(env, 3));
  napi_set_named_property(env, primitiveSurfaceSchema, "maxPrimitives", uint32(env, 4096));
  napi_value primitiveKinds = moduleObject(env);
  napi_set_named_property(env, primitiveKinds, "solidRect", uint32(env, 0));
  napi_set_named_property(env, primitiveKinds, "concentricRadialGradient", uint32(env, 1));
  napi_set_named_property(env, primitiveSurfaceSchema, "kinds", primitiveKinds);
  napi_value primitiveCompositions = moduleObject(env);
  napi_set_named_property(env, primitiveCompositions, "sourceOver", uint32(env, 0));
  napi_set_named_property(env, primitiveCompositions, "additive", uint32(env, 1));
  napi_set_named_property(env, primitiveSurfaceSchema, "compositions",
                          primitiveCompositions);
  napi_set_named_property(env, render, "primitiveSurfaceSchema",
                          primitiveSurfaceSchema);
  method(env, render, "renderToCanvas", renderToCanvas);
  method(env, render, "renderToImage", renderToImage);
  method(env, render, "presentation", presentationGeometry);
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
