#include "node_addon_internal.hpp"
#include "mv_engine.hpp"
#include "mv_presentation.hpp"
#include "mv_core_input.hpp"
#include "mv_core_types.hpp"
#include "mv_core_utils.hpp"
#include "mv_managers.hpp"
#include "mv_sprites.hpp"
#include <cmath>

namespace pmjs::addon {
namespace {
mv::Value readValue(napi_env env, napi_value value, int depth = 0) {
  if (depth > 128) throw std::invalid_argument("engine data nesting limit exceeded");
  napi_valuetype type;
  check(env, napi_typeof(env, value, &type), "cannot inspect engine data");
  switch (type) {
    case napi_null: return {};
    case napi_undefined: return mv::Value::undefined();
    case napi_boolean: return asBoolean(env, value);
    case napi_number: return asNumber(env, value);
    case napi_string: return asString(env, value);
    case napi_object: {
      bool array = false;
      check(env, napi_is_array(env, value, &array), "cannot inspect engine array");
      if (array) {
        std::uint32_t length = 0;
        check(env, napi_get_array_length(env, value, &length), "cannot read engine array");
        mv::Value::Array result; result.reserve(length);
        for (std::uint32_t i = 0; i < length; ++i) {
          napi_value item;
          check(env, napi_get_element(env, value, i, &item), "cannot read engine item");
          result.push_back(readValue(env, item, depth + 1));
        }
        return result;
      }
      napi_value keys;
      check(env, napi_get_property_names(env, value, &keys), "cannot read engine fields");
      std::uint32_t length = 0;
      check(env, napi_get_array_length(env, keys, &length), "cannot read engine keys");
      mv::Value::Object result;
      for (std::uint32_t i = 0; i < length; ++i) {
        napi_value key, item;
        check(env, napi_get_element(env, keys, i, &key), "cannot read engine key");
        check(env, napi_get_property(env, value, key, &item), "cannot read engine field");
        result.emplace(asString(env, key), readValue(env, item, depth + 1));
      }
      return result;
    }
    default: throw std::invalid_argument("engine data must contain only JSON values");
  }
}
napi_value writeValue(napi_env env, const mv::Value& value) {
  if (value.isUndefined()) return undefined(env);
  if (value.null()) return null(env);
  if (const auto* item = std::get_if<bool>(&value.data)) return boolean(env, *item);
  if (const auto* item = std::get_if<double>(&value.data)) return number(env, *item);
  if (const auto* item = std::get_if<std::string>(&value.data)) return string(env, *item);
  napi_value result;
  if (const auto* items = std::get_if<mv::Value::Array>(&value.data)) {
    check(env, napi_create_array_with_length(env, items->size(), &result), "cannot create state array");
    for (std::size_t i = 0; i < items->size(); ++i) check(env, napi_set_element(env, result, i, writeValue(env, (*items)[i])), "cannot write state item");
  } else {
    check(env, napi_create_object(env, &result), "cannot create state object");
    for (const auto& [key, item] : std::get<mv::Value::Object>(value.data)) check(env, napi_set_named_property(env, result, key.c_str(), writeValue(env, item)), "cannot write state field");
  }
  return result;
}
struct EngineSession {
  struct RuntimeReference {
    napi_ref reference;
    bool rooted;
  };
  std::shared_ptr<const int> runtimeOwner = std::make_shared<const int>(0);
  int runtimeCalls = 0;
  bool stepping = false;
  napi_env env = nullptr;
  napi_ref runtimeSelf = nullptr;
  std::map<std::uint64_t, RuntimeReference> runtimeReferences;
  ~EngineSession() {
    if (session) session->setRuntimeHooks({});
    for (const auto& [id, ref] : runtimeReferences) { (void)id; napi_delete_reference(env, ref.reference); }
    if (runtimeSelf) napi_delete_reference(env, runtimeSelf);
  }

