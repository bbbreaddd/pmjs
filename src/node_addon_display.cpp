#include "node_addon_internal.hpp"
#include "mv_script_scene.hpp"
#include "mv_windows.hpp"
#include "mv_core_input.hpp"
#include "mv_sprites.hpp"

namespace pmjs::addon {
namespace {
using namespace mv::core;
struct BoundGlitchFilter : Container { std::shared_ptr<GlitchFilter> value = std::make_shared<GlitchFilter>(); };
struct BoundSprite : Sprite {
  struct Animation {
    mv::Value source;
    mv::Sprite_Animation state;
    explicit Animation(const mv::Value& value, bool mirror, int delay) : source(value) { state.setup(&source, mirror, delay); }
  };
  std::vector<std::shared_ptr<Animation>> animations;
};
struct BoundWindow : Window {
  mv::Window_Command model{0, 0, 0, 0};
  bool opening = false, closing = false;
  void tick() {
    if (active) ++animationCount;
    if (opening) { openness = std::min(255.0, openness + 32); if (openness == 255) opening = false; }
    if (closing) { openness = std::max(0.0, openness - 32); if (openness == 0) closing = false; }
  }
};
struct DisplayServices {
  std::shared_ptr<State> owner;
  mv::ScriptSceneManager scenes;
  Input input;
  bool focused = true;
  explicit DisplayServices(std::shared_ptr<State> value) : owner(std::move(value)) { bindRuntime(owner->core); }
  ~DisplayServices() { scenes.scene.reset(); scenes.nextScene.reset(); unbindRuntime(owner->core); }
};
struct DisplayOwner { std::shared_ptr<DisplayServices> services; std::shared_ptr<Container> node; std::string kind; };
constexpr napi_type_tag servicesTag{0xb35341ad709ea415ULL, 0x849010442b3af827ULL};
constexpr napi_type_tag displayTag{0x25a787ced299548cULL, 0xb38331dc9ba9b429ULL};
template<class T> T& unwrap(napi_env env, napi_value object, const napi_type_tag& tag) {
  bool valid = false;
  check(env, napi_check_object_type_tag(env, object, &tag, &valid), "invalid display handle");
  if (!valid) throw std::invalid_argument("invalid display handle");
  T* result = nullptr;
  check(env, napi_unwrap(env, object, reinterpret_cast<void**>(&result)), "invalid display owner");
  if (!result) throw std::invalid_argument("invalid display owner");
  return *result;
}
auto services(napi_env env, napi_value object) { return unwrap<std::shared_ptr<DisplayServices>>(env, object, servicesTag); }
DisplayOwner& display(napi_env env, napi_value object) { return unwrap<DisplayOwner>(env, object, displayTag); }
std::string kind(const std::shared_ptr<Container>& node) {
  if (std::dynamic_pointer_cast<BoundGlitchFilter>(node)) return "glitch";
  if (std::dynamic_pointer_cast<mv::ScriptScene>(node)) return "scene";
  if (std::dynamic_pointer_cast<BoundWindow>(node)) return "window";
  if (std::dynamic_pointer_cast<WindowLayer>(node)) return "windowLayer";
  if (std::dynamic_pointer_cast<TilingSprite>(node)) return "tiling";
  if (std::dynamic_pointer_cast<Sprite>(node)) return "sprite";
  if (std::dynamic_pointer_cast<ScreenSprite>(node)) return "screen";
  return "container";
}
napi_value wrap(napi_env env, const std::shared_ptr<DisplayServices>& runtime, const std::shared_ptr<Container>& node) {
  if (!node) return null(env);
  auto value = std::make_unique<DisplayOwner>(DisplayOwner{runtime, node, kind(node)});
  auto result = moduleObject(env); napi_value identity;
  check(env, napi_create_bigint_uint64(env, node->displayId, &identity), "cannot identify display object");
  check(env, napi_set_named_property(env, result, "identity", identity), "cannot set display identity");
  check(env, napi_set_named_property(env, result, "kind", string(env, value->kind)), "cannot set display kind");
  check(env, napi_type_tag_object(env, result, &displayTag), "cannot tag display object");
  check(env, napi_wrap(env, result, value.get(), [](napi_env, void* data, void*) { delete static_cast<DisplayOwner*>(data); }, nullptr, nullptr), "cannot own display object");
  value.release(); return result;
}
napi_value open(napi_env env, napi_callback_info) try {
  host(env);
  auto value = std::make_unique<std::shared_ptr<DisplayServices>>(std::make_shared<DisplayServices>(state));
  auto result = moduleObject(env);
  check(env, napi_type_tag_object(env, result, &servicesTag), "cannot tag display runtime");
  check(env, napi_wrap(env, result, value.get(), [](napi_env, void* data, void*) { delete static_cast<std::shared_ptr<DisplayServices>*>(data); }, nullptr, nullptr), "cannot own display runtime");
  value.release(); return result;
} catch (const std::exception& error) { return throwException(env, error); }
napi_value create(napi_env env, napi_callback_info info) try {
  const auto args = arguments(env, info);
  if (args.size() != 2) throw std::invalid_argument("display creation requires runtime and kind");
  auto runtime = services(env, args[0]); const auto type = asString(env, args[1]);
  std::shared_ptr<Container> node;
  if (type == "scene") node = std::make_shared<mv::ScriptScene>();
  else if (type == "sprite") node = std::make_shared<BoundSprite>();
  else if (type == "tiling") node = std::make_shared<TilingSprite>();
  else if (type == "screen") node = std::make_shared<ScreenSprite>();
  else if (type == "window") node = std::make_shared<BoundWindow>();
  else if (type == "windowLayer") node = std::make_shared<WindowLayer>();
  else if (type == "container") node = std::make_shared<Container>();
  else if (type == "glitch") node = std::make_shared<BoundGlitchFilter>();
  else throw std::invalid_argument("unknown display kind: " + type);
  return wrap(env, runtime, node);
} catch (const std::exception& error) { return throwException(env, error); }
napi_value field(napi_env env, napi_callback_info info) try {
  const auto args = arguments(env, info);
  if (args.size() < 2 || args.size() > 3) throw std::invalid_argument("display property requires handle, field and optional value");
  auto& owner = display(env, args[0]); auto& node = *owner.node; const auto name = asString(env, args[1]);
  double* scalar = nullptr; bool* flag = nullptr; int* integer = nullptr;
  if (name == "x") scalar = &node.position.x; else if (name == "y") scalar = &node.position.y;
  else if (name == "scaleX") scalar = &node.scale.x; else if (name == "scaleY") scalar = &node.scale.y;
  else if (name == "pivotX") scalar = &node.pivot.x; else if (name == "pivotY") scalar = &node.pivot.y;
  else if (name == "skewX") scalar = &node.skew.x; else if (name == "skewY") scalar = &node.skew.y;
  else if (name == "rotation") scalar = &node.rotation; else if (name == "alpha") scalar = &node.alpha;
  else if (name == "visible") flag = &node.visible; else if (name == "renderable") flag = &node.renderable;
  else if (name == "z") integer = &node.z;
  auto sprite = std::dynamic_pointer_cast<Sprite>(owner.node);
  auto tiling = std::dynamic_pointer_cast<TilingSprite>(owner.node);
  auto window = std::dynamic_pointer_cast<BoundWindow>(owner.node);
  auto scene = std::dynamic_pointer_cast<mv::ScriptScene>(owner.node);
  if (auto filter = std::dynamic_pointer_cast<BoundGlitchFilter>(owner.node)) {
    if (name == "slices") scalar = &filter->value->slices; else if (name == "offset") scalar = &filter->value->offset;
    else if (name == "direction") scalar = &filter->value->direction; else if (name == "fillMode") scalar = &filter->value->fillMode;
    else if (name == "seed") scalar = &filter->value->seed; else if (name == "enabled") flag = &filter->value->enabled;
  }
  if (sprite) {
    if (name == "anchorX") scalar = &sprite->anchor.x; else if (name == "anchorY") scalar = &sprite->anchor.y;
    else if (name == "blendMode") {
      if (args.size() == 3) sprite->blendMode = asBlendMode(env, args[2]);
      return number(env, static_cast<int>(sprite->blendMode));
    }
  }
  if (tiling) {
    if (name == "originX") scalar = &tiling->origin.x; else if (name == "originY") scalar = &tiling->origin.y;
    else if (name == "width") scalar = &tiling->areaWidth; else if (name == "height") scalar = &tiling->areaHeight;
  }
  if (window) {
    if (name == "originX") scalar = &window->origin.x; else if (name == "originY") scalar = &window->origin.y;
    if (name == "width") scalar = &window->width; else if (name == "height") scalar = &window->height;
    else if (name == "padding") scalar = &window->padding; else if (name == "margin") scalar = &window->margin;
    else if (name == "openness") scalar = &window->openness; else if (name == "opacity") scalar = &window->opacity;
    else if (name == "backOpacity") scalar = &window->backOpacity; else if (name == "contentsOpacity") scalar = &window->contentsOpacity;
    else if (name == "active") flag = &window->active; else if (name == "opening") flag = &window->opening;
    else if (name == "closing") flag = &window->closing; else if (name == "index") integer = &window->model.index;
    else if (name == "topRow") integer = &window->model.topRow;
  }
  if (scene) {
    if (name == "active") flag = &scene->active; else if (name == "fadeDuration") integer = &scene->fadeDuration;
    else if (name == "fadeSign") integer = &scene->fadeSign;
  }
  if (name == "opacity" && !window) {
    if (args.size() == 3) node.alpha = std::clamp(asNumber(env, args[2]), 0.0, 255.0) / 255;
    return number(env, node.alpha * 255);
  }
  if ((name == "width" || name == "height") && sprite && !tiling) {
    if (args.size() == 3) { if (name == "width") sprite->setWidth(asNumber(env, args[2])); else sprite->setHeight(asNumber(env, args[2])); }
    return number(env, name == "width" ? sprite->width() : sprite->height());
  }
  if (scalar) { if (args.size() == 3) *scalar = asNumber(env, args[2]); return number(env, *scalar); }
  if (flag) { if (args.size() == 3) *flag = asBoolean(env, args[2]); return boolean(env, *flag); }
  if (integer) { if (args.size() == 3) *integer = asInt32(env, args[2]); return number(env, *integer); }
  throw std::invalid_argument("display field is not bound: " + name);
} catch (const std::exception& error) { return throwException(env, error); }
napi_value children(napi_env env, napi_callback_info info) try {
  const auto args = arguments(env, info); if (args.size() != 1) throw std::invalid_argument("children requires display handle");
  auto& owner = display(env, args[0]); napi_value result;
  check(env, napi_create_array_with_length(env, owner.node->children.size(), &result), "cannot list display children");
  for (std::size_t i = 0; i < owner.node->children.size(); ++i)
    check(env, napi_set_element(env, result, i, wrap(env, owner.services, owner.node->children[i])), "cannot list display child");
  return result;
} catch (const std::exception& error) { return throwException(env, error); }
napi_value invoke(napi_env env, napi_callback_info info) try {
  const auto args = arguments(env, info); if (args.size() < 2) throw std::invalid_argument("display operation requires handle and method");
  auto& owner = display(env, args[0]); const auto method = asString(env, args[1]); auto& node = *owner.node;
  auto sprite = std::dynamic_pointer_cast<Sprite>(owner.node);
  auto window = std::dynamic_pointer_cast<BoundWindow>(owner.node);
  auto scene = std::dynamic_pointer_cast<mv::ScriptScene>(owner.node);
  auto scalar = [&](std::size_t index) { if (index >= args.size()) throw std::invalid_argument("missing display argument"); return asNumber(env, args[index]); };
  if (method == "add" || method == "remove") {
    if (args.size() < 3) throw std::invalid_argument("missing display child");
    auto& child = display(env, args[2]); if (child.services != owner.services) throw std::invalid_argument("display child belongs to another runtime");
    if (child.kind == "glitch") throw std::invalid_argument("filter is not a display child");
    if (method == "add") node.addChildAt(child.node, args.size() > 3 ? asUint32(env, args[3]) : node.children.size());
    else node.removeChild(child.node.get());
  } else if (method == "removeChildren") node.removeChildren();
  else if (method == "filters") {
    if (window) throw std::invalid_argument("window filters are not bound");
    std::vector<std::shared_ptr<GlitchFilter>> filters;
    for (std::size_t i = 2; i < args.size(); ++i) {
      auto& filter = display(env, args[i]);
      if (filter.services != owner.services) throw std::invalid_argument("filter belongs to another runtime");
      auto glitch = std::dynamic_pointer_cast<BoundGlitchFilter>(filter.node);
      if (!glitch) throw std::invalid_argument("filter type is not bound");
      filters.push_back(glitch->value);
    }
    node.glitchFilters = std::move(filters);
  }
  else if (method == "bitmap" || method == "contents" || method == "windowskin") {
    if (args.size() != 3) throw std::invalid_argument("bitmap assignment requires bitmap or null");
    napi_valuetype type; check(env, napi_typeof(env, args[2], &type), "cannot inspect bitmap");
    auto bitmap = type == napi_null ? nullptr : bitmapForRuntime(env, args[2], owner.services->owner->core);
    if (method == "bitmap" && sprite) sprite->setBitmap(std::move(bitmap));
    else if (method == "contents" && window) window->contents = std::move(bitmap);
    else if (method == "windowskin" && window) window->windowskin = std::move(bitmap);
    else throw std::invalid_argument("bitmap slot does not exist on this display object");
  } else if (method == "frame" && sprite) {
    if (args.size() > 2) sprite->setFrame(scalar(2), scalar(3), scalar(4), scalar(5));
    const auto rect = sprite->frame(); napi_value result; check(env, napi_create_array_with_length(env, 4, &result), "cannot read sprite frame");
    const std::array values{rect.x, rect.y, rect.width, rect.height};
    for (int i = 0; i < 4; ++i) check(env, napi_set_element(env, result, i, number(env, values[i])), "cannot read frame component");
    return result;
  } else if (method == "refreshSprite" && sprite) sprite->refresh();
  else if ((method == "tone" || method == "blend") && sprite) {
    if (args.size() > 2) {
      const std::array<double,4> value{scalar(2), scalar(3), scalar(4), scalar(5)};
      if (method == "tone") sprite->setColorTone(value); else sprite->setBlendColor(value);
    }
    const auto values = method == "tone" ? sprite->colorTone() : sprite->blendColor(); napi_value result;
    check(env, napi_create_array_with_length(env, 4, &result), "cannot read sprite color");
    for (int i = 0; i < 4; ++i) check(env, napi_set_element(env, result, i, number(env, values[i])), "cannot read color component");
    return result;
  } else if (method == "color") {
    auto screen = std::dynamic_pointer_cast<ScreenSprite>(owner.node);
    if (!screen) throw std::invalid_argument("screen color requires ScreenSprite");
    screen->setColor(scalar(2), scalar(3), scalar(4));
  } else if (method == "cursor" && window) window->setCursorRect(scalar(2), scalar(3), scalar(4), scalar(5));
  else if (method == "tick" && window) window->tick();
  else if (method == "refreshWindow" && window) window->refreshAllParts();
  else if (method == "updateAnimations" || method == "isAnimationPlaying") {
    auto target = std::dynamic_pointer_cast<BoundSprite>(owner.node);
    if (!target) throw std::invalid_argument("animation target must be a sprite");
    if (method == "updateAnimations") {
      for (const auto& animation : target->animations) animation->state.update();
      std::erase_if(target->animations, [](const auto& animation) { return !animation->state.isPlaying(); });
    }
    return boolean(env, !target->animations.empty());
  }
  else if (method == "cursorMove" && window) {
    if (args.size() != 7) throw std::invalid_argument("cursor movement requires item count, columns, rows, direction and wrap");
    mv::Window_Selectable::moveCursor(window->model.index, window->model.topRow, asInt32(env, args[2]), asInt32(env, args[3]), asInt32(env, args[4]), asInt32(env, args[5]), asBoolean(env, args[6]));
  } else if (method == "itemRect" && window) {
    if (args.size() != 7) throw std::invalid_argument("item rectangle requires index, columns, height, spacing and width");
    const int columns = asInt32(env, args[3]), spacing = asInt32(env, args[5]);
    const int contentsWidth = columns * (asInt32(env, args[6]) + spacing) - spacing;
    const auto rect = mv::Window_Selectable::itemRectFor(asInt32(env, args[2]), contentsWidth,
      asInt32(env, args[3]), asInt32(env, args[4]), asInt32(env, args[5]), window->model.topRow);
    napi_value result; check(env, napi_create_array_with_length(env, 4, &result), "cannot return item rectangle");
    const std::array values{rect.x, rect.y, rect.width, rect.height};
    for (int i = 0; i < 4; ++i) check(env, napi_set_element(env, result, i, number(env, values[i])), "cannot return item rectangle component");
    return result;
  } else if (method == "cursorVisible" && window) {
    if (args.size() != 4) throw std::invalid_argument("cursor visibility requires columns and page rows");
    window->model.maxCols = asInt32(env, args[2]);
    const int row = window->model.row();
    return boolean(env, row >= window->model.topRow && row <= std::max(0, window->model.topRow + asInt32(env, args[3]) - 1));
  } else if (method == "clearCommands" && window) window->model.commands.clear();
  else if (method == "addCommand" && window) {
    if (args.size() != 5) throw std::invalid_argument("command requires name, symbol and enabled flag");
    window->model.addCommand(asString(env, args[2]), asString(env, args[3]), asBoolean(env, args[4]));
  } else if (method == "commandCount" && window) return number(env, window->model.maxItems());
  else if (method == "command" && window) {
    const int index = asInt32(env, args.at(2));
    if (index < 0 || index >= window->model.maxItems()) return null(env);
    const auto& command = window->model.commands[index]; auto result = moduleObject(env);
    check(env, napi_set_named_property(env, result, "name", string(env, command.name)), "cannot return command name");
    check(env, napi_set_named_property(env, result, "symbol", string(env, command.symbol)), "cannot return command symbol");
    check(env, napi_set_named_property(env, result, "enabled", boolean(env, command.enabled)), "cannot return command state");
    return result;
  } else if (method == "fade" && scene) scene->startFade(asBoolean(env, args[2]), asInt32(env, args[3]), asBoolean(env, args[4]));
  else if (method == "updateFade" && scene) scene->updateFade();
  else throw std::invalid_argument("display operation is not bound: " + method);
  return undefined(env);
} catch (const std::exception& error) { return throwException(env, error); }
mv::ScriptSceneManager::Dispatch dispatcher(napi_env env, napi_value callback, const std::shared_ptr<DisplayServices>& runtime) {
  return [env, callback, runtime](const auto& scene, const std::string& method) {
    const napi_value args[]{wrap(env, runtime, scene), string(env, method)}; napi_value result;
    check(env, napi_call_function(env, undefined(env), callback, 2, args, &result), "script scene callback failed");
    napi_value truth; check(env, napi_coerce_to_bool(env, result, &truth), "invalid scene result"); return asBoolean(env, truth);
  };
}
napi_value sceneOperation(napi_env env, napi_callback_info info) try {
  const auto args = arguments(env, info); if (args.size() < 2) throw std::invalid_argument("scene operation requires runtime and operation");
  auto runtime = services(env, args[0]); const auto method = asString(env, args[1]); auto& scenes = runtime->scenes;
  if (method == "goto" || (method == "next" && args.size() == 3)) {
    if (method == "goto" && args.size() != 4) throw std::invalid_argument("scene transition requires scene and dispatcher");
    napi_valuetype type; check(env, napi_typeof(env, args[2], &type), "cannot inspect next scene");
    std::shared_ptr<mv::ScriptScene> next;
    if (type != napi_null) {
      auto& owner = display(env, args[2]); if (owner.services != runtime) throw std::invalid_argument("scene belongs to another runtime");
      next = std::dynamic_pointer_cast<mv::ScriptScene>(owner.node); if (!next) throw std::invalid_argument("transition requires a scene");
    }
    if (method == "goto") scenes.goTo(next, dispatcher(env, args[3], runtime));
    else { scenes.nextScene = std::move(next); scenes.changing = bool(scenes.nextScene); }
  } else if (method == "update") {
    if (args.size() != 3) throw std::invalid_argument("scene update requires dispatcher");
    scenes.update(dispatcher(env, args[2], runtime));
  } else if (method == "current") return wrap(env, runtime, scenes.scene);
  else if (method == "next") return wrap(env, runtime, scenes.nextScene);
  else if (method == "changing") return boolean(env, scenes.changing);
  else if (method == "started") return boolean(env, scenes.started);
  else if (method == "frameCount") return number(env, Graphics::frameCount);
  else if (method == "stopped") { if (args.size() == 3) scenes.stopped = asBoolean(env, args[2]); return boolean(env, scenes.stopped); }
  else throw std::invalid_argument("scene operation is not bound: " + method);
  return undefined(env);
} catch (const std::exception& error) { return throwException(env, error); }
napi_value inputOperation(napi_env env, napi_callback_info info) try {
  const auto args = arguments(env, info); if (args.size() < 2) throw std::invalid_argument("input operation requires runtime and operation");
  auto runtime = services(env, args[0]); auto& input = runtime->input; const auto method = asString(env, args[1]);
  if (method == "keyMapper" || method == "gamepadMapper") {
    auto& mapper = method == "keyMapper" ? input.keyMapper : input.gamepadMapper;
    if (args.size() == 3) {
      napi_value keys; check(env, napi_get_property_names(env, args[2], &keys), "cannot inspect input map");
      std::uint32_t length; check(env, napi_get_array_length(env, keys, &length), "cannot inspect input map keys");
      std::map<int, std::string> replacement;
      for (std::uint32_t i = 0; i < length; ++i) {
        napi_value key, value; check(env, napi_get_element(env, keys, i, &key), "cannot read input key");
        check(env, napi_get_property(env, args[2], key, &value), "cannot read input binding");
        replacement.emplace(std::stoi(asString(env, key)), asString(env, value));
      }
      mapper = std::move(replacement);
    } else if (args.size() == 4) {
      const int key = asInt32(env, args[2]); napi_valuetype type;
      check(env, napi_typeof(env, args[3], &type), "cannot inspect input binding");
      if (type == napi_null) mapper.erase(key); else mapper[key] = asString(env, args[3]);
    }
    auto result = moduleObject(env);
    for (const auto& [key, value] : mapper) check(env, napi_set_named_property(env, result, std::to_string(key).c_str(), string(env, value)), "cannot return input binding");
    return result;
  }
  if (method == "update") {
    auto& platform = runtime->owner->platform; const bool focused = platform.windowFocused();
    if (!focused && runtime->focused) input.clear(); runtime->focused = focused;
    if (focused) for (const auto& event : platform.keyEvents()) { if (event.down) input.keyDown(event.keyCode); else input.keyUp(event.keyCode); }
    std::vector<Gamepad> pads;
    for (const auto& source : platform.gamepads()) {
      Gamepad pad; pad.index = source.index; pad.connected = source.connected; pad.axes = source.axes; pad.buttons.resize(17);
      for (const int button : source.buttonsDown) if (button >= 0 && button < 17) pad.buttons[button] = true;
      pads.push_back(std::move(pad));
    }
    const auto now = std::chrono::duration_cast<std::chrono::milliseconds>(std::chrono::system_clock::now().time_since_epoch()).count();
    input.update(pads, now);
  } else if (method == "clear") input.clear();
  else if (method == "keyDown" || method == "keyUp") {
    if (args.size() != 3) throw std::invalid_argument("key operation requires key code");
    if (method == "keyDown") input.keyDown(asInt32(env, args[2])); else input.keyUp(asInt32(env, args[2]));
  } else if (method == "dir4") return number(env, input.dir4());
  else if (method == "dir8") return number(env, input.dir8());
  else if (method == "date") return number(env, input.date());
  else {
    if (args.size() != 3) throw std::invalid_argument("input query requires button name");
    const auto name = asString(env, args[2]);
    if (method == "isPressed") return boolean(env, input.isPressed(name));
    if (method == "isTriggered") return boolean(env, input.isTriggered(name));
    if (method == "isRepeated") return boolean(env, input.isRepeated(name));
    if (method == "isLongPressed") return boolean(env, input.isLongPressed(name));
    throw std::invalid_argument("input operation is not bound: " + method);
  }
  return undefined(env);
} catch (const std::exception& error) { return throwException(env, error); }
}

std::shared_ptr<mv::core::Container> displayForRuntime(napi_env env, napi_value object, RuntimeCore& runtime) {
  auto& value = display(env, object);
  if (&value.services->owner->core != &runtime) throw std::invalid_argument("display belongs to another host");
  return value.node;
}
void startDisplayAnimation(napi_env env, napi_value object, RuntimeCore& runtime, const mv::Value& animation, bool mirror, int delay) {
  auto sprite = std::dynamic_pointer_cast<BoundSprite>(displayForRuntime(env, object, runtime));
  if (!sprite) throw std::invalid_argument("animation target must be a sprite");
  for (int frame = 0; frame < static_cast<int>(animation["frames"].array().size()); ++frame)
    if (!mv::Sprite_Animation::cells(animation, frame, mirror).empty() || !mv::Sprite_Animation::timings(animation, frame).empty())
      throw std::runtime_error("display animation cells and timings are not bound");
  sprite->animations.push_back(std::make_shared<BoundSprite::Animation>(animation, mirror, delay));
}
void registerDisplayBindings(napi_env env, napi_value exports) {
  auto api = moduleObject(env);
  method(env, api, "open", open); method(env, api, "create", create); method(env, api, "field", field);
  method(env, api, "children", children); method(env, api, "invoke", invoke); method(env, api, "scene", sceneOperation);
  method(env, api, "input", inputOperation);
  check(env, napi_set_named_property(env, exports, "mvDisplay", api), "cannot export display bindings");
}
}
