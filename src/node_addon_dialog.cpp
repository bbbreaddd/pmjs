#include "node_addon_internal.hpp"

#include <string>

#include "dialog.hpp"

namespace pmjs::addon {

namespace {

napi_value dialogAlert(napi_env env, napi_callback_info info) try {
  const auto args = arguments(env, info, 1);
  if (args.empty()) throw std::runtime_error("alert requires a message");
  host(env).core.dialog().alert(asString(env, args.at(0)));
  return undefined(env);
} catch (const std::exception& error) {
  napi_throw_error(env, nullptr, error.what());
  return nullptr;
} catch (...) {
  napi_throw_error(env, nullptr, "alert failed");
  return nullptr;
}

napi_value dialogConfirm(napi_env env, napi_callback_info info) try {
  const auto args = arguments(env, info, 1);
  if (args.empty()) throw std::runtime_error("confirm requires a message");
  return boolean(env, host(env).core.dialog().confirm(asString(env, args.at(0))));
} catch (const std::exception& error) {
  napi_throw_error(env, nullptr, error.what());
  return nullptr;
} catch (...) {
  napi_throw_error(env, nullptr, "confirm failed");
  return nullptr;
}

napi_value dialogPrompt(napi_env env, napi_callback_info) try {
  (void)env;
  throw std::runtime_error(
    "prompt() is not supported: the native host has no text entry yet");
} catch (const std::exception& error) {
  napi_throw_error(env, nullptr, error.what());
  return nullptr;
} catch (...) {
  napi_throw_error(env, nullptr, "prompt failed");
  return nullptr;
}

napi_value dialogSetFont(napi_env env, napi_callback_info info) try {
  const auto args = arguments(env, info, 1);
  if (args.empty()) throw std::runtime_error("setFont requires a path");
  host(env).core.dialog().setFontOverride(asString(env, args.at(0)));
  return undefined(env);
} catch (const std::exception& error) {
  napi_throw_error(env, nullptr, error.what());
  return nullptr;
} catch (...) {
  napi_throw_error(env, nullptr, "setFont failed");
  return nullptr;
}

}  // namespace

void registerDialogBindings(napi_env env, napi_value exports) {
  napi_value dialog = moduleObject(env);
  method(env, dialog, "alert", dialogAlert);
  method(env, dialog, "confirm", dialogConfirm);
  method(env, dialog, "prompt", dialogPrompt);
  method(env, dialog, "setFont", dialogSetFont);
  check(env, napi_set_named_property(env, exports, "dialog", dialog),
        "cannot export dialog module");
}

}  // namespace pmjs::addon