  std::shared_ptr<State> owner;
  std::unique_ptr<mv::Session> session;
  std::unique_ptr<mv::Presentation> presentation;
  mv::core::Input input;
  mv::core::TouchInput touch;
  bool focused = true;
};
struct RuntimeCallScope {
  int& depth;
  explicit RuntimeCallScope(EngineSession& owner) : depth(owner.runtimeCalls) { ++depth; }
  ~RuntimeCallScope() { --depth; }
};
constexpr napi_type_tag engineSessionTag{0x0578d08b153544caULL, 0x8f758858cefbf452ULL};
EngineSession& session(napi_env env, napi_value object) {
  napi_valuetype type;
  check(env, napi_typeof(env, object, &type), "invalid engine session");
  if (type != napi_object) throw std::invalid_argument("invalid engine session");
  bool tagged = false;
  check(env, napi_check_object_type_tag(env, object, &engineSessionTag, &tagged), "invalid engine session");
  if (!tagged) throw std::invalid_argument("invalid engine session");
  EngineSession* value = nullptr;
  check(env, napi_unwrap(env, object, reinterpret_cast<void**>(&value)), "invalid engine session");
  if (!value || !value->session) throw std::runtime_error("engine session is disposed");
  return *value;
}
struct RuntimePayload {
  std::shared_ptr<const int> owner;
  std::shared_ptr<mv::RuntimeObject> object;
};
constexpr napi_type_tag runtimeObjectTag{0xe1bf1768ba904423ULL, 0xa8c9be64539f9f18ULL};
RuntimePayload& runtimePayload(napi_env env, napi_value object) {
  bool tagged = false;
  check(env, napi_check_object_type_tag(env, object, &runtimeObjectTag, &tagged), "invalid runtime object");
  if (!tagged) throw std::invalid_argument("invalid runtime object");
  void* pointer = nullptr;
  check(env, napi_unwrap(env, object, &pointer), "cannot unwrap runtime object");
  if (!pointer) throw std::invalid_argument("invalid runtime object");
  return *static_cast<RuntimePayload*>(pointer);
}
template<class T> std::shared_ptr<T> runtimeAs(napi_env env, napi_value value) {
  auto object = std::dynamic_pointer_cast<T>(runtimePayload(env, value).object);
  if (!object) throw std::invalid_argument("runtime object has the wrong type");
  return object;
}
napi_value runtimeHandle(EngineSession& owner, const std::shared_ptr<mv::RuntimeObject>& object) {
  auto env = owner.env;
  const auto found = owner.runtimeReferences.find(object->identity);
  if (found != owner.runtimeReferences.end()) {
    napi_value existing = nullptr;
    check(env, napi_get_reference_value(env, found->second.reference, &existing), "cannot retrieve runtime object");
    if (existing) return existing;
    napi_delete_reference(env, found->second.reference); owner.runtimeReferences.erase(found);
  }
  auto payload = std::make_unique<RuntimePayload>(RuntimePayload{owner.runtimeOwner, object});
  napi_value result = moduleObject(env), identity;
  check(env, napi_create_bigint_uint64(env, object->identity, &identity), "cannot create runtime identity");
  const napi_property_descriptor identityProperty{"identity", nullptr, nullptr, nullptr, nullptr, identity, napi_default, nullptr};
  check(env, napi_define_properties(env, result, 1, &identityProperty), "cannot set runtime identity");
  if (const auto picture = std::dynamic_pointer_cast<mv::RuntimePicture>(object)) {
    napi_value spriteIdentity;
    check(env, napi_create_bigint_uint64(env, picture->sprite->runtimeIdentity, &spriteIdentity), "cannot identify picture sprite");
    check(env, napi_set_named_property(env, result, "slot", number(env, picture->slot)), "cannot set picture slot");
    check(env, napi_set_named_property(env, result, "spriteIdentity", spriteIdentity), "cannot set sprite identity");
  }
  check(env, napi_type_tag_object(env, result, &runtimeObjectTag), "cannot identify runtime object");
  check(env, napi_wrap(env, result, payload.get(), [](napi_env, void* data, void*) {
    delete static_cast<RuntimePayload*>(data);
  }, nullptr, nullptr), "cannot own runtime object");
  payload.release();
  napi_ref reference;
  check(env, napi_create_reference(env, result, 1, &reference), "cannot retain runtime object");
  owner.runtimeReferences.emplace(object->identity, EngineSession::RuntimeReference{reference, true});
  return result;
}
napi_value callRuntime(EngineSession& owner, const char* methodName, const std::vector<napi_value>& args) {
  auto env = owner.env;
  RuntimeCallScope callScope(owner);
  napi_value self = nullptr, runtime, method, result;
  check(env, napi_get_reference_value(env, owner.runtimeSelf, &self), "cannot retrieve runtime owner");
  if (!self) throw std::runtime_error("runtime owner is unavailable");
  check(env, napi_get_named_property(env, self, "__mvRuntime", &runtime), "cannot retrieve runtime");
  check(env, napi_get_named_property(env, runtime, methodName, &method), "cannot retrieve runtime method");
  check(env, napi_call_function(env, runtime, method, args.size(), args.data(), &result), "native MV script callback failed");
  return result;
}
void collectRuntime(EngineSession& owner) {
  if (!owner.runtimeSelf) return;
  const auto nativeObjects = owner.session->runtimeObjectIdentities();
  napi_value active = moduleObject(owner.env);
  for (auto it = owner.runtimeReferences.begin(); it != owner.runtimeReferences.end();) {
    auto& ref = it->second;
    napi_value object = nullptr;
    check(owner.env, napi_get_reference_value(owner.env, ref.reference, &object), "cannot inspect runtime object");
    if (!object) {
      napi_delete_reference(owner.env, ref.reference); it = owner.runtimeReferences.erase(it); continue;
    }
    const bool nativeOwner = nativeObjects.contains(it->first);
    std::uint32_t count;
    if (nativeOwner && !ref.rooted) check(owner.env, napi_reference_ref(owner.env, ref.reference, &count), "cannot root runtime object");
    if (!nativeOwner && ref.rooted) check(owner.env, napi_reference_unref(owner.env, ref.reference, &count), "cannot unroot runtime object");
    ref.rooted = nativeOwner;
    if (nativeOwner) check(owner.env, napi_set_named_property(owner.env, active, std::to_string(it->first).c_str(), boolean(owner.env, true)), "cannot collect runtime identity");
    ++it;
  }
  callRuntime(owner, "collect", {active});
}
void requireRuntimeOwner(EngineSession& owner, napi_value object);
napi_value connectRuntime(napi_env env, napi_callback_info info) try {
  const auto args = arguments(env, info);
  if (args.size() != 2) throw std::invalid_argument("connectRuntime requires session and callbacks");
  auto& owner = session(env, args[0]);
  if (owner.runtimeSelf) throw std::runtime_error("session runtime is already connected");
  check(env, napi_set_named_property(env, args[0], "__mvRuntime", args[1]), "cannot attach runtime");
  check(env, napi_create_reference(env, args[0], 0, &owner.runtimeSelf), "cannot reference runtime owner");
  auto hooks = std::make_shared<mv::RuntimeHooks>();
  hooks->picture = [&owner](const auto& object, const std::string& method, const mv::Value::Array& arguments) {
    return asBoolean(owner.env, callRuntime(owner, "picture", {runtimeHandle(owner, object), string(owner.env, method), writeValue(owner.env, arguments)}));
  };
  hooks->sprite = [&owner](const auto& object) { callRuntime(owner, "sprite", {runtimeHandle(owner, object)}); };
  hooks->updateSprites = [&owner] { callRuntime(owner, "updateSprites", {}); };
  hooks->wait = [&owner](const auto& object, const std::string& method) -> std::optional<bool> {
    auto result = callRuntime(owner, "wait", {runtimeHandle(owner, object), string(owner.env, method)});
    napi_valuetype type;
    check(owner.env, napi_typeof(owner.env, result, &type), "cannot inspect wait result");
    return type == napi_undefined ? std::optional<bool>{} : std::optional<bool>{asBoolean(owner.env, result)};
  };
  hooks->command = [&owner](const auto& object, const std::string& method) -> std::optional<bool> {
    const auto result = callRuntime(owner, "command", {runtimeHandle(owner, object), string(owner.env, method)});
    napi_valuetype type;
    check(owner.env, napi_typeof(owner.env, result, &type), "cannot inspect command result");
    return type == napi_undefined ? std::optional<bool>{} : std::optional<bool>{asBoolean(owner.env, result)};
  };
  hooks->script = [&owner](const auto& object, const std::string& source) {
    callRuntime(owner, "script", {runtimeHandle(owner, object), string(owner.env, source)});
  };
  hooks->pluginCommand = [&owner](const auto& object, const std::string& command, const std::vector<std::string>& args) {
    mv::Value::Array values;
    for (const auto& arg : args) values.emplace_back(arg);
    return asBoolean(owner.env, callRuntime(owner, "pluginCommand", {runtimeHandle(owner, object), string(owner.env, command), writeValue(owner.env, values)}));
  };
  hooks->interpreterLifecycle = [&owner](const auto& object, const std::string& method, const auto& list, int eventId) {
    return asBoolean(owner.env, callRuntime(owner, "lifecycle", {runtimeHandle(owner, object), string(owner.env, method),
      list ? runtimeHandle(owner, list) : null(owner.env), number(owner.env, eventId)}));
  };
  hooks->message = [&owner](const std::string& method, const mv::Value::Array& args) -> std::optional<bool> {
    const auto result = callRuntime(owner, "message", {string(owner.env, method), writeValue(owner.env, args)});
    napi_valuetype type; check(owner.env, napi_typeof(owner.env, result, &type), "cannot inspect message override");
    return type == napi_undefined ? std::optional<bool>{} : std::optional<bool>{asBoolean(owner.env, result)};
  };
  hooks->requestImages = [&owner](const auto& list) { callRuntime(owner, "requestImages", {runtimeHandle(owner, list)}); };
  hooks->choice = [&owner](int index) { return asBoolean(owner.env, callRuntime(owner, "choice", {number(owner.env, index)})); };
  owner.session->setRuntimeHooks(std::move(hooks));
  return undefined(env);
} catch (const std::exception& error) { return throwException(env, error); }
napi_value runtimePicture(napi_env env, napi_callback_info info) try {
  const auto args = arguments(env, info, 2); auto& owner = session(env, args.at(0));
  const auto picture = owner.session->runtimePicture(asInt32(env, args.at(1)));
  return picture ? runtimeHandle(owner, picture) : null(env);
} catch (const std::exception& error) { return throwException(env, error); }
napi_value createRuntimePicture(napi_env env, napi_callback_info info) try {
  const auto args = arguments(env, info, 1); auto& owner = session(env, args.at(0));
  return runtimeHandle(owner, owner.session->createRuntimePicture());
} catch (const std::exception& error) { return throwException(env, error); }
napi_value pictureField(napi_env env, napi_callback_info info) try {
  const auto args = arguments(env, info);
  if (args.size() != 2 && args.size() != 3) throw std::invalid_argument("pictureField requires object, field and optional scalar");
  auto object = runtimeAs<mv::RuntimePicture>(env, args[0]);
  const auto key = asString(env, args[1]);
  if (key == "_tone" || key == "_toneTarget") throw std::invalid_argument("picture tone requires the collection binding");
  if (args.size() == 3) {
    const auto field = readValue(env, args[2]);
    if (std::holds_alternative<mv::Value::Array>(field.data) || std::holds_alternative<mv::Value::Object>(field.data))
      throw std::invalid_argument("pictureField accepts scalar fields only");
    std::get<mv::Value::Object>(object->state.data)[key] = field;
  }
  const auto& field = object->state[key];
  if (std::holds_alternative<mv::Value::Array>(field.data) || std::holds_alternative<mv::Value::Object>(field.data))
    throw std::invalid_argument("native collection binding is not available");
  return writeValue(env, field);
} catch (const std::exception& error) { return throwException(env, error); }
napi_value pictureInvoke(napi_env env, napi_callback_info info) try {
  const auto args = arguments(env, info); auto& owner = session(env, args.at(0));
  requireRuntimeOwner(owner, args.at(1));
  RuntimeCallScope callScope(owner);
  const auto parameters = args.size() == 4 ? readValue(env, args[3]).array() : mv::Value::Array{};
  owner.session->invokePictureBase(runtimeAs<mv::RuntimePicture>(env, args.at(1)), asString(env, args.at(2)), parameters);
  return undefined(env);
} catch (const std::exception& error) { return throwException(env, error); }
napi_value pictureTone(napi_env env, napi_callback_info info) try {
  const auto args = arguments(env, info);
  if (args.size() != 3 && args.size() != 4) throw std::invalid_argument("pictureTone requires session, picture, field and optional tone");
  auto& owner = session(env, args[0]); requireRuntimeOwner(owner, args[1]);
  auto picture = runtimeAs<mv::RuntimePicture>(env, args[1]);
  const auto key = asString(env, args[2]);
  if (key != "_tone" && key != "_toneTarget") throw std::invalid_argument("unknown picture tone field");
  auto& tone = key == "_tone" ? picture->tone : picture->toneTarget;
  if (args.size() == 4) {
    napi_valuetype type;
    check(env, napi_typeof(env, args[3], &type), "cannot inspect tone");
    if (type == napi_null) tone.reset();
    else { requireRuntimeOwner(owner, args[3]); tone = runtimeAs<mv::RuntimeTone>(env, args[3]); }
  }
  return tone ? runtimeHandle(owner, tone) : null(env);
} catch (const std::exception& error) { return throwException(env, error); }
napi_value toneComponent(napi_env env, napi_callback_info info) try {
  const auto args = arguments(env, info);
  if (args.size() != 2 && args.size() != 3) throw std::invalid_argument("toneComponent requires tone, index and optional value");
  auto tone = runtimeAs<mv::RuntimeTone>(env, args[0]);
  const int index = asInt32(env, args[1]);
  if (index < 0 || index >= 4) throw std::invalid_argument("tone component is out of range");
  if (args.size() == 3) tone->values[index] = asNumber(env, args[2]);
  return number(env, tone->values[index]);
} catch (const std::exception& error) { return throwException(env, error); }
napi_value interpreterField(napi_env env, napi_callback_info info) try {
  const auto args = arguments(env, info);
  if (args.size() != 3 && args.size() != 4) throw std::invalid_argument("interpreterField requires session, interpreter, field and optional value");
  auto& owner = session(env, args[0]); requireRuntimeOwner(owner, args[1]);
  RuntimeCallScope callScope(owner);
  const std::optional<mv::Value> value = args.size() == 4 ? std::optional<mv::Value>{readValue(env, args[3])} : std::nullopt;
  return writeValue(env, owner.session->runtimeInterpreterField(runtimeAs<mv::RuntimeInterpreter>(env, args[1]), asString(env, args[2]), value));
} catch (const std::exception& error) { return throwException(env, error); }
napi_value interpreterWaitInvoke(napi_env env, napi_callback_info info) try {
  const auto args = arguments(env, info, 3); auto& owner = session(env, args.at(0));
  requireRuntimeOwner(owner, args.at(1));
  return boolean(env, owner.session->invokeInterpreterWaitBase(runtimeAs<mv::RuntimeInterpreter>(env, args.at(1)), asString(env, args.at(2))));
} catch (const std::exception& error) { return throwException(env, error); }
napi_value interpreterCommandInvoke(napi_env env, napi_callback_info info) try {
  const auto args = arguments(env, info, 3); auto& owner = session(env, args.at(0));
  requireRuntimeOwner(owner, args.at(1));
  RuntimeCallScope callScope(owner);
  return boolean(env, owner.session->invokeInterpreterCommandBase(runtimeAs<mv::RuntimeInterpreter>(env, args.at(1)), asString(env, args.at(2))));
} catch (const std::exception& error) { return throwException(env, error); }
napi_value interpreterCollection(napi_env env, napi_callback_info info) try {
  const auto args = arguments(env, info, 3); auto& owner = session(env, args.at(0));
  requireRuntimeOwner(owner, args.at(1));
  const auto object = owner.session->runtimeInterpreterCollection(runtimeAs<mv::RuntimeInterpreter>(env, args.at(1)), asString(env, args.at(2)));
  return object ? runtimeHandle(owner, object) : null(env);
} catch (const std::exception& error) { return throwException(env, error); }
napi_value interpreterSetList(napi_env env, napi_callback_info info) try {
  const auto args = arguments(env, info, 3); auto& owner = session(env, args.at(0));
  requireRuntimeOwner(owner, args.at(1));
  napi_valuetype type; check(env, napi_typeof(env, args.at(2), &type), "cannot inspect interpreter list");
  std::shared_ptr<mv::RuntimeCommandList> list;
  if (type != napi_null) { requireRuntimeOwner(owner, args[2]); list = runtimeAs<mv::RuntimeCommandList>(env, args[2]); }
  owner.session->setRuntimeInterpreterList(runtimeAs<mv::RuntimeInterpreter>(env, args[1]), list);
  return undefined(env);
} catch (const std::exception& error) { return throwException(env, error); }
napi_value interpreterLifecycle(napi_env env, napi_callback_info info) try {
  const auto args = arguments(env, info);
  if (args.size() != 3 && args.size() != 5) throw std::invalid_argument("interpreterLifecycle requires session, interpreter, method and optional list/event ID");
  auto& owner = session(env, args[0]); requireRuntimeOwner(owner, args[1]);
  RuntimeCallScope callScope(owner);
  std::shared_ptr<mv::RuntimeCommandList> list;
  int eventId = 0;
  if (args.size() == 5) {
    napi_valuetype type; check(env, napi_typeof(env, args[3], &type), "cannot inspect interpreter list");
    if (type != napi_null) { requireRuntimeOwner(owner, args[3]); list = runtimeAs<mv::RuntimeCommandList>(env, args[3]); }
    eventId = asInt32(env, args[4]);
  }
  owner.session->invokeInterpreterLifecycleBase(runtimeAs<mv::RuntimeInterpreter>(env, args[1]), asString(env, args[2]), list, eventId);
  return undefined(env);
} catch (const std::exception& error) { return throwException(env, error); }
napi_value mapId(napi_env env, napi_callback_info info) try {
  const auto args = arguments(env, info, 1);
  return number(env, session(env, args.at(0)).session->mapId());
} catch (const std::exception& error) { return throwException(env, error); }
napi_value inBattle(napi_env env, napi_callback_info info) try {
  const auto args = arguments(env, info, 1); return boolean(env, session(env, args.at(0)).session->inBattle());
} catch (const std::exception& error) { return throwException(env, error); }
napi_value ownsPictureSprite(napi_env env, napi_callback_info info) try {
  const auto args = arguments(env, info, 2); auto& owner = session(env, args.at(0)); requireRuntimeOwner(owner, args.at(1));
  return boolean(env, owner.session->ownsPictureSprite(*runtimeAs<mv::RuntimePicture>(env, args[1])));
} catch (const std::exception& error) { return throwException(env, error); }
napi_value messageInvoke(napi_env env, napi_callback_info info) try {
  const auto args = arguments(env, info, 3); auto& owner = session(env, args.at(0));
  RuntimeCallScope callScope(owner);
  const auto parameters = readValue(env, args.at(2));
  return writeValue(env, owner.session->invokeMessageBase(asString(env, args.at(1)), parameters.array()));
} catch (const std::exception& error) { return throwException(env, error); }
napi_value imageRequests(napi_env env, napi_callback_info info) try {
  const auto args = arguments(env, info, 2); auto& owner = session(env, args.at(0)); requireRuntimeOwner(owner, args.at(1));
  return writeValue(env, owner.session->imageRequests(*runtimeAs<mv::RuntimeCommandList>(env, args[1])));
} catch (const std::exception& error) { return throwException(env, error); }
napi_value commonEventList(napi_env env, napi_callback_info info) try {
  const auto args = arguments(env, info, 2); auto& owner = session(env, args.at(0));
  const auto& source = owner.session->database()["commonEvents"][asInt32(env, args[1])]["list"];
  if (source.null()) return null(env);
  auto list = std::make_shared<mv::RuntimeCommandList>(); list->root = source;
  return runtimeHandle(owner, list);
} catch (const std::exception& error) { return throwException(env, error); }
napi_value messageChoices(napi_env env, napi_callback_info info) try {
  const auto args = arguments(env, info, 1); auto& owner = session(env, args.at(0));
  return runtimeHandle(owner, owner.session->messageChoices());
} catch (const std::exception& error) { return throwException(env, error); }
napi_value interpreterControl(napi_env env, napi_callback_info info) try {
  const auto args = arguments(env, info, 4); auto& owner = session(env, args.at(0)); requireRuntimeOwner(owner, args.at(1));
  RuntimeCallScope callScope(owner); const auto parameters = readValue(env, args.at(3));
  owner.session->invokeInterpreterControl(runtimeAs<mv::RuntimeInterpreter>(env, args[1]), asString(env, args[2]), parameters.array());
  return undefined(env);
} catch (const std::exception& error) { return throwException(env, error); }
napi_value scriptRandom(napi_env env, napi_callback_info info) try {
  const auto args = arguments(env, info, 1); return number(env, session(env, args.at(0)).session->scriptRandom());
} catch (const std::exception& error) { return throwException(env, error); }
napi_value messageField(napi_env env, napi_callback_info info) try {
  const auto args = arguments(env, info);
  if (args.size() != 2 && args.size() != 3) throw std::invalid_argument("messageField requires session, field and optional value");
  auto& owner = session(env, args[0]); RuntimeCallScope callScope(owner);
  const auto value = args.size() == 3 ? std::optional<mv::Value>{readValue(env, args[2])} : std::nullopt;
  return writeValue(env, owner.session->runtimeMessageField(asString(env, args[1]), value));
} catch (const std::exception& error) { return throwException(env, error); }
struct CommandCollection {
  std::shared_ptr<mv::RuntimeCommandList> list;
  std::vector<std::string> path;
  explicit CommandCollection(const std::shared_ptr<mv::RuntimeObject>& object) {
    if (auto root = std::dynamic_pointer_cast<mv::RuntimeCommandList>(object)) list = root;
    else if (auto view = std::dynamic_pointer_cast<mv::RuntimeCommandView>(object)) { list = view->list; path = view->path; }
    else throw std::invalid_argument("runtime object is not a command collection");
  }
  mv::Value& value() const { return list->resolve(path); }
};
int branchKey(const std::string& key) {
  std::size_t end;
  const int value = std::stoi(key, &end);
  if (value < 0 || end != key.size() || std::to_string(value) != key) throw std::invalid_argument("branch key must be a nonnegative integer");
  return value;
}
napi_value collectionInfo(napi_env env, napi_callback_info info) try {
  const auto args = arguments(env, info, 1);
  const auto object = runtimePayload(env, args.at(0)).object;
  mv::Value::Array keys;
  bool array = false, branch = false;
  if (const auto branches = std::dynamic_pointer_cast<mv::RuntimeBranches>(object)) {
    branch = true;
    for (const auto& [key, value] : branches->values) { (void)value; keys.emplace_back(std::to_string(key)); }
  } else {
    const auto& value = CommandCollection(object).value();
    if (const auto items = std::get_if<mv::Value::Array>(&value.data)) {
      array = true;
      for (std::size_t i = 0; i < items->size(); ++i) keys.emplace_back(std::to_string(i));
    } else for (const auto& [key, item] : std::get<mv::Value::Object>(value.data)) { (void)item; keys.emplace_back(key); }
  }
  return writeValue(env, mv::Value::Object{{"array", array}, {"branch", branch}, {"keys", std::move(keys)}});
} catch (const std::exception& error) { return throwException(env, error); }
napi_value collectionField(napi_env env, napi_callback_info info) try {
  const auto args = arguments(env, info);
  if (args.size() != 3 && args.size() != 4) throw std::invalid_argument("collectionField requires session, collection, key and optional scalar");
  auto& owner = session(env, args[0]); requireRuntimeOwner(owner, args[1]);
  RuntimeCallScope callScope(owner);
  const auto object = runtimePayload(env, args[1]).object;
  const auto key = asString(env, args[2]);
  std::optional<mv::Value> replacement;
  if (args.size() == 4) {
    replacement = readValue(env, args[3]);
    if (std::holds_alternative<mv::Value::Array>(replacement->data) || std::holds_alternative<mv::Value::Object>(replacement->data))
      throw std::invalid_argument("collection replacement requires a scalar");
  }
  if (const auto branches = std::dynamic_pointer_cast<mv::RuntimeBranches>(object)) {
    const auto index = branchKey(key);
    if (replacement) branches->values[index] = *replacement;
    const auto it = branches->values.find(index);
    return it == branches->values.end() ? undefined(env) : writeValue(env, it->second);
  }
  const CommandCollection collection(object);
  auto path = collection.path; path.push_back(key);
  auto& value = collection.list->resolve(path);
  const bool container = std::holds_alternative<mv::Value::Array>(value.data) || std::holds_alternative<mv::Value::Object>(value.data);
  if (replacement) {
    if (container) throw std::invalid_argument("command collection structure cannot be replaced");
    value = *replacement;
  }
  return container ? runtimeHandle(owner, collection.list->view(path)) : writeValue(env, value);
} catch (const std::exception& error) { return throwException(env, error); }
napi_value collectionDelete(napi_env env, napi_callback_info info) try {
  const auto args = arguments(env, info, 3); auto& owner = session(env, args.at(0));
  requireRuntimeOwner(owner, args.at(1));
  auto branches = runtimeAs<mv::RuntimeBranches>(env, args.at(1));
  branches->values.erase(branchKey(asString(env, args.at(2))));
  return boolean(env, true);
} catch (const std::exception& error) { return throwException(env, error); }
napi_value interpreterPluginCommand(napi_env env, napi_callback_info info) try {
  const auto args = arguments(env, info, 4); auto& owner = session(env, args.at(0));
  requireRuntimeOwner(owner, args.at(1));
  RuntimeCallScope callScope(owner);
  runtimeAs<mv::RuntimeInterpreter>(env, args.at(1));
  std::vector<std::string> parameters;
  const auto values = readValue(env, args.at(3));
  for (const auto& arg : values.array()) parameters.push_back(arg.text());
  mv::PluginManager::callCommand(*owner.session, asString(env, args.at(2)), parameters);
  return undefined(env);
} catch (const std::exception& error) { return throwException(env, error); }
napi_value interpreterMode(napi_env env, napi_callback_info info) try {
  const auto args = arguments(env, info); auto& owner = session(env, args.at(0));
  requireRuntimeOwner(owner, args.at(1));
  auto object = runtimeAs<mv::RuntimeInterpreter>(env, args.at(1));
  if (args.size() == 3) owner.session->setRuntimeWaitMode(object, asString(env, args[2]));
  return string(env, owner.session->runtimeWaitMode(object));
} catch (const std::exception& error) { return throwException(env, error); }
napi_value interpreterWaitBase(napi_env env, napi_callback_info info) try {
  const auto args = arguments(env, info, 2); auto& owner = session(env, args.at(0));
  requireRuntimeOwner(owner, args.at(1));
  return boolean(env, owner.session->invokeWaitBase(runtimeAs<mv::RuntimeInterpreter>(env, args.at(1))));
} catch (const std::exception& error) { return throwException(env, error); }
napi_value pictureFrame(napi_env env, napi_callback_info info) try {
  const auto args = arguments(env, info); auto picture = runtimeAs<mv::RuntimePicture>(env, args.at(0));
  if (args.size() == 5) {
    std::array<double, 4> frame;
    for (std::size_t i = 0; i < 4; ++i) { frame[i] = asNumber(env, args[i + 1]); if (!std::isfinite(frame[i])) throw std::invalid_argument("invalid picture frame"); }
    picture->sprite->sourceFrame = frame;
  }
  if (!picture->sprite->sourceFrame && picture->sprite->bitmap)
    return writeValue(env, mv::Value::Array{0, 0, picture->sprite->bitmap->width, picture->sprite->bitmap->height});
  if (!picture->sprite->sourceFrame) return null(env);
  mv::Value::Array frame;
  for (const auto value : *picture->sprite->sourceFrame) frame.emplace_back(value);
  return writeValue(env, frame);
} catch (const std::exception& error) { return throwException(env, error); }
napi_value pictureBitmap(napi_env env, napi_callback_info info) try {
  const auto args = arguments(env, info);
  if (args.size() != 3 && args.size() != 4) throw std::invalid_argument("pictureBitmap requires session, picture, property and optional value");
  auto& owner = session(env, args[0]); requireRuntimeOwner(owner, args[1]);
  auto picture = runtimeAs<mv::RuntimePicture>(env, args[1]); const auto key = asString(env, args[2]);
  if (key == "name") {
    if (args.size() == 4) picture->sprite->bitmapName = asString(env, args[3]);
    return string(env, picture->sprite->bitmapName);
  }
  if (key != "bitmap" || args.size() != 4) throw std::invalid_argument("unknown picture bitmap operation");
  napi_valuetype type; check(env, napi_typeof(env, args[3], &type), "cannot inspect picture bitmap");
  if (type == napi_null) picture->sprite->bitmap.reset();
  else {
    const auto graphics = owner.owner ? owner.owner : state;
    if (!graphics) throw std::runtime_error("graphics runtime is unavailable");
    const auto bitmap = bitmapForRuntime(env, args[3], graphics->core);
    if (picture->sprite->bitmap != bitmap) picture->sprite->sourceFrame.reset();
    picture->sprite->bitmap = bitmap;
  }
  return undefined(env);
} catch (const std::exception& error) { return throwException(env, error); }
void requireRuntimeOwner(EngineSession& owner, napi_value object) {
  if (runtimePayload(owner.env, object).owner != owner.runtimeOwner)
    throw std::invalid_argument("runtime object belongs to another session");
}
napi_value createEngine(napi_env env, napi_callback_info info) {
  try {
    const auto args = arguments(env, info);
    if (args.size() != 1) throw std::invalid_argument("mvEngine.create requires database data");
    auto value = std::make_unique<EngineSession>();
    value->env = env;
    value->session = std::make_unique<mv::Session>(readValue(env, args[0]));
    napi_value result; check(env, napi_create_object(env, &result), "cannot create engine session");
    check(env, napi_type_tag_object(env, result, &engineSessionTag), "cannot identify engine session");
    check(env, napi_wrap(env, result, value.get(), [](napi_env, void* data, void*) { delete static_cast<EngineSession*>(data); }, nullptr, nullptr), "cannot own engine session");
    value.release(); return result;
  } catch (const std::exception& error) { return throwException(env, error); }
}
napi_value newGame(napi_env env, napi_callback_info info) {
  try { const auto args = arguments(env, info); if (args.size() != 1) throw std::invalid_argument("newGame requires session"); auto& owner = session(env, args[0]); if (owner.runtimeCalls) throw std::runtime_error("cannot reset a session during a script callback"); owner.session->newGame(); return undefined(env); }
  catch (const std::exception& error) { return throwException(env, error); }
}
napi_value battleTest(napi_env env, napi_callback_info info) {
  try { const auto args = arguments(env, info); if (args.size() != 1) throw std::invalid_argument("battleTest requires session"); auto& owner = session(env, args[0]); if (owner.runtimeCalls) throw std::runtime_error("cannot reset a session during a script callback"); owner.session->setupBattleTest(); return undefined(env); }
  catch (const std::exception& error) { return throwException(env,error); }
}
napi_value stepEngine(napi_env env, napi_callback_info info) {
  try {
    const auto args = arguments(env, info);
    if (args.empty() || args.size() > 2) throw std::invalid_argument("step requires session and optional logical input");
    auto& value = session(env, args[0]);
    if (value.stepping || value.runtimeCalls) throw std::runtime_error("native frame is already updating or executing a script callback");
    struct StepScope { bool& active; explicit StepScope(bool& value) : active(value) { active = true; } ~StepScope() { active = false; } } stepScope(value.stepping);
    mv::Input controls;
    if (args.size() == 2) {
      const auto input = readValue(env, args[1]);
      controls.direction = input["direction"].integer(); controls.ok = input["ok"].boolean();
      controls.okLongPressed = input["okLongPressed"].boolean();
      controls.inputDate = input["inputDate"].number(); controls.touchDate = input["touchDate"].number();
      if (!input["okTriggered"].null()) controls.okTriggered = input["okTriggered"].boolean();
      if (!input["cancelTriggered"].null()) controls.cancelTriggered = input["cancelTriggered"].boolean();
      if (!input["repeatedDirection"].null()) controls.repeatedDirection = input["repeatedDirection"].integer();
      if (!input["okRepeated"].null()) controls.okRepeated = input["okRepeated"].boolean();
      if (!input["cancelRepeated"].null()) controls.cancelRepeated = input["cancelRepeated"].boolean();
      if (!input["shiftTriggered"].null()) controls.shiftTriggered = input["shiftTriggered"].boolean();
      if (!input["directionTriggered"].null()) controls.directionTriggered = input["directionTriggered"].boolean();
      if (!input["pageUpRepeated"].null()) controls.pageUpRepeated = input["pageUpRepeated"].boolean();
      if (!input["pageDownRepeated"].null()) controls.pageDownRepeated = input["pageDownRepeated"].boolean();
      controls.cancel = input["cancel"].boolean(); controls.dash = input["dash"].boolean();
      if (!input["destinationX"].null()) controls.destinationX = input["destinationX"].integer();
      if (!input["destinationY"].null()) controls.destinationY = input["destinationY"].integer();
      if (!input["touchX"].null()) controls.touchX = input["touchX"].number();
      if (!input["touchY"].null()) controls.touchY = input["touchY"].number();
      controls.touchTriggered = input["touchTriggered"].boolean(); controls.touchPressed = input["touchPressed"].boolean(); controls.touchCancelled = input["touchCancelled"].boolean();
      controls.touchRepeated = input["touchRepeated"].boolean(); controls.touchLongPressed = input["touchLongPressed"].boolean();
      controls.touchMoved = input["touchMoved"].boolean(); controls.touchReleased = input["touchReleased"].boolean();
      controls.wheelX = input["wheelX"].number(); controls.wheelY = input["wheelY"].number();
      for (const auto& button : input["pressed"].array()) controls.pressed.insert(button.text());
    } else {
      auto& platform = host(env).platform;
      const bool focused = platform.windowFocused();
      if (!focused && value.focused) value.input.clear();
      value.focused = focused;
      if (focused) for (const auto& event : platform.keyEvents()) {
        if (event.down) {
          if (!event.repeat) mv::core::Graphics::onKeyDown(event.keyCode,event.ctrl,event.alt);
          auto& resources = mv::ResourceHandler::shared();
          if (value.input.keyDown(event.keyCode, resources.exists())) resources.retry();
        } else value.input.keyUp(event.keyCode);
      }
      std::vector<mv::core::Gamepad> pads;
      for (const auto& source : platform.gamepads()) {
        mv::core::Gamepad pad; pad.index = source.index; pad.connected = source.connected;
        pad.axes = source.axes; pad.buttons.resize(17);
        for (int button : source.buttonsDown) if (button >= 0 && button < 17) pad.buttons[button] = true;
        pads.push_back(std::move(pad));
      }
      const auto now = std::chrono::duration_cast<std::chrono::milliseconds>(std::chrono::system_clock::now().time_since_epoch()).count();
      value.input.update(pads, static_cast<double>(now));
      const auto geometry = host(env).core.renderer().presentationGeometry();
      const auto drawable = platform.drawableSize();
      const double ratioX = double(drawable.first) / std::max(1, platform.windowWidth());
      const double ratioY = double(drawable.second) / std::max(1, platform.windowHeight());
      const mv::core::Rectangle bounds{0,0,double(host(env).core.width()),double(host(env).core.height())};
      for (const auto& event : platform.pointerEvents()) {
        if (event.syntheticTouch) continue;
        const double x = std::floor((event.x * ratioX - geometry.viewportX) * bounds.width / std::max(1,geometry.viewportWidth) + 0.5);
        const double y = std::floor((event.y * ratioY - geometry.viewportY) * bounds.height / std::max(1,geometry.viewportHeight) + 0.5);
        if (event.type == "mousedown") value.touch.mouseDown(event.button,x,y,bounds.contains(x,y),static_cast<double>(now));
        else if (event.type == "mouseup") value.touch.mouseUp(event.button,x,y);
        else if (event.type == "mousemove") value.touch.mouseMove(x,y);
        else if (event.type == "wheel") value.touch.wheel(event.deltaX,event.deltaY);
        else if (event.type == "touchstart") value.touch.touchStart({{x,y}},event.touchCount,host(env).core.width(),host(env).core.height(),static_cast<double>(now));
        else if (event.type == "touchmove") value.touch.touchMove(x,y);
        else if (event.type == "touchend") value.touch.touchEnd(x,y);
        else if (event.type == "touchcancel") value.touch.touchCancel();
      }
      platform.clearPointerEvents();
      value.touch.update();
      controls.touchX = value.touch.x(); controls.touchY = value.touch.y();
      controls.touchTriggered = value.touch.isTriggered(); controls.touchPressed = value.touch.isPressed(); controls.touchCancelled = value.touch.isCancelled();
      controls.touchRepeated = value.touch.isRepeated(); controls.touchLongPressed = value.touch.isLongPressed();
      controls.touchMoved = value.touch.isMoved(); controls.touchReleased = value.touch.isReleased();
      controls.wheelX = value.touch.wheelX(); controls.wheelY = value.touch.wheelY();
      controls.direction = value.input.dir4(); controls.ok = value.input.isPressed("ok");
      controls.cancel = value.input.isPressed("cancel") || value.input.isPressed("menu");
      controls.dash = value.input.isPressed("shift");
      for (const char* button : {"ok","cancel","menu","escape","shift","control","tab","pageup","pagedown","up","down","left","right","debug"})
        if (value.input.isPressed(button)) controls.pressed.insert(button);
      controls.okTriggered = value.input.isTriggered("ok");
      controls.okLongPressed = value.input.isLongPressed("ok");
      controls.inputDate = value.input.date(); controls.touchDate = value.touch.date();
      controls.okRepeated = value.input.isRepeated("ok");
      controls.cancelRepeated = value.input.isRepeated("cancel");
      controls.shiftTriggered = value.input.isTriggered("shift");
      controls.pageUpRepeated = value.input.isRepeated("pageup");
      controls.pageDownRepeated = value.input.isRepeated("pagedown");
      controls.cancelTriggered = value.input.isTriggered("cancel") || value.input.isTriggered("menu") || value.touch.isCancelled();
      const char* direction = controls.direction == 2 ? "down" : controls.direction == 4 ? "left" : controls.direction == 6 ? "right" : "up";
      controls.repeatedDirection = value.input.isRepeated(direction) ? controls.direction : 0;
      controls.directionTriggered = controls.direction != 0 && value.input.isTriggered(direction);
    }
    if (controls.touchTriggered && controls.touchX && controls.touchY) mv::core::Graphics::onPointerDown(*controls.touchX,*controls.touchY);
    value.session->step(controls); collectRuntime(value); return boolean(env, !value.session->finished());
  } catch (const std::exception& error) { return throwException(env, error); }
}
napi_value acknowledge(napi_env env, napi_callback_info info) {
  try { const auto args = arguments(env, info); if (args.empty() || args.size() > 2) throw std::invalid_argument("acknowledge requires session and optional choice"); session(env, args[0]).session->acknowledge(args.size() == 2 ? asInt32(env, args[1]) : -1); return undefined(env); }
  catch (const std::exception& error) { return throwException(env, error); }
}
napi_value snapshot(napi_env env, napi_callback_info info) {
  try { const auto args = arguments(env, info); if (args.size() != 1) throw std::invalid_argument("snapshot requires session"); auto& value = session(env,args[0]); auto result = value.session->snapshot();
    const auto& touch = value.touch;
    std::get<mv::Value::Object>(result.data)["touchInput"] = mv::Value::Object{
      {"pressed",touch.isPressed()},{"triggered",touch.isTriggered()},{"cancelled",touch.isCancelled()},
      {"moved",touch.isMoved()},{"released",touch.isReleased()},{"repeated",touch.isRepeated()},
      {"longPressed",touch.isLongPressed()},{"x",touch.x()},{"y",touch.y()},
      {"wheelX",touch.wheelX()},{"wheelY",touch.wheelY()},{"date",touch.date()}};
    return writeValue(env,result); }
  catch (const std::exception& error) { return throwException(env, error); }
}
napi_value dispose(napi_env env, napi_callback_info info) {
  try { const auto args = arguments(env, info); if (args.size() != 1) throw std::invalid_argument("dispose requires session"); auto& value = session(env, args[0]); if (value.runtimeCalls) throw std::runtime_error("cannot dispose a session during a script callback"); value.presentation.reset(); value.session.reset(); value.owner.reset(); return undefined(env); }
  catch (const std::exception& error) { return throwException(env, error); }
}
napi_value attach(napi_env env, napi_callback_info info) {
  try {
    const auto args = arguments(env, info);
    if (args.size() != 2) throw std::invalid_argument("attach requires session and presentation settings");
    host(env);
    auto& value = session(env, args[0]);
    if (value.presentation) throw std::runtime_error("presentation already attached");
    value.owner = state;
    value.presentation = std::make_unique<mv::Presentation>(value.owner->core, *value.session, readValue(env, args[1]));
    return undefined(env);
  } catch (const std::exception& error) { return throwException(env, error); }
}
napi_value present(napi_env env, napi_callback_info info) {
  try {
    const auto args = arguments(env, info);
    if (args.size() != 1) throw std::invalid_argument("present requires session");
    auto& value = session(env, args[0]);
    if (!value.presentation) throw std::runtime_error("presentation is not attached");
    value.presentation->render(); return undefined(env);
  } catch (const std::exception& error) { return throwException(env, error); }
}
napi_value render(napi_env env, napi_callback_info info) {
  try {
    const auto args = arguments(env, info);
    if (args.size() != 1) throw std::invalid_argument("render requires session");
    auto& value = session(env, args[0]);
    if (!value.presentation) throw std::runtime_error("presentation is not attached");
    const bool rendered = value.presentation->renderFrame([&]{renderPreparedFrame(env,*value.owner);});
    return boolean(env,rendered);
  } catch (const std::exception& error) { return throwException(env, error); }
}
napi_value openTitle(napi_env env, napi_callback_info info) {
  try { const auto args = arguments(env, info); if (args.size() != 1) throw std::invalid_argument("openTitle requires session"); session(env, args[0]).session->openTitle(); return undefined(env); }
  catch (const std::exception& error) { return throwException(env, error); }
}
napi_value startBattle(napi_env env, napi_callback_info info) {
  try { const auto args = arguments(env, info); if (args.size() != 4) throw std::invalid_argument("startBattle requires session, troop, canEscape, canLose"); auto& owner = session(env, args[0]); if (owner.runtimeCalls) throw std::runtime_error("cannot replace battle state during a script callback"); owner.session->startBattle(asInt32(env, args[1]), asBoolean(env, args[2]), asBoolean(env, args[3])); return undefined(env); }
  catch (const std::exception& error) { return throwException(env, error); }
}
napi_value chooseAction(napi_env env, napi_callback_info info) {
  try { const auto args = arguments(env, info); if (args.size() != 5) throw std::invalid_argument("chooseAction requires session, actor index, action, target, item"); session(env, args[0]).session->chooseAction(asInt32(env, args[1]), asInt32(env, args[2]), asInt32(env, args[3]), asBoolean(env, args[4])); return undefined(env); }
  catch (const std::exception& error) { return throwException(env, error); }
}
napi_value randomStream(napi_env env, napi_callback_info info) {
  try {
    const auto args = arguments(env, info); if (args.size() != 2) throw std::invalid_argument("setRandomStream requires session and values");
    const auto values = readValue(env, args[1]); std::vector<double> stream;
    for (const auto& value : values.array()) stream.push_back(value.number(-1));
    session(env, args[0]).session->setRandomStream(std::move(stream)); return undefined(env);
  } catch (const std::exception& error) { return throwException(env, error); }
}
napi_value encodeSaveGraph(napi_env env,napi_callback_info info) {
  try {const auto args=arguments(env,info);if(args.size()!=1)throw std::invalid_argument("encodeGraph requires state");const auto encoded=mv::JsonEx::stringifyOptional(readValue(env,args[0]));return encoded?string(env,*encoded):undefined(env);}
  catch(const std::exception& error){return throwException(env,error);}
}
napi_value decodeSaveGraph(napi_env env,napi_callback_info info) {
  try {const auto args=arguments(env,info);if(args.size()!=1)throw std::invalid_argument("decodeGraph requires JSON");return writeValue(env,mv::JsonEx::parse(asString(env,args[0])));}
  catch(const std::exception& error){return throwException(env,error);}
}
napi_value save(napi_env env, napi_callback_info info) {
  try { const auto args = arguments(env, info); if (args.size() != 1) throw std::invalid_argument("save requires session"); auto& value = session(env, args[0]); if (value.presentation) value.presentation->captureAudioState(); return writeValue(env, value.session->save()); }
  catch (const std::exception& error) { return throwException(env, error); }
}
napi_value load(napi_env env, napi_callback_info info) {
  try { const auto args = arguments(env, info); if (args.size() != 2) throw std::invalid_argument("load requires session and contents"); auto& owner = session(env, args[0]); if (owner.runtimeCalls) throw std::runtime_error("cannot load a session during a script callback"); owner.session->load(readValue(env, args[1])); return undefined(env); }
  catch (const std::exception& error) { return throwException(env, error); }
}
napi_value storageStatus(napi_env env, napi_callback_info info) {
  try { const auto args = arguments(env, info); if (args.size() != 1) throw std::invalid_argument("storageStatus requires session"); const auto& value = *session(env, args[0]).session; return writeValue(env, mv::Value::Object{{"save", value.saveRequested()}, {"load", value.loadRequested()}, {"slot", value.ui().cursor + 1}, {"configurationRevision", value.configurationRevision()}}); }
  catch (const std::exception& error) { return throwException(env, error); }
}
napi_value configure(napi_env env, napi_callback_info info) {
  try { const auto args = arguments(env, info); if (args.size() != 2) throw std::invalid_argument("configure requires session and settings"); session(env, args[0]).session->configure(readValue(env, args[1])); return undefined(env); }
  catch (const std::exception& error) { return throwException(env, error); }
}
napi_value setSaveMetadata(napi_env env, napi_callback_info info) {
  try { const auto args = arguments(env, info); if (args.size() != 2) throw std::invalid_argument("setSaveMetadata requires session and slot metadata"); session(env, args[0]).session->setSaveMetadata(readValue(env, args[1]).array()); return undefined(env); }
  catch (const std::exception& error) { return throwException(env, error); }
}
napi_value configuration(napi_env env, napi_callback_info info) {
  try { const auto args = arguments(env, info); if (args.size() != 1) throw std::invalid_argument("configuration requires session"); return writeValue(env, session(env, args[0]).session->configuration()); }
  catch (const std::exception& error) { return throwException(env, error); }
}
napi_value completeStorage(napi_env env, napi_callback_info info) {
  try { const auto args = arguments(env, info); if (args.size() != 2) throw std::invalid_argument("completeStorage requires session and success"); session(env, args[0]).session->completeStorage(asBoolean(env, args[1])); return undefined(env); }
  catch (const std::exception& error) { return throwException(env, error); }
}
}
void registerMvEngineBindings(napi_env env, napi_value exports) {
  napi_value engine; check(env, napi_create_object(env, &engine), "cannot create engine API");
  method(env, engine, "connectRuntime", connectRuntime);
  method(env, engine, "picture", runtimePicture); method(env, engine, "createPicture", createRuntimePicture);
  method(env, engine, "pictureField", pictureField); method(env, engine, "pictureInvoke", pictureInvoke);
  method(env, engine, "pictureTone", pictureTone); method(env, engine, "toneComponent", toneComponent);
  method(env, engine, "interpreterField", interpreterField); method(env, engine, "interpreterWaitInvoke", interpreterWaitInvoke);
  method(env, engine, "interpreterPluginCommand", interpreterPluginCommand);
  method(env, engine, "interpreterCommandInvoke", interpreterCommandInvoke);
  method(env, engine, "interpreterCollection", interpreterCollection);
  method(env, engine, "interpreterSetList", interpreterSetList); method(env, engine, "interpreterLifecycle", interpreterLifecycle);
  method(env, engine, "mapId", mapId);
  method(env, engine, "inBattle", inBattle); method(env, engine, "ownsPictureSprite", ownsPictureSprite);
  method(env, engine, "messageInvoke", messageInvoke); method(env, engine, "messageField", messageField);
  method(env, engine, "imageRequests", imageRequests); method(env, engine, "commonEventList", commonEventList);
  method(env, engine, "messageChoices", messageChoices); method(env, engine, "interpreterControl", interpreterControl);
  method(env, engine, "random", scriptRandom);
  method(env, engine, "collectionInfo", collectionInfo); method(env, engine, "collectionField", collectionField); method(env, engine, "collectionDelete", collectionDelete);
  method(env, engine, "interpreterMode", interpreterMode); method(env, engine, "interpreterWaitBase", interpreterWaitBase);
  method(env, engine, "pictureFrame", pictureFrame);
  method(env, engine, "pictureBitmap", pictureBitmap);
  method(env, engine, "create", createEngine); method(env, engine, "newGame", newGame); method(env, engine, "battleTest", battleTest);
  method(env, engine, "step", stepEngine); method(env, engine, "acknowledge", acknowledge);
  method(env, engine, "snapshot", snapshot); method(env, engine, "dispose", dispose);
  method(env, engine, "attach", attach); method(env, engine, "present", present); method(env, engine, "render", render); method(env, engine, "openTitle", openTitle);
  method(env, engine, "startBattle", startBattle); method(env, engine, "chooseAction", chooseAction); method(env, engine, "setRandomStream", randomStream);
  method(env, engine, "configure", configure); method(env, engine, "configuration", configuration);
  method(env, engine, "setSaveMetadata", setSaveMetadata);
  method(env, engine, "encodeGraph", encodeSaveGraph); method(env, engine, "decodeGraph", decodeSaveGraph);
  method(env, engine, "save", save); method(env, engine, "load", load); method(env, engine, "storageStatus", storageStatus); method(env, engine, "completeStorage", completeStorage);
  check(env, napi_set_named_property(env, exports, "mvEngine", engine), "cannot register engine API");
}
}
