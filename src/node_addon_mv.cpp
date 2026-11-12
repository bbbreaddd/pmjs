#include "node_addon_internal.hpp"
#include "mv_engine.hpp"
#include "mv_presentation.hpp"
#include "mv_core_input.hpp"
#include "mv_core_types.hpp"

namespace pmjs::addon {
namespace {
mv::Value readValue(napi_env env, napi_value value, int depth = 0) {
  if (depth > 128) throw std::invalid_argument("engine data nesting limit exceeded");
  napi_valuetype type;
  check(env, napi_typeof(env, value, &type), "cannot inspect engine data");
  switch (type) {
    case napi_null: case napi_undefined: return {};
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
  std::shared_ptr<State> owner;
  std::unique_ptr<mv::Session> session;
  std::unique_ptr<mv::Presentation> presentation;
  mv::core::Input input;
  mv::core::TouchInput touch;
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
napi_value createEngine(napi_env env, napi_callback_info info) {
  try {
    const auto args = arguments(env, info);
    if (args.size() != 1) throw std::invalid_argument("mvEngine.create requires database data");
    auto value = std::make_unique<EngineSession>();
    value->session = std::make_unique<mv::Session>(readValue(env, args[0]));
    napi_value result; check(env, napi_create_object(env, &result), "cannot create engine session");
    check(env, napi_type_tag_object(env, result, &engineSessionTag), "cannot identify engine session");
    check(env, napi_wrap(env, result, value.get(), [](napi_env, void* data, void*) { delete static_cast<EngineSession*>(data); }, nullptr, nullptr), "cannot own engine session");
    value.release(); return result;
  } catch (const std::exception& error) { return throwException(env, error); }
}
napi_value newGame(napi_env env, napi_callback_info info) {
  try { const auto args = arguments(env, info); if (args.size() != 1) throw std::invalid_argument("newGame requires session"); session(env, args[0]).session->newGame(); return undefined(env); }
  catch (const std::exception& error) { return throwException(env, error); }
}
napi_value stepEngine(napi_env env, napi_callback_info info) {
  try {
    const auto args = arguments(env, info);
    if (args.empty() || args.size() > 2) throw std::invalid_argument("step requires session and optional logical input");
    auto& value = session(env, args[0]);
    mv::Input controls;
    if (args.size() == 2) {
      const auto input = readValue(env, args[1]);
      controls = {input["direction"].integer(), input["ok"].boolean(), input["cancel"].boolean(), input["dash"].boolean()};
    } else {
      auto& platform = host(env).platform;
      if (!platform.windowFocused()) value.input.clear();
      else for (const auto& event : platform.keyEvents()) {
        if (event.down) value.input.keyDown(event.keyCode); else value.input.keyUp(event.keyCode);
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
        const double x = std::floor((event.x * ratioX - geometry.viewportX) * bounds.width / std::max(1,geometry.viewportWidth) + 0.5);
        const double y = std::floor((event.y * ratioY - geometry.viewportY) * bounds.height / std::max(1,geometry.viewportHeight) + 0.5);
        if (event.type == "mousedown") value.touch.mouseDown(event.button,x,y,bounds.contains(x,y),static_cast<double>(now));
        else if (event.type == "mouseup") value.touch.mouseUp(event.button,x,y);
        else if (event.type == "mousemove") value.touch.mouseMove(x,y);
        else if (event.type == "wheel") value.touch.wheel(event.deltaX,event.deltaY);
      }
      platform.clearPointerEvents();
      value.touch.update();
      controls.direction = value.input.dir4(); controls.ok = value.input.isPressed("ok");
      controls.cancel = value.input.isPressed("cancel") || value.input.isPressed("menu");
      controls.dash = value.input.isPressed("shift");
      controls.okTriggered = value.input.isTriggered("ok");
      controls.cancelTriggered = value.input.isTriggered("cancel") || value.input.isTriggered("menu");
      const char* direction = controls.direction == 2 ? "down" : controls.direction == 4 ? "left" : controls.direction == 6 ? "right" : "up";
      controls.repeatedDirection = value.input.isRepeated(direction) ? controls.direction : 0;
    }
    value.session->step(controls); return undefined(env);
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
  try { const auto args = arguments(env, info); if (args.size() != 1) throw std::invalid_argument("dispose requires session"); auto& value = session(env, args[0]); value.presentation.reset(); value.session.reset(); value.owner.reset(); return undefined(env); }
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
napi_value openTitle(napi_env env, napi_callback_info info) {
  try { const auto args = arguments(env, info); if (args.size() != 1) throw std::invalid_argument("openTitle requires session"); session(env, args[0]).session->openTitle(); return undefined(env); }
  catch (const std::exception& error) { return throwException(env, error); }
}
napi_value startBattle(napi_env env, napi_callback_info info) {
  try { const auto args = arguments(env, info); if (args.size() != 4) throw std::invalid_argument("startBattle requires session, troop, canEscape, canLose"); session(env, args[0]).session->startBattle(asInt32(env, args[1]), asBoolean(env, args[2]), asBoolean(env, args[3])); return undefined(env); }
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
napi_value save(napi_env env, napi_callback_info info) {
  try { const auto args = arguments(env, info); if (args.size() != 1) throw std::invalid_argument("save requires session"); auto& value = session(env, args[0]); if (value.presentation) value.presentation->captureAudioState(); return writeValue(env, value.session->save()); }
  catch (const std::exception& error) { return throwException(env, error); }
}
napi_value load(napi_env env, napi_callback_info info) {
  try { const auto args = arguments(env, info); if (args.size() != 2) throw std::invalid_argument("load requires session and contents"); session(env, args[0]).session->load(readValue(env, args[1])); return undefined(env); }
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
  method(env, engine, "create", createEngine); method(env, engine, "newGame", newGame);
  method(env, engine, "step", stepEngine); method(env, engine, "acknowledge", acknowledge);
  method(env, engine, "snapshot", snapshot); method(env, engine, "dispose", dispose);
  method(env, engine, "attach", attach); method(env, engine, "present", present); method(env, engine, "openTitle", openTitle);
  method(env, engine, "startBattle", startBattle); method(env, engine, "chooseAction", chooseAction); method(env, engine, "setRandomStream", randomStream);
  method(env, engine, "configure", configure); method(env, engine, "configuration", configuration);
  method(env, engine, "setSaveMetadata", setSaveMetadata);
  method(env, engine, "save", save); method(env, engine, "load", load); method(env, engine, "storageStatus", storageStatus); method(env, engine, "completeStorage", completeStorage);
  check(env, napi_set_named_property(env, exports, "mvEngine", engine), "cannot register engine API");
}
}
