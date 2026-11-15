#include "node_addon_internal.hpp"
#include "bridge_trace.hpp"
#include <unordered_map>
#include "mv_engine.hpp"
#include "mv_tiled_map.hpp"
#include "mv_presentation.hpp"
#include "mv_core_input.hpp"
#include "mv_core_types.hpp"
#include "mv_core_utils.hpp"
#include "mv_managers.hpp"
#include "mv_sprites.hpp"
#include "mv_generated_bindings.hpp"
#include "mv_bound_sprites.hpp"
#include "../patches/omori/character-presentation.hpp"
#include "mv_windows.hpp"
#include "mv_window_bindings.hpp"
#include <cstring>
#include <cmath>
#include <string_view>
#include <unordered_map>

namespace pmjs::addon {
namespace {
struct DatabaseGraph;
void collectDatabase(const std::shared_ptr<DatabaseGraph>& graph);
void disconnectDatabase(const std::shared_ptr<DatabaseGraph>& graph);
napi_value databaseObject(const mv::Value& value);
struct ValueHandleScope {
  napi_env env;
  napi_handle_scope scope;
  explicit ValueHandleScope(napi_env value) : env(value) {
    check(env, napi_open_handle_scope(env, &scope), "cannot open value conversion scope");
  }
  ~ValueHandleScope() { napi_close_handle_scope(env, scope); }
};
mv::Value readValue(napi_env env, napi_value value, int depth = 0, bool databaseProjection = false) {
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
          ValueHandleScope handles(env);
          napi_value item;
          check(env, napi_get_element(env, value, i, &item), "cannot read engine item");
          result.push_back(readValue(env, item, depth + 1, databaseProjection));
        }
        return result;
      }
      napi_value keys;
      check(env, napi_get_property_names(env, value, &keys), "cannot read engine fields");
      std::uint32_t length = 0;
      check(env, napi_get_array_length(env, keys, &length), "cannot read engine keys");
      mv::Value::Object result;
      for (std::uint32_t i = 0; i < length; ++i) {
        ValueHandleScope handles(env);
        napi_value key, item;
        check(env, napi_get_element(env, keys, i, &key), "cannot read engine key");
        check(env, napi_get_property(env, value, key, &item), "cannot read engine field");
        if (databaseProjection) {
          napi_valuetype memberType; check(env,napi_typeof(env,item,&memberType),"cannot inspect database member");
          if (memberType==napi_function || memberType==napi_symbol || memberType==napi_undefined) continue;
        }
        result.emplace(asString(env, key), readValue(env, item, depth + 1, databaseProjection));
      }
      return result;
    }
    case napi_function: case napi_symbol: if (databaseProjection) return mv::Value::undefined(); [[fallthrough]];
    default: throw std::invalid_argument("engine data must contain only JSON values");
  }
}
napi_value writeValue(napi_env env, const mv::Value& value) {
  if (value.reader) { if (auto object = databaseObject(value)) return object; return writeValue(env, value.snapshot()); }
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
struct NativePresentationProgram;
struct EngineSession;
void collectCharacterPresentation(EngineSession&);
struct EngineSession {
  struct RuntimeReference {
    napi_ref reference;
    bool rooted;
  };
  std::shared_ptr<const int> runtimeOwner = std::make_shared<const int>(0);
  int runtimeCalls = 0, sceneCalls = 0;
  unsigned scriptFrames = 0;
  std::uint64_t nextResourceLoader=0;
  bool stepping = false;
  bool touchPrepared = false;
  std::optional<mv::Input> mapSceneInput;
  bool sceneRequestsSuppressed = false;
  napi_env env = nullptr;
  napi_ref runtimeSelf = nullptr;
  std::map<std::uint64_t, RuntimeReference> runtimeReferences;
  std::shared_ptr<DatabaseGraph> database;
  std::shared_ptr<NativePresentationProgram> characterPresentation;
  ~EngineSession() {
    characterPresentation.reset();
    disconnectDatabase(database);
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
struct SceneTransitionScope {
  EngineSession& owner;
  explicit SceneTransitionScope(EngineSession& value) : owner(value) { ++owner.sceneCalls; }
  ~SceneTransitionScope() { if (--owner.sceneCalls == 0 && !owner.stepping && !owner.runtimeCalls) owner.session->deferScriptScene(); }
};
struct RuntimeSceneState : mv::RuntimeObject {
  mv::Ui state;
  explicit RuntimeSceneState(const mv::Ui& value) : state(value) {}
};
struct RuntimeCallScope {
  EngineSession& owner;
  explicit RuntimeCallScope(EngineSession& value) : owner(value) { ++owner.runtimeCalls; }
  ~RuntimeCallScope() {
    if (--owner.runtimeCalls == 0 && !owner.stepping && !owner.sceneCalls) owner.session->deferScriptScene();
  }
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
  if (!value->stepping && !value->runtimeCalls && !value->sceneCalls && !value->scriptFrames) collectDatabase(value->database);
  return *value;
}
struct DatabaseGraph {
  napi_env env;
  EngineSession* owner;
  napi_ref roots = nullptr;
  std::uint64_t nextIdentity = 0;
  std::vector<std::shared_ptr<void>> pins;
  DatabaseGraph(napi_env environment, EngineSession& session, napi_value object) : env(environment), owner(&session) {
    auto references = moduleObject(env);
    check(env, napi_set_named_property(env, object, "__mvDatabaseReferences", references), "cannot attach database references");
    check(env, napi_create_reference(env, references, 0, &roots), "cannot reference database roots");
  }
  ~DatabaseGraph() { napi_delete_reference(env, roots); }
  napi_value references() const {
    napi_value result = nullptr;
    check(env, napi_get_reference_value(env, roots, &result), "cannot retrieve database roots");
    if (!result || !owner) throw std::runtime_error("database session is unavailable");
    return result;
  }
  template<class T> std::shared_ptr<T> pin(std::shared_ptr<T> value) { pins.push_back(value); return value; }
};
void collectDatabase(const std::shared_ptr<DatabaseGraph>& graph) { if (graph) graph->pins.clear(); }
void disconnectDatabase(const std::shared_ptr<DatabaseGraph>& graph) { if (graph) { graph->owner = nullptr; graph->pins.clear(); } }
bool sameDatabaseValue(const mv::Value& left, const mv::Value& right) {
  if (left.reader || right.reader) return left.reader == right.reader;
  if (left.data.index() != right.data.index()) return false;
  if (const auto* value = std::get_if<bool>(&left.data)) return *value == std::get<bool>(right.data);
  if (const auto* value = std::get_if<double>(&left.data)) return *value == std::get<double>(right.data);
  if (const auto* value = std::get_if<std::string>(&left.data)) return *value == std::get<std::string>(right.data);
  return true;
}
struct DatabaseReader : mv::ValueReader {
  std::weak_ptr<DatabaseGraph> graph;
  napi_env env;
  napi_ref reference = nullptr;
  std::string identity;
  bool isArray = false, overlay = false, sourceRooted = true;
  std::shared_ptr<mv::ValueReader> fallback;
  mutable std::set<std::string> knownFields;
  mutable std::map<std::string, std::weak_ptr<mv::Value>> fields;
  mutable std::map<std::string, std::shared_ptr<mv::Value>> borrowedFields;
  mutable std::weak_ptr<mv::Value::Array> items;
  DatabaseReader(const std::shared_ptr<DatabaseGraph>& context, napi_value object, bool root, bool retainSource=true) : graph(context), env(context->env), overlay(root), sourceRooted(retainSource) {
    identity = std::to_string(++context->nextIdentity);
    check(env, napi_is_array(env, object, &isArray), "cannot inspect database collection");
    if (overlay) {
      napi_value keys; std::uint32_t length;
      check(env, napi_get_property_names(env, object, &keys), "cannot inspect database tables");
      check(env, napi_get_array_length(env, keys, &length), "cannot inspect database table count");
      for (std::uint32_t index = 0; index < length; ++index) {
        napi_value key; check(env, napi_get_element(env, keys, index, &key), "cannot inspect database table name");
        knownFields.insert(asString(env, key));
      }
    }
    if(sourceRooted)check(env, napi_set_named_property(env, context->references(), identity.c_str(), object), "cannot retain database object");
    check(env, napi_create_reference(env, object, 0, &reference), "cannot reference database object");
  }
  ~DatabaseReader() override {
    if (const auto context = graph.lock(); context && sourceRooted) {
      napi_value roots = nullptr;
      if (napi_get_reference_value(env, context->roots, &roots) == napi_ok && roots) {
        napi_value key; bool removed;
        if (napi_create_string_utf8(env, identity.c_str(), identity.size(), &key) == napi_ok) napi_delete_property(env, roots, key, &removed);
      }
    }
    napi_delete_reference(env, reference);
  }
  std::shared_ptr<DatabaseGraph> context() const {
    auto result = graph.lock();
    if (!result || !result->owner || !result->owner->session) throw std::runtime_error("database session is unavailable");
    return result;
  }
  napi_value object() const {
    context();
    napi_value result = nullptr;
    check(env, napi_get_reference_value(env, reference, &result), "cannot retrieve database object");
    if (!result) throw std::runtime_error("database object is unavailable");
    return result;
  }
  bool sameSource(const mv::ValueReader& other) const override {
    const auto* source = dynamic_cast<const DatabaseReader*>(&other);
    if (!source || source->env != env) return false;
    bool same = false;
    check(env, napi_strict_equals(env, object(), source->object(), &same), "cannot compare database sources");
    return same;
  }
  const mv::Value* retain(const std::string& key, napi_value value) const {
    auto owner = context();
    mv::Value current;
    napi_valuetype type; check(env, napi_typeof(env, value, &type), "cannot inspect database value");
    auto previous = sourceRooted ? fields[key].lock() : borrowedFields[key];
    if (type == napi_object) {
      if (previous && previous->reader) {
        const auto reader = std::dynamic_pointer_cast<DatabaseReader>(previous->reader);
        bool same = false;
        if (reader) {
          napi_value object=nullptr;
          check(env,napi_get_reference_value(env,reader->reference,&object),"cannot retrieve cached database object");
          if(object)check(env,napi_strict_equals(env,object,value,&same),"cannot compare database objects");
        }
        if (same) return previous.get();
      }
      auto reader = std::make_shared<DatabaseReader>(owner, value, false, sourceRooted);
      current.data = reader->isArray ? mv::Value(mv::Value::Array{}).data : mv::Value(mv::Value::Object{}).data;
      current.reader = std::move(reader);
    } else {
      current = readValue(env, value,0,true);
      if (previous && sameDatabaseValue(*previous, current)) return previous.get();
    }
    auto result = owner->pin(std::make_shared<mv::Value>(std::move(current)));
    if(sourceRooted)fields[key] = result;
    else borrowedFields[key] = result;
    return result.get();
  }
  const mv::Value* field(const std::string& key) const override {
    bridge_trace::Scope trace("read:"+key);
    auto owner = context(); RuntimeCallScope call(*owner->owner);
    auto source = object();
    if (overlay) {
      bool present; check(env, napi_has_named_property(env, source, key.c_str(), &present), "cannot inspect database field");
      if (!present && !knownFields.contains(key)) return fallback ? fallback->field(key) : nullptr;
      if (present) knownFields.insert(key);
    }
    napi_value value; check(env, napi_get_named_property(env, source, key.c_str(), &value), "cannot read database field");
    return retain(key, value);
  }
  const mv::Value* element(std::size_t index) const override { return field(std::to_string(index)); }
  std::size_t arrayLength() const override {
    if (!isArray) return 0;
    std::uint32_t length;
    check(env, napi_get_array_length(env, object(), &length), "cannot read database length");
    return length;
  }
  const mv::Value::Array& array() const override {
    static const mv::Value::Array empty;
    if (!isArray) return empty;
    auto owner = context(); RuntimeCallScope call(*owner->owner);
    std::uint32_t length; check(env, napi_get_array_length(env, object(), &length), "cannot read database length");
    auto result = std::make_shared<mv::Value::Array>(); result->reserve(length);
    for (std::uint32_t index = 0; index < length; ++index) result->push_back(element(index)->reference());
    if (auto previous = items.lock(); previous && previous->size() == result->size() && std::equal(previous->begin(), previous->end(), result->begin(), sameDatabaseValue)) return *previous;
    items = owner->pin(result);
    return *result;
  }
  mv::Value snapshot() const override {
    auto owner = context(); RuntimeCallScope call(*owner->owner);
    auto result = readValue(env, object(), 0, true);
    if (!overlay) return result;
    auto merged = fallback ? std::get<mv::Value::Object>(fallback->snapshot().data) : mv::Value::Object{};
    for (const auto& key : knownFields) merged[key] = mv::Value::undefined();
    for (auto& [key, value] : std::get<mv::Value::Object>(result.data)) merged[key] = std::move(value);
    return merged;
  }
};
napi_value databaseObject(const mv::Value& value) {
  const auto reader = std::dynamic_pointer_cast<DatabaseReader>(value.reader);
  return reader && !reader->overlay ? reader->object() : nullptr;
}
struct RuntimePayload {
  std::shared_ptr<const int> owner;
  std::shared_ptr<mv::RuntimeObject> object;
  std::shared_ptr<mv::Interpreter> interpreterOwner;
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
  std::shared_ptr<mv::Interpreter> interpreterOwner;
  if (const auto interpreter = std::dynamic_pointer_cast<mv::RuntimeInterpreter>(object)) interpreterOwner = interpreter->detachedRoot.lock();
  auto payload = std::make_unique<RuntimePayload>(RuntimePayload{owner.runtimeOwner, object, interpreterOwner});
  napi_value result = moduleObject(env), identity;
  check(env, napi_create_bigint_uint64(env, object->identity, &identity), "cannot create runtime identity");
  const napi_property_descriptor identityProperty{"identity", nullptr, nullptr, nullptr, nullptr, identity, napi_default, nullptr};
  check(env, napi_define_properties(env, result, 1, &identityProperty), "cannot set runtime identity");
  if (const auto bound = std::dynamic_pointer_cast<mv::RuntimeBoundObject>(object))
    check(env, napi_set_named_property(env, result, "bindingType", string(env, bound->bindingType())), "cannot set runtime binding type");
  if (const auto character=std::dynamic_pointer_cast<mv::RuntimeCharacter>(object)) {
    check(env,napi_set_named_property(env,result,"entityType",string(env,"character")),"cannot set entity type");
    check(env,napi_set_named_property(env,result,"entityId",number(env,character->id)),"cannot set entity ID");
  } else if (const auto actor=std::dynamic_pointer_cast<mv::RuntimeActor>(object)) {
    check(env,napi_set_named_property(env,result,"entityType",string(env,actor->value().enemy ? "enemy" : "actor")),"cannot set entity type");
  }
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
  bridge_trace::Scope trace(std::string("callback:")+methodName);
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
napi_value resourceCallback(napi_env env,std::function<void()> callback) {
  auto data=std::make_unique<std::function<void()>>(std::move(callback));napi_value function;
  check(env,napi_create_function(env,"nativeResourceCallback",NAPI_AUTO_LENGTH,[](napi_env env,napi_callback_info info)->napi_value {
    try {void* data=nullptr;check(env,napi_get_cb_info(env,info,nullptr,nullptr,nullptr,&data),"cannot read resource callback");const auto& callback=*static_cast<std::function<void()>*>(data);if(callback)callback();return undefined(env);}
    catch(const std::exception& error) {return throwException(env,error);}
  },data.get(),&function),"cannot create resource callback");
  check(env,napi_add_finalizer(env,function,data.get(),[](napi_env,void* data,void*){delete static_cast<std::function<void()>*>(data);},nullptr,nullptr),"cannot own resource callback");
  data.release();return function;
}
struct ResourceLoaderReference {
  napi_env env; napi_ref reference=nullptr,roots=nullptr;
  std::string key;
  ResourceLoaderReference(napi_env environment,napi_value function,napi_value container,std::string id):env(environment),key(std::move(id)) {
    check(env,napi_set_named_property(env,container,key.c_str(),function),"cannot root resource loader");
    check(env,napi_create_reference(env,function,0,&reference),"cannot reference resource loader");
    check(env,napi_create_reference(env,container,0,&roots),"cannot reference resource loader owner");
    check(env,napi_add_env_cleanup_hook(env,cleanup,this),"cannot own resource loader environment");
  }
  static void cleanup(void* data) {auto& self=*static_cast<ResourceLoaderReference*>(data);self.env=nullptr;self.reference=nullptr;self.roots=nullptr;}
  ~ResourceLoaderReference() {
    if(!env)return;
    napi_value container=nullptr;bool removed=false;
    if(napi_get_reference_value(env,roots,&container)==napi_ok&&container) {napi_value name;if(napi_create_string_utf8(env,key.c_str(),key.size(),&name)==napi_ok)napi_delete_property(env,container,name,&removed);}
    napi_remove_env_cleanup_hook(env,cleanup,this);napi_delete_reference(env,reference);napi_delete_reference(env,roots);
  }
  void invoke() {
    if(!env)return;napi_value function=nullptr,receiver,result;check(env,napi_get_reference_value(env,reference,&function),"cannot read resource loader");if(!function)return;
    check(env,napi_get_global(env,&receiver),"cannot read resource loader receiver");check(env,napi_call_function(env,receiver,function,0,nullptr,&result),"native resource loader callback failed");
  }
};

void applyTouchEvent(EngineSession& owner, const Platform::PointerEvent& event) {
  auto& touch = owner.touch;
  if (event.type == "wheel") { touch.wheel(event.deltaX,event.deltaY); return; }
  if (event.type == "touchcancel") { touch.touchCancel(); return; }
  if (event.type == "mousedown" && event.button == 1) return;
  auto& platform = host(owner.env).platform;
  const auto geometry = host(owner.env).core.renderer().presentationGeometry();
  const auto drawable = platform.drawableSize();
  const double ratioX = double(drawable.first) / std::max(1, platform.windowWidth());
  const double ratioY = double(drawable.second) / std::max(1, platform.windowHeight());
  const mv::core::Rectangle bounds{0,0,double(host(owner.env).core.width()),double(host(owner.env).core.height())};
  const double x = std::floor((event.x * ratioX - geometry.viewportX) * bounds.width / std::max(1,geometry.viewportWidth) + 0.5);
  const double y = std::floor((event.y * ratioY - geometry.viewportY) * bounds.height / std::max(1,geometry.viewportHeight) + 0.5);
  const double now = static_cast<double>(std::chrono::duration_cast<std::chrono::milliseconds>(std::chrono::system_clock::now().time_since_epoch()).count());
  if (event.type == "mousedown") touch.mouseDown(event.button,x,y,bounds.contains(x,y),now);
  else if (event.type == "mouseup") touch.mouseUp(event.button,x,y);
  else if (event.type == "mousemove") touch.mouseMove(x,y);
  else if (event.type == "touchstart") touch.touchStart({{x,y}},event.touchCount,static_cast<int>(bounds.width),static_cast<int>(bounds.height),now);
  else if (event.type == "touchmove") touch.touchMove(x,y);
  else if (event.type == "touchend") touch.touchEnd(x,y);
  else if (event.type == "pointerdown") touch.pointerDown(event.touchCount > 0,event.primary,x,y,bounds.contains(x,y));
}
void invokeTouchHandler(EngineSession& owner, const std::string& method, const mv::Value& source) {
  static const std::map<std::string,std::string> types{{"_onLeftButtonDown","mousedown"},{"_onMiddleButtonDown","mousedown"},{"_onRightButtonDown","mousedown"},
    {"_onMouseMove","mousemove"},{"_onMouseUp","mouseup"},{"_onWheel","wheel"},{"_onTouchStart","touchstart"},
    {"_onTouchMove","touchmove"},{"_onTouchEnd","touchend"},{"_onTouchCancel","touchcancel"},{"_onPointerDown","pointerdown"}};
  const auto found = types.find(method);
  if (found == types.end()) throw std::invalid_argument("touch event handler is not bound: " + method);
  Platform::PointerEvent event{}; event.type = found->second;
  event.x = source["pageX"].number(); event.y = source["pageY"].number(); event.button = source["button"].integer();
  if (method == "_onLeftButtonDown") event.button = 0;
  else if (method == "_onMiddleButtonDown") event.button = 1;
  else if (method == "_onRightButtonDown") event.button = 2;
  event.deltaX = source["deltaX"].number(); event.deltaY = source["deltaY"].number();
  event.primary = source["isPrimary"].boolean();
  event.touchCount = static_cast<int>(source["touches"].arrayLength());
  if (method == "_onPointerDown") event.touchCount = source["pointerType"].text() == "touch" ? 1 : 0;
  if (event.type == "touchstart" || event.type == "touchmove" || event.type == "touchend") {
    for (const auto& point : source["changedTouches"].array()) {
      event.x = point["pageX"].number(); event.y = point["pageY"].number(); applyTouchEvent(owner,event);
    }
  } else applyTouchEvent(owner,event);
}
void updateTouchInput(EngineSession& owner) {
  owner.touchPrepared = false;
  auto& platform = host(owner.env).platform;
  std::vector<Platform::PointerEvent> snapshot;
  if (owner.runtimeSelf) { snapshot = platform.pointerEvents(); platform.clearPointerEvents(); }
  const auto& events = owner.runtimeSelf ? snapshot : platform.pointerEvents();
  for (const auto& event : events) {
    if (event.syntheticTouch) continue;
    if (!owner.runtimeSelf) { applyTouchEvent(owner,event); continue; }
    mv::Value::Array touches(static_cast<std::size_t>(std::max(0, event.touchCount)));
    const mv::Value point = mv::Value::Object{{"pageX", event.x}, {"pageY", event.y}};
    const mv::Value data = mv::Value::Object{{"type", event.type}, {"button", event.button}, {"buttons", static_cast<double>(event.buttons)},
      {"pageX", event.x}, {"pageY", event.y}, {"clientX", event.x}, {"clientY", event.y},
      {"deltaX", event.deltaX}, {"deltaY", event.deltaY}, {"changedTouches", mv::Value::Array{point}}, {"touches", touches},
      {"pointerType", "touch"}, {"isPrimary", event.primary}};
    callRuntime(owner, "touchEvent", {writeValue(owner.env, data)});
  }
  if (!owner.runtimeSelf) platform.clearPointerEvents();
  if (owner.runtimeSelf) callRuntime(owner, "touchUpdate", {}); else owner.touch.update();
  owner.touchPrepared = true;
}
napi_value updateTouch(napi_env env, napi_callback_info info) try {
  const auto args = arguments(env, info, 1); auto& owner = session(env, args.at(0));
  if (owner.runtimeCalls || owner.stepping) throw std::runtime_error("cannot poll touch input during a script callback or step");
  updateTouchInput(owner); return undefined(env);
} catch (const std::exception& error) { return throwException(env, error); }
mv::Value readTouchEvent(napi_env env, napi_value source) {
  const auto property = [&](napi_value object, const char* name) {
    napi_value value; check(env, napi_get_named_property(env, object, name, &value), "cannot read touch event property"); return value;
  };
  mv::Value::Object result;
  for (const char* name : {"pageX", "pageY", "button", "deltaX", "deltaY", "isPrimary", "pointerType"})
    result[name] = readValue(env, property(source, name));
  for (const char* name : {"touches", "changedTouches"}) {
    const auto list = property(source, name);
    napi_valuetype type; check(env, napi_typeof(env, list, &type), "cannot inspect touch list");
    if (type == napi_undefined || type == napi_null) continue;
    const auto length = asUint32(env, property(list, "length"));
    mv::Value::Array points;
    for (std::uint32_t index = 0; index < length; ++index) {
      napi_value point; check(env, napi_get_element(env, list, index, &point), "cannot read touch point");
      points.emplace_back(mv::Value::Object{{"pageX", readValue(env, property(point, "pageX"))}, {"pageY", readValue(env, property(point, "pageY"))}});
    }
    result[name] = std::move(points);
  }
  return result;
}
napi_value touchInvoke(napi_env env, napi_callback_info info) try {
  const auto args = arguments(env, info);
  if (args.size() < 2 || args.size() > 3) throw std::invalid_argument("touch operation requires session, method and optional event or value");
  auto& owner = session(env, args[0]); auto& touch = owner.touch; const auto method = asString(env, args[1]);
  double* scalar=nullptr;bool* flag=nullptr;
  if(method=="_mousePressed")flag=&touch.mousePressedState();
  else if(method=="_screenPressed")flag=&touch.screenPressedState();
  else if(method=="_pressedTime")scalar=&touch.pressedTimeState();
  else if(method=="_x")scalar=&touch.xState();
  else if(method=="_y")scalar=&touch.yState();
  else if(method=="_date")scalar=&touch.dateState();
  else {
    auto& events=touch.frameEvents();
    const auto key=method.starts_with("_")?method.substr(1):"";
    if(key=="triggered")flag=&events.triggered;else if(key=="cancelled")flag=&events.cancelled;
    else if(key=="moved")flag=&events.moved;else if(key=="released")flag=&events.released;
    else if(key=="wheelX")scalar=&events.wheelX;else if(key=="wheelY")scalar=&events.wheelY;
  }
  if(scalar) {if(args.size()==3)*scalar=asNumber(env,args[2]);return number(env,*scalar);}
  if(flag) {if(args.size()==3)*flag=asBoolean(env,args[2]);return boolean(env,*flag);}
  if (method=="_onTrigger" || method=="_onCancel" || method=="_onMove" || method=="_onRelease") {
    const auto value=readValue(env,args.at(2));const double x=value["x"].number(),y=value["y"].number();
    if(method=="_onTrigger") {
      const auto now=std::chrono::duration_cast<std::chrono::milliseconds>(std::chrono::system_clock::now().time_since_epoch()).count();
      touch.applyTrigger(x,y,double(now));
    } else if(method=="_onCancel")touch.applyCancel(x,y);
    else if(method=="_onMove")touch.applyMove(x,y);
    else touch.applyRelease(x,y);
  }
  else if (method == "clear") touch.clear();
  else if (method == "update") touch.update();
  else if (method == "keyRepeatWait" || method == "keyRepeatInterval") {
    auto& value = method == "keyRepeatWait" ? touch.keyRepeatWait : touch.keyRepeatInterval;
    if (args.size() == 3) value = asNumber(env, args[2]);
    return number(env, value);
  } else if (method == "x") return number(env,touch.x());
  else if (method == "y") return number(env,touch.y());
  else if (method == "wheelX") return number(env,touch.wheelX());
  else if (method == "wheelY") return number(env,touch.wheelY());
  else if (method == "date") return number(env,touch.date());
  else if (method == "isPressed") return boolean(env,touch.isPressed());
  else if (method == "isTriggered") return boolean(env,touch.isTriggered());
  else if (method == "isCancelled") return boolean(env,touch.isCancelled());
  else if (method == "isMoved") return boolean(env,touch.isMoved());
  else if (method == "isReleased") return boolean(env,touch.isReleased());
  else if (method == "isRepeated") return boolean(env,touch.isRepeated());
  else if (method == "isLongPressed") return boolean(env,touch.isLongPressed());
  else {
    if (args.size() != 3) throw std::invalid_argument("touch event argument required");
    invokeTouchHandler(owner, method, readTouchEvent(env,args[2]));
  }
  return undefined(env);
} catch (const std::exception& error) { return throwException(env, error); }
napi_value compileTiledMap(napi_env env, napi_callback_info info) try {
  const auto args=arguments(env,info);
  if(args.size()!=2)throw std::invalid_argument("tiled compilation requires map and half-tile mode");
  return writeValue(env,mv::compileTiledMap(readValue(env,args[0]),asBoolean(env,args[1])));
} catch(const std::exception& error) { return throwException(env,error); }
napi_value tiledInvoke(napi_env env, napi_callback_info info) try {
  const auto args=arguments(env,info);
  if(args.size()!=3)throw std::invalid_argument("tiled operation requires session, method and arguments");
  auto& owner=session(env,args[0]);RuntimeCallScope scope(owner);
  const auto name=asString(env,args[1]);
  std::uint32_t count;check(env,napi_get_array_length(env,args[2],&count),"cannot read tiled arguments");
  const bool live=name=="bindReflections"||name=="bindTables"||name=="bindSource";
  auto parameters=live ? mv::Value(mv::Value::Array(count)) : readValue(env,args[2]);
  if(live) {
    if(!owner.database)owner.database=std::make_shared<DatabaseGraph>(env,owner,args[0]);
    const int index=name=="bindTables"||name=="bindSource" ? 1 : 0;
    napi_value array;check(env,napi_get_element(env,args[2],index,&array),"cannot read tiled table");
    auto& values=std::get<mv::Value::Array>(parameters.data);
    for(int i=0;i<index;++i) { napi_value value;check(env,napi_get_element(env,args[2],i,&value),"cannot read tiled argument");values[i]=readValue(env,value); }
    napi_valuetype type;check(env,napi_typeof(env,array,&type),"cannot inspect tiled binding");
    if(type==napi_object || type==napi_function) {
      values.at(index)=mv::Value(mv::Value::Array{});values.at(index).reader=std::make_shared<DatabaseReader>(owner.database,array,false);
    } else values.at(index)=readValue(env,array);
  }
  return writeValue(env,owner.session->invokeTiled(name,parameters.array()));
} catch(const std::exception& error) { return throwException(env,error); }
napi_value tiledApply(napi_env env, napi_callback_info info) try {
  const auto args=arguments(env,info);
  if(args.size()!=4)throw std::invalid_argument("tiled update requires session, table, level and array factory");
  auto& owner=session(env,args[0]);RuntimeCallScope scope(owner);
  const auto method=asString(env,args[1]);
  const auto root=[&](const std::string& name) {
    const auto result=databaseObject(owner.session->tiledRoot(name));
    if(!result)throw std::invalid_argument("tiled table is not bound: "+name);
    return result;
  };
  const auto initialize=[&](int level,bool dispatch) {
    if(dispatch&&owner.session->dispatchTiledInitialize(level))return;
    const auto key=std::to_string(level);napi_value current,truth;
    check(env,napi_get_named_property(env,root("collision"),key.c_str(),&current),"cannot read tiled level");
    check(env,napi_coerce_to_bool(env,current,&truth),"cannot inspect tiled level");
    if(asBoolean(env,truth))return;
    const int size=owner.session->invokeTiled("width",{}).integer()*owner.session->invokeTiled("height",{}).integer();
    for(const auto& [name,initial]:std::array<std::pair<const char*,int>,4>{{{"collision",0},{"arrows",15},{"regions",0},{"levelChanges",-1}}}) {
      napi_value receiver,result;check(env,napi_get_global(env,&receiver),"cannot read array factory receiver");
      napi_value values[]{number(env,size),number(env,initial)};
      check(env,napi_call_function(env,receiver,args[3],2,values,&result),"cannot create tiled level table");
      check(env,napi_set_named_property(env,root(name),key.c_str(),result),"cannot publish tiled level table");
    }
  };
  if(method=="initialize")initialize(asInt32(env,args[2]),false);
  else {
    if(method!="collision"&&method!="arrows"&&method!="regions"&&method!="levelChanges")throw std::invalid_argument("unknown tiled update");
    mv::visitTiledCells(owner.session->tiledSource(),owner.session->tiledHalfTile(),method,[&](int level,int index,int value) {
      if(index<0) {initialize(level,true);return;}
      napi_value table;check(env,napi_get_named_property(env,root(method),std::to_string(level).c_str(),&table),"cannot read tiled table");
      if(method=="arrows") {
        napi_value previous,converted;check(env,napi_get_element(env,table,index,&previous),"cannot read tiled arrow");
        check(env,napi_coerce_to_number(env,previous,&converted),"cannot convert tiled arrow");
        value^=asInt32(env,converted);
      }
      check(env,napi_set_element(env,table,index,number(env,value)),"cannot update tiled cell");
    });
  }
  return undefined(env);
} catch(const std::exception& error) {return throwException(env,error);}
napi_value databaseInvoke(napi_env env, napi_callback_info info) try {
  const auto args = arguments(env, info);
  if (args.size() < 2 || args.size() > 4) throw std::invalid_argument("database operation requires session, method and operation arguments");
  auto& owner = session(env, args[0]); const auto method = asString(env, args[1]);
  if (method == "canWrite") return boolean(env, owner.session->canWriteDatabase());
  if (method == "read" && args.size() == 3) return writeValue(env, owner.session->database()[asString(env, args[2])]);
  if(method=="readMap" && args.size()==3) {
    const int id=asInt32(env,args[2]);
    if(id<0)throw std::invalid_argument("map id must not be negative");
    return writeValue(env,owner.session->mapData(id));
  }
  if(method=="publishTiledMap" && args.size()==4) {
    if(owner.runtimeCalls || owner.stepping) throw std::runtime_error("cannot replace map data during a script callback or step");
    owner.session->setTiledMapData(asInt32(env,args[2]), readValue(env,args[3]));
    return undefined(env);
  }
  if(method=="publishMap" && args.size()==4) {
    if(owner.runtimeCalls || owner.stepping)throw std::runtime_error("cannot replace map data during a script callback or step");
    const int id=asInt32(env,args[2]);
    if(id<0)throw std::invalid_argument("map id must not be negative");
    napi_valuetype type; check(env,napi_typeof(env,args[3],&type),"cannot inspect map data");
    bool array=false;
    if(type==napi_object)check(env,napi_is_array(env,args[3],&array),"cannot inspect map data");
    if(type!=napi_object || array)throw std::invalid_argument("map publication requires a map object");
    RuntimeCallScope scope(owner);
    if(!owner.database)owner.database=std::make_shared<DatabaseGraph>(env,owner,args[0]);
    mv::Value map(mv::Value::Object{});
    map.reader=std::make_shared<DatabaseReader>(owner.database,args[3],false);
    owner.session->setMapData(id,std::move(map));
    return undefined(env);
  }
  if (method == "publish" && args.size() == 3) {
    if (owner.runtimeCalls || owner.stepping) throw std::runtime_error("cannot replace database tables during a script callback or step");
    RuntimeCallScope scope(owner);
    napi_valuetype type; check(env,napi_typeof(env,args[2],&type),"cannot inspect database tables");
    bool array = false;
    if (type == napi_object) check(env, napi_is_array(env, args[2], &array), "cannot inspect database tables");
    if (type != napi_object || array) throw std::invalid_argument("database publication requires named tables");
    owner.session->setDatabaseTables(mv::Value::Object{});
    if (!owner.database) owner.database = std::make_shared<DatabaseGraph>(env, owner, args[0]);
    auto reader = std::make_shared<DatabaseReader>(owner.database, args[2], true);
    reader->fallback = owner.session->database().reader;
    owner.session->setDatabaseReader(std::move(reader));
    return undefined(env);
  }
  if (method == "metadata" && args.size() == 3) {
    mv::Value::Object result;
    for (const auto& [key,value] : mv::DataManager::extractMetadata(asString(env,args[2]))) result[key] = value;
    return writeValue(env,result);
  }
  throw std::invalid_argument("database operation is not bound: " + method);
} catch (const std::exception& error) { return throwException(env, error); }
napi_value utilsInvoke(napi_env env, napi_callback_info info) try {
  const auto args = arguments(env, info);
  if (args.size() < 2 || args.size() > 3) throw std::invalid_argument("utility operation requires session, method and optional arguments");
  session(env, args[0]); const auto method = asString(env, args[1]);
  const auto values = args.size() == 3 ? readValue(env,args[2]) : mv::Value(mv::Value::Array{});
  if (method == "RPGMAKER_NAME") return string(env,mv::Utils::RPGMAKER_NAME);
  if (method == "RPGMAKER_VERSION") return string(env,mv::Utils::RPGMAKER_VERSION);
  if (method == "isNwjs") return boolean(env,mv::Utils::isNwjs());
  if (method == "canReadGameFiles") return boolean(env,mv::Utils::canReadGameFiles());
  if (method == "isSupportPassiveEvent") return boolean(env,mv::Utils::isSupportPassiveEvent());
  if (method == "isMobileDevice") return boolean(env,mv::Utils::isMobileDevice(values[0].text()));
  if (method == "isMobileSafari") return boolean(env,mv::Utils::isMobileSafari(values[0].text()));
  if (method == "isAndroidChrome") return boolean(env,mv::Utils::isAndroidChrome(values[0].text()));
  if (method == "generateRuntimeId") return number(env,static_cast<double>(mv::Utils::generateRuntimeId()));
  if (method == "rgbToCssColor") return string(env,mv::Utils::rgbToCssColor(values[0].number(),values[1].number(),values[2].number()));
  if (method == "escapeHtml") return string(env,mv::Utils::escapeHtml(values[0].text()));
  if (method == "isOptionValid") {
    std::vector<std::string> options;
    for (const auto& option : values[1].array()) options.push_back(option.text());
    return boolean(env,mv::Utils::isOptionValid(values[0].text(),options,values[2].text()));
  }
  throw std::invalid_argument("utility method is not bound: " + method);
} catch (const std::exception& error) { return throwException(env, error); }
void collectRuntime(EngineSession& owner) {
  collectCharacterPresentation(owner);
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
napi_value scriptFrame(napi_env env, napi_callback_info info) try {
  const auto args = arguments(env, info);
  if (args.size() != 2) throw std::invalid_argument("script frame requires session and phase");
  auto& owner = session(env, args[0]);
  const auto phase = asString(env, args[1]);
  if (phase == "begin") ++owner.scriptFrames;
  else if (phase == "end") {
    if (!owner.scriptFrames) throw std::invalid_argument("script frame is not active");
    if (--owner.scriptFrames == 0) {
      struct ReleasePins {
        std::shared_ptr<DatabaseGraph> database;
        ~ReleasePins() { collectDatabase(database); }
      } cleanup{owner.database};
      collectRuntime(owner);
    }
  } else throw std::invalid_argument("unknown script frame phase");
  return undefined(env);
} catch (const std::exception& error) { return throwException(env, error); }
void requireRuntimeOwner(EngineSession& owner, napi_value object);
std::shared_ptr<mv::core::WebAudio> retainAudioBuffer(EngineSession& owner,napi_value value);
struct PresentationDispatch {
  bool handled=false;
  std::optional<mv::Value> value;
};
PresentationDispatch dispatchCharacterPresentation(EngineSession&,const std::shared_ptr<mv::RuntimeBoundObject>&,const std::string&,const mv::Value::Array&);
std::optional<bool> characterPresentationOverride(EngineSession&,const std::shared_ptr<mv::RuntimeBoundObject>&,const std::string&);
std::optional<std::array<double,2>> nativeCharacterPosition(EngineSession&,const std::shared_ptr<mv::RuntimeCharacter>&);
std::optional<int> nativeCharacterZ(EngineSession&,const std::shared_ptr<mv::RuntimeCharacter>&);
napi_value connectRuntime(napi_env env, napi_callback_info info) try {
  const auto args = arguments(env, info);
  if (args.size() != 2) throw std::invalid_argument("connectRuntime requires session and callbacks");
  auto& owner = session(env, args[0]);
  if (owner.runtimeSelf) throw std::runtime_error("session runtime is already connected");
  check(env, napi_set_named_property(env, args[0], "__mvRuntime", args[1]), "cannot attach runtime");
  check(env, napi_create_reference(env, args[0], 0, &owner.runtimeSelf), "cannot reference runtime owner");
  owner.touch.transition=[&owner](const char* method,double x,double y) {
    return asBoolean(owner.env,callRuntime(owner,"touchTransition",{string(owner.env,method),number(owner.env,x),number(owner.env,y)}));
  };
  auto hooks = std::make_shared<mv::RuntimeHooks>();
  hooks->manager = [&owner](const std::string& manager, const std::string& method, const mv::Value::Array& arguments) {
    return asBoolean(owner.env, callRuntime(owner, "manager", {string(owner.env, manager), string(owner.env, method), writeValue(owner.env, arguments)}));
  };
  hooks->scene = [&owner](const std::string& method, int scene) -> std::optional<bool> {
    if (owner.sceneRequestsSuppressed) return {};
    const auto result = callRuntime(owner, "scene", {string(owner.env, method), number(owner.env, scene)});
    napi_valuetype type; check(owner.env, napi_typeof(owner.env, result, &type), "cannot inspect scene result");
    if (type == napi_null) return {};
    return asBoolean(owner.env, result);
  };
  hooks->picture = [&owner](const auto& object, const std::string& method, const mv::Value::Array& arguments) {
    return asBoolean(owner.env, callRuntime(owner, "picture", {runtimeHandle(owner, object), string(owner.env, method), writeValue(owner.env, arguments)}));
  };
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
  hooks->characterScript = [&owner](const auto& object, const std::string& source) {
    callRuntime(owner, "characterScript", {runtimeHandle(owner, object), string(owner.env, source)});
  };
  hooks->enemySpriteBattler = [&owner](const auto& object, const auto& battler) {
    return asBoolean(owner.env, callRuntime(owner, "enemySpriteBattler", {runtimeHandle(owner, object), runtimeHandle(owner, battler)}));
  };
  hooks->actorSpriteHome = [&owner](const auto& object, int index) {
    return asBoolean(owner.env, callRuntime(owner, "actorSpriteHome", {runtimeHandle(owner, object), number(owner.env, index)}));
  };
  hooks->boundOverride = [&owner](const auto& object,const std::string& method) {
    if(const auto bound=std::dynamic_pointer_cast<mv::RuntimeBoundObject>(object))
      if(const auto native=characterPresentationOverride(owner,bound,method))return *native;
    return asBoolean(owner.env,callRuntime(owner,"boundOverride",{runtimeHandle(owner,object),string(owner.env,method)}));
  };
  hooks->boundMethod = [&owner](const auto& object, const std::string& method, const mv::Value::Array& arguments, const std::string& prototype) -> std::optional<mv::Value> {
    if(const auto bound=std::dynamic_pointer_cast<mv::RuntimeBoundObject>(object); bound && prototype.empty()) {
      auto native=dispatchCharacterPresentation(owner,bound,method,arguments);
      if(native.handled)return std::move(native.value);
    }
    auto result = callRuntime(owner, "boundMethod", {runtimeHandle(owner, object), string(owner.env, method), writeValue(owner.env, arguments), string(owner.env, prototype)});
    napi_valuetype type; check(owner.env, napi_typeof(owner.env, result, &type), "cannot inspect method override");
    if (type == napi_null) return {};
    napi_value value; check(owner.env, napi_get_named_property(owner.env, result, "value", &value), "cannot read method result");
    return readValue(owner.env, value);
  };
  hooks->boundListener = [&owner](const auto& object, std::uint32_t token) {
    callRuntime(owner,"boundListener",{runtimeHandle(owner,object),number(owner.env,token)});
  };
  hooks->audioBuffer = [&owner](const std::string& kind,const std::string& name) -> std::shared_ptr<mv::core::WebAudio> {
    return retainAudioBuffer(owner,callRuntime(owner,"audioBuffer",{string(owner.env,kind),string(owner.env,name)}));
  };
  hooks->systemBitmap = [&owner](const auto& object, const std::string& name) {
    return bitmapForRuntime(owner.env, callRuntime(owner, "systemBitmap", {runtimeHandle(owner, object), string(owner.env, name)}), owner.owner->core);
  };
  hooks->nativeBitmap = [&owner](const auto& object,const std::string& method,const mv::Value::Array& arguments,const std::string& slot) {
    return bitmapForRuntime(owner.env,callRuntime(owner,"nativeBitmap",{runtimeHandle(owner,object),string(owner.env,method),writeValue(owner.env,arguments),string(owner.env,slot)}),owner.owner->core);
  };
  hooks->boundObjectMethod = [&owner](const auto& object,const std::string& method,const auto& argument) -> std::optional<mv::Value> {
    const auto result=callRuntime(owner,"boundObjectMethod",{runtimeHandle(owner,object),string(owner.env,method),argument ? runtimeHandle(owner,argument) : null(owner.env)});
    napi_valuetype type; check(owner.env,napi_typeof(owner.env,result,&type),"cannot inspect object override");
    if (type==napi_null) return {};
    napi_value value; check(owner.env,napi_get_named_property(owner.env,result,"value",&value),"cannot read object override result");
    return readValue(owner.env,value);
  };
  hooks->characterPosition = [&owner](const auto& object) -> std::optional<std::array<double, 2>> {
    if(const auto character=std::dynamic_pointer_cast<mv::RuntimeCharacter>(object))
      if(const auto value=nativeCharacterPosition(owner,character))return value;
    const auto result = callRuntime(owner, "characterPosition", {runtimeHandle(owner, object)});
    napi_valuetype type; check(owner.env, napi_typeof(owner.env, result, &type), "cannot inspect character position result");
    if (type == napi_undefined || type == napi_null) return {};
    const auto point = readValue(owner.env, result);
    if (point.arrayLength() != 2) throw std::invalid_argument("character position override must return two coordinates");
    const double x = point[0].number(), y = point[1].number();
    if (!std::isfinite(x) || !std::isfinite(y)) throw std::invalid_argument("character position override must return finite coordinates");
    return std::array<double, 2>{x, y};
  };
  hooks->characterQuery = [&owner](const auto& object, const std::string& method, const mv::Value::Array& values) -> std::optional<mv::Value> {
    const auto result = callRuntime(owner, "characterQuery", {runtimeHandle(owner, object), string(owner.env, method), writeValue(owner.env, values)});
    napi_valuetype type; check(owner.env, napi_typeof(owner.env, result, &type), "cannot inspect character query result");
    if (type == napi_null || type == napi_undefined) return std::nullopt;
    return readValue(owner.env, property(owner.env, result, "value"));
  };
  hooks->characterLifecycle = [&owner](const auto& object, const std::string& method) {
    return asBoolean(owner.env, callRuntime(owner, "characterLifecycle", {runtimeHandle(owner, object), string(owner.env, method)}));
  };
  hooks->characterZ = [&owner](const auto& object)->std::optional<int> {
    if(const auto character=std::dynamic_pointer_cast<mv::RuntimeCharacter>(object))
      if(const auto value=nativeCharacterZ(owner,character))return value;
    const auto result=callRuntime(owner,"characterZ",{runtimeHandle(owner,object)});napi_valuetype type;
    check(owner.env,napi_typeof(owner.env,result,&type),"cannot inspect character z");
    return type==napi_undefined||type==napi_null ? std::nullopt : std::optional<int>(asInt32(owner.env,result));
  };
  hooks->characterMethod = [&owner](const auto& object, const std::string& method, const auto& values) {
    return asBoolean(owner.env,callRuntime(owner,"characterMethod",{runtimeHandle(owner,object),string(owner.env,method),writeValue(owner.env,values)}));
  };
  hooks->actorLifecycle = [&owner](const auto& object, const std::string& method, const auto& values) {
    return asBoolean(owner.env, callRuntime(owner, "actorLifecycle", {runtimeHandle(owner, object), string(owner.env, method), writeValue(owner.env, values)}));
  };
  hooks->scriptCondition = [&owner](const auto& object, const std::string& source) {
    return asBoolean(owner.env, callRuntime(owner, "scriptCondition", {runtimeHandle(owner, object), string(owner.env, source)}));
  };
  hooks->scriptValue = [&owner](const auto& object, const std::string& source) {
    RuntimeCallScope callScope(owner);
    const auto result = callRuntime(owner, "scriptValue", {runtimeHandle(owner, object), string(owner.env, source)});
    napi_valuetype type; check(owner.env, napi_typeof(owner.env, result, &type), "cannot inspect script variable operand");
    if (type == napi_object || type == napi_function) throw std::invalid_argument("object script variable operands are not bound");
    return readValue(owner.env, result);
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
  hooks->gameDataMutation = [&owner](const std::string& kind, const std::string& method, const mv::Value::Array& args) {
    return asBoolean(owner.env, callRuntime(owner, "gameDataMutation", {string(owner.env, kind), string(owner.env, method), writeValue(owner.env, args)}));
  };
  hooks->troopConditions = [&owner](const mv::Value& page) -> std::optional<bool> {
    const auto result = callRuntime(owner, "troopConditions", {writeValue(owner.env, page)});
    napi_valuetype type; check(owner.env, napi_typeof(owner.env, result, &type), "cannot inspect troop conditions");
    return type == napi_undefined ? std::optional<bool>{} : std::optional<bool>{asBoolean(owner.env, result)};
  };
  hooks->setupAutorunCommonEvent = [&owner]() -> std::optional<bool> {
    const auto result = callRuntime(owner, "setupAutorunCommonEvent", {});
    napi_valuetype type; check(owner.env, napi_typeof(owner.env, result, &type), "cannot inspect autorun query result");
    return type == napi_undefined ? std::optional<bool>{} : std::optional<bool>{asBoolean(owner.env, result)};
  };
  hooks->resourceLoader=[&owner](const std::string& url,std::function<void()> retry,std::function<void()> resign,const std::optional<std::vector<int>>& intervals)->std::optional<std::function<void()>> {
    mv::Value::Array values;if(intervals)for(auto interval:*intervals)values.emplace_back(interval);
    const auto function=callRuntime(owner,"resourceLoader",{string(owner.env,url),resourceCallback(owner.env,std::move(retry)),resourceCallback(owner.env,std::move(resign)),intervals?writeValue(owner.env,values):undefined(owner.env)});
    napi_valuetype type;check(owner.env,napi_typeof(owner.env,function,&type),"cannot inspect resource loader");if(type==napi_undefined)return {};if(type!=napi_function)throw std::invalid_argument("ResourceHandler.createLoader must return a function");
    napi_value self,callbacks,roots;check(owner.env,napi_get_reference_value(owner.env,owner.runtimeSelf,&self),"cannot read resource loader session");
    check(owner.env,napi_get_named_property(owner.env,self,"__mvRuntime",&callbacks),"cannot read resource loader callbacks");
    bool has=false;check(owner.env,napi_has_named_property(owner.env,callbacks,"__nativeResourceLoaders",&has),"cannot inspect resource loader roots");
    if(has)check(owner.env,napi_get_named_property(owner.env,callbacks,"__nativeResourceLoaders",&roots),"cannot read resource loader roots");
    else {roots=moduleObject(owner.env);check(owner.env,napi_set_named_property(owner.env,callbacks,"__nativeResourceLoaders",roots),"cannot own resource loader roots");}
    const std::weak_ptr<const int> lifetime=owner.runtimeOwner;auto reference=std::make_shared<ResourceLoaderReference>(owner.env,function,roots,std::to_string(++owner.nextResourceLoader));
    return std::function<void()>{[lifetime,reference] {if(!lifetime.expired())reference->invoke();}};
  };
  hooks->resourceExists=[&owner] {return asBoolean(owner.env,callRuntime(owner,"resourceExists",{}));};
  hooks->resourceRetry=[&owner] {callRuntime(owner,"resourceRetry",{});};
  hooks->tilemapState=[&owner](const mv::Value& value) {callRuntime(owner,"tilemapState",{writeValue(owner.env,value)});};
  hooks->tilemapGeometry=[&owner](int firstX,int firstY,int lastX,int lastY,int width,int height)->std::optional<mv::Value> {
    const auto value=callRuntime(owner,"tilemapGeometry",{number(owner.env,firstX),number(owner.env,firstY),number(owner.env,lastX),number(owner.env,lastY),number(owner.env,width),number(owner.env,height)});
    napi_valuetype type;check(owner.env,napi_typeof(owner.env,value,&type),"cannot inspect tile drawing override");
    return type==napi_undefined?std::nullopt:std::optional<mv::Value>{readValue(owner.env,value)};
  };
  hooks->tilemapOperation=[&owner](const std::string& method,int first,int second,int third)->std::optional<mv::Value> {
    const auto value=callRuntime(owner,"tilemapOperation",{string(owner.env,method),number(owner.env,first),number(owner.env,second),number(owner.env,third)});
    napi_valuetype type;check(owner.env,napi_typeof(owner.env,value,&type),"cannot inspect tile override");
    return type==napi_undefined?std::nullopt:std::optional<mv::Value>{readValue(owner.env,value)};
  };
  hooks->tileShadow = [&owner](int bits,int x,int y,int width,int height) -> std::optional<mv::Value> {
    const auto result = callRuntime(owner, "tileShadow", {number(owner.env,bits), number(owner.env,x), number(owner.env,y), number(owner.env,width), number(owner.env,height)});
    napi_valuetype type; check(owner.env, napi_typeof(owner.env,result,&type), "cannot inspect tile shadow");
    return type == napi_undefined ? std::optional<mv::Value>{} : std::optional<mv::Value>{readValue(owner.env,result)};
  };
  hooks->commonEventLifecycle = [&owner](const auto& event, const std::string& method) {
    return asBoolean(owner.env, callRuntime(owner, "commonEventLifecycle", {runtimeHandle(owner, event), string(owner.env, method)}));
  };
  hooks->eventPage = [&owner](const auto& event) -> std::optional<int> {
    const auto result = callRuntime(owner, "eventPage", {runtimeHandle(owner, event)});
    napi_valuetype type; check(owner.env, napi_typeof(owner.env, result, &type), "cannot inspect event page selection");
    if (type == napi_undefined) return std::nullopt;
    return asInt32(owner.env, result);
  };
  hooks->characterRouteCommand = [&owner](const auto& character, const mv::Value& command) {
    const auto result = callRuntime(owner, "characterRouteCommand", {runtimeHandle(owner, character), writeValue(owner.env, command)});
    return result && asBoolean(owner.env, result);
  };
  hooks->actionRate = [&owner](const std::string& method, const auto& subject, const auto& target, bool item, int id) -> std::optional<double> {
    const auto result = callRuntime(owner, "actionRate", {string(owner.env, method), runtimeHandle(owner, subject), runtimeHandle(owner, target), boolean(owner.env, item), number(owner.env, id)});
    napi_valuetype type; check(owner.env, napi_typeof(owner.env, result, &type), "cannot inspect action rate");
    return type == napi_undefined ? std::optional<double>{} : std::optional<double>{asNumber(owner.env, result)};
  };
  hooks->choice = [&owner](int index) { return asBoolean(owner.env, callRuntime(owner, "choice", {number(owner.env, index)})); };
  hooks->interpreterControl = [&owner](const auto& object, const std::string& method, const mv::Value::Array& args) {
    return asBoolean(owner.env, callRuntime(owner, "interpreterControl", {runtimeHandle(owner, object), string(owner.env, method), writeValue(owner.env, args)}));
  };
  hooks->setupChoiceCallback = [&owner](const auto& object) { callRuntime(owner, "setupChoiceCallback", {runtimeHandle(owner, object)}); };
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
napi_value createAction(napi_env env, napi_callback_info info) try {
  const auto args = arguments(env, info, 3); auto& owner = session(env, args[0]);
  std::shared_ptr<mv::RuntimeActor> subject; napi_valuetype type; check(env, napi_typeof(env, args[1], &type), "cannot inspect action subject");
  if (type != napi_null) { requireRuntimeOwner(owner, args[1]); subject = runtimeAs<mv::RuntimeActor>(env, args[1]); }
  return runtimeHandle(owner, owner.session->createRuntimeAction(subject, asBoolean(env, args[2])));
} catch (const std::exception& error) { return throwException(env, error); }
napi_value actionField(napi_env env, napi_callback_info info) try {
  const auto args = arguments(env, info); auto& owner = session(env, args.at(0)); requireRuntimeOwner(owner, args.at(1)); RuntimeCallScope scope(owner);
  return writeValue(env, owner.session->runtimeActionField(runtimeAs<mv::RuntimeAction>(env, args[1]), asString(env, args.at(2)), args.size() == 4 ? std::optional<mv::Value>{readValue(env, args[3])} : std::nullopt));
} catch (const std::exception& error) { return throwException(env, error); }
napi_value actionSubject(napi_env env, napi_callback_info info) try {
  const auto args = arguments(env, info); auto& owner = session(env, args.at(0)); requireRuntimeOwner(owner, args.at(1)); RuntimeCallScope scope(owner);
  const auto action = runtimeAs<mv::RuntimeAction>(env, args[1]);
  if (args.size() == 3) {
    napi_valuetype type; check(env, napi_typeof(env, args[2], &type), "cannot inspect action subject");
    std::shared_ptr<mv::RuntimeActor> subject;
    if (type != napi_null) { requireRuntimeOwner(owner, args[2]); subject = runtimeAs<mv::RuntimeActor>(env, args[2]); }
    owner.session->setRuntimeActionSubject(action, subject);
  }
  const auto subject = owner.session->runtimeActionSubject(action); return subject ? runtimeHandle(owner, subject) : null(env);
} catch (const std::exception& error) { return throwException(env, error); }
napi_value currentAction(napi_env env, napi_callback_info info) try {
  const auto args = arguments(env, info, 1); auto& owner = session(env, args[0]); RuntimeCallScope scope(owner);
  const auto action = owner.session->currentRuntimeAction(); return action ? runtimeHandle(owner, action) : null(env);
} catch (const std::exception& error) { return throwException(env, error); }
napi_value battlerActions(napi_env env, napi_callback_info info) try {
  const auto args = arguments(env, info); auto& owner = session(env, args.at(0)); requireRuntimeOwner(owner, args.at(1)); RuntimeCallScope scope(owner);
  const auto battler = runtimeAs<mv::RuntimeActor>(env, args[1]);
  if (args.size() == 3) {
    bool array = false; check(env, napi_is_array(env, args[2], &array), "cannot inspect battler actions"); if (!array) throw std::invalid_argument("battler actions require an array");
    uint32_t length = 0; check(env, napi_get_array_length(env, args[2], &length), "cannot read action count");
    std::vector<std::shared_ptr<mv::RuntimeAction>> actions;
    for (uint32_t index = 0; index < length; ++index) { napi_value value; check(env, napi_get_element(env, args[2], index, &value), "cannot read action"); requireRuntimeOwner(owner, value); actions.push_back(runtimeAs<mv::RuntimeAction>(env, value)); }
    owner.session->replaceBattlerActions(battler, std::move(actions));
  }
  napi_value result; check(env, napi_create_array_with_length(env, battler->value().actions.size(), &result), "cannot create actions");
  for (std::size_t index = 0; index < battler->value().actions.size(); ++index) check(env, napi_set_element(env, result, index, runtimeHandle(owner, battler->value().actions[index])), "cannot set action");
  return result;
} catch (const std::exception& error) { return throwException(env, error); }
napi_value createCommonEvent(napi_env env, napi_callback_info info) try {
  const auto args = arguments(env, info, 2); auto& owner = session(env, args.at(0));
  auto event = std::make_shared<mv::RuntimeCommonEvent>(); event->id = asInt32(env, args.at(1)); event->initialized = true;
  return runtimeHandle(owner, event);
} catch (const std::exception& error) { return throwException(env, error); }
napi_value commonEvents(napi_env env, napi_callback_info info) try {
  const auto args = arguments(env, info, 1); auto& owner = session(env, args.at(0)); RuntimeCallScope scope(owner);
  const auto events = owner.session->runtimeCommonEventObjects(); napi_value result; check(env, napi_create_array_with_length(env, events.size(), &result), "cannot create common events");
  for (std::size_t index = 0; index < events.size(); ++index) check(env, napi_set_element(env, result, index, runtimeHandle(owner, events[index])), "cannot set common event");
  return result;
} catch (const std::exception& error) { return throwException(env, error); }
napi_value commonEventId(napi_env env, napi_callback_info info) try {
  const auto args = arguments(env, info); auto& owner = session(env, args.at(0)); requireRuntimeOwner(owner, args.at(1));
  const auto event = runtimeAs<mv::RuntimeCommonEvent>(env, args.at(1)); if (args.size() == 3) event->id = asInt32(env, args[2]);
  return number(env, event->id);
} catch (const std::exception& error) { return throwException(env, error); }
napi_value commonEventInterpreter(napi_env env, napi_callback_info info) try {
  const auto args = arguments(env, info); auto& owner = session(env, args.at(0)); requireRuntimeOwner(owner, args.at(1)); RuntimeCallScope scope(owner);
  const auto event = runtimeAs<mv::RuntimeCommonEvent>(env, args.at(1));
  if (args.size() == 3) {
    napi_valuetype type; check(env, napi_typeof(env, args[2], &type), "cannot inspect common-event interpreter");
    std::shared_ptr<mv::RuntimeInterpreter> interpreter;
    if (type != napi_null) { requireRuntimeOwner(owner, args[2]); interpreter = runtimeAs<mv::RuntimeInterpreter>(env, args[2]); }
    owner.session->setRuntimeCommonInterpreter(event, interpreter);
  }
  return event->interpreter ? runtimeHandle(owner, event->interpreter->runtime) : null(env);
} catch (const std::exception& error) { return throwException(env, error); }
napi_value createInterpreter(napi_env env, napi_callback_info info) try {
  const auto args = arguments(env, info, 2); auto& owner = session(env, args.at(0));
  return runtimeHandle(owner, owner.session->createRuntimeInterpreter(asInt32(env, args.at(1))));
} catch (const std::exception& error) { return throwException(env, error); }
napi_value createCommandList(napi_env env, napi_callback_info info) try {
  const auto args = arguments(env, info, 2); auto& owner = session(env, args.at(0));
  auto list = std::make_shared<mv::RuntimeCommandList>(); list->root = readValue(env, args.at(1));
  if (!std::holds_alternative<mv::Value::Array>(list->root.data)) throw std::invalid_argument("command list requires an array");
  return runtimeHandle(owner, list);
} catch (const std::exception& error) { return throwException(env, error); }
napi_value interpreterChild(napi_env env, napi_callback_info info) try {
  const auto args = arguments(env, info, 2); auto& owner = session(env, args.at(0)); requireRuntimeOwner(owner, args.at(1));
  const auto child = owner.session->runtimeChildInterpreter(runtimeAs<mv::RuntimeInterpreter>(env, args.at(1)));
  return child ? runtimeHandle(owner, child) : null(env);
} catch (const std::exception& error) { return throwException(env, error); }
napi_value scriptInterpreter(napi_env env, napi_callback_info info) try {
  const auto args = arguments(env, info, 2); auto& owner = session(env, args.at(0));
  const auto value = owner.session->runtimeInterpreter(asInt32(env, args.at(1)));
  return value ? runtimeHandle(owner, value) : null(env);
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
  SceneTransitionScope transition(owner);
  RuntimeCallScope callScope(owner);
  napi_valuetype type;
  check(env, napi_typeof(env, args.at(2), &type), "cannot inspect command code");
  const std::optional<int> code = type == napi_null ? std::nullopt : std::optional<int>{asInt32(env, args.at(2))};
  return boolean(env, owner.session->invokeInterpreterCommandBase(runtimeAs<mv::RuntimeInterpreter>(env, args.at(1)), code));
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
  SceneTransitionScope transition(owner);
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
napi_value windowClasses(napi_env env,napi_callback_info) try {
  mv::Value::Array result;
  for (const auto& binding:mv::windowBindings()) {
    mv::Value::Array fields; for (const auto& field:binding.fields) fields.emplace_back(field);
    result.emplace_back(mv::Value::Object{{"name",binding.name},{"parent",binding.parent},{"arguments",binding.arguments},{"fields",fields},{"selectable",binding.selectable},{"command",binding.command},{"data",binding.data}});
  }
  return writeValue(env,result);
} catch (const std::exception& error) { return throwException(env,error); }
std::shared_ptr<mv::core::WebAudio> retainAudioBuffer(EngineSession& owner,napi_value value) {
  napi_valuetype type; check(owner.env,napi_typeof(owner.env,value,&type),"cannot inspect audio buffer");
  if(type==napi_null || type==napi_undefined)return {};
  requireRuntimeOwner(owner,value);
  const auto object=runtimeAs<mv::GeneratedRuntimeObject>(owner.env,value);
  if(!std::dynamic_pointer_cast<mv::core::WebAudio>(object))throw std::invalid_argument("audio buffer must use a native WebAudio binding");
  auto voice=std::dynamic_pointer_cast<mv::core::WebAudio>(object->nativeLease());
  callRuntime(owner,"retainBoundObject",{runtimeHandle(owner,object)});
  return voice;
}
napi_value audioBufferHandle(EngineSession& owner,const std::shared_ptr<mv::core::WebAudio>& voice) {
  if(!voice)return null(owner.env);
  const auto object=std::dynamic_pointer_cast<mv::GeneratedRuntimeObject>(voice);
  if(!object)throw std::runtime_error("native audio voice has no script binding");
  return runtimeHandle(owner,object);
}
napi_value audioManager(napi_env env,napi_callback_info info) try {
  const auto args=arguments(env,info);
  if(args.size()<3 || args.size()>5)throw std::invalid_argument("audio manager requires session, channel, operation and optional values");
  auto& owner=session(env,args[0]);
  if(!owner.presentation)throw std::runtime_error("presentation is not attached");
  const auto kind=asString(env,args[1]),operation=asString(env,args[2]);
  if(kind!="bgm" && kind!="bgs" && kind!="me" && kind!="se")throw std::invalid_argument("unknown audio channel: "+kind);
  RuntimeCallScope callScope(owner);
  auto& presentation=*owner.presentation;
  if(operation=="volume" && args.size()<=4) {
    auto& state = *owner.session;
    if (args.size()==4) {
      const double value = asNumber(env,args[3]);
      if (kind=="bgm") mv::AudioManager::setBgmVolume(state,value);
      else if (kind=="bgs") mv::AudioManager::setBgsVolume(state,value);
      else if (kind=="me") mv::AudioManager::setMeVolume(state,value);
      else mv::AudioManager::setSeVolume(state,value);
    }
    return number(env, kind=="bgm" ? mv::AudioManager::bgmVolume(state) : kind=="bgs" ? mv::AudioManager::bgsVolume(state) : kind=="me" ? mv::AudioManager::meVolume(state) : mv::AudioManager::seVolume(state));
  }
  if(operation=="flush" && args.size()==3) { presentation.flushAudio(); return undefined(env); }
  if(operation=="buffer" && kind!="se" && args.size()<=4) {
    if(args.size()==4)presentation.setAudioBuffer(kind,retainAudioBuffer(owner,args[3]));
    return audioBufferHandle(owner,presentation.audioBuffer(kind));
  }
  if(operation=="current" && kind!="se" && args.size()<=4) {
    if(args.size()==4)presentation.setCurrentAudio(kind,readValue(env,args[3]));
    return writeValue(env,presentation.currentAudio(kind));
  }
  if(operation=="buffers" && kind=="se" && args.size()<=4) {
    if(args.size()==4) {
      bool array=false; check(env,napi_is_array(env,args[3],&array),"cannot inspect sound buffers");
      if(!array)throw std::invalid_argument("sound buffers must be an array");
      std::uint32_t length=0; check(env,napi_get_array_length(env,args[3],&length),"cannot count sound buffers");
      std::vector<std::shared_ptr<mv::core::WebAudio>> buffers; buffers.reserve(length);
      for(std::uint32_t i=0;i<length;++i) {
        napi_value value; check(env,napi_get_element(env,args[3],i,&value),"cannot read sound buffer");
        auto voice=retainAudioBuffer(owner,value);
        if(!voice)throw std::invalid_argument("sound buffers cannot contain empty entries");
        buffers.push_back(std::move(voice));
      }
      presentation.setSoundBuffers(std::move(buffers));
    }
    napi_value result; check(env,napi_create_array_with_length(env,presentation.soundBuffers().size(),&result),"cannot return sound buffers");
    std::uint32_t index=0;
    for(const auto& voice:presentation.soundBuffers())check(env,napi_set_element(env,result,index++,audioBufferHandle(owner,voice)),"cannot return sound buffer");
    return result;
  }
  if(operation=="parameters") {
    if(kind=="se" && args.size()==5)presentation.updateAudioParameters(kind,readValue(env,args[4]),retainAudioBuffer(owner,args[3]));
    else if(kind!="se" && args.size()==4)presentation.updateAudioParameters(kind,readValue(env,args[3]));
    else throw std::invalid_argument("audio parameters require channel data, and a buffer for sound effects");
    return undefined(env);
  }
  throw std::invalid_argument("audio manager operation is not bound: "+operation);
} catch(const std::exception& error) { return throwException(env,error); }
napi_value windowModel(napi_env env,napi_callback_info info) try {
  const auto args=arguments(env,info); auto& owner=session(env,args.at(0));
  const auto name=asString(env,args.at(2)),operation=asString(env,args.at(3));
  const auto values=readValue(env,args.at(4)).array();
  for (const auto& binding:mv::windowBindings()) if (binding.name==name) {
    if (operation=="construct") setWindowModelForRuntime(env,args[1],owner.owner->core,binding.create(*owner.session,values));
    auto model=windowModelForRuntime(env,args[1],owner.owner->core);
    return writeValue(env,binding.invoke(*model,*owner.session,operation=="construct" ? "geometry" : operation,values));
  }
  throw std::invalid_argument("unknown native window class: "+name);
} catch (const std::exception& error) { return throwException(env,error); }
napi_value coreService(napi_env env,napi_callback_info info) try {
  const auto args=arguments(env,info); const auto methodName=asString(env,args.at(0));
  using Decrypter=mv::Decrypter;
  if (methodName=="switchFPSMeter") { mv::core::Graphics::onKeyDown(113); return undefined(env); }
  if (methodName=="videoEnded") { mv::core::Graphics::videoPlaying = false; return undefined(env); }
  if (methodName=="clearUpperCanvas") { mv::core::Graphics::clearUpperCanvas(); return undefined(env); }
  if (methodName=="printError") { mv::core::Graphics::printError(asString(env,args.at(1)),asString(env,args.at(2))); return undefined(env); }
  if (methodName=="audioMasterVolume") return number(env,mv::core::WebAudio::masterVolume);
  if (methodName=="graphicsDimension") {
    using Graphics=mv::core::Graphics;
    const auto field=asString(env,args.at(1));
    if (field=="width" || field=="height") {
      auto& dimension=field=="width" ? Graphics::width : Graphics::height;
      if (args.size()>2) {
        const int value=asInt32(env,args[2]);
        if(value<=0)throw std::invalid_argument("invalid graphics size");
        dimension=value;
      }
      return number(env,dimension);
    }
    if (field=="boxWidth" || field=="boxHeight") {
      auto& dimension=field=="boxWidth" ? Graphics::boxWidth : Graphics::boxHeight;
      if (args.size()>2) dimension=asInt32(env,args[2]);
      return number(env,dimension);
    }
    throw std::invalid_argument("unknown graphics dimension: "+field);
  }
  if(methodName=="graphicsState") {
    using Graphics=mv::core::Graphics;const auto name=asString(env,args.at(1));
    if(name=="stretchEnabled") {if(args.size()>2)Graphics::stretchEnabled=asBoolean(env,args[2]);return boolean(env,Graphics::stretchEnabled);}
    auto* value=name=="scale"?&Graphics::scale:name=="realScale"?&Graphics::realScale:name=="videoVolume"?&Graphics::videoVolume:nullptr;
    if(!value)throw std::invalid_argument("unknown graphics state: "+name);
    if(args.size()>2)*value=asNumber(env,args[2]);return number(env,*value);
  }
  if(methodName=="updateGraphicsScale") {mv::core::Graphics::updateScale();return undefined(env);}
  if(methodName=="updateGraphicsElements") {mv::core::Graphics::updateElements();return undefined(env);}
  if (methodName=="initializeGraphics") return boolean(env,mv::core::Graphics::initialize(asInt32(env,args.at(1)),asInt32(env,args.at(2)),"webgl"));
  if (methodName=="playVideo") { mv::core::Graphics::playVideo(asString(env,args.at(1))); return undefined(env); }
  if (methodName=="canPlayVideoType") return string(env,mv::core::Graphics::canPlayVideoType(asString(env,args.at(1))));
  if (methodName=="setVideoVolume") { mv::core::Graphics::setVideoVolume(asNumber(env,args.at(1))); return undefined(env); }
  if (methodName=="pageToCanvasX") return number(env,mv::core::Graphics::pageToCanvasX(asNumber(env,args.at(1))));
  if (methodName=="pageToCanvasY") return number(env,mv::core::Graphics::pageToCanvasY(asNumber(env,args.at(1))));
  if (methodName=="isInsideCanvas") return boolean(env,mv::core::Graphics::isInsideCanvas(asNumber(env,args.at(1)),asNumber(env,args.at(2))));
  if (methodName=="isWebGL") return boolean(env,mv::core::Graphics::isWebGL());
  if (methodName=="hasWebGL") return boolean(env,mv::core::Graphics::hasWebGL());
  if (methodName=="canUseDifferenceBlend") return boolean(env,mv::core::Graphics::canUseDifferenceBlend());
  if (methodName=="canUseSaturationBlend") return boolean(env,mv::core::Graphics::canUseSaturationBlend());
  if (methodName=="setLoadingImage") { mv::core::Graphics::setLoadingImage(asString(env,args.at(1))); return undefined(env); }
  if (methodName=="printLoadingError") { mv::core::Graphics::printLoadingError(asString(env,args.at(1))); return undefined(env); }
  if (methodName=="eraseLoadingError") { mv::core::Graphics::eraseLoadingError(); return undefined(env); }
  if (methodName=="callGC") { mv::core::Graphics::callGC(); return undefined(env); }
  if (methodName=="showFps") { mv::core::Graphics::showFps(); return undefined(env); }
  if (methodName=="hideFps") { mv::core::Graphics::hideFps(); return undefined(env); }
  if (methodName=="isVideoPlaying") return boolean(env,mv::core::Graphics::isVideoPlaying());
  if (methodName=="startLoading") { mv::core::Graphics::startLoading(); return undefined(env); }
  if (methodName=="endLoading") { mv::core::Graphics::endLoading(); return undefined(env); }
  if (methodName=="updateLoading") { mv::core::Graphics::updateLoading(); return undefined(env); }
  if (methodName=="tickStart") { mv::core::Graphics::tickStart(); return undefined(env); }
  if (methodName=="tickEnd") { mv::core::Graphics::tickEnd(); return undefined(env); }
  if (methodName=="isFontLoaded") return boolean(env,mv::core::Graphics::isFontLoaded(asString(env,args.at(1))));
  if (methodName=="extToEncryptExt") return string(env,Decrypter::extToEncryptExt(asString(env,args.at(1))));
  if (methodName=="checkImgIgnore") return boolean(env,Decrypter::checkImgIgnore(asString(env,args.at(1))));
  if (methodName=="readEncryptionkey") { Decrypter::readEncryptionkey(readValue(env,args.at(1))); return undefined(env); }
  if (methodName=="encryptionKey") {
    constexpr char digits[]="0123456789abcdef"; mv::Value::Array values;
    for (auto byte:Decrypter::encryptionKey) values.emplace_back(std::string{digits[byte>>4],digits[byte&15]});
    return writeValue(env,values);
  }
  if (methodName=="hasEncryptedImages" || methodName=="hasEncryptedAudio") {
    auto& flag=methodName=="hasEncryptedImages" ? Decrypter::hasEncryptedImages : Decrypter::hasEncryptedAudio;
    if (args.size()>1) flag=asBoolean(env,args[1]); return boolean(env,flag);
  }
  if (methodName=="decryptArrayBuffer" || methodName=="cutArrayHeader") {
    bool array=false; check(env,napi_is_arraybuffer(env,args.at(1),&array),"cannot inspect encrypted bytes");
    if (!array) throw std::invalid_argument("decryption requires an ArrayBuffer");
    void* data=nullptr; std::size_t length=0;
    check(env,napi_get_arraybuffer_info(env,args[1],&data,&length),"cannot read encrypted bytes");
    const auto* start=static_cast<const std::uint8_t*>(data);
    std::vector<std::uint8_t> bytes; if (length) bytes.assign(start,start+length);
    const auto result=methodName=="decryptArrayBuffer" ? Decrypter::decryptArrayBuffer(bytes) : Decrypter::cutArrayHeader(bytes,Decrypter::kHeaderLen);
    napi_value output; void* destination=nullptr;
    check(env,napi_create_arraybuffer(env,result.size(),&destination,&output),"cannot allocate decrypted bytes");
    if (!result.empty()) std::memcpy(destination,result.data(),result.size()); return output;
  }
  throw std::invalid_argument("core service is not bound: "+methodName);
} catch (const std::exception& error) { return throwException(env,error); }
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
napi_value messageTexts(napi_env env, napi_callback_info info) try {
  const auto args = arguments(env, info, 1); auto& owner = session(env, args.at(0));
  return runtimeHandle(owner, owner.session->messageTexts());
} catch (const std::exception& error) { return throwException(env, error); }
napi_value interpreterOperand(napi_env env, napi_callback_info info) try {
  const auto args = arguments(env, info, 5); auto& owner = session(env, args.at(0)); requireRuntimeOwner(owner, args.at(1));
  RuntimeCallScope callScope(owner);
  return writeValue(env, owner.session->runtimeGameDataOperand(runtimeAs<mv::RuntimeInterpreter>(env, args.at(1)),
    asInt32(env, args.at(2)), asInt32(env, args.at(3)), asInt32(env, args.at(4))));
} catch (const std::exception& error) { return throwException(env, error); }
napi_value interpreterControl(napi_env env, napi_callback_info info) try {
  const auto args = arguments(env, info, 4); auto& owner = session(env, args.at(0)); requireRuntimeOwner(owner, args.at(1));
  SceneTransitionScope transition(owner);
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
  bool array = false, branch = false, mutableArray = false;
  if (const auto branches = std::dynamic_pointer_cast<mv::RuntimeBranches>(object)) {
    branch = true;
    for (const auto& [key, value] : branches->values) { (void)value; keys.emplace_back(std::to_string(key)); }
  } else {
    const CommandCollection collection(object);
    mutableArray = collection.list->mutableArray;
    const auto& value = collection.value();
    if (const auto items = std::get_if<mv::Value::Array>(&value.data)) {
      array = true;
      for (std::size_t i = 0; i < items->size(); ++i) keys.emplace_back(std::to_string(i));
    } else for (const auto& [key, item] : std::get<mv::Value::Object>(value.data)) { (void)item; keys.emplace_back(key); }
  }
  return writeValue(env, mv::Value::Object{{"array", array}, {"branch", branch}, {"mutableArray", mutableArray}, {"keys", std::move(keys)}});
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
  if (collection.list->mutableArray) {
    auto& items = std::get<mv::Value::Array>(collection.value().data);
    if (key == "length") {
      if (replacement) {
        const double length = replacement->number(-1);
        if (length < 0 || length > 2147483647 || length != std::floor(length)) throw std::invalid_argument("invalid collection array length");
        items.resize(static_cast<std::size_t>(length), mv::Value::undefined());
      }
      if (replacement) owner.session->messageTextsChanged(collection.list);
      return number(env, items.size());
    }
    const auto index = static_cast<std::size_t>(branchKey(key));
    if (replacement) {
      if (items.size() <= index) items.resize(index + 1, mv::Value::undefined());
      items[index] = *replacement; owner.session->messageTextsChanged(collection.list);
    }
    return index < items.size() ? writeValue(env, items[index]) : undefined(env);
  }
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
  const auto object = runtimePayload(env, args.at(1)).object;
  if (auto list = std::dynamic_pointer_cast<mv::RuntimeCommandList>(object); list && list->mutableArray) {
    auto& items = std::get<mv::Value::Array>(list->root.data);
    const auto index = static_cast<std::size_t>(branchKey(asString(env, args.at(2))));
    if (index < items.size()) items[index] = mv::Value::undefined();
    owner.session->messageTextsChanged(list); return boolean(env, true);
  }
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
  try { const auto args = arguments(env, info); if (args.empty() || args.size()>2) throw std::invalid_argument("newGame requires session and optional starting-state flag"); auto& owner = session(env, args[0]); if (owner.runtimeCalls) throw std::runtime_error("cannot reset a session during a script callback"); SceneTransitionScope transition(owner); owner.session->newGame(args.size()<2 || asBoolean(env,args[1])); return undefined(env); }
  catch (const std::exception& error) { return throwException(env, error); }
}
napi_value battleTest(napi_env env, napi_callback_info info) {
  try { const auto args = arguments(env, info); if (args.size() != 1) throw std::invalid_argument("battleTest requires session"); auto& owner = session(env, args[0]); if (owner.runtimeCalls) throw std::runtime_error("cannot reset a session during a script callback"); SceneTransitionScope transition(owner); owner.session->setupBattleTest(); return undefined(env); }
  catch (const std::exception& error) { return throwException(env,error); }
}
mv::Input acquireEngineInput(napi_env env, EngineSession& value, napi_value logicalInput = nullptr) {
    mv::Input controls;
    if (logicalInput) {
      const auto input = readValue(env, logicalInput);
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
      if (!value.touchPrepared) updateTouchInput(value);
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
    return controls;
}
napi_value stepEngine(napi_env env, napi_callback_info info) {
  try {
    const auto args = arguments(env, info);
    if (args.empty() || args.size() > 2) throw std::invalid_argument("step requires session and optional logical input");
    auto& value = session(env, args[0]);
    if (value.stepping || value.runtimeCalls) throw std::runtime_error("native frame is already updating or executing a script callback");
    struct StepScope {
      EngineSession& owner;
      explicit StepScope(EngineSession& value) : owner(value) { owner.stepping = true; }
      ~StepScope() { owner.session->deferScriptScene(); owner.stepping = false; owner.touchPrepared = false; }
    } stepScope(value);
    const auto controls = acquireEngineInput(env, value, args.size() == 2 ? args[1] : nullptr);
    value.session->step(controls); value.session->deferScriptScene(); if (!value.scriptFrames) collectRuntime(value); return boolean(env, !value.session->finished());
  } catch (const std::exception& error) { return throwException(env, error); }
}
napi_value mapScene(napi_env env, napi_callback_info info) {
  try {
    const auto args = arguments(env, info);
    if (args.size() < 2 || args.size() > 3) throw std::invalid_argument("mapScene requires session, phase and optional logical input");
    auto& value = session(env, args[0]);
    const auto phase = asString(env, args[1]);
    if (phase != "destination" && phase != "update" && phase != "sceneChange") throw std::invalid_argument("unknown map scene phase: " + phase);
    if (value.stepping || value.runtimeCalls) throw std::runtime_error("native frame is already updating or executing a script callback");
    struct MapScope {
      EngineSession& owner;
      explicit MapScope(EngineSession& value) : owner(value) { owner.stepping = true; }
      ~MapScope() { owner.session->deferScriptScene(); owner.stepping = false; }
    } scope(value);
    if (phase == "sceneChange") {
      value.session->finishMapScene();
      value.mapSceneInput.reset(); value.touchPrepared = false;
    } else {
      if (args.size() == 3 || phase == "destination" || !value.mapSceneInput)
        value.mapSceneInput = acquireEngineInput(env, value, args.size() == 3 ? args[2] : nullptr);
      if (phase == "destination") value.session->updateMapSceneDestination(*value.mapSceneInput);
      else value.session->stepMapScene(*value.mapSceneInput);
    }
    value.session->deferScriptScene(); if (!value.scriptFrames) collectRuntime(value);
    return boolean(env, !value.session->finished());
  } catch (const std::exception& error) { return throwException(env, error); }
}
napi_value acknowledge(napi_env env, napi_callback_info info) {
  try { const auto args = arguments(env, info); if (args.empty() || args.size() > 2) throw std::invalid_argument("acknowledge requires session and optional choice"); auto& owner = session(env, args[0]); SceneTransitionScope transition(owner); owner.session->acknowledge(args.size() == 2 ? asInt32(env, args[1]) : -1); return undefined(env); }
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
napi_value setScreenSize(napi_env env,napi_callback_info info) try {
  const auto args=arguments(env,info);auto& owner=session(env,args.at(0));
  owner.session->setScreenSize(asInt32(env,args.at(1)),asInt32(env,args.at(2)));return undefined(env);
} catch(const std::exception& error) {return throwException(env,error);}
napi_value present(napi_env env, napi_callback_info info) {
  try {
    const auto args = arguments(env, info);
    if (args.size() != 1) throw std::invalid_argument("present requires session");
    auto& value = session(env, args[0]);
    if (!value.presentation) throw std::runtime_error("presentation is not attached");
    if (value.runtimeCalls || value.stepping) throw std::runtime_error("cannot present during a script callback or step");
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
  try { const auto args = arguments(env, info); if (args.size() != 1) throw std::invalid_argument("openTitle requires session"); auto& owner = session(env, args[0]); SceneTransitionScope transition(owner); owner.session->openTitle(); return undefined(env); }
  catch (const std::exception& error) { return throwException(env, error); }
}
napi_value sceneControl(napi_env env, napi_callback_info info) try {
  const auto args = arguments(env, info);
  if (args.size() < 2 || args.size() > 3) throw std::invalid_argument("scene control requires session, method and optional state");
  auto& owner = session(env, args[0]); const auto method = asString(env, args[1]);
  SceneTransitionScope transition(owner);
  if (method == "capture") return runtimeHandle(owner, std::make_shared<RuntimeSceneState>(owner.session->ui()));
  if (method == "restore" && args.size() == 3) {
    requireRuntimeOwner(owner, args[2]);
    owner.session->prepareScriptScene(runtimeAs<RuntimeSceneState>(env, args[2])->state);
  } else if ((method == "prepare" || method == "commit") && args.size() == 3) {
    const int kind = asInt32(env, args[2]);
    if (kind < -1 || kind > static_cast<int>(mv::Scene::debug) || (method == "prepare" && kind < 0))
      throw std::invalid_argument("invalid native scene kind");
    if (method == "prepare") { mv::Ui state; state.scene = static_cast<mv::Scene>(kind); owner.session->prepareScriptScene(std::move(state)); }
    else owner.session->commitScriptScene(kind < 0 ? std::optional<mv::Scene>{} : std::optional<mv::Scene>{static_cast<mv::Scene>(kind)});
  } else if (method == "exit") {
    mv::SceneManager::exit(*owner.session);
  } else if (method == "title") {
    struct Guard {
      bool& suppressed;
      explicit Guard(bool& flag) : suppressed(flag) { suppressed = true; }
      ~Guard() { suppressed = false; }
    } guard(owner.sceneRequestsSuppressed);
    owner.session->openTitle();
  } else throw std::invalid_argument("scene control is not bound: " + method);
  return undefined(env);
} catch (const std::exception& error) { return throwException(env, error); }
napi_value bindMapSpriteset(napi_env env,napi_callback_info info) try {
  const auto args=arguments(env,info);
  if(args.size()!=2)throw std::invalid_argument("map spriteset binding requires session and native spriteset");
  auto& owner=session(env,args[0]); requireRuntimeOwner(owner,args[1]);
  if(!owner.presentation)throw std::runtime_error("presentation is not attached");
  const auto spriteset=std::dynamic_pointer_cast<mv::NativeMapSpriteset>(runtimeAs<mv::GeneratedRuntimeObject>(env,args[1]));
  if(!spriteset)throw std::invalid_argument("map spriteset must use the native Spriteset_Map binding");
  owner.presentation->bindMapSpriteset(*spriteset);
  return undefined(env);
} catch(const std::exception& error) { return throwException(env,error); }
napi_value scriptStage(napi_env env, napi_callback_info info) {
  try {
    const auto args = arguments(env, info);
    if (args.size() != 2) throw std::invalid_argument("scriptStage requires session and display root or null");
    auto& value = session(env, args[0]);
    if (!value.presentation) throw std::runtime_error("presentation is not attached");
    napi_valuetype type; check(env, napi_typeof(env, args[1], &type), "cannot inspect script stage");
    value.presentation->setScriptStage(type == napi_null ? nullptr : displayForRuntime(env, args[1], value.owner->core));
    return undefined(env);
  } catch (const std::exception& error) { return throwException(env, error); }
}
napi_value playerTransfer(napi_env env, napi_callback_info info) try {
  const auto args = arguments(env, info);
  if (args.size() < 2) throw std::invalid_argument("player transfer requires session and operation");
  auto& owner = session(env, args[0]); const auto operation = asString(env, args[1]);
  if (operation == "isTransferring") return boolean(env, owner.session->playerTransferring());
  if (operation == "newMapId") return number(env, owner.session->playerNewMapId());
  if (operation == "fadeType") return number(env, owner.session->playerFadeType());
  if (operation == "reserve") {
    if (args.size() != 7) throw std::invalid_argument("reserve transfer requires map, coordinates, direction and fade");
    owner.session->reservePlayerTransfer(asInt32(env, args[2]), asInt32(env, args[3]), asInt32(env, args[4]), asInt32(env, args[5]), asInt32(env, args[6]));
  } else if (operation == "perform") {
    if (owner.runtimeCalls || owner.stepping) throw std::runtime_error("cannot perform a player transfer during a script callback or step");
    owner.session->performPlayerTransfer();
  } else throw std::invalid_argument("unknown player transfer operation: " + operation);
  return undefined(env);
} catch (const std::exception& error) { return throwException(env, error); }
napi_value entity(napi_env env, napi_callback_info info) try {
  const auto args = arguments(env, info);
  if (args.size() != 3) throw std::invalid_argument("entity requires session, kind and ID");
  auto& owner = session(env, args[0]); RuntimeCallScope callScope(owner);
  const auto kind = asString(env, args[1]); const int id = asInt32(env, args[2]);
  std::shared_ptr<mv::RuntimeObject> object;
  if (kind == "character") object = owner.session->runtimeCharacter(id);
  else if (kind == "follower") object = owner.session->runtimeFollower(id);
  else if (kind == "actor") object = owner.session->runtimeActor(id);
  else if (kind == "enemy") object = owner.session->runtimeEnemy(id);
  else throw std::invalid_argument("entity kind is not bound: " + kind);
  return object ? runtimeHandle(owner, object) : null(env);
} catch (const std::exception& error) { return throwException(env, error); }
napi_value entityField(napi_env env, napi_callback_info info) try {
  const auto args = arguments(env, info);
  if (args.size() < 2 || args.size() > 3) throw std::invalid_argument("entityField requires handle, field and optional value");
  const auto object = runtimePayload(env, args[0]).object; const auto field = asString(env, args[1]);
  int* integer = nullptr; double* scalar = nullptr; bool* flag = nullptr; std::string* text = nullptr;
  if (auto character = std::dynamic_pointer_cast<mv::RuntimeCharacter>(object)) {
    auto& value = character->value();
    if (field == "id") return number(env, character->id);
    if (field == "mapId") return number(env, character->mapId);
    if (field == "memberIndex") return number(env, character->id <= -8 ? -static_cast<double>(character->id)-4 : character->id >= -4 && character->id <= -2 ? -character->id-1 : 0);
    if (field == "x") integer = &value.x; else if (field == "y") integer = &value.y;
    else if (field == "realX") scalar = &value.realX; else if (field == "realY") scalar = &value.realY;
    else if (field == "direction") integer = &value.direction; else if (field == "opacity") integer = &value.opacity;
    else if (field == "moveRouteIndex") integer = &value.routeIndex;
    else if (field == "moveSpeed") integer = &value.moveSpeed;
    else if (field == "moveFrequency") integer = &value.moveFrequency;
    else if (field == "characterIndex") integer = &value.characterIndex;
    else if (field == "bushDepth") integer = &value.bushDepth;
    else if (field == "stopCount") integer = &value.stopCount;
    else if (field == "animationCount") scalar = &value.animationCount;
    else if (field == "stepAnime") flag = &value.stepAnime;
    else if (field == "walkAnime") flag = &value.walkAnime;
    else if (field == "pattern") integer = &value.pattern;
    else if (field == "tileId") integer = &value.tileId;
    else if (field == "jumpCount") integer = &value.jumpCount;
    else if (field == "movementSuccess") flag = &value.movementSuccess;
    else if (field == "directionFix") flag = &value.directionFix;
    else if (field == "transparent") flag = &value.transparent; else if (field == "through") flag = &value.through; else if (field == "characterName") text = &value.characterName;
  } else if (auto actor = std::dynamic_pointer_cast<mv::RuntimeActor>(object)) {
    auto& value = actor->value();
    if (field == "id") integer = &value.id;
    else if (field == "classId") integer = &value.classId;
    if (field == "enemy") return boolean(env, value.enemy);
    if (field == "hidden") flag = &value.hidden;
    if (field == "letter") text = &value.letter;
    if (field == "plural") flag = &value.plural;
    if (field == "level") integer = &value.level;
    else if (field == "profile") text = &value.profile;
    else if (field == "characterName") text = &value.characterName;
    else if (field == "characterIndex") integer = &value.characterIndex;
    else if (field == "faceName") text = &value.faceName;
    else if (field == "faceIndex") integer = &value.faceIndex;
    else if (field == "battlerName") text = &value.battlerName;
    else if (field == "result.used") flag = &value.result.used;
    else if (field == "result.missed") flag = &value.result.missed;
    else if (field == "result.evaded") flag = &value.result.evaded;
    else if (field == "result.physical") flag = &value.result.physical;
    else if (field == "result.drain") flag = &value.result.drain;
    else if (field == "result.critical") flag = &value.result.critical;
    else if (field == "result.success") flag = &value.result.success;
    else if (field == "result.hpAffected") flag = &value.result.hpAffected;
    else if (field == "result.hpDamage") integer = &value.result.hpDamage;
    else if (field == "result.mpDamage") integer = &value.result.mpDamage;
    else if (field == "result.tpDamage") integer = &value.result.tpDamage;
    if (field == "screenX") scalar = &value.screenX; else if (field == "screenY") scalar = &value.screenY;
    if (field == "hp") integer = &value.hp; else if (field == "mp") integer = &value.mp; else if (field == "tp") integer = &value.tp;
    else if (field == "name") text = &value.name; else if (field == "nickname") text = &value.nickname;
  } else throw std::invalid_argument("entity handle is not bound");
  if (integer) { if (args.size() == 3) *integer = asInt32(env, args[2]); return number(env, *integer); }
  if (scalar) { if (args.size() == 3) *scalar = asNumber(env, args[2]); return number(env, *scalar); }
  if (flag) { if (args.size() == 3) *flag = asBoolean(env, args[2]); return boolean(env, *flag); }
  if (text) { if (args.size() == 3) *text = asString(env, args[2]); return string(env, *text); }
  throw std::invalid_argument("entity field is not bound: " + field);
} catch (const std::exception& error) { return throwException(env, error); }
napi_value actorState(napi_env env, napi_callback_info info) try {
  const auto args = arguments(env, info);
  if (args.size() != 2) throw std::invalid_argument("actorState requires actor and state ID");
  const auto actor = runtimeAs<mv::RuntimeActor>(env, args[0]); const int id = asInt32(env, args[1]);
  const auto& states = actor->value().states;
  return boolean(env, std::find(states.begin(), states.end(), id) != states.end());
} catch (const std::exception& error) { return throwException(env, error); }
napi_value actionRate(napi_env env, napi_callback_info info) try {
  const auto args = arguments(env, info);
  if (args.size() != 6) throw std::invalid_argument("actionRate requires session, subject, target, method, item flag and ID");
  auto& owner = session(env, args[0]); requireRuntimeOwner(owner, args[1]); requireRuntimeOwner(owner, args[2]);
  const auto subject = runtimeAs<mv::RuntimeActor>(env, args[1]), target = runtimeAs<mv::RuntimeActor>(env, args[2]);
  const auto& item = owner.session->database()[asBoolean(env, args[4]) ? "items" : "skills"][asInt32(env, args[5])];
  if (item.null()) throw std::invalid_argument("action item does not exist");
  return number(env, owner.session->actionRateBase(asString(env, args[3]), subject->value(), target->value(), item));
} catch (const std::exception& error) { return throwException(env, error); }
const std::vector<mv::ClassBinding>& bindingClasses() {
  using namespace mv;
  const auto battler = [](RuntimeBoundObject& object) -> Sprite_Battler& { return dynamic_cast<RuntimeBattlerSprite&>(object).state(); };
  const auto battlerObject = [](RuntimeBoundObject& object) -> RuntimeBattlerSprite& { return dynamic_cast<RuntimeBattlerSprite&>(object); };
  auto setBattler = bindingMethod("setBattler", battlerObject, &RuntimeBattlerSprite::setBattler); setBattler.aliases = {{"_battler", 0}};
  auto setActor = setBattler; setActor.aliases.push_back({"_actor", 0});
  const auto actor = [](RuntimeBoundObject& object) -> Sprite_Actor& { auto& owner = dynamic_cast<RuntimeActorSprite&>(object); owner.state(); return owner.value; };
  const auto enemy = [](RuntimeBoundObject& object) -> Sprite_Enemy& { return *dynamic_cast<RuntimeEnemySprite&>(object).value; };
  const auto enemyObject = [](RuntimeBoundObject& object) -> RuntimeEnemySprite& { return dynamic_cast<RuntimeEnemySprite&>(object); };
  auto setEnemy = bindingMethod("setBattler", enemyObject, &RuntimeEnemySprite::setBattler);
  setEnemy.aliases = {{"_battler", 0}, {"_enemy", 0}};
  const auto balloon = [](RuntimeBoundObject& object) -> RuntimeBalloon& { return dynamic_cast<RuntimeBalloon&>(object); };
  const auto balloonMethods = [balloon] {
    std::vector<BindingMethod> result;
    for (const auto* name : {"_initializeBalloon", "initMembers", "loadBitmap", "setup", "update", "updateFrame", "frameIndex", "speed", "waitTime", "isPlaying"}) {
      const std::size_t arity = std::string(name) == "setup" ? 1 : 0;
      result.push_back({name, arity, [balloon, method = std::string(name)](RuntimeBoundObject& object, const BindingArguments& arguments) {
        Value::Array values; for (const auto& argument : arguments) values.push_back(std::get<Value>(argument));
        return balloon(object).invoke(method, values);
      }, std::vector<std::string>(arity, "value"), {}, std::string(name) == "frameIndex" || std::string(name) == "speed" || std::string(name) == "waitTime" || std::string(name) == "isPlaying"});
    }
    return result;
  };
  static const std::vector<ClassBinding> classes = [&] {
  std::vector<ClassBinding> result{
    {"Sprite_Balloon", "Sprite_Base", "pmjs::mv::Sprite_Balloon", [] { return std::make_shared<RuntimeBalloon>(); }, {
      bindingField("_balloonId", [balloon](RuntimeBoundObject& object) -> int& { return balloon(object).value.balloonId; }),
      bindingField("_duration", [balloon](RuntimeBoundObject& object) -> int& { return balloon(object).value.duration; })
    }, balloonMethods(), "_initializeBalloon", {}},
    {"Sprite_Battler", "Sprite_Base", "pmjs::mv::Sprite_Battler", [] { return std::make_shared<RuntimeBaseBattlerSprite>(); }, {
      bindingField("_homeX", [battler](RuntimeBoundObject& object) -> float& { return battler(object).homePosition.x; }),
      bindingField("_homeY", [battler](RuntimeBoundObject& object) -> float& { return battler(object).homePosition.y; }),
      bindingField("_offsetX", [battler](RuntimeBoundObject& object) -> float& { return battler(object).offset.x; }),
      bindingField("_offsetY", [battler](RuntimeBoundObject& object) -> float& { return battler(object).offset.y; }),
      bindingField("_targetOffsetX", [battler](RuntimeBoundObject& object) -> float& { return battler(object).targetOffset.x; }),
      bindingField("_targetOffsetY", [battler](RuntimeBoundObject& object) -> float& { return battler(object).targetOffset.y; }),
      bindingField("_movementDuration", [battler](RuntimeBoundObject& object) -> int& { return battler(object).movementDuration; }),
      bindingField("_motionCount", [battler](RuntimeBoundObject& object) -> int& { return battler(object).motionCount; }),
      bindingField("_pattern", [battler](RuntimeBoundObject& object) -> int& { return battler(object).pattern; }),
      bindingField("_selectionEffectCount", [battler](RuntimeBoundObject& object) -> int& { return battler(object).selectionEffectCount; }),
      BindingField{"_motionIndex", [battler](RuntimeBoundObject& object) { return Value(static_cast<int>(battler(object).motion)); },
        [battler](RuntimeBoundObject& object, const Value& value) { const int index = value.integer(); if (index < 0 || index > 17) throw std::invalid_argument("invalid battler motion"); battler(object).motion = static_cast<BattlerMotion>(index); }},
      BindingField{"opacity", [battler](RuntimeBoundObject& object) { return Value(battler(object).opacity * 255); },
        [battlerObject](RuntimeBoundObject& object, const Value& value) { auto& owner = battlerObject(object); const double opacity = std::clamp(value.number(), 0.0, 255.0); owner.state().opacity = static_cast<float>(opacity / 255); owner.drawable->setOpacity(opacity); }},
      BindingField{"alpha", [battler](RuntimeBoundObject& object) { return Value(battler(object).opacity); },
        [battlerObject](RuntimeBoundObject& object, const Value& value) { auto& owner = battlerObject(object); owner.state().opacity = static_cast<float>(value.number()); owner.drawable->alpha = value.number(); }}
    }, {
      setBattler,
      bindingMethod("setHome", battler, &Sprite_Battler::setHome),
      bindingMethod("startMove", battler, &Sprite_Battler::startMove),
      bindingMethod("updateMove", battlerObject, &RuntimeBattlerSprite::updateMove),
      bindingMethod("isMoving", battler, &Sprite_Battler::isMoving)
    }, "setBattler", {Value{}}},
    {"Sprite_Actor", "Sprite_Battler", "pmjs::mv::Sprite_Actor", [] { return std::make_shared<RuntimeActorSprite>(); }, {}, {
      setActor,
      bindingMethod("refreshMotion", actor, &Sprite_Actor::refreshMotion),
      bindingMethod("setActorHome", actor, &Sprite_Actor::setActorHome),
      bindingMethod("retreat", actor, &Sprite_Actor::retreat)
    }, "setBattler", {Value{}}},
    {"Sprite_Enemy", "Sprite_Battler", "pmjs::mv::Sprite_Enemy", [] { return std::make_shared<RuntimeEnemySprite>(); }, {
      bindingField("_shake", [enemy](RuntimeBoundObject& object) -> double& { return enemy(object).shake; }),
      bindingField("_appeared", [enemy](RuntimeBoundObject& object) -> bool& { return enemy(object).appeared; }),
      bindingField("_effectDuration", [enemy](RuntimeBoundObject& object) -> int& { return enemy(object).effectDuration; }),
      bindingField("_effectType", [enemy](RuntimeBoundObject& object) -> std::string& { return enemy(object).effectType; })
    }, {setEnemy, bindingMethod("startEffect", enemy, &Sprite_Enemy::startEffect),
      bindingMethod("startBossCollapse", enemy, &Sprite_Enemy::startBossCollapse),
      bindingMethod("isEffecting", enemy, &Sprite_Enemy::isEffecting)}, "setBattler", {Value{}}}
  };
  auto generated = generatedClassBindings();
  result.insert(result.end(), std::make_move_iterator(generated.begin()), std::make_move_iterator(generated.end()));
  return result;
  }();
  return classes;
}
const mv::ClassBinding* findBindingClass(std::string_view name) {
  static const auto classes = [] {
    std::unordered_map<std::string_view, const mv::ClassBinding*> result;
    result.reserve(bindingClasses().size());
    for (const auto& binding : bindingClasses()) result.emplace(binding.name, &binding);
    return result;
  }();
  const auto found = classes.find(name);
  return found == classes.end() ? nullptr : found->second;
}
struct PresentationReference {
  napi_env env;
  napi_ref reference=nullptr;
  PresentationReference(napi_env value,napi_value object,std::uint32_t count=0):env(value) {
    check(env,napi_create_reference(env,object,count,&reference),"cannot reference character presentation object");
  }
  ~PresentationReference() {napi_delete_reference(env,reference);}
  napi_value get() const {
    napi_value value=nullptr;check(env,napi_get_reference_value(env,reference,&value),"cannot retrieve character presentation object");return value;
  }
};
struct NativePresentationDefinition;
struct PresentationMethodCache {
  std::shared_ptr<PresentationReference> function;
  const NativePresentationDefinition* definition=nullptr;
};
struct NativePresentationDefinition {
  std::string method,operation,bindingType,baseProperty;
  const mv::BindingMethod* binding=nullptr;
  mv::omori::CharacterPresentationQuery query=nullptr;
  std::shared_ptr<PresentationReference> function,native,baseFunction,baseOwner;
  mutable PresentationMethodCache baseCache;
  mutable std::unordered_map<std::string,PresentationMethodCache> methods;
};
struct NativePresentationProgram {
  struct View {std::weak_ptr<mv::RuntimeBoundObject> model;std::shared_ptr<PresentationReference> object;mv::Value receiver;};
  bool enabled=false;
  std::shared_ptr<PresentationReference> environment,displayKey;
  std::vector<std::unique_ptr<NativePresentationDefinition>> definitions;
  std::unordered_map<std::string,std::vector<const NativePresentationDefinition*>> methods;
  std::unordered_map<std::uint64_t,View> views;
  std::unordered_map<const mv::ValueReader*,std::weak_ptr<mv::RuntimeBoundObject>> receiverModels;
  struct EntityView {std::weak_ptr<mv::RuntimeCharacter> model;std::shared_ptr<PresentationReference> object;mv::Value receiver;};
  std::unordered_map<std::uint64_t,EntityView> entities;
  std::unordered_map<std::string,PresentationMethodCache> boundMethods;
  std::uint64_t nativeCalls=0,nativeFrames=0,scriptCalls=0;
  mv::Value environmentData;
};
void collectCharacterPresentation(EngineSession& owner) {
  if(!owner.characterPresentation)return;
  auto& views=owner.characterPresentation->views;
  for(auto i=views.begin();i!=views.end();)if(i->second.model.expired()) {
    owner.characterPresentation->receiverModels.erase(i->second.receiver.reader.get());i=views.erase(i);
  } else ++i;
  auto& entities=owner.characterPresentation->entities;
  for(auto i=entities.begin();i!=entities.end();)if(i->second.model.expired())i=entities.erase(i);else ++i;
}
napi_value presentationProperty(napi_env env,napi_value object,const std::string& name) {
  bridge_trace::Scope trace("lookup:"+name);
  napi_value value;check(env,napi_get_named_property(env,object,name.c_str(),&value),"cannot read character presentation property");return value;
}
mv::Value presentationValue(EngineSession& owner,napi_value value,bool retainSource=true) {
  // Cached views borrow their JS owners instead of keeping the session alive.
  napi_valuetype type;check(owner.env,napi_typeof(owner.env,value,&type),"cannot inspect character presentation value");
  if(type!=napi_object)return readValue(owner.env,value);
  if(!owner.database)throw std::runtime_error("character presentation requires a published database");
  auto reader=std::make_shared<DatabaseReader>(owner.database,value,false,retainSource);
  mv::Value result=reader->isArray ? mv::Value(mv::Value::Array{}) : mv::Value(mv::Value::Object{});
  result.reader=std::move(reader);return result;
}
std::shared_ptr<mv::core::Container> presentationDisplay(EngineSession& owner,const mv::Value& receiver) {
  auto& program=*owner.characterPresentation;
  if(const auto found=program.receiverModels.find(receiver.reader.get());found!=program.receiverModels.end())
    if(const auto model=found->second.lock())return model->displayObject();
  const auto object=writeValue(owner.env,receiver);
  const auto key=presentationProperty(owner.env,program.displayKey->get(),"key");
  napi_value handle;check(owner.env,napi_get_property(owner.env,object,key,&handle),"cannot read presentation display handle");
  napi_valuetype type;check(owner.env,napi_typeof(owner.env,handle,&type),"cannot inspect presentation display handle");
  return type==napi_undefined ? nullptr : displayForRuntime(owner.env,handle,owner.owner->core);
}
mv::Value presentationEntity(EngineSession& owner,const std::shared_ptr<mv::RuntimeCharacter>& character) {
  auto& entities=owner.characterPresentation->entities;
  auto found=entities.find(character->identity);
  if(found==entities.end() || !found->second.object->get()) {
    callRuntime(owner,"presentationCharacter",{runtimeHandle(owner,character)});found=entities.find(character->identity);
  }
  if(found==entities.end())throw std::runtime_error("native character view is unavailable");
  if(!found->second.receiver.reader)found->second.receiver=presentationValue(owner,found->second.object->get(),false);
  return found->second.receiver.reference();
}
std::shared_ptr<mv::RuntimeCharacter> presentationEntityForValue(EngineSession& owner,const mv::Value& value) {
  const auto key=presentationProperty(owner.env,owner.characterPresentation->displayKey->get(),"entityKey");
  napi_value identity;check(owner.env,napi_get_property(owner.env,writeValue(owner.env,value),key,&identity),"cannot identify presentation character");
  napi_valuetype type;check(owner.env,napi_typeof(owner.env,identity,&type),"cannot inspect presentation character identity");
  if(type!=napi_number)return {};
  const auto found=owner.characterPresentation->entities.find(static_cast<std::uint64_t>(asNumber(owner.env,identity)));
  return found==owner.characterPresentation->entities.end() ? nullptr : found->second.model.lock();
}
void tagPresentationEntity(EngineSession& owner,napi_value object,std::uint64_t identity) {
  const auto key=presentationProperty(owner.env,owner.characterPresentation->displayKey->get(),"entityKey");
  const napi_property_descriptor field{nullptr,key,nullptr,nullptr,nullptr,number(owner.env,static_cast<double>(identity)),napi_default,nullptr};
  check(owner.env,napi_define_properties(owner.env,object,1,&field),"cannot identify native presentation character");
}
const NativePresentationDefinition* presentationDefinition(EngineSession& owner,napi_value function,const std::string& method) {
  auto& program=*owner.characterPresentation;
  const auto found=program.methods.find(method);if(found==program.methods.end())return nullptr;
  for(const auto* definition:found->second)for(const auto& reference:{definition->function,definition->native})if(reference) {
    const auto candidate=reference->get();if(!candidate)continue;
    bool same;check(owner.env,napi_strict_equals(owner.env,function,candidate,&same),"cannot compare presentation method identity");
    if(same)return definition;
  }
  return nullptr;
}
const NativePresentationDefinition* cachedPresentationDefinition(EngineSession& owner,napi_value function,const std::string& method,PresentationMethodCache& cache) {
  if(cache.function)if(const auto previous=cache.function->get()) {
    bool same;check(owner.env,napi_strict_equals(owner.env,function,previous,&same),"cannot compare cached presentation method");
    if(same)return cache.definition;
  }
  napi_valuetype type;check(owner.env,napi_typeof(owner.env,function,&type),"cannot inspect presentation method");
  if(type!=napi_function)return nullptr;
  cache.definition=presentationDefinition(owner,function,method);
  cache.function=std::make_shared<PresentationReference>(owner.env,function);return cache.definition;
}
mv::Value invokePresentationFunction(EngineSession&,const mv::Value&,napi_value,const std::string&,const mv::Value::Array&,PresentationMethodCache* = nullptr);
struct NativeCharacterPresentationContext final : mv::omori::CharacterPresentationContext {
  EngineSession& owner;
  const NativePresentationDefinition& definition;
  mv::CharacterSprite* characterSprite;
  NativeCharacterPresentationContext(EngineSession& value,const mv::Value& object,const NativePresentationDefinition& method,
      std::shared_ptr<mv::RuntimeCharacter> character,std::shared_ptr<mv::core::Container> node)
    :CharacterPresentationContext(*value.session,object.reference(),std::move(character),value.characterPresentation->environmentData.reference(),std::move(node)),
     owner(value),definition(method),characterSprite(dynamic_cast<mv::CharacterSprite*>(display.get())) {}
  mv::Value characterData() override {
    if(!characterSprite)return receiver["_character"].reference();
    return characterSprite->character ? presentationEntity(owner,characterSprite->character) : mv::Value{};
  }
  mv::Value call(const mv::Value& target,const std::string& method,const mv::Value::Array& values) override {
    const auto function=presentationProperty(owner.env,writeValue(owner.env,target),method);
    return invokePresentationFunction(owner,target,function,method,values,&definition.methods[method]);
  }
  mv::Value base(const mv::Value::Array& values) override {
    napi_value function=nullptr;
    if(definition.baseOwner) {
      const auto object=definition.baseOwner->get();if(!object)throw std::runtime_error("character presentation parent is unavailable");
      function=presentationProperty(owner.env,object,definition.baseProperty);
    } else if(definition.baseFunction)function=definition.baseFunction->get();
    if(!function)throw std::runtime_error("character presentation parent method is unavailable");
    return invokePresentationFunction(owner,receiver,function,definition.method,values,&definition.baseCache);
  }
  mv::Value construct(const std::string& name,const mv::Value::Array& values) override {
    const auto constructors=presentationProperty(owner.env,owner.characterPresentation->environment->get(),"constructors");
    const auto function=presentationProperty(owner.env,constructors,name);std::vector<napi_value> parameters;
    for(const auto& value:values)parameters.push_back(writeValue(owner.env,value));
    napi_value result;check(owner.env,napi_new_instance(owner.env,function,parameters.size(),parameters.data(),&result),"cannot construct character presentation object");
    return presentationValue(owner,result);
  }
  void set(const mv::Value& target,const std::string& field,const mv::Value& value) override {
    check(owner.env,napi_set_named_property(owner.env,writeValue(owner.env,target),field.c_str(),writeValue(owner.env,value)),"cannot set character presentation property");
  }
  void erase(const mv::Value& target,const std::string& field) override {
    bool removed;check(owner.env,napi_delete_property(owner.env,writeValue(owner.env,target),string(owner.env,field),&removed),"cannot delete character presentation property");
  }
  std::shared_ptr<mv::core::Container> displayOf(const mv::Value& target) override {return presentationDisplay(owner,target);}
};
mv::Value invokePresentationDefinition(EngineSession& owner,const mv::Value& receiver,const NativePresentationDefinition& definition,const mv::Value::Array& arguments) {
  bridge_trace::Scope trace("native:"+(definition.operation.empty() ? definition.bindingType+"."+definition.method : definition.operation));
  auto& program=*owner.characterPresentation;
  if(!definition.bindingType.empty()) {
    const auto object=std::dynamic_pointer_cast<mv::RuntimeBoundObject>(presentationDisplay(owner,receiver));
    if(!object)throw std::invalid_argument("native presentation method requires a bound sprite");
    if(definition.binding) {
      const auto& method=*definition.binding;
      if(method.arity!=arguments.size())throw std::invalid_argument("native presentation method argument count differs");
      mv::BindingArguments values;for(const auto& value:arguments)values.emplace_back(value.reference());
      return method.invoke(*object,values);
    }
    throw std::invalid_argument("native presentation method is not bound: "+definition.method);
  }
  ++program.nativeCalls;if(definition.operation=="omori.chain")++program.nativeFrames;
  if(definition.query)return definition.query(*owner.session,arguments);
  const bool dataOperation=definition.operation.starts_with("character.") || definition.operation.starts_with("position.") || definition.operation.starts_with("map.");
  const auto display=dataOperation ? nullptr : presentationDisplay(owner,receiver);
  const bool entityOperation=definition.operation=="character.object" || definition.operation=="character.jump" || definition.operation=="character.screenZ";
  const auto entity=entityOperation ? presentationEntityForValue(owner,receiver) : nullptr;
  NativeCharacterPresentationContext context(owner,receiver,definition,entity,display);
  return mv::omori::invokeCharacterPresentation(definition.operation,context,arguments);
}
mv::Value invokePresentationFunction(EngineSession& owner,const mv::Value& receiver,napi_value function,const std::string& method,const mv::Value::Array& arguments,PresentationMethodCache* cache) {
  const auto* definition=cache ? cachedPresentationDefinition(owner,function,method,*cache) : presentationDefinition(owner,function,method);
  if(definition)return invokePresentationDefinition(owner,receiver,*definition,arguments);
  bridge_trace::Scope trace("fallback:"+method+"#"+std::to_string(bridge_trace::functionId(owner.env,function)));
  ++owner.characterPresentation->scriptCalls;
  std::vector<napi_value> values;for(const auto& value:arguments)values.push_back(writeValue(owner.env,value));
  napi_value result;check(owner.env,napi_call_function(owner.env,writeValue(owner.env,receiver),function,values.size(),values.data(),&result),"character presentation override failed");
  return presentationValue(owner,result);
}
std::optional<std::array<double,2>> nativeCharacterPosition(EngineSession& owner,const std::shared_ptr<mv::RuntimeCharacter>& character) {
  if(!owner.characterPresentation || !owner.characterPresentation->enabled)return {};
  const auto value=presentationEntity(owner,character);const auto object=writeValue(owner.env,value);
  const auto x=presentationProperty(owner.env,object,"screenX"),y=presentationProperty(owner.env,object,"screenY");
  auto& methods=owner.characterPresentation->boundMethods;
  const auto* dx=cachedPresentationDefinition(owner,x,"screenX",methods["screenX"]);
  if(!dx || !cachedPresentationDefinition(owner,y,"screenY",methods["screenY"]))return {};
  const double sx=invokePresentationDefinition(owner,value,*dx,{}).number();
  const auto currentY=presentationProperty(owner.env,object,"screenY");
  const double sy=invokePresentationFunction(owner,value,currentY,"screenY",{},&methods["screenY"]).number();
  if(!std::isfinite(sx)||!std::isfinite(sy))throw std::invalid_argument("character position override must return finite coordinates");
  return std::array<double,2>{sx,sy};
}
std::optional<int> nativeCharacterZ(EngineSession& owner,const std::shared_ptr<mv::RuntimeCharacter>& character) {
  if(!owner.characterPresentation || !owner.characterPresentation->enabled)return {};
  const auto value=presentationEntity(owner,character);const auto function=presentationProperty(owner.env,writeValue(owner.env,value),"screenZ");
  const auto* definition=cachedPresentationDefinition(owner,function,"screenZ",owner.characterPresentation->boundMethods["screenZ"]);
  if(!definition)return {};
  return invokePresentationDefinition(owner,value,*definition,{}).integer();
}
napi_value characterPresentationView(EngineSession& owner,const std::shared_ptr<mv::RuntimeBoundObject>& object) {
  auto& program=*owner.characterPresentation;
  if(const auto found=program.views.find(object->identity);found!=program.views.end())if(const auto value=found->second.object->get())return value;
  callRuntime(owner,"retainBoundObject",{runtimeHandle(owner,object)});
  const auto found=program.views.find(object->identity);
  if(found==program.views.end())throw std::runtime_error("character presentation view was not attached");
  const auto result=found->second.object->get();if(!result)throw std::runtime_error("character presentation view is unavailable");return result;
}
PresentationDispatch dispatchCharacterPresentation(EngineSession& owner,const std::shared_ptr<mv::RuntimeBoundObject>& object,const std::string& method,const mv::Value::Array& arguments) {
  if(!owner.characterPresentation || !owner.characterPresentation->enabled || std::string_view(object->bindingType())!="Sprite_Character")return {};
  const auto view=characterPresentationView(owner,object);const auto function=presentationProperty(owner.env,view,method);
  const auto* definition=cachedPresentationDefinition(owner,function,method,owner.characterPresentation->boundMethods[method]);
  if(!definition)return {};
  if(!definition->bindingType.empty())return {true,{}};
  auto& cached=owner.characterPresentation->views.at(object->identity).receiver;
  if(!cached.reader) {
    cached=presentationValue(owner,view,false);
    owner.characterPresentation->receiverModels[cached.reader.get()]=object;
  }
  return {true,invokePresentationDefinition(owner,cached,*definition,arguments)};
}
std::optional<bool> characterPresentationOverride(EngineSession& owner,const std::shared_ptr<mv::RuntimeBoundObject>& object,const std::string& method) {
  if(!owner.characterPresentation || !owner.characterPresentation->enabled || std::string_view(object->bindingType())!="Sprite_Character")return {};
  const auto view=characterPresentationView(owner,object);
  const auto* definition=cachedPresentationDefinition(owner,presentationProperty(owner.env,view,method),method,owner.characterPresentation->boundMethods[method]);
  if(!definition)return {};
  return definition->bindingType.empty();
}
napi_value attachCharacterView(napi_env env,napi_callback_info info) try {
  const auto args=arguments(env,info);if(args.size()!=3)throw std::invalid_argument("character view requires session, model and object");
  auto& owner=session(env,args[0]);requireRuntimeOwner(owner,args[1]);
  const auto object=runtimeAs<mv::RuntimeBoundObject>(env,args[1]);
  if(std::string_view(object->bindingType())!="Sprite_Character")throw std::invalid_argument("character view requires a character sprite");
  if(!owner.characterPresentation)owner.characterPresentation=std::make_shared<NativePresentationProgram>();
  if(const auto found=owner.characterPresentation->views.find(object->identity);found!=owner.characterPresentation->views.end())
    owner.characterPresentation->receiverModels.erase(found->second.receiver.reader.get());
  owner.characterPresentation->views[object->identity]={object,std::make_shared<PresentationReference>(env,args[2]),{}};return undefined(env);
} catch(const std::exception& error) {return throwException(env,error);}
napi_value attachPresentationCharacter(napi_env env,napi_callback_info info) try {
  const auto args=arguments(env,info);if(args.size()!=3)throw std::invalid_argument("character attachment requires session, character and view");
  auto& owner=session(env,args[0]);requireRuntimeOwner(owner,args[1]);const auto character=runtimeAs<mv::RuntimeCharacter>(env,args[1]);
  if(!owner.characterPresentation)owner.characterPresentation=std::make_shared<NativePresentationProgram>();
  owner.characterPresentation->entities[character->identity]={character,std::make_shared<PresentationReference>(env,args[2]),{}};
  if(owner.characterPresentation->enabled)tagPresentationEntity(owner,args[2],character->identity);
  return undefined(env);
} catch(const std::exception& error) {return throwException(env,error);}
napi_value registerCharacterPresentation(napi_env env,napi_callback_info info) try {
  const auto args=arguments(env,info);if(args.size()!=5)throw std::invalid_argument("character presentation requires session, environment, display key, defaults and definitions");
  auto& owner=session(env,args[0]);
  if(!owner.characterPresentation)owner.characterPresentation=std::make_shared<NativePresentationProgram>();
  auto& program=*owner.characterPresentation;if(program.enabled)throw std::runtime_error("character presentation is already registered");
  program.environment=std::make_shared<PresentationReference>(env,args[1]);
  auto holder=moduleObject(env);check(env,napi_set_named_property(env,holder,"key",args[2]),"cannot retain presentation display key");
  napi_value entityKey;check(env,napi_create_symbol(env,string(env,"native presentation character"),&entityKey),"cannot create presentation character key");
  check(env,napi_set_named_property(env,holder,"entityKey",entityKey),"cannot retain presentation character key");
  program.displayKey=std::make_shared<PresentationReference>(env,holder,1);
  program.environmentData=presentationValue(owner,args[1],false);
  const auto reference=[env](napi_value object,const char* name) -> std::shared_ptr<PresentationReference> {
    const auto value=presentationProperty(env,object,name);napi_valuetype type;check(env,napi_typeof(env,value,&type),"cannot inspect presentation reference");
    return type==napi_undefined ? nullptr : std::make_shared<PresentationReference>(env,value);
  };
  for(int index=3;index<5;++index) {
    std::uint32_t length;check(env,napi_get_array_length(env,args[index],&length),"cannot read presentation definitions");
    for(std::uint32_t i=0;i<length;++i) {
      napi_value value;check(env,napi_get_element(env,args[index],i,&value),"cannot read presentation definition");
      NativePresentationDefinition definition;definition.method=asString(env,presentationProperty(env,value,"method"));
      definition.function=reference(value,"function");if(!definition.function)throw std::invalid_argument("presentation definition requires a function");
      if(index==3) {
        definition.bindingType=asString(env,presentationProperty(env,value,"bindingType"));
        if(const auto* binding=findBindingClass(definition.bindingType))
          for(const auto& method:binding->methods)if(method.name==definition.method) {definition.binding=&method;break;}
      }
      else {
        definition.operation=asString(env,presentationProperty(env,value,"operation"));
        definition.query=mv::omori::findCharacterPresentationQuery(definition.operation);
        if(!mv::omori::hasCharacterPresentationOperation(definition.operation))throw std::invalid_argument("unknown character presentation operation: "+definition.operation);
        definition.native=reference(value,"native");
        const auto base=presentationProperty(env,value,"base");napi_valuetype type;check(env,napi_typeof(env,base,&type),"cannot inspect presentation parent");
        if(type==napi_object) {
          definition.baseFunction=reference(base,"function");definition.baseOwner=reference(base,"owner");
          if(definition.baseOwner)definition.baseProperty=asString(env,presentationProperty(env,base,"property"));
        }
      }
      program.definitions.push_back(std::make_unique<NativePresentationDefinition>(std::move(definition)));
      const auto* installed=program.definitions.back().get();program.methods[installed->method].push_back(installed);
    }
  }
  // The JavaScript session owns the callable graph; native entries stay weak.
  const auto graph=moduleObject(env);
  check(env,napi_set_named_property(env,graph,"environment",args[1]),"cannot retain presentation environment");
  check(env,napi_set_named_property(env,graph,"defaults",args[3]),"cannot retain presentation defaults");
  check(env,napi_set_named_property(env,graph,"definitions",args[4]),"cannot retain presentation definitions");
  check(env,napi_set_named_property(env,args[0],"__mvCharacterPresentation",graph),"cannot attach character presentation");
  for(const auto& [identity,view]:program.entities)if(const auto object=view.object->get())tagPresentationEntity(owner,object,identity);
  program.enabled=true;return undefined(env);
} catch(const std::exception& error) {return throwException(env,error);}
napi_value characterPresentationInvoke(napi_env env,napi_callback_info info) try {
  const auto args=arguments(env,info);if(args.size()!=5)throw std::invalid_argument("presentation invocation requires session, receiver, function, method and arguments");
  auto& owner=session(env,args[0]);RuntimeCallScope callScope(owner);
  if(!owner.characterPresentation || !owner.characterPresentation->enabled)throw std::runtime_error("character presentation is not installed");
  const auto* definition=presentationDefinition(owner,args[2],asString(env,args[3]));if(!definition)throw std::invalid_argument("presentation function is not registered");
  const auto parameters=readValue(env,args[4]);
  return writeValue(env,invokePresentationDefinition(owner,presentationValue(owner,args[1]),*definition,parameters.array()));
} catch(const std::exception& error) {return throwException(env,error);}
napi_value diagnosticBridgeTrace(napi_env env,napi_callback_info info) try {
  const auto args=arguments(env,info);const auto command=asString(env,args.at(0));
  if(command=="start") {bridge_trace::reset(env);bridge_trace::active=true;return undefined(env);}
  bridge_trace::active=false;
  mv::Value::Array rows;
  for(const auto& [key,row]:bridge_trace::records) {
    (void)key;rows.emplace_back(mv::Value::Object{{"parent",row.parent},{"name",row.name},{"calls",double(row.calls)},
      {"inclusiveMs",row.inclusive},{"exclusiveMs",row.exclusive}});
  }
  auto result=writeValue(env,mv::Value::Object{{"records",std::move(rows)}});
  napi_value functions;napi_create_array(env,&functions);
  for(std::size_t i=0;i<bridge_trace::functions.size();++i) {
    napi_value value;napi_get_reference_value(env,bridge_trace::functions[i],&value);napi_set_element(env,functions,i,value);
  }
  napi_set_named_property(env,result,"functions",functions);return result;
} catch(const std::exception& error) {return throwException(env,error);}
napi_value characterPresentationStats(napi_env env,napi_callback_info info) try {
  const auto args=arguments(env,info);if(args.size()!=1)throw std::invalid_argument("presentation statistics require a session");
  auto& owner=session(env,args[0]);if(!owner.characterPresentation)return writeValue(env,mv::Value::Object{{"installed",false}});
  const auto& program=*owner.characterPresentation;
  return writeValue(env,mv::Value::Object{{"installed",program.enabled},{"nativeCalls",static_cast<double>(program.nativeCalls)},
    {"nativeFrames",static_cast<double>(program.nativeFrames)},{"scriptCalls",static_cast<double>(program.scriptCalls)}});
} catch(const std::exception& error) {return throwException(env,error);}
napi_value describeClassBindings(napi_env env, napi_callback_info) try {
  mv::Value::Array classes;
  for (const auto& binding : bindingClasses()) {
    mv::Value::Array fields, methods, events, statics;
    for (const auto& field : binding.fields) fields.emplace_back(mv::Value::Object{{"name", field.name}, {"writable", bool(field.set)}, {"kind", field.kind}});
    for (const auto& field : binding.displays) fields.emplace_back(mv::Value::Object{{"name", field.name}, {"writable", bool(field.set)}, {"kind", "display"}});
    for (const auto& field : binding.displayLists) fields.emplace_back(mv::Value::Object{{"name",field.name},{"writable",true},{"kind","displayList"}});
    for (const auto& field : binding.references) fields.emplace_back(mv::Value::Object{{"name", field.name}, {"writable", bool(field.set)}, {"kind", "object"}});
    for (const auto& method : binding.methods) {
      mv::Value::Array kinds, aliases;
      for (const auto& kind : method.argumentKinds) kinds.emplace_back(kind);
      for (const auto& [property, index] : method.aliases) aliases.emplace_back(mv::Value::Object{{"property", property}, {"index", static_cast<int>(index)}});
      methods.emplace_back(mv::Value::Object{{"name", method.name}, {"arity", static_cast<int>(method.arity)}, {"argumentKinds", kinds}, {"aliases", aliases}, {"returnsValue", method.returnsValue}, {"defaults",method.defaults}, {"inherited",method.inherited}});
    }
    for (const auto& event:binding.events) events.emplace_back(event.name);
    for (const auto& method:binding.statics) statics.emplace_back(mv::Value::Object{{"name",method.name},{"defaults",method.defaults}});
    classes.emplace_back(mv::Value::Object{{"name", binding.name}, {"parent", binding.parent}, {"nativeType", binding.nativeType}, {"fields", fields}, {"methods", methods}, {"initializer", binding.initializer}, {"constructorDefaults", binding.constructorDefaults}, {"events",events}, {"statics",statics}});
  }
  return writeValue(env, classes);
} catch (const std::exception& error) { return throwException(env,error); }
napi_value createBoundObject(napi_env env, napi_callback_info info) try {
  const auto args = arguments(env,info);
  if (args.size() != 2) throw std::invalid_argument("class creation requires session and type");
  auto& owner = session(env,args[0]); const auto name = asString(env,args[1]);
  const auto* binding = findBindingClass(name);
  if (!binding) throw std::invalid_argument("native class is not bound: " + name);
  std::shared_ptr<mv::RuntimeBoundObject> object;
  if (name == "Sprite_Balloon") object = owner.session->createBalloon();
  else if (binding->generated) object = owner.session->createGeneratedBinding(name);
  else object = binding->create();
  return runtimeHandle(owner, object);
} catch (const std::exception& error) { return throwException(env,error); }
napi_value boundField(napi_env env, napi_callback_info info) try {
  const auto args = arguments(env,info);
  if (args.size() < 2 || args.size() > 3) throw std::invalid_argument("class field requires model, name and optional value");
  const auto object = runtimeAs<mv::RuntimeBoundObject>(env,args[0]); const auto name = asString(env,args[1]);
  for (auto* binding = findBindingClass(object->bindingType()); binding; binding = findBindingClass(binding->parent)) {
    for (const auto& field : binding->fields) if (field.name == name) {
      if (args.size() == 3) {
        if (!field.set) throw std::invalid_argument("native field is read-only: " + name);
        field.set(*object,readValue(env,args[2]));
      }
      return writeValue(env,field.get(*object));
    }
  }
  throw std::invalid_argument("native field is not bound: " + name);
} catch (const std::exception& error) { return throwException(env,error); }
napi_value invokeBoundMethod(napi_env env, napi_callback_info info) try {
  const auto args = arguments(env,info);
  if (args.size() < 3 || args.size() > 4) throw std::invalid_argument("class invocation requires model, method and arguments");
  const auto object = runtimeAs<mv::RuntimeBoundObject>(env,args[0]); const auto name = asString(env,args[1]);
  const auto& payload = runtimePayload(env,args[0]);
  bool array = false; check(env,napi_is_array(env,args[2],&array),"cannot inspect native arguments");
  if (!array) throw std::invalid_argument("native method arguments must be an array");
  const auto* selected=findBindingClass(object->bindingType());
  if (args.size()==4) {
    const auto declaring=asString(env,args[3]);
    while (selected && selected->name!=declaring) selected=findBindingClass(selected->parent);
    if (!selected) throw std::invalid_argument("declaring class is not an ancestor of the native object");
  }
  for (auto* binding = selected; binding; binding = findBindingClass(binding->parent))
    for (const auto& method : binding->methods) if (method.name == name) {
      std::uint32_t length = 0; check(env,napi_get_array_length(env,args[2],&length),"cannot read native arguments");
      if (length != method.arity) throw std::invalid_argument("native method argument count differs");
      mv::BindingArguments values;
      for (std::uint32_t index = 0; index < length; ++index) {
        napi_value value; check(env,napi_get_element(env,args[2],index,&value),"cannot read native argument");
        if (method.argumentKinds[index] == "object") {
          napi_valuetype type; check(env,napi_typeof(env,value,&type),"cannot inspect native object argument");
          if (type == napi_null) values.emplace_back(std::shared_ptr<mv::RuntimeObject>{});
          else {
            const auto& argument = runtimePayload(env,value);
            if (argument.owner != payload.owner) throw std::invalid_argument("native object argument belongs to another session");
            values.emplace_back(argument.object);
          }
        } else values.emplace_back(readValue(env,value));
      }
      return writeValue(env,method.invoke(*object,values));
    }
  throw std::invalid_argument("native method is not bound: " + name);
} catch (const std::exception& error) { return throwException(env,error); }
napi_value boundObjectActive(napi_env env, napi_callback_info info) try {
  const auto args = arguments(env,info);
  if (args.size() != 1) throw std::invalid_argument("class activity requires model");
  return boolean(env,runtimeAs<mv::RuntimeBoundObject>(env,args[0])->active);
} catch (const std::exception& error) { return throwException(env,error); }
napi_value listenBoundObject(napi_env env,napi_callback_info info) try {
  const auto args=arguments(env,info);
  if (args.size()!=3) throw std::invalid_argument("listener requires object, method and token");
  const auto object=runtimeAs<mv::GeneratedRuntimeObject>(env,args[0]);
  const auto name=asString(env,args[1]);
  std::uint32_t token; check(env,napi_get_value_uint32(env,args[2],&token),"invalid listener token");
  for (const auto& event:findBindingClass(object->bindingType())->events) if (event.name==name) {
    object->listen(event,token); return undefined(env);
  }
  throw std::invalid_argument("native listener is not bound: "+name);
} catch (const std::exception& error) { return throwException(env,error); }
napi_value invokeBoundStatic(napi_env env,napi_callback_info info) try {
  const auto args=arguments(env,info);
  if (args.size()!=3) throw std::invalid_argument("static invocation requires class, method and arguments");
  const auto* binding=findBindingClass(asString(env,args[0]));
  if (!binding) throw std::invalid_argument("native class is not bound");
  const auto name=asString(env,args[1]); const auto values=readValue(env,args[2]);
  for (const auto& method:binding->statics) if (method.name==name) {
    if (!std::holds_alternative<mv::Value::Array>(values.data) || values.arrayLength()!=method.defaults.size()) throw std::invalid_argument("static argument count differs");
    return writeValue(env,method.invoke(values.array()));
  }
  throw std::invalid_argument("native static method is not bound: "+name);
} catch (const std::exception& error) { return throwException(env,error); }
napi_value boundDisplay(napi_env env, napi_callback_info info) try {
  const auto args = arguments(env, info);
  if (args.size() != 2) throw std::invalid_argument("bound display requires object and display services");
  const auto object = runtimeAs<mv::RuntimeBoundObject>(env, args[0]);
  auto node = object->displayObject();
  return node ? wrapRuntimeDisplay(env, args[1], node, state->core) : null(env);
} catch (const std::exception& error) { return throwException(env,error); }
napi_value boundDisplayField(napi_env env, napi_callback_info info) try {
  const auto args = arguments(env, info);
  if (args.size() < 3 || args.size() > 4) throw std::invalid_argument("display field requires model, name, services and optional value");
  const auto object = runtimeAs<mv::RuntimeBoundObject>(env, args[0]);
  const auto name = asString(env, args[1]);
  for (auto* binding = findBindingClass(object->bindingType()); binding; binding = findBindingClass(binding->parent))
    for (const auto& field : binding->displays) if (field.name == name) {
      if (args.size() == 4) {
        if (!field.set) throw std::invalid_argument("native display field is read-only: " + name);
        napi_valuetype type; check(env, napi_typeof(env, args[3], &type), "cannot inspect display field");
        field.set(*object, type == napi_null ? nullptr : displayForRuntime(env, args[3], state->core));
      }
      return wrapRuntimeDisplay(env, args[2], field.get(*object), state->core);
    }
  for(auto* binding=findBindingClass(object->bindingType());binding;binding=findBindingClass(binding->parent))
    for(const auto& field:binding->displayLists)if(field.name==name) {
      if(args.size()==4) {
        bool array=false;check(env,napi_is_array(env,args[3],&array),"cannot inspect display list");
        if(!array)throw std::invalid_argument("display list must be an array");
        std::uint32_t length;check(env,napi_get_array_length(env,args[3],&length),"cannot read display list");
        std::vector<std::shared_ptr<mv::core::Container>> values(length);
        for(std::uint32_t i=0;i<length;++i) {
          bool present=false;check(env,napi_has_element(env,args[3],i,&present),"cannot inspect display list member");
          if(!present)continue;
          napi_value value;check(env,napi_get_element(env,args[3],i,&value),"cannot read display list member");
          values[i]=displayForRuntime(env,value,state->core);
        }
        field.items(*object)=std::move(values);
      }
      const auto& values=field.items(*object);napi_value result;
      check(env,napi_create_array_with_length(env,values.size(),&result),"cannot create display list");
      for(std::uint32_t i=0;i<values.size();++i)if(values[i])
        check(env,napi_set_element(env,result,i,wrapRuntimeDisplay(env,args[2],values[i],state->core)),"cannot return display list member");
      return result;
    }
  throw std::invalid_argument("native display field is not bound: " + name);
} catch (const std::exception& error) { return throwException(env,error); }
napi_value boundReferenceField(napi_env env,napi_callback_info info) try {
  const auto args=arguments(env,info); if (args.size()<3 || args.size()>4) throw std::invalid_argument("reference requires session, object, field and optional value");
  auto& owner=session(env,args[0]); requireRuntimeOwner(owner,args[1]);
  const auto object=runtimeAs<mv::RuntimeBoundObject>(env,args[1]); const auto name=asString(env,args[2]);
  for (auto* binding=findBindingClass(object->bindingType());binding;binding=findBindingClass(binding->parent))
    for (const auto& field:binding->references) if (field.name==name) {
      if (args.size()==4) {
        napi_valuetype type; check(env,napi_typeof(env,args[3],&type),"cannot inspect reference");
        if (type==napi_null) field.set(*object,{});
        else { requireRuntimeOwner(owner,args[3]); field.set(*object,runtimePayload(env,args[3]).object); }
      }
      const auto value=field.get(*object); return value ? runtimeHandle(owner,value) : null(env);
    }
  throw std::invalid_argument("reference field is not bound: "+name);
} catch (const std::exception& error) { return throwException(env,error); }
napi_value actorInvoke(napi_env env, napi_callback_info info) try {
  const auto args = arguments(env, info);
  if (args.size() < 3 || args.size() > 4) throw std::invalid_argument("actorInvoke requires session, actor, method and optional arguments");
  auto& owner = session(env, args[0]); requireRuntimeOwner(owner, args[1]); RuntimeCallScope callScope(owner);
  const auto object = runtimeAs<mv::RuntimeActor>(env, args[1]);
  const auto method = asString(env, args[2]);
  if (method == "initSkills") owner.session->initializeActorSkills(object);
  else if (method == "initMembers") owner.session->initializeActorMembers(object);
  else return writeValue(env, owner.session->runtimeBattlerCommand(object, method, args.size() == 4 ? readValue(env, args[3]).array() : mv::Value::Array{}));
  return undefined(env);
} catch (const std::exception& error) { return throwException(env, error); }
napi_value battlerArray(napi_env env, napi_callback_info info) try {
  const auto args = arguments(env, info);
  if (args.size() < 2 || args.size() > 3) throw std::invalid_argument("battlerArray requires actor, field and optional array");
  auto& battler = runtimeAs<mv::RuntimeActor>(env, args[0])->value();
  const auto field = asString(env, args[1]);
  auto access = [&](auto& data, bool fixed) -> napi_value {
    if (args.size() == 3) {
      const auto value = readValue(env, args[2]);
      if (!std::holds_alternative<mv::Value::Array>(value.data)) throw std::invalid_argument("battler collection requires an array");
      if (fixed && value.arrayLength() != data.size()) throw std::invalid_argument("battler parameter array must contain eight entries");
      std::vector<int> replacement;
      for (const auto& item : value.array()) replacement.push_back(item.integer());
      if constexpr (requires { data.resize(replacement.size()); }) data.resize(replacement.size());
      std::copy(replacement.begin(), replacement.end(), data.begin());
    }
    mv::Value::Array result;
    for (int value : data) result.emplace_back(value);
    return writeValue(env, result);
  };
  if (field == "states") return access(battler.states, false);
  if (field == "buffs") return access(battler.buffs, true);
  if (field == "buffTurns") return access(battler.buffTurns, true);
  if (field == "paramPlus") return access(battler.paramPlus, true);
  if (field == "equips") return access(battler.equips, false);
  if (field == "equipKinds") return access(battler.equipKinds, false);
  if (field == "result.addedStates") return access(battler.result.addedStates, false);
  if (field == "result.removedStates") return access(battler.result.removedStates, false);
  if (field == "result.addedBuffs") return access(battler.result.addedBuffs, false);
  if (field == "result.addedDebuffs") return access(battler.result.addedDebuffs, false);
  if (field == "result.removedBuffs") return access(battler.result.removedBuffs, false);
  if (field == "skills") {
    std::vector<int> skills(battler.skills.begin(), battler.skills.end());
    const auto result = access(skills, false);
    if (args.size() == 3) battler.skills = std::set<int>(skills.begin(), skills.end());
    return result;
  }
  throw std::invalid_argument("battler array is not bound: " + field);
} catch (const std::exception& error) { return throwException(env, error); }
napi_value characterReflectionState(napi_env env, napi_callback_info info) try {
  const auto args=arguments(env,info);
  if(args.size()!=2)throw std::invalid_argument("reflection state requires session and character");
  auto& owner=session(env,args[0]);requireRuntimeOwner(owner,args[1]);
  const auto object=runtimeAs<mv::RuntimeCharacter>(env,args[1]);
  auto retained=std::make_unique<std::shared_ptr<mv::RuntimeCharacter>>(object);
  napi_value buffer,view;
  check(env,napi_create_external_arraybuffer(env,&object->reflectionsRevision,sizeof(double),
    [](napi_env,void*,void* data){delete static_cast<std::shared_ptr<mv::RuntimeCharacter>*>(data);},retained.get(),&buffer),"cannot expose reflection revision");
  retained.release();
  check(env,napi_create_typedarray(env,napi_float64_array,1,buffer,0,&view),"cannot view reflection revision");
  return view;
} catch(const std::exception& error) {return throwException(env,error);}
napi_value characterReflections(napi_env env, napi_callback_info info) try {
  const auto args=arguments(env,info);
  if(args.size()!=3)throw std::invalid_argument("character reflections require session, character and array constructor");
  auto& owner=session(env,args[0]);requireRuntimeOwner(owner,args[1]);RuntimeCallScope callScope(owner);
  const auto object=runtimeAs<mv::RuntimeCharacter>(env,args[1]);
  if(object->reflections.reader)return writeValue(env,object->reflections);
  const auto& items=object->reflections.array();
  napi_value array,length=number(env,items.size());
  check(env,napi_new_instance(env,args[2],1,&length,&array),"cannot create character reflections");
  for(std::size_t i=0;i<items.size();++i) {
    const auto key=std::to_string(i);
    const napi_property_descriptor field{key.c_str(),nullptr,nullptr,nullptr,nullptr,writeValue(env,items[i]),
      static_cast<napi_property_attributes>(napi_writable|napi_enumerable|napi_configurable),nullptr};
    check(env,napi_define_properties(env,array,1,&field),"cannot write character reflection");
  }
  if(!owner.database)owner.database=std::make_shared<DatabaseGraph>(env,owner,args[0]);
  mv::Value value(mv::Value::Array{});
  value.reader=std::make_shared<DatabaseReader>(owner.database,array,false);
  object->reflections=std::move(value);++object->reflectionsRevision;
  return array;
} catch(const std::exception& error) {return throwException(env,error);}
napi_value characterCommand(napi_env env, napi_callback_info info) try {
  const auto args = arguments(env, info);
  if (args.size() != 4) throw std::invalid_argument("characterCommand requires session, character, method and arguments");
  auto& owner = session(env, args[0]); requireRuntimeOwner(owner, args[1]); RuntimeCallScope callScope(owner);
  const auto object = runtimeAs<mv::RuntimeCharacter>(env, args[1]);
  const auto method = asString(env, args[2]);
  std::uint32_t count;check(env,napi_get_array_length(env,args[3],&count),"cannot read character arguments");
  auto parameters=method=="reflections"&&count==1 ? mv::Value(mv::Value::Array(1)) : readValue(env,args[3]);
  if(method=="reflections" && count==1) {
    if(!owner.database)owner.database=std::make_shared<DatabaseGraph>(env,owner,args[0]);
    napi_value array;check(env,napi_get_element(env,args[3],0,&array),"cannot read character reflections");
    auto& value=std::get<mv::Value::Array>(parameters.data)[0];value=mv::Value(mv::Value::Array{});
    value.reader=std::make_shared<DatabaseReader>(owner.database,array,false);
  }
  if (method == "cameraTarget") owner.session->setCameraTarget(object, parameters[0].number());
  else return writeValue(env, owner.session->runtimeCharacterCommand(object, method, parameters.array()));
  return undefined(env);
} catch (const std::exception& error) { return throwException(env, error); }
napi_value gameDataInvoke(napi_env env, napi_callback_info info) try {
  const auto args = arguments(env, info);
  if (args.size() != 4) throw std::invalid_argument("gameDataInvoke requires session, store, method and arguments");
  auto& owner = session(env, args[0]); SceneTransitionScope transition(owner);
  RuntimeCallScope callScope(owner);
  const auto kind = asString(env, args[1]), method = asString(env, args[2]);
  const auto variableValue = [&](napi_value value) {
    napi_valuetype type; check(env, napi_typeof(env, value, &type), "cannot inspect variable value");
    if (type != napi_object) return readValue(env, value);
    if (!owner.database) owner.database = std::make_shared<DatabaseGraph>(env, owner, args[0]);
    auto reader = std::make_shared<DatabaseReader>(owner.database, value, false);
    mv::Value result;
    result.data = reader->isArray ? mv::Value(mv::Value::Array{}).data : mv::Value(mv::Value::Object{}).data;
    result.reader = std::move(reader); return result;
  };
  std::uint32_t length; check(env, napi_get_array_length(env, args[3], &length), "game data arguments must be an array");
  mv::Value::Array parameters; parameters.reserve(length);
  for (std::uint32_t index = 0; index < length; ++index) {
    napi_value value; check(env, napi_get_element(env, args[3], index, &value), "cannot read game data argument");
    if ((kind == "variables" || kind == "selfSwitches") && index == 1 && (method == "setValue" || method == "rawSet")) parameters.push_back(variableValue(value));
    else if (method == "replaceData" && ((kind == "variables" && index == 1) || (kind == "selfSwitches" && index == 0))) {
      napi_value keys; check(env, napi_get_property_names(env, value, &keys), "cannot read variable entries");
      std::uint32_t count; check(env, napi_get_array_length(env, keys, &count), "cannot read variable entry count");
      mv::Value::Object entries;
      for (std::uint32_t entry = 0; entry < count; ++entry) {
        napi_value key, item;
        check(env, napi_get_element(env, keys, entry, &key), "cannot read variable key");
        check(env, napi_get_property(env, value, key, &item), "cannot read variable entry");
        entries.emplace(asString(env, key), variableValue(item));
      }
      parameters.emplace_back(std::move(entries));
    } else parameters.push_back(readValue(env, value));
  }
  auto value = owner.session->invokeGameDataBase(kind, method, parameters);
  auto result = writeValue(env, value);
  if ((kind == "variables" || kind == "selfSwitches") && (method == "value" || method == "rawValue") && !value.reader &&
      (std::holds_alternative<mv::Value::Array>(value.data) || std::holds_alternative<mv::Value::Object>(value.data))) {
    mv::Value::Array replacement;
    replacement.push_back(parameters.at(0).reference()); replacement.push_back(variableValue(result));
    owner.session->invokeGameDataBase(kind, "rawSet", replacement);
  }
  return result;
} catch (const std::exception& error) { return throwException(env, error); }
napi_value managerInvoke(napi_env env, napi_callback_info info) {
  try {
    const auto args = arguments(env, info);
    if (args.size() < 2 || args.size() > 4) throw std::invalid_argument("manager operation requires session, method and optional arguments");
    auto& value = *session(env, args[0]).session; const auto method = asString(env, args[1]);
    const auto sound = args.size() > 2 ? readValue(env, args[2]) : mv::Value{};
    const double position = args.size() > 3 ? asNumber(env, args[3]) : 0;
    if (method == "isCurrentBgm") return boolean(env,mv::AudioManager::isCurrentBgm(value,sound));
    else if (method == "isCurrentBgs") return boolean(env,mv::AudioManager::isCurrentBgs(value,sound));
    else if (method == "shouldUseHtml5Audio") return boolean(env,mv::AudioManager::shouldUseHtml5Audio());
    else if (method == "fadeInBgm") mv::AudioManager::fadeInBgm(value,sound.number());
    else if (method == "fadeInBgs") mv::AudioManager::fadeInBgs(value,sound.number());
    else if (method == "replayBgm") mv::AudioManager::replayBgm(value,sound);
    else if (method == "replayBgs") mv::AudioManager::replayBgs(value,sound);
    else if (method == "playStaticSe") mv::AudioManager::playStaticSe(value,sound);
    else if (method == "playBgm") mv::AudioManager::playBgm(value, sound, position);
    else if (method == "playBgs") mv::AudioManager::playBgs(value, sound, position);
    else if (method == "playSe") mv::AudioManager::playSe(value, sound);
    else if (method == "playMe") mv::AudioManager::playMe(value, sound);
    else if (method == "stopBgm") mv::AudioManager::stopBgm(value);
    else if (method == "stopBgs") mv::AudioManager::stopBgs(value);
    else if (method == "stopMe") mv::AudioManager::stopMe(value);
    else if (method == "stopSe") mv::AudioManager::stopSe(value);
    else if (method == "fadeOutBgm") mv::AudioManager::fadeOutBgm(value, sound.number());
    else if (method == "fadeOutBgs") mv::AudioManager::fadeOutBgs(value, sound.number());
    else if (method == "fadeOutMe") mv::AudioManager::fadeOutMe(value, sound.number());
    else if (method == "preloadImportantSounds") mv::SoundManager::preloadImportantSounds(value);
    else if (method == "playSystemSound") mv::SoundManager::playSystemSound(value, sound.integer());
    else if (method == "loadSystemSound") mv::SoundManager::loadSystemSound(value, sound.integer());
    else if (method == "playBuzzer") mv::SoundManager::playBuzzer(value);
    else if (method == "playOk") mv::SoundManager::playOk(value);
    else if (method == "playCancel") mv::SoundManager::playCancel(value);
    else if (method == "playLoad") mv::SoundManager::playLoad(value);
    else if (method == "playCursor") mv::SoundManager::playCursor(value);
    else if (method == "isBattleTest") return boolean(env, mv::DataManager::isBattleTest(value));
    else if (method == "isEventTest") return boolean(env, mv::DataManager::isEventTest(value));
    else if (method == "isAnySavefileExists") return boolean(env, mv::DataManager::isAnySavefileExists(value));
    else if (method == "initTitleCommandPosition") value.initTitleCommandPosition();
    else if (method == "menuCommands" || method == "optionCommands") {
      mv::Value::Array commands;
      for (const auto& command : (method == "menuCommands" ? mv::Window_MenuCommand::makeCommands(value) : mv::Window_Options::makeCommands(value)))
        commands.emplace_back(mv::Value::Object{{"name", command.name}, {"symbol", command.symbol}, {"enabled", command.enabled}});
      return writeValue(env, commands);
    }
    else if (method == "titleCommands") {
      mv::Value::Array commands;
      for (const auto& command : mv::Window_TitleCommand::makeCommands(value))
        commands.emplace_back(mv::Value::Object{{"name", command.name}, {"symbol", command.symbol}, {"enabled", command.enabled}});
      return writeValue(env, commands);
    }
    else throw std::invalid_argument("manager method is not bound: " + method);
    return undefined(env);
  } catch (const std::exception& error) { return throwException(env, error); }
}
napi_value displayAnimation(napi_env env, napi_callback_info info) {
  try {
    const auto args = arguments(env, info);
    if (args.size() < 5 || args.size() > 6) throw std::invalid_argument("displayAnimation requires session, sprite, animation ID, mirror, delay and optional rate");
    auto& value = session(env, args[0]); const int id = asInt32(env, args[2]);
    const auto& animation = value.session->database()["animations"][id];
    if (animation.null()) throw std::invalid_argument("animation does not exist");
    if (!value.owner) throw std::runtime_error("animation graphics services are not attached");
    const int rate = args.size() == 6 ? asInt32(env, args[5]) : 4;
    if (rate <= 0) throw std::invalid_argument("animation rate must be positive");
    startDisplayAnimation(env, args[1], value.owner->core, animation, asBoolean(env, args[3]), asInt32(env, args[4]), rate);
    return undefined(env);
  } catch (const std::exception& error) { return throwException(env, error); }
}
napi_value startBattle(napi_env env, napi_callback_info info) {
  try { const auto args = arguments(env, info); if (args.size() != 4) throw std::invalid_argument("startBattle requires session, troop, canEscape, canLose"); auto& owner = session(env, args[0]); if (owner.runtimeCalls) throw std::runtime_error("cannot replace battle state during a script callback"); SceneTransitionScope transition(owner); owner.session->startBattle(asInt32(env, args[1]), asBoolean(env, args[2]), asBoolean(env, args[3])); return undefined(env); }
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
  try { const auto args = arguments(env, info); if (args.size() < 1 || args.size() > 2) throw std::invalid_argument("save requires session and optional counter flag"); auto& value = session(env, args[0]); if (value.presentation) value.presentation->captureAudioState(); return writeValue(env, value.session->save(args.size() < 2 || asBoolean(env, args[1]))); }
  catch (const std::exception& error) { return throwException(env, error); }
}
napi_value load(napi_env env, napi_callback_info info) {
  try { const auto args = arguments(env, info); if (args.size() != 2) throw std::invalid_argument("load requires session and contents"); auto& owner = session(env, args[0]); if (owner.runtimeCalls) throw std::runtime_error("cannot load a session during a script callback"); SceneTransitionScope transition(owner); owner.session->load(readValue(env, args[1])); return undefined(env); }
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
  try { const auto args = arguments(env, info); if (args.size() != 2) throw std::invalid_argument("completeStorage requires session and success"); auto& owner = session(env, args[0]); SceneTransitionScope transition(owner); owner.session->completeStorage(asBoolean(env, args[1])); return undefined(env); }
  catch (const std::exception& error) { return throwException(env, error); }
}
}
void registerMvEngineBindings(napi_env env, napi_value exports) {
  napi_value engine; check(env, napi_create_object(env, &engine), "cannot create engine API");
  method(env,engine,"diagnosticBridgeTrace",diagnosticBridgeTrace);
  method(env, engine, "connectRuntime", connectRuntime); method(env, engine, "scriptFrame", scriptFrame);
  method(env,engine,"audioManager",audioManager);
  method(env,engine,"windowClasses",windowClasses); method(env,engine,"windowModel",windowModel);
  method(env, engine, "picture", runtimePicture); method(env, engine, "createPicture", createRuntimePicture);
  method(env, engine, "pictureField", pictureField); method(env, engine, "pictureInvoke", pictureInvoke);
  method(env, engine, "pictureTone", pictureTone); method(env, engine, "toneComponent", toneComponent);
  method(env, engine, "interpreterField", interpreterField); method(env, engine, "interpreterWaitInvoke", interpreterWaitInvoke);
  method(env, engine, "interpreterPluginCommand", interpreterPluginCommand);
  method(env, engine, "interpreterCommandInvoke", interpreterCommandInvoke);
  method(env, engine, "interpreterCollection", interpreterCollection);
  method(env, engine, "createAction", createAction); method(env, engine, "actionField", actionField); method(env, engine, "actionSubject", actionSubject);
  method(env, engine, "currentAction", currentAction); method(env, engine, "battlerActions", battlerActions);
  method(env, engine, "createCommonEvent", createCommonEvent); method(env, engine, "commonEvents", commonEvents);
  method(env, engine, "commonEventId", commonEventId); method(env, engine, "commonEventInterpreter", commonEventInterpreter);
  method(env, engine, "createInterpreter", createInterpreter); method(env, engine, "createCommandList", createCommandList); method(env, engine, "interpreterChild", interpreterChild);
  method(env, engine, "interpreterSetList", interpreterSetList); method(env, engine, "interpreterLifecycle", interpreterLifecycle);
  method(env, engine, "mapId", mapId);
  method(env, engine, "inBattle", inBattle); method(env, engine, "ownsPictureSprite", ownsPictureSprite);
  method(env, engine, "messageInvoke", messageInvoke); method(env, engine, "messageField", messageField);
  method(env, engine, "coreService", coreService);
  method(env, engine, "imageRequests", imageRequests); method(env, engine, "commonEventList", commonEventList);
  method(env, engine, "messageChoices", messageChoices); method(env, engine, "messageTexts", messageTexts); method(env, engine, "interpreterControl", interpreterControl); method(env, engine, "interpreterOperand", interpreterOperand);
  method(env, engine, "random", scriptRandom);
  method(env, engine, "collectionInfo", collectionInfo); method(env, engine, "collectionField", collectionField); method(env, engine, "collectionDelete", collectionDelete);
  method(env, engine, "interpreterMode", interpreterMode); method(env, engine, "interpreterWaitBase", interpreterWaitBase);
  method(env, engine, "pictureFrame", pictureFrame);
  method(env, engine, "pictureBitmap", pictureBitmap);
  method(env, engine, "create", createEngine); method(env, engine, "newGame", newGame); method(env, engine, "battleTest", battleTest);
  method(env, engine, "step", stepEngine); method(env, engine, "mapScene", mapScene); method(env, engine, "acknowledge", acknowledge);
  method(env, engine, "snapshot", snapshot); method(env, engine, "dispose", dispose);
  method(env, engine, "setScreenSize", setScreenSize);
  method(env, engine, "attach", attach); method(env, engine, "present", present); method(env, engine, "render", render); method(env, engine, "openTitle", openTitle);
  method(env,engine,"bindMapSpriteset",bindMapSpriteset);
  method(env, engine, "scriptStage", scriptStage); method(env, engine, "sceneControl", sceneControl);
  method(env, engine, "managerInvoke", managerInvoke);
  method(env, engine, "gameDataInvoke", gameDataInvoke);
  method(env, engine, "entity", entity); method(env, engine, "entityField", entityField);
  auto classBindings = moduleObject(env);
  method(env,classBindings,"describe",describeClassBindings); method(env,classBindings,"create",createBoundObject);
  method(env,classBindings,"field",boundField); method(env,classBindings,"invoke",invokeBoundMethod); method(env,classBindings,"active",boundObjectActive);
  method(env,classBindings,"display",boundDisplay);
  method(env,classBindings,"displayField",boundDisplayField); method(env,classBindings,"reference",boundReferenceField);
  method(env,classBindings,"listen",listenBoundObject); method(env,classBindings,"invokeStatic",invokeBoundStatic);
  method(env,classBindings,"attachCharacterView",attachCharacterView);
  check(env,napi_set_named_property(env,engine,"classBindings",classBindings),"cannot export class bindings");
  method(env, engine, "actionRate", actionRate); method(env, engine, "actorState", actorState); method(env, engine, "actorInvoke", actorInvoke); method(env, engine, "characterCommand", characterCommand);
  method(env, engine, "battlerArray", battlerArray);
  method(env, engine, "displayAnimation", displayAnimation);
  method(env, engine, "playerTransfer", playerTransfer);
  method(env, engine, "updateTouch", updateTouch);
  method(env, engine, "touchInvoke", touchInvoke);
  method(env, engine, "utilsInvoke", utilsInvoke);
  method(env, engine, "databaseInvoke", databaseInvoke);
  method(env, engine, "compileTiledMap", compileTiledMap);
  method(env, engine, "tiledInvoke", tiledInvoke);
  method(env, engine, "tiledApply", tiledApply);
  method(env, engine, "characterReflectionState", characterReflectionState);
  method(env, engine, "characterReflections", characterReflections);
  method(env, engine, "registerCharacterPresentation", registerCharacterPresentation);
  method(env, engine, "characterPresentationInvoke", characterPresentationInvoke);
  method(env, engine, "characterPresentationStats", characterPresentationStats);
  method(env, engine, "attachPresentationCharacter", attachPresentationCharacter);
  method(env, engine, "startBattle", startBattle); method(env, engine, "chooseAction", chooseAction); method(env, engine, "setRandomStream", randomStream);
  method(env, engine, "configure", configure); method(env, engine, "configuration", configuration);
  method(env, engine, "setSaveMetadata", setSaveMetadata);
  method(env, engine, "encodeGraph", encodeSaveGraph); method(env, engine, "decodeGraph", decodeSaveGraph);
  method(env, engine, "scriptInterpreter", scriptInterpreter); method(env, engine, "save", save); method(env, engine, "load", load); method(env, engine, "storageStatus", storageStatus); method(env, engine, "completeStorage", completeStorage);
  check(env, napi_set_named_property(env, exports, "mvEngine", engine), "cannot register engine API");
}
}
