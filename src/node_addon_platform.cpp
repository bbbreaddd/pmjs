#include "node_addon_internal.hpp"

namespace pmjs::addon {
napi_value readText(napi_env env, napi_callback_info info) try {
  auto args = arguments(env, info, 1);
  auto value = host(env).vfs.readText(asString(env, args.at(0)));
  if (!value) { napi_value result; napi_get_null(env, &result); return result; }
  return string(env, *value);
} catch (const std::exception& error) {
  napi_throw_type_error(env, nullptr, error.what()); return nullptr;
}

napi_value readBytes(napi_env env, napi_callback_info info) try {
  auto args = arguments(env, info, 1);
  auto value = host(env).vfs.readBytes(asString(env, args.at(0)));
  if (!value) { napi_value result; napi_get_null(env, &result); return result; }
  void* destination = nullptr;
  napi_value result;
  napi_create_arraybuffer(env, value->size(), &destination, &result);
  if (!value->empty()) std::memcpy(destination, value->data(), value->size());
  return result;
} catch (const std::exception& error) {
  napi_throw_type_error(env, nullptr, error.what()); return nullptr;
}

napi_value exists(napi_env env, napi_callback_info info) try {
  auto args = arguments(env, info, 1);
  return boolean(env, host(env).vfs.exists(asString(env, args.at(0))));
} catch (const std::exception& error) {
  napi_throw_type_error(env, nullptr, error.what()); return nullptr;
}

napi_value isDirectory(napi_env env, napi_callback_info info) try {
  auto args = arguments(env, info, 1);
  return boolean(env, host(env).vfs.isDirectory(asString(env, args.at(0))));
} catch (const std::exception& error) {
  napi_throw_type_error(env, nullptr, error.what()); return nullptr;
}

napi_value readDirectory(napi_env env, napi_callback_info info) try {
  auto args = arguments(env, info, 1);
  auto entries = host(env).vfs.readDirectory(asString(env, args.at(0)));
  if (!entries) throw std::runtime_error("cannot read directory");
  napi_value result;
  napi_create_array_with_length(env, entries->size(), &result);
  for (std::size_t index = 0; index < entries->size(); ++index) {
    napi_set_element(env, result, index, string(env, (*entries)[index]));
  }
  return result;
} catch (const std::exception& error) {
  napi_throw_error(env, nullptr, error.what()); return nullptr;
}

napi_value inputDown(napi_env env, napi_callback_info info) try {
  auto args = arguments(env, info, 1);
  return boolean(env, host(env).platform.inputDown(asString(env, args.at(0))));
} catch (const std::exception& error) {
  napi_throw_type_error(env, nullptr, error.what()); return nullptr;
}

napi_value inputPressed(napi_env env, napi_callback_info info) try {
  auto args = arguments(env, info, 1);
  return boolean(env, host(env).platform.inputPressed(asString(env, args.at(0))));
} catch (const std::exception& error) {
  napi_throw_type_error(env, nullptr, error.what()); return nullptr;
}

napi_value inputState(napi_env env, napi_callback_info) try {
  return uint32(env, host(env).core.inputState());
} catch (const std::exception& error) {
  napi_throw_error(env, nullptr, error.what());
  return nullptr;
} catch (...) {
  napi_throw_error(env, nullptr, "inputState failed");
  return nullptr;
}

napi_value inputConsumePressed(napi_env env, napi_callback_info) try {
  host(env).platform.consumePressed();
  return undefined(env);
} catch (const std::exception& error) {
  napi_throw_error(env, nullptr, error.what()); return nullptr;
}

napi_value injectInput(napi_env env, napi_callback_info info) try {
  const auto args = arguments(env, info, 1);
  host(env).core.injectInput(static_cast<std::uint16_t>(
    asUint32(env, args.at(0)) & 0xffffU));
  return undefined(env);
} catch (const std::exception& error) {
  napi_throw_range_error(env, nullptr, error.what());
  return nullptr;
}


void registerPlatformBindings(napi_env env, napi_value exports) {
  napi_value fs = moduleObject(env);
  method(env, fs, "readText", readText);
  method(env, fs, "readBytes", readBytes);
  method(env, fs, "readDirectory", readDirectory);
  method(env, fs, "exists", exists);
  method(env, fs, "isDirectory", isDirectory);
  napi_value input = moduleObject(env);
  method(env, input, "down", inputDown);
  method(env, input, "pressed", inputPressed);
  method(env, input, "consumePressed", inputConsumePressed);
  method(env, input, "state", inputState);
  method(env, input, "inject", injectInput);
  check(env, napi_set_named_property(env, exports, "fs", fs), "cannot export fs module");
  check(env, napi_set_named_property(env, exports, "input", input), "cannot export input module");
}

}  // namespace pmjs::addon
