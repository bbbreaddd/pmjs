#include "node_addon_internal.hpp"

namespace pmjs::addon {

std::unique_ptr<State> state;
void check(napi_env env, napi_status status, const char* message) {
  if (status != napi_ok) {
    napi_throw_error(env, nullptr, message);
    throw std::runtime_error(message);
  }
}

napi_value undefined(napi_env env) {
  napi_value value;
  check(env, napi_get_undefined(env, &value), "cannot create undefined");
  return value;
}

napi_value null(napi_env env) {
  napi_value value;
  check(env, napi_get_null(env, &value), "cannot create null");
  return value;
}

napi_value boolean(napi_env env, bool input) {
  napi_value value;
  check(env, napi_get_boolean(env, input, &value), "cannot create boolean");
  return value;
}

napi_value number(napi_env env, double input) {
  napi_value value;
  check(env, napi_create_double(env, input, &value), "cannot create number");
  return value;
}

napi_value uint32(napi_env env, std::uint32_t input) {
  napi_value value;
  check(env, napi_create_uint32(env, input, &value), "cannot create uint32");
  return value;
}

napi_value string(napi_env env, const std::string& input) {
  napi_value value;
  check(env, napi_create_string_utf8(env, input.data(), input.size(), &value),
        "cannot create string");
  return value;
}

std::vector<napi_value> arguments(napi_env env, napi_callback_info info,
                                  std::size_t limit) {
  std::vector<napi_value> values(limit);
  std::size_t count = limit;
  check(env, napi_get_cb_info(env, info, &count, values.data(), nullptr, nullptr),
        "cannot read arguments");
  values.resize(count);
  return values;
}

double asNumber(napi_env env, napi_value value) {
  double result = 0;
  check(env, napi_get_value_double(env, value, &result), "argument must be numeric");
  return result;
}

std::int32_t asInt32(napi_env env, napi_value value) {
  std::int32_t result = 0;
  check(env, napi_get_value_int32(env, value, &result), "argument must be int32");
  return result;
}

std::uint32_t asUint32(napi_env env, napi_value value) {
  std::uint32_t result = 0;
  check(env, napi_get_value_uint32(env, value, &result), "argument must be uint32");
  return result;
}

bool asBoolean(napi_env env, napi_value value) {
  bool result = false;
  check(env, napi_get_value_bool(env, value, &result), "argument must be boolean");
  return result;
}

pmjs::BlendMode asBlendMode(napi_env env, napi_value value) {
  const auto result = asUint32(env, value);
  if (result > static_cast<std::uint32_t>(pmjs::BlendMode::screen)) {
    throw std::runtime_error("blend mode must be between 0 and 3");
  }
  return static_cast<pmjs::BlendMode>(result);
}

std::string asString(napi_env env, napi_value value) {
  std::size_t size = 0;
  check(env, napi_get_value_string_utf8(env, value, nullptr, 0, &size),
        "argument must be a string");
  std::string result(size, '\0');
  check(env, napi_get_value_string_utf8(env, value, result.data(), size + 1, &size),
        "cannot read string");
  return result;
}

napi_value property(napi_env env, napi_value object, const char* name) {
  napi_value value;
  check(env, napi_get_named_property(env, object, name, &value),
        "cannot read initialization option");
  return value;
}

bool hasProperty(napi_env env, napi_value object, const char* name) {
  bool result = false;
  check(env, napi_has_named_property(env, object, name, &result),
        "cannot inspect initialization option");
  return result;
}

State& host(napi_env env) {
  if (!state) {
    napi_throw_error(env, nullptr, "native host is not initialized");
    throw std::runtime_error("native host is not initialized");
  }
  return *state;
}

// Image and canvas stores mutate on the main thread. Async workers only decode
// into private buffers, so their totals can be reported without locking.
void syncExternalMemory(napi_env env) {
  State& value = host(env);
  const std::int64_t current =
      static_cast<std::int64_t>(value.images.gpuBytes()) +
      static_cast<std::int64_t>(value.images.cpuBytes()) +
      static_cast<std::int64_t>(value.canvases.cpuBytes());
  const std::int64_t delta = current - value.reportedExternalBytes;
  if (delta == 0) return;
  std::int64_t adjusted = 0;
  if (napi_adjust_external_memory(env, delta, &adjusted) != napi_ok) return;
  value.reportedExternalBytes = current;
}

napi_value imageInfo(napi_env env, std::uint32_t handle, int width, int height) {
  napi_value result;
  check(env, napi_create_object(env, &result), "cannot create image result");
  napi_set_named_property(env, result, "handle", uint32(env, handle));
  napi_set_named_property(env, result, "width", number(env, width));
  napi_set_named_property(env, result, "height", number(env, height));
  return result;
}

std::optional<pmjs::ImageHandle> resolveImage(State& value, std::uint32_t handle) {
  return value.core.resolveImage(handle);
}

void method(napi_env env, napi_value object, const char* name, napi_callback callback) {
  napi_value function;
  check(env, napi_create_function(env, name, NAPI_AUTO_LENGTH, callback, nullptr, &function),
        "cannot create native method");
  check(env, napi_set_named_property(env, object, name, function), "cannot export method");
}

napi_value moduleObject(napi_env env) {
  napi_value object;
  check(env, napi_create_object(env, &object), "cannot create module object");
  return object;
}

}  // namespace pmjs::addon
