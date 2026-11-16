#include "node_addon_internal.hpp"

#include <string>

#include "dialog.hpp"

namespace pmjs::addon {

namespace {

// Prompt values retain lone UTF-16 surrogates.
std::string promptString(napi_env env, napi_value input) {
  std::size_t length = 0;
  check(env, napi_get_value_string_utf16(env, input, nullptr, 0, &length), "expected prompt string");
  std::u16string units(length + 1, 0);
  check(env, napi_get_value_string_utf16(env, input, units.data(), units.size(), &length), "cannot read prompt string");
  units.resize(length);
  std::string result;
  for (std::size_t i = 0; i < units.size(); ++i) {
    std::uint32_t code = units[i];
    if (code >= 0xD800 && code <= 0xDBFF && i + 1 < units.size() &&
        units[i + 1] >= 0xDC00 && units[i + 1] <= 0xDFFF) {
      code = 0x10000 + ((code - 0xD800) << 10) + (units[++i] - 0xDC00);
    }
    if (code < 0x80) result.push_back(static_cast<char>(code));
    else if (code < 0x800) {
      result.push_back(static_cast<char>(0xC0 | (code >> 6)));
      result.push_back(static_cast<char>(0x80 | (code & 0x3F)));
    } else if (code < 0x10000) {
      result.push_back(static_cast<char>(0xE0 | (code >> 12)));
      result.push_back(static_cast<char>(0x80 | ((code >> 6) & 0x3F)));
      result.push_back(static_cast<char>(0x80 | (code & 0x3F)));
    } else {
      result.push_back(static_cast<char>(0xF0 | (code >> 18)));
      result.push_back(static_cast<char>(0x80 | ((code >> 12) & 0x3F)));
      result.push_back(static_cast<char>(0x80 | ((code >> 6) & 0x3F)));
      result.push_back(static_cast<char>(0x80 | (code & 0x3F)));
    }
  }
  return result;
}

napi_value promptValue(napi_env env, const std::string& text) {
  std::u16string units;
  for (std::size_t at = 0; at < text.size();) {
    const auto first = static_cast<unsigned char>(text[at]);
    std::size_t length = first < 0x80 ? 1 : first >= 0xC2 && first <= 0xDF ? 2 :
      first >= 0xE0 && first <= 0xEF ? 3 : first >= 0xF0 && first <= 0xF4 ? 4 : 0;
    std::uint32_t code = first;
    bool valid = length && length <= text.size() - at;
    if (valid && length > 1) {
      code &= length == 2 ? 0x1F : length == 3 ? 0x0F : 0x07;
      for (std::size_t i = 1; i < length; ++i) {
        const auto next = static_cast<unsigned char>(text[at + i]);
        if ((next & 0xC0) != 0x80) { valid = false; break; }
        code = (code << 6) | (next & 0x3F);
      }
      const std::uint32_t minimum = length == 2 ? 0x80 : length == 3 ? 0x800 : 0x10000;
      valid = valid && code >= minimum && code <= 0x10FFFF;
    }
    if (!valid) { code = 0xFFFD; length = 1; }
    at += length;
    if (code <= 0xFFFF) units.push_back(static_cast<char16_t>(code));
    else {
      code -= 0x10000;
      units.push_back(static_cast<char16_t>(0xD800 + (code >> 10)));
      units.push_back(static_cast<char16_t>(0xDC00 + (code & 0x3FF)));
    }
  }
  napi_value result;
  check(env, napi_create_string_utf16(env, units.data(), units.size(), &result), "cannot create prompt result");
  return result;
}

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

napi_value dialogPrompt(napi_env env, napi_callback_info info) try {
  const auto args = arguments(env, info, 2);
  if (args.size() < 2) throw std::runtime_error("prompt requires a message and default value");
  const auto result = host(env).core.dialog().prompt(asString(env, args[0]), promptString(env, args[1]));
  return result ? promptValue(env, *result) : null(env);
} catch (const std::exception& error) {
  return throwException(env, error);
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
