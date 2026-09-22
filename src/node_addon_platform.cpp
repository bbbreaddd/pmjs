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

napi_value inputSnapshot(napi_env env, napi_callback_info) try {
  auto& platform = host(env).platform;
  napi_value result = moduleObject(env);
  auto integers = [&](const char* name, const std::vector<int>& values) {
    napi_value array;
    check(env, napi_create_array_with_length(env, values.size(), &array), "cannot create input array");
    for (std::size_t i = 0; i < values.size(); ++i)
      check(env, napi_set_element(env, array, i, uint32(env, values[i])), "cannot set input value");
    check(env, napi_set_named_property(env, result, name, array), "cannot set input array");
  };
  integers("keysDown", platform.keysDown());
  integers("keysPressed", platform.keysPressed());
  napi_value events;
  check(env, napi_create_array_with_length(env, platform.keyEvents().size(), &events), "cannot create key events");
  for (std::size_t i = 0; i < platform.keyEvents().size(); ++i) {
    const auto& key = platform.keyEvents()[i];
    napi_value event = moduleObject(env);
    check(env, napi_set_named_property(env, event, "keyCode", uint32(env, key.keyCode)), "cannot set key code");
    check(env, napi_set_named_property(env, event, "down", boolean(env, key.down)), "cannot set key state");
    check(env, napi_set_named_property(env, event, "repeat", boolean(env, key.repeat)), "cannot set repeat");
    check(env, napi_set_named_property(env, event, "capsLock", boolean(env, key.capsLock)), "cannot set caps lock");
    check(env, napi_set_named_property(env, event, "code", string(env, key.code)), "cannot set code");
    check(env, napi_set_named_property(env, event, "key", string(env, key.key)), "cannot set key");
    check(env, napi_set_named_property(env, event, "shift", boolean(env, key.shift)), "cannot set shift");
    check(env, napi_set_named_property(env, event, "ctrl", boolean(env, key.ctrl)), "cannot set ctrl");
    check(env, napi_set_named_property(env, event, "alt", boolean(env, key.alt)), "cannot set alt");
    check(env, napi_set_named_property(env, event, "meta", boolean(env, key.meta)), "cannot set meta");
    check(env, napi_set_element(env, events, i, event), "cannot set key event");
  }
  check(env, napi_set_named_property(env, result, "keyEvents", events), "cannot set key events");
  platform.clearKeyEvents();
  const auto pads = platform.gamepads();
  napi_value gamepads;
  check(env, napi_create_array_with_length(env, pads.size(), &gamepads), "cannot create gamepads");
  for (std::size_t index = 0; index < pads.size(); ++index) {
    napi_value pad = moduleObject(env);
    check(env, napi_set_named_property(env, pad, "index", uint32(env, pads[index].index)), "cannot set pad index");
    check(env, napi_set_named_property(env, pad, "instance", uint32(env, pads[index].instance)), "cannot set pad instance");
    check(env, napi_set_named_property(env, pad, "connected", boolean(env, pads[index].connected)), "cannot set pad connection");
    check(env, napi_set_named_property(env, pad, "id", string(env, pads[index].id)), "cannot set pad id");
    auto padIntegers = [&](const char* name, const std::vector<int>& values) {
      napi_value array;
      check(env, napi_create_array_with_length(env, values.size(), &array), "cannot create pad buttons");
      for (std::size_t i = 0; i < values.size(); ++i)
        check(env, napi_set_element(env, array, i, uint32(env, values[i])), "cannot set pad button");
      check(env, napi_set_named_property(env, pad, name, array), "cannot set pad buttons");
    };
    padIntegers("buttonsDown", pads[index].buttonsDown);
    padIntegers("buttonsPressed", pads[index].buttonsPressed);
    napi_value padAxes;
    check(env, napi_create_array_with_length(env, pads[index].axes.size(), &padAxes), "cannot create pad axes");
    for (std::size_t i = 0; i < pads[index].axes.size(); ++i)
      check(env, napi_set_element(env, padAxes, i, number(env, pads[index].axes[i])), "cannot set pad axis");
    check(env, napi_set_named_property(env, pad, "axes", padAxes), "cannot set pad axes");
    check(env, napi_set_element(env, gamepads, index, pad), "cannot set gamepad");
  }
  check(env, napi_set_named_property(env, result, "gamepads", gamepads), "cannot set gamepads");
  return result;
} catch (const std::exception& error) {
  napi_throw_error(env, nullptr, error.what()); return nullptr;
}

napi_value inputConsumePressed(napi_env env, napi_callback_info) try {
  host(env).platform.consumePressed();
  return undefined(env);
} catch (const std::exception& error) {
  napi_throw_error(env, nullptr, error.what()); return nullptr;
}

void registerPlatformBindings(napi_env env, napi_value exports) {
  napi_value fs = moduleObject(env);
  method(env, fs, "readText", readText);
  method(env, fs, "readBytes", readBytes);
  method(env, fs, "readDirectory", readDirectory);
  method(env, fs, "exists", exists);
  method(env, fs, "isDirectory", isDirectory);
  napi_value input = moduleObject(env);
  method(env, input, "snapshot", inputSnapshot);
  method(env, input, "consumePressed", inputConsumePressed);
  check(env, napi_set_named_property(env, exports, "fs", fs), "cannot export fs module");
  check(env, napi_set_named_property(env, exports, "input", input), "cannot export input module");
}

}  // namespace pmjs::addon
