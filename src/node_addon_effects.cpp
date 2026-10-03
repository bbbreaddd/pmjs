#include "node_addon_internal.hpp"
#include "effects_license.hpp"
#include <cmath>

namespace pmjs::addon {
namespace {

napi_value effectCall(napi_env env, napi_callback_info info) {
  try {
    void* data = nullptr;
    check(env, napi_get_cb_info(env, info, nullptr, nullptr, nullptr, &data), "effect operation");
    const std::string operation = static_cast<const char*>(data);
    const auto args = arguments(env, info);
    auto& effects = host(env).core.effects();
    if (operation == "createContext") return uint32(env, effects.createContext());
    if (operation == "counts") {
      auto result = moduleObject(env);
      const auto counts = effects.counts();
      napi_set_named_property(env, result, "contexts", uint32(env, counts[0]));
      napi_set_named_property(env, result, "effects", uint32(env, counts[1]));
      napi_set_named_property(env, result, "handles", uint32(env, counts[2]));
      napi_set_named_property(env, result, "voices", uint32(env, counts[3]));
      return result;
    }
    if (args.empty()) throw std::runtime_error("missing effect ID");
    const auto id = asUint32(env, args[0]);
    if (operation == "exists") return boolean(env, effects.exists(id));
    if (operation == "releaseContext") effects.releaseContext(id);
    else if (operation == "stopAll") effects.stopAll(id);
    else if (operation == "release") {
      if (args.size() != 2) throw std::runtime_error("effect release requires context and resource");
      effects.release(id, asUint32(env, args[1]));
    } else if (operation == "load") {
      if (args.size() != 3) throw std::runtime_error("effect load requires context, path and scale");
      const auto scale = asNumber(env, args[2]);
      if (!std::isfinite(scale) || scale <= 0 || scale > 10000) throw std::runtime_error("invalid effect scale");
      return uint32(env, effects.load(id, asString(env, args[1]), static_cast<float>(scale)));
    } else if (operation == "play") {
      if (args.size() != 5) throw std::runtime_error("effect play requires context, resource and position");
      const auto location = floatArray<3>(env, args, 2);
      for (const auto value : location) if (!std::isfinite(value)) throw std::runtime_error("invalid effect position");
      return uint32(env, effects.play(id, asUint32(env, args[1]), location));
    } else if (operation == "update") {
      if (args.size() != 2) throw std::runtime_error("effect update requires context and frames");
      const auto frames = asNumber(env, args[1]);
      if (!std::isfinite(frames) || frames < 0 || frames > 10000) throw std::runtime_error("invalid effect update");
      effects.update(id, static_cast<float>(frames));
    } else if (operation == "control") {
      if (args.size() != 6) throw std::runtime_error("effect control requires handle, operation and four values");
      const auto values = floatArray<4>(env, args, 2);
      for (const auto value : values) if (!std::isfinite(value)) throw std::runtime_error("invalid effect control");
      effects.control(id, asString(env, args[1]), values);
    } else throw std::runtime_error("unknown effect operation");
    return undefined(env);
  } catch (const std::exception& error) {
    napi_throw_error(env, nullptr, error.what());
    return nullptr;
  }
}

}  // namespace

void registerEffectBindings(napi_env env, napi_value exports) {
  auto effects = moduleObject(env);
  check(env, napi_set_named_property(env, effects, "license", string(env, effectsLicense)),
    "cannot export effects license");
  for (const char* name : {"createContext", "releaseContext", "load", "release", "play", "update", "stopAll", "exists", "control", "counts"}) {
    napi_value function;
    check(env, napi_create_function(env, name, NAPI_AUTO_LENGTH, effectCall,
      const_cast<char*>(name), &function), "cannot create effect binding");
    check(env, napi_set_named_property(env, effects, name, function), "cannot export effect binding");
  }
  check(env, napi_set_named_property(env, exports, "effects", effects), "cannot export effects");
}

}  // namespace pmjs::addon
