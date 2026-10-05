#include "node_addon_internal.hpp"
#include <GLES3/gl3.h>
#include <cmath>

namespace pmjs::addon {
std::vector<float> floatVector(napi_env env, napi_value input);

napi_value graphicsInfo(napi_env env, napi_callback_info) try {
  host(env);
  napi_value result;
  check(env, napi_create_object(env, &result), "cannot create graphics info");
  const auto setText = [&](const char* key, GLenum parameter) {
    const auto* value = glGetString(parameter);
    check(env, napi_set_named_property(env, result, key,
      string(env, value ? reinterpret_cast<const char*>(value) : "unknown")),
      "cannot set graphics string");
  };
  const auto setBits = [&](const char* key, GLenum parameter) {
    GLint value = 0;
    glGetIntegerv(parameter, &value);
    check(env, napi_set_named_property(env, result, key,
      number(env, value)), "cannot set graphics channel bits");
  };
  setText("vendor", GL_VENDOR);
  setText("renderer", GL_RENDERER);
  setText("version", GL_VERSION);
  setText("shadingLanguageVersion", GL_SHADING_LANGUAGE_VERSION);
  setBits("redBits", GL_RED_BITS);
  setBits("greenBits", GL_GREEN_BITS);
  setBits("blueBits", GL_BLUE_BITS);
  setBits("alphaBits", GL_ALPHA_BITS);
  setBits("maxVaryingVectors", GL_MAX_VARYING_VECTORS);
  check(env, napi_set_named_property(env, result, "sceneFormat",
    string(env, "RGBA8")), "cannot set scene format");
  return result;
} catch (const std::exception& error) {
  napi_throw_error(env, nullptr, error.what()); return nullptr;
}

napi_value setClearColor(napi_env env, napi_callback_info info) try {
  auto args = arguments(env, info, 4);
  if (args.size() != 4) throw std::runtime_error("setClearColor requires rgba");
  host(env).renderer.setClearColor(asNumber(env, args[0]), asNumber(env, args[1]),
                                   asNumber(env, args[2]), asNumber(env, args[3]));
  return undefined(env);
} catch (const std::exception& error) {
  napi_throw_type_error(env, nullptr, error.what()); return nullptr;
}

napi_value clearScene(napi_env env, napi_callback_info info) try {
  auto args = arguments(env, info, 8);
  if (args.size() != 4 && args.size() != 8)
    throw std::runtime_error("clearScene requires rgba and an optional pixel rectangle");
  std::optional<std::array<int, 4>> clip;
  if (args.size() == 8) {
    clip = std::array<int, 4>{asInt32(env, args[4]), asInt32(env, args[5]),
            asInt32(env, args[6]), asInt32(env, args[7])};
  }
  host(env).renderer.clearScene(asNumber(env, args[0]), asNumber(env, args[1]),
                                asNumber(env, args[2]), asNumber(env, args[3]), clip);
  return undefined(env);
} catch (const std::exception& error) {
  napi_throw_type_error(env, nullptr, error.what()); return nullptr;
}

napi_value setPresentationViewport(napi_env env, napi_callback_info info) try {
  auto args = arguments(env, info, 3);
  host(env).renderer.setPresentationViewport(asUint32(env, args.at(0)), asUint32(env, args.at(1)),
    asUint32(env, args.at(2)));
  return undefined(env);
} catch (const std::exception& error) {
  napi_throw_range_error(env, nullptr, error.what()); return nullptr;
}

napi_value setClearBeforeRender(napi_env env, napi_callback_info info) try {
  auto args = arguments(env, info, 1);
  host(env).renderer.setClearBeforeRender(asBoolean(env, args.at(0)));
  return undefined(env);
} catch (const std::exception& error) {
  napi_throw_type_error(env, nullptr, error.what()); return nullptr;
}

napi_value setSceneProjection(napi_env env, napi_callback_info info) try {
  auto args = arguments(env, info, 1);
  const auto values = floatVector(env, args.at(0));
  if (values.size() != 6) throw std::invalid_argument("scene projection requires six coefficients");
  std::array<float, 6> transform;
  std::copy(values.begin(), values.end(), transform.begin());
  host(env).renderer.setSceneProjection(transform);
  return undefined(env);
} catch (const std::exception& error) {
  napi_throw_type_error(env, nullptr, error.what()); return nullptr;
}

napi_value configurePixiFragmentPrecision(napi_env env, napi_callback_info info) try {
  auto args = arguments(env, info, 1);
  if (args.empty()) {
    throw std::invalid_argument("configurePixiFragmentPrecision requires a precision");
  }
  host(env).renderer.configurePixiFragmentPrecision(asString(env, args[0]));
  return undefined(env);
} catch (const std::exception& error) {
  napi_throw_type_error(env, nullptr, error.what()); return nullptr;
}

napi_value createFilterProgram(napi_env env, napi_callback_info info) try {
  const auto args = arguments(env, info, 2);
  if (args.empty()) throw std::invalid_argument("createFilterProgram requires fragment source");
  auto& renderer = host(env).renderer;
  const auto handle = renderer.createFilterProgram(asString(env, args[0]),
    args.size() > 1 ? asString(env, args[1]) : "");
  const auto& program = renderer.filterProgram(handle);
  napi_value result = moduleObject(env);
  check(env, napi_set_named_property(env, result, "handle", number(env, handle)),
    "cannot set filter handle");
  napi_value uniforms;
  check(env, napi_create_array_with_length(env, program.uniforms.size(), &uniforms),
    "cannot create filter uniforms");
  for (std::size_t index = 0; index < program.uniforms.size(); ++index) {
    const auto& uniform = program.uniforms[index];
    napi_value entry = moduleObject(env);
    std::string name = uniform.name;
    if (name.ends_with("[0]")) name.resize(name.size() - 3);
    check(env, napi_set_named_property(env, entry, "name", string(env, name)),
      "cannot set uniform name");
    check(env, napi_set_named_property(env, entry, "size",
      number(env, uniform.components * uniform.count)), "cannot set uniform size");
    check(env, napi_set_named_property(env, entry, "sampler",
      boolean(env, uniform.type == GL_SAMPLER_2D)), "cannot set uniform type");
    check(env, napi_set_element(env, uniforms, index, entry), "cannot set filter uniform");
  }
  check(env, napi_set_named_property(env, result, "uniforms", uniforms),
    "cannot set filter uniforms");
  return result;
} catch (const std::exception& error) {
  napi_throw_error(env, nullptr, error.what()); return nullptr;
}

napi_value createFilterPlan(napi_env env, napi_callback_info info) try {
  const auto args = arguments(env, info, 1);
  if (args.empty()) throw std::invalid_argument("createFilterPlan requires a plan");
  auto& value = host(env);
  auto plan = std::make_shared<CustomFilterPlan>();
  const auto elements = [&](napi_value array, std::size_t limit) {
    std::uint32_t count = 0;
    check(env, napi_get_array_length(env, array, &count), "filter plan requires arrays");
    if (count > limit) throw std::invalid_argument("filter plan capacity exceeded");
    std::vector<napi_value> result(count);
    for (std::uint32_t i = 0; i < count; ++i)
      check(env, napi_get_element(env, array, i, &result[i]), "cannot read filter plan");
    return result;
  };
  const auto finite = [&](napi_value number) {
    const double result = asNumber(env, number);
    if (!std::isfinite(result) || std::abs(result) > 1e30)
      throw std::invalid_argument("invalid filter plan number");
    return result;
  };
  const auto frame = elements(property(env, args[0], "frame"), 4);
  if (frame.size() != 4) throw std::invalid_argument("filter frame requires four values");
  for (std::size_t i = 0; i < 4; ++i) plan->frame[i] = finite(frame[i]);
  if (std::abs(plan->frame[0]) > 65536 || std::abs(plan->frame[1]) > 65536 ||
      plan->frame[2] < 0 || plan->frame[3] < 0 ||
      plan->frame[2] > 65536 || plan->frame[3] > 65536)
    throw std::invalid_argument("invalid filter frame");
  for (auto item : elements(property(env, args[0], "resolutions"), 64)) {
    const float resolution = finite(item);
    if (resolution <= 0 || resolution > 16) throw std::invalid_argument("invalid filter resolution");
    plan->resolutions.push_back(resolution);
  }
  if (plan->resolutions.size() < 2) throw std::invalid_argument("filter plan requires input and output");
  for (auto item : elements(property(env, args[0], "passes"), 256)) {
    CustomFilterPass pass;
    pass.program = asUint32(env, property(env, item, "program"));
    const auto& program = value.renderer.filterProgram(pass.program);
    pass.input = asUint32(env, property(env, item, "input"));
    pass.output = asUint32(env, property(env, item, "output"));
    pass.clear = asBoolean(env, property(env, item, "clear"));
    pass.blend = asBlendMode(env, property(env, item, "blend"));
    if (hasProperty(env, item, "transform")) {
      const auto transform = elements(property(env, item, "transform"), 6);
      if (transform.size() != 6) throw std::invalid_argument("invalid filter transform");
      for (std::size_t i = 0; i < 6; ++i) pass.transform[i] = finite(transform[i]);
    }
    if (pass.input >= plan->resolutions.size() || pass.output >= plan->resolutions.size() ||
        pass.input == pass.output || pass.input == 1)
      throw std::invalid_argument("invalid filter pass targets");
    for (auto component : elements(property(env, item, "uniforms"), 4096))
      pass.uniforms.push_back(finite(component));
    for (auto sampler : elements(property(env, item, "samplers"), 32)) {
      CustomFilterPass::Sampler binding;
      binding.image = asUint32(env, property(env, sampler, "image"));
      binding.target = asUint32(env, property(env, sampler, "target"));
      binding.nearest = hasProperty(env, sampler, "nearest") && asBoolean(env, property(env, sampler, "nearest"));
      binding.mipmap = hasProperty(env, sampler, "mipmap") && asBoolean(env, property(env, sampler, "mipmap"));
      if (hasProperty(env, sampler, "wrap")) binding.wrap = asUint32(env, property(env, sampler, "wrap"));
      if (binding.wrap != GL_CLAMP_TO_EDGE && binding.wrap != GL_REPEAT && binding.wrap != GL_MIRRORED_REPEAT)
        throw std::invalid_argument("invalid filter sampler wrap mode");
      if (binding.image) {
        const auto image = resolveImage(value, binding.image);
        if (!image) throw std::invalid_argument("invalid filter sampler image");
        binding.image = *image;
      } else if (binding.target >= plan->resolutions.size() || binding.target == 1 ||
                 binding.target == pass.output) {
        throw std::invalid_argument("invalid filter sampler target");
      }
      pass.samplers.push_back(binding);
    }
    std::size_t components = 0, samplers = 0;
    for (const auto& uniform : program.uniforms) {
      if (uniform.type == GL_SAMPLER_2D) samplers += uniform.count;
      else components += uniform.components * uniform.count;
    }
    GLint textureUnits = 0;
    glGetIntegerv(GL_MAX_TEXTURE_IMAGE_UNITS, &textureUnits);
    if (components != pass.uniforms.size() || samplers != pass.samplers.size() ||
        samplers + 1 > static_cast<std::size_t>(textureUnits))
      throw std::invalid_argument("invalid filter uniform or sampler count");
    plan->passes.push_back(std::move(pass));
  }
  const auto handle = value.renderer.registerFilterPlan(plan);
  napi_value result = moduleObject(env);
  check(env, napi_set_named_property(env, result, "handle", uint32(env, handle)), "cannot set filter plan handle");
  auto owner = std::make_unique<std::shared_ptr<CustomFilterPlan>>(plan);
  check(env, napi_add_finalizer(env, result, owner.get(),
    [](napi_env, void* data, void*) { delete static_cast<std::shared_ptr<CustomFilterPlan>*>(data); },
    nullptr, nullptr), "cannot retain filter plan");
  owner.release();
  return result;
} catch (const std::exception& error) {
  napi_throw_error(env, nullptr, error.what()); return nullptr;
}

napi_value setPresentationLayers(napi_env env, napi_callback_info info) try {
  auto args = arguments(env, info, 5);
  if (args.size() != 5) {
    throw std::runtime_error("setPresentationLayers requires five arguments");
  }
  State& value = host(env);
  const auto resolveOptionalImage = [&value, env](napi_value argument) {
    const auto handle = asUint32(env, argument);
    if (!handle) return pmjs::ImageHandle{0};
    if (!value.images.lookup(handle)) {
      throw std::runtime_error("invalid presentation image handle");
    }
    return static_cast<pmjs::ImageHandle>(handle);
  };
  const auto resolveOptionalCanvas = [&value, env](napi_value argument) {
    const auto handle = asUint32(env, argument);
    if (!handle) return pmjs::ImageHandle{0};
    const auto image = value.canvases.prepareImage(handle);
    if (!image) throw std::runtime_error("invalid presentation canvas handle");
    return *image;
  };
  if (!value.renderer.setPresentationLayers(
      static_cast<float>(asNumber(env, args[0])),
      resolveOptionalImage(args[1]), static_cast<float>(asNumber(env, args[2])),
      resolveOptionalCanvas(args[3]), static_cast<float>(asNumber(env, args[4])))) {
    throw std::runtime_error("could not retain presentation image handle");
  }
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

pmjs::AlphaMode imageAlphaMode(napi_env env, napi_value options) {
  napi_valuetype type;
  check(env, napi_typeof(env, options, &type), "invalid alpha options");
  if (type != napi_object) throw std::runtime_error("alphaMode requires an options object");
  if (!hasProperty(env, options, "alphaMode")) return pmjs::AlphaMode::straight;
  const auto mode = asString(env, property(env, options, "alphaMode"));
  if (mode == "straight") return pmjs::AlphaMode::straight;
  if (mode == "premultiplied") return pmjs::AlphaMode::premultiplied;
  throw std::runtime_error("alphaMode must be straight or premultiplied");
}

napi_value createMeshResource(napi_env env, const std::vector<napi_value>& args,
                            const pmjs::MeshMaterial& material) {
  State& value = host(env);
  const auto image = resolveImage(value, asUint32(env, args[0]));
  if (!image) throw std::runtime_error("invalid mesh image");
  const auto mesh = value.renderer.createMesh(*image, floatVector(env, args[1]),
    floatVector(env, args[2]), uintVector(env, args[3]), asUint32(env, args[4]) == 0, material);
  if (!mesh) throw std::runtime_error("invalid mesh geometry or material");
  return uint32(env, mesh);
}

napi_value createMesh(napi_env env, napi_callback_info info) try {
  auto args = arguments(env, info, 6);
  if (args.size() != 5) throw std::runtime_error("createMesh requires exactly five geometry arguments");
  return createMeshResource(env, args, pmjs::TexturedMeshMaterial{});
} catch (const std::exception& error) {
  napi_throw_range_error(env, nullptr, error.what()); return nullptr;
}

napi_value createMppBitmapMesh(napi_env env, napi_callback_info info) try {
  auto args = arguments(env, info, 6);
  if (args.size() != 6) throw std::runtime_error("MPP bitmap mesh requires geometry and raster options");
  if (hasProperty(env, args[5], "rasterRule")) throw std::runtime_error("triangle raster rule is encoded in coefficients");
  pmjs::TriangleBitmapMaterial material;
  const auto coefficients = floatVector(env, property(env, args[5], "coefficients"));
  if (coefficients.size() != material.coefficients.size()) throw std::runtime_error("invalid compiled triangle coefficients");
  std::copy(coefficients.begin(), coefficients.end(), material.coefficients.begin());
  const float compiledMode = material.coefficients[29];
  if (!std::isfinite(compiledMode) || compiledMode < 0 || compiledMode > 31 ||
      compiledMode != std::floor(compiledMode)) throw std::runtime_error("invalid triangle raster mode");
  const auto modeBits = static_cast<unsigned>(compiledMode) & 24U;
  if (modeBits == 24U) material.rasterRule = pmjs::TriangleBitmapMaterial::RasterRule::canvasFourSample;
  return createMeshResource(env, args, material);
} catch (const std::exception& error) {
  napi_throw_range_error(env, nullptr, error.what()); return nullptr;
}

napi_value createMvBitmapMesh(napi_env env, napi_callback_info info) try {
  auto args = arguments(env, info, 6);
  if (args.size() != 6) throw std::runtime_error("MV bitmap mesh requires geometry and bitmap options");
  pmjs::MvBitmapMaterial material;
  const auto bounds = floatVector(env, property(env, args[5], "texelBounds"));
  if (bounds.size() != 4) throw std::runtime_error("invalid MV bitmap texel bounds");
  std::copy(bounds.begin(), bounds.end(), material.texelBounds.begin());
  material.alphaMode = imageAlphaMode(env, args[5]);
  return createMeshResource(env, args, material);
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

napi_value clearImageTriangles(napi_env env, napi_callback_info info) try {
  auto args = arguments(env, info, 4);
  if (args.size() < 2) throw std::runtime_error("image triangle clear requires an image and points");
  if (!host(env).renderer.clearImageTriangles(asUint32(env, args[0]), floatVector(env, args[1]),
      args.size() > 2 ? floatVector(env, args[2]) : std::vector<float>{},
      args.size() > 3 ? floatVector(env, args[3]) : std::vector<float>{})) {
    throw std::runtime_error("triangle clear requires a live GPU-only image and finite triangle coordinates");
  }
  return undefined(env);
} catch (const std::exception& error) {
  napi_throw_range_error(env, nullptr, error.what()); return nullptr;
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
  auto args = arguments(env, info, 4);
  State& value = host(env);
  const auto target = value.canvases.info(asUint32(env, args.at(0)));
  if (!target) throw std::runtime_error("invalid render target canvas");
  value.canvases.uploadDirty();
  const bool clear = args.size() < 2 || asBoolean(env, args[1]);
  const bool retainImage = args.size() > 2 && asBoolean(env, args[2]);
  std::optional<pmjs::ImageHandle> initialImage;
  if (!clear) {
    const auto previous = args.size() > 3 ? asUint32(env, args[3]) : 0;
    initialImage = previous ? std::optional<pmjs::ImageHandle>{previous} :
      value.canvases.prepareImage(asUint32(env, args[0]));
  }
  if (!clear && !initialImage) throw std::runtime_error("cannot restore render target canvas");
  if (initialImage) {
    const auto image = value.images.lookup(*initialImage);
    if (!image || image->width != target->width || image->height != target->height)
      throw std::runtime_error("render target backing must match the canvas");
  }
  const bool written = value.canvases.replacePixels(
    asUint32(env, args.at(0)),
    value.renderer.renderToRgba(target->width, target->height, initialImage.value_or(0), AlphaMode::premultiplied),
    PixelEncoding::PremultipliedRGBA8);
  value.renderer.beginFrame();
  if (!written) {
    throw std::runtime_error("could not write native render target");
  }
  if (retainImage) {
    const auto image = value.renderer.captureOffscreenImage();
    if (!image) throw std::runtime_error("could not retain render target image");
    return imageInfo(env, image->handle, image->width, image->height);
  }
  return undefined(env);
} catch (const std::exception& error) {
  napi_throw_range_error(env, nullptr, error.what()); return nullptr;
}

napi_value renderToImage(napi_env env, napi_callback_info info) try {
  auto args = arguments(env, info, 3);
  if (args.size() < 2) {
    throw std::runtime_error("renderToImage requires width and height");
  }
  State& value = host(env);
  value.canvases.uploadDirty();
  const auto image = value.renderer.renderToImage(
    asInt32(env, args[0]), asInt32(env, args[1]),
    args.size() > 2 ? imageAlphaMode(env, args[2]) : pmjs::AlphaMode::straight);
  value.renderer.beginFrame();
  if (!image) throw std::runtime_error("could not create GPU render image");
  return imageInfo(env, image->handle, image->width, image->height);
} catch (const std::bad_alloc&) {
  napi_throw_error(env, "PMJS_RENDER_IMAGE_ALLOCATION", "cannot allocate GPU render image");
  return nullptr;
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

napi_value finishRendering(napi_env env, napi_callback_info) try {
  host(env).renderer.finish();
  return undefined(env);
} catch (const std::exception& error) { napi_throw_error(env, nullptr, error.what()); return nullptr; }

void registerGraphicsBindings(napi_env env, napi_value exports) {
  napi_value render = moduleObject(env);
  method(env, render, "setClearColor", setClearColor);
  method(env, render, "clearScene", clearScene);
  method(env, render, "setPresentationViewport", setPresentationViewport);
  method(env, render, "setClearBeforeRender", setClearBeforeRender);
  method(env, render, "setSceneProjection", setSceneProjection);
  method(env, render, "configurePixiFragmentPrecision", configurePixiFragmentPrecision);
  method(env, render, "createFilterProgram", createFilterProgram);
  method(env, render, "createFilterPlan", createFilterPlan);
  method(env, render, "graphicsInfo", graphicsInfo);
  method(env, render, "setPresentationLayers", setPresentationLayers);
  method(env, render, "setRenderTargetSize", setRenderTargetSize);
  method(env, render, "setScreenRenderSize", setScreenRenderSize);
  method(env, render, "quad", quad);
  method(env, render, "image", drawImage);
  method(env, render, "createTileLayer", createTileLayer);
  method(env, render, "releaseTileLayer", releaseTileLayer);
  method(env, render, "createMesh", createMesh);
  method(env, render, "releaseMesh", releaseMesh);
  napi_value plugins = moduleObject(env), mpp = moduleObject(env), mv = moduleObject(env);
  method(env, mpp, "createBitmapMesh", createMppBitmapMesh);
  method(env, mpp, "clearBackgroundTriangles", clearImageTriangles);
  method(env, mv, "createBitmapMesh", createMvBitmapMesh);
  napi_set_named_property(env, plugins, "mpp", mpp);
  napi_set_named_property(env, exports, "plugins", plugins);
  napi_set_named_property(env, exports, "mv", mv);
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
  method(env, render, "finish", finishRendering);
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
  napi_set_named_property(env, schema, "gpuSpriteTextures", boolean(env, true));
  napi_set_named_property(env, schema, "clampedTilingSampling", boolean(env, true));
  napi_set_named_property(env, schema, "floatSpriteUv", boolean(env, true));
  napi_set_named_property(env, schema, "repeatSpriteSampling", boolean(env, true));
  napi_set_named_property(env, schema, "filterCompositeBlend", boolean(env, true));
  napi_set_named_property(env, schema, "effects", boolean(env, true));
  napi_set_named_property(env, scene, "schema", schema);
  check(env, napi_set_named_property(env, exports, "render", render), "cannot export render module");
  check(env, napi_set_named_property(env, exports, "scene", scene), "cannot export scene module");
}

}  // namespace pmjs::addon
