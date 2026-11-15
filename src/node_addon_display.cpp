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
  mv::Sprite_Button button;
  struct Animation {
    mv::Value source;
    mv::Sprite_Animation state;
    explicit Animation(const mv::Value& value, bool mirror, int delay, int rate) : source(value) { state.setup(&source, mirror, delay); state.rate = rate; state.duration = mv::Sprite_Animation::durationFor(source, rate); }
  };
  std::vector<std::shared_ptr<Animation>> animations;
};
struct BoundWindow : Window {
  std::shared_ptr<mv::Window_Base> model=std::make_shared<mv::Window_Command>(0,0,0,0);
  mv::Window_Selectable& selection() { auto* value=dynamic_cast<mv::Window_Selectable*>(model.get()); if (!value) throw std::invalid_argument("window is not selectable"); return *value; }
  mv::Window_Command& command() { auto* value=dynamic_cast<mv::Window_Command*>(model.get()); if (!value) throw std::invalid_argument("window is not a command window"); return *value; }
  void synchronizeModel() {
    model->rect={int(position.x),int(position.y),int(width),int(height)}; model->padding=padding;
    model->openness=openness; model->active=active; model->visible=visible; model->animationCount=animationCount;
    if (contents) model->fontSize=contents->fontSize;
  }
  bool opening = false, closing = false;
  void tick() {
    if (active) ++animationCount;
    const auto previousOpenness=openness;
    if (opening) { openness = std::min(255.0, openness + 32); if (openness == 255) opening = false; }
    if (closing) { openness = std::max(0.0, openness - 32); if (openness == 0) closing = false; }
    if(openness!=previousOpenness)synchronizeSkinContainer();
  }
};
struct DisplayServices {
  std::shared_ptr<State> owner;
  mv::ScriptSceneManager scenes;
  Input input;
  std::map<Container*,std::weak_ptr<Container>> nodes;
  std::map<std::uint64_t,napi_ref> handles;
  std::uint64_t wraps=0;
  bool focused = true;
  explicit DisplayServices(std::shared_ptr<State> value) : owner(std::move(value)) {
    if (boundRuntime() && boundRuntime() != &owner->core) throw std::runtime_error("display graphics services belong to another runtime");
    bindRuntime(owner->core);
  }
  ~DisplayServices() { scenes.scene.reset(); scenes.nextScene.reset(); unbindRuntime(owner->core); }
};
struct DisplayOwner { std::shared_ptr<DisplayServices> services; std::shared_ptr<Container> node; std::string kind; napi_ref handleReference=nullptr; };
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
  if (std::dynamic_pointer_cast<Tilemap>(node)) return "tilemap";
  if (std::dynamic_pointer_cast<TilingSprite>(node)) return "tiling";
  if (std::dynamic_pointer_cast<Sprite>(node)) return "sprite";
  if (std::dynamic_pointer_cast<ScreenSprite>(node)) return "screen";
  if (std::dynamic_pointer_cast<ToneSprite>(node)) return "tone";
  return "container";
}
napi_value wrap(napi_env env, const std::shared_ptr<DisplayServices>& runtime, const std::shared_ptr<Container>& node) {
  if (!node) return null(env);
  const auto found=runtime->handles.find(node->displayId);
  if(found!=runtime->handles.end()) {
    napi_value existing=nullptr;
    check(env,napi_get_reference_value(env,found->second,&existing),"cannot retrieve display handle");
    if(existing)return existing;
    runtime->handles.erase(found);
  }
  runtime->nodes[node.get()]=node;
  if(++runtime->wraps%256==0)std::erase_if(runtime->nodes,[](const auto& entry){return entry.second.expired();});
  auto value = std::make_unique<DisplayOwner>(DisplayOwner{runtime, node, kind(node)});
  auto result = moduleObject(env); napi_value identity;
  check(env, napi_create_bigint_uint64(env, node->displayId, &identity), "cannot identify display object");
  check(env, napi_set_named_property(env, result, "identity", identity), "cannot set display identity");
  check(env, napi_set_named_property(env, result, "kind", string(env, value->kind)), "cannot set display kind");
  check(env, napi_type_tag_object(env, result, &displayTag), "cannot tag display object");
  check(env, napi_wrap(env, result, value.get(), [](napi_env env, void* data, void*) {
    auto* owner=static_cast<DisplayOwner*>(data);
    auto& handles=owner->services->handles;
    const auto found=handles.find(owner->node->displayId);
    if(found!=handles.end()&&found->second==owner->handleReference)handles.erase(found);
    if(owner->handleReference)napi_delete_reference(env,owner->handleReference);
    delete owner;
  }, nullptr, nullptr), "cannot own display object");
  auto* owner=value.release();
  check(env,napi_create_reference(env,result,0,&owner->handleReference),"cannot cache display handle");
  runtime->handles[node->displayId]=owner->handleReference;
  return result;
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
  else if (type == "tone") node = std::make_shared<ToneSprite>();
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
  if (name=="buttonTouching") {
    const auto button=std::dynamic_pointer_cast<BoundSprite>(owner.node);
    if (!button) throw std::invalid_argument("button state requires a sprite");
    if (args.size()==3) button->button.touching=asBoolean(env,args[2]);
    return boolean(env,button->button.touching);
  }
  auto tiling = std::dynamic_pointer_cast<TilingSprite>(owner.node);
  auto window = std::dynamic_pointer_cast<BoundWindow>(owner.node);
  if (auto tone = std::dynamic_pointer_cast<ToneSprite>(owner.node)) {
    if (name=="_red") scalar=&tone->tone_[0]; else if (name=="_green") scalar=&tone->tone_[1];
    else if (name=="_blue") scalar=&tone->tone_[2]; else if (name=="_gray") scalar=&tone->tone_[3];
  }
  if (auto layer = std::dynamic_pointer_cast<WindowLayer>(owner.node)) {
    if (name == "width") scalar = &layer->width; else if (name == "height") scalar = &layer->height;
  }
  auto scene = std::dynamic_pointer_cast<mv::ScriptScene>(owner.node);
  if (auto filter = std::dynamic_pointer_cast<BoundGlitchFilter>(owner.node)) {
    if (name == "slices") scalar = &filter->value->slices; else if (name == "offset") scalar = &filter->value->offset;
    else if (name == "direction") scalar = &filter->value->direction; else if (name == "fillMode") scalar = &filter->value->fillMode;
    else if (name == "seed") scalar = &filter->value->seed; else if (name == "enabled") flag = &filter->value->enabled;
  }
  if (sprite) {
    if(name=="_refreshFrame") {if(args.size()==3)sprite->setRefreshFrame(asBoolean(env,args[2]));return boolean(env,sprite->refreshFrame());}
    if(name=="ax")scalar=&sprite->ax;else if(name=="ay")scalar=&sprite->ay;
    if(name=="opaque")flag=&sprite->opaque;else if(name=="_isPicture")flag=&sprite->isPicture;
    else if(name=="spriteId") {if(args.size()==3)sprite->spriteId=asNumber(env,args[2]);return number(env,sprite->spriteId);}
    if (name == "anchorX") scalar = &sprite->anchor.x; else if (name == "anchorY") scalar = &sprite->anchor.y;
    else if (name == "blendMode") {
      if (args.size() == 3) sprite->blendMode = asBlendMode(env, args[2]);
      return number(env, static_cast<int>(sprite->blendMode));
    }
  }
  if (auto screen = std::dynamic_pointer_cast<ScreenSprite>(owner.node); screen && name == "blendMode") {
    if (args.size() == 3) screen->blendMode = asBlendMode(env, args[2]);
    return number(env, static_cast<int>(screen->blendMode));
  }
  if (tiling) {
    if (name == "originX") scalar = &tiling->origin.x; else if (name == "originY") scalar = &tiling->origin.y;
    else if (name == "width") scalar = &tiling->areaWidth; else if (name == "height") scalar = &tiling->areaHeight;
  }
  if (const auto tilemap = std::dynamic_pointer_cast<Tilemap>(owner.node)) {
    if(name=="tileWidth"||name=="tileHeight") {
      if(args.size()==3) {if(name=="tileWidth")tilemap->setTileWidth(asInt32(env,args[2]));else tilemap->setTileHeight(asInt32(env,args[2]));}
      return number(env,name=="tileWidth"?tilemap->tileWidth:tilemap->tileHeight);
    }
    int* value=name=="mapWidth"?&tilemap->mapWidth:name=="mapHeight"?&tilemap->mapHeight:
      name=="width"?&tilemap->width:name=="height"?&tilemap->height:name=="margin"?&tilemap->margin:
      name=="animationFrame"?&tilemap->animationFrame:name=="animationCount"?&tilemap->animationCount:nullptr;
    if(value) {if(args.size()==3) {const auto next=asInt32(env,args[2]);if(*value!=next){*value=next;if(name!="animationFrame"&&name!="animationCount")tilemap->refresh();}}return number(env,*value);}
    if(name=="customChildOrder") {if(args.size()==3)tilemap->customChildOrder=asBoolean(env,args[2]);return boolean(env,tilemap->customChildOrder);}
    if(name=="horizontalWrap"||name=="verticalWrap") {
      auto& wrap=name=="horizontalWrap"?tilemap->horizontalWrap:tilemap->verticalWrap;
      if(args.size()==3) {const bool next=asBoolean(env,args[2]);if(wrap!=next){wrap=next;tilemap->refresh();}}return boolean(env,wrap);
    }
    if (name == "originX") scalar = &tilemap->origin.x;
    else if (name == "originY") scalar = &tilemap->origin.y;
  }
  if (window) {
    if (name=="_animationCount") {if(args.size()==3)window->animationCount=std::uint64_t(asNumber(env,args[2]));return number(env,window->animationCount);}
    if (name == "originX") scalar = &window->origin.x; else if (name == "originY") scalar = &window->origin.y;
    if (name == "width") scalar = &window->width; else if (name == "height") scalar = &window->height;
    else if (name == "padding") scalar = &window->padding; else if (name == "margin") scalar = &window->margin;
    else if (name == "openness" || name == "rawOpenness") scalar = &window->openness; else if (name == "opacity") scalar = &window->opacity;
    else if (name == "backOpacity") scalar = &window->backOpacity; else if (name == "contentsOpacity") scalar = &window->contentsOpacity;
    else if (name == "active") flag = &window->active; else if (name == "opening") flag = &window->opening;
    else if (name == "pause") flag = &window->pause;
    else if (name == "_isWindow") flag = &window->isWindow;
    else if (name == "upArrowVisible") flag = &window->upArrowVisible;
    else if (name == "downArrowVisible") flag = &window->downArrowVisible;
    else if (name == "closing") flag = &window->closing; else if (name == "index") integer = &window->selection().index;
    else if (name == "topRow") integer = &window->selection().topRow;
    else if (name == "cursorFixed") flag = &window->selection().cursorFixed;
    else if (name == "cursorAll") flag = &window->selection().cursorAll;
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
  if (scalar) { if (args.size() == 3) {
    const auto value = asNumber(env, args[2]);
    *scalar = window && (name == "openness" || name == "opacity" || name == "backOpacity" || name == "contentsOpacity") ? std::clamp(value, 0.0, 255.0) : value;
    if (window) { if(name=="openness")window->synchronizeSkinContainer(); window->synchronizeModel(); }
  } return number(env, *scalar); }
  if (flag) { if (args.size() == 3) { *flag = asBoolean(env, args[2]); if (window) window->synchronizeModel(); } return boolean(env, *flag); }
  if (integer) { if (args.size() == 3) *integer = asInt32(env, args[2]); return number(env, *integer); }
  throw std::invalid_argument("display field is not bound: " + name);
} catch (const std::exception& error) { return throwException(env, error); }
napi_value numericState(napi_env env, napi_callback_info info) try {
  const auto args = arguments(env, info);
  if (args.size() != 1) throw std::invalid_argument("numeric state requires a display handle");
  const auto& owner = display(env, args[0]);
  auto result = moduleObject(env);
  const auto expose = [&](const char* name, void* data, std::size_t length, napi_typedarray_type type = napi_float64_array, std::size_t elementSize = sizeof(double)) {
    auto retained = std::make_unique<DisplayOwner>(owner);
    napi_value buffer, view;
    check(env, napi_create_external_arraybuffer(env, data, length * elementSize,
      [](napi_env, void* , void* hint) { delete static_cast<DisplayOwner*>(hint); },
      retained.get(), &buffer), "cannot expose display state");
    retained.release();
    check(env, napi_create_typedarray(env, type, length, buffer, 0, &view), "cannot view display state");
    check(env, napi_set_named_property(env, result, name, view), "cannot name display state");
  };
  static_assert(sizeof(Point) == 2 * sizeof(double) && offsetof(Point, y) == sizeof(double));
  auto& node = *owner.node;
  expose("position", &node.position.x, 2); expose("scale", &node.scale.x, 2);
  expose("pivot", &node.pivot.x, 2); expose("skew", &node.skew.x, 2);
  expose("childrenRevision", &node.childrenRevision, 1); expose("parentRevision", &node.parentRevision, 1);
  expose("rotation", &node.rotation, 1); expose("alpha", &node.alpha, 1);
  static_assert(sizeof(bool) == 1 && sizeof(int) == 4);
  expose("visible", &node.visible, 1, napi_uint8_array, sizeof(bool));
  expose("renderable", &node.renderable, 1, napi_uint8_array, sizeof(bool));
  expose("z", &node.z, 1, napi_int32_array, sizeof(int));
  if (auto sprite = std::dynamic_pointer_cast<Sprite>(owner.node)) expose("anchor", &sprite->anchor.x, 2);
  if (auto tiling = std::dynamic_pointer_cast<TilingSprite>(owner.node)) expose("origin", &tiling->origin.x, 2);
  else if (auto tilemap = std::dynamic_pointer_cast<Tilemap>(owner.node)) expose("origin", &tilemap->origin.x, 2);
  else if (auto window = std::dynamic_pointer_cast<BoundWindow>(owner.node)) expose("origin", &window->origin.x, 2);
  return result;
} catch (const std::exception& error) { return throwException(env, error); }
napi_value children(napi_env env, napi_callback_info info) try {
  const auto args = arguments(env, info); if (args.empty() || args.size() > 2) throw std::invalid_argument("children requires display handle and optional previous list");
  auto& owner = display(env, args[0]); napi_value result;
  if (args.size() == 2) {
    bool array = false;
    check(env, napi_is_array(env, args[1], &array), "cannot inspect previous child list");
    if (array) {
      std::uint32_t length;
      check(env, napi_get_array_length(env, args[1], &length), "cannot inspect previous child count");
      bool same = length == owner.node->children.size();
      for (std::uint32_t i = 0; same && i < length; ++i) {
        napi_value child;
        check(env, napi_get_element(env, args[1], i, &child), "cannot inspect previous child");
        same = display(env, child).node == owner.node->children[i];
      }
      if (same) return args[1];
    }
  }
  check(env, napi_create_array_with_length(env, owner.node->children.size(), &result), "cannot list display children");
  for (std::size_t i = 0; i < owner.node->children.size(); ++i)
    check(env, napi_set_element(env, result, i, wrap(env, owner.services, owner.node->children[i])), "cannot list display child");
  return result;
} catch (const std::exception& error) { return throwException(env, error); }
struct ChildSnapshot { std::vector<std::uint64_t> identities; };
constexpr napi_type_tag childSnapshotTag{0x3bd4596c96ba4a8dULL,0xab934236fc6a104eULL};
napi_value childSnapshot(napi_env env,napi_callback_info info) try {
  const auto args=arguments(env,info);
  if(args.empty()||args.size()>2)throw std::invalid_argument("child snapshot requires display handle and optional previous snapshot");
  auto& owner=display(env,args[0]);
  if(args.size()==2) {
    napi_valuetype type;check(env,napi_typeof(env,args[1],&type),"cannot inspect child snapshot");
    if(type==napi_object) {
      bool tagged=false;check(env,napi_check_object_type_tag(env,args[1],&childSnapshotTag,&tagged),"cannot identify child snapshot");
      if(tagged) {
        const auto& previous=unwrap<ChildSnapshot>(env,args[1],childSnapshotTag);
        bool same=previous.identities.size()==owner.node->children.size();
        for(std::size_t i=0;same&&i<previous.identities.size();++i)same=previous.identities[i]==owner.node->children[i]->displayId;
        if(same)return args[1];
      }
    }
  }
  auto snapshot=std::make_unique<ChildSnapshot>();
  napi_value handles;check(env,napi_create_array_with_length(env,owner.node->children.size(),&handles),"cannot list child snapshot");
  for(std::size_t i=0;i<owner.node->children.size();++i) {
    const auto& child=owner.node->children[i];snapshot->identities.push_back(child->displayId);
    check(env,napi_set_element(env,handles,i,wrap(env,owner.services,child)),"cannot wrap child snapshot");
  }
  check(env,napi_object_freeze(env,handles),"cannot freeze child snapshot handles");
  auto result=moduleObject(env);
  check(env,napi_set_named_property(env,result,"handles",handles),"cannot publish child snapshot");
  check(env,napi_type_tag_object(env,result,&childSnapshotTag),"cannot tag child snapshot");
  check(env,napi_wrap(env,result,snapshot.get(),[](napi_env,void* data,void*) {delete static_cast<ChildSnapshot*>(data);},nullptr,nullptr),"cannot own child snapshot");
  snapshot.release();
  check(env,napi_object_freeze(env,result),"cannot freeze child snapshot");
  return result;
} catch(const std::exception& error) {return throwException(env,error);}
napi_value callWindow(napi_env env, napi_value receiver, const char* name, std::vector<napi_value> arguments = {}) {
  napi_value method, result;
  check(env, napi_get_named_property(env, receiver, name, &method), "cannot read window method");
  check(env, napi_call_function(env, receiver, method, arguments.size(), arguments.data(), &result), "window method failed");
  return result;
}
bool windowBoolean(napi_env env, napi_value receiver, const char* name, std::vector<napi_value> arguments = {}) {
  const auto value = callWindow(env, receiver, name, std::move(arguments));
  napi_value converted; check(env, napi_coerce_to_bool(env, value, &converted), "cannot read window predicate");
  return asBoolean(env, converted);
}
napi_value invoke(napi_env env, napi_callback_info info) try {
  const auto args = arguments(env, info); if (args.size() < 2) throw std::invalid_argument("display operation requires handle and method");
  auto& owner = display(env, args[0]); const auto method = asString(env, args[1]); auto& node = *owner.node;
  auto sprite = std::dynamic_pointer_cast<Sprite>(owner.node);
  auto window = std::dynamic_pointer_cast<BoundWindow>(owner.node);
  auto scene = std::dynamic_pointer_cast<mv::ScriptScene>(owner.node);
  auto scalar = [&](std::size_t index) { if (index >= args.size()) throw std::invalid_argument("missing display argument"); return asNumber(env, args[index]); };
  if(method=="parent") {
    auto* target=node.parent;if(!target)return null(env);
    auto parent=owner.services->nodes[target].lock();
    if(!parent) {
      auto* root=target;while(root->parent)root=root->parent;
      const auto find=[&](auto&& self,const std::shared_ptr<Container>& candidate)->std::shared_ptr<Container> {
        if(!candidate)return {};if(candidate.get()==target)return candidate;
        for(const auto& child:candidate->children)if(auto found=self(self,child))return found;
        return {};
      };
      parent=find(find,owner.services->nodes[root].lock());
    }
    if(!parent)throw std::runtime_error("native display parent has no live tree owner");
    return wrap(env,owner.services,parent);
  }
  if(method=="tilemapState"||method=="tilemapBitmaps") {
    const auto tilemap=std::dynamic_pointer_cast<Tilemap>(owner.node);
    if(!tilemap)throw std::invalid_argument("display is not a tilemap");
    if(method=="tilemapBitmaps") {
      napi_value result;check(env,napi_create_array_with_length(env,tilemap->bitmaps.size(),&result),"cannot list tile bitmaps");
      for(std::size_t i=0;i<tilemap->bitmaps.size();++i) {
        check(env,napi_set_element(env,result,i,wrapRuntimeBitmap(env,tilemap->bitmapOwners[i],owner.services->owner->core)),"cannot list tile bitmap");
      }
      return result;
    }
    if(args.size()!=11)throw std::invalid_argument("tilemap state requires dimensions, map data, flags, wrapping and bitmaps");
    const auto integers=[&](napi_value array) {
      std::uint32_t length;check(env,napi_get_array_length(env,array,&length),"tile data must be an array");std::vector<int> values;values.reserve(length);
      for(std::uint32_t i=0;i<length;++i) {napi_value value;check(env,napi_get_element(env,array,i,&value),"cannot read tile data");values.push_back(asInt32(env,value));}
      return values;
    };
    tilemap->setTileWidth(int(scalar(2)));tilemap->setTileHeight(int(scalar(3)));
    tilemap->setData(int(scalar(4)),int(scalar(5)),integers(args[6]));tilemap->flags=integers(args[7]);
    tilemap->horizontalWrap=asBoolean(env,args[8]);tilemap->verticalWrap=asBoolean(env,args[9]);
    std::array<std::shared_ptr<PixelBitmap>,9> bitmaps;
    std::uint32_t length;check(env,napi_get_array_length(env,args[10],&length),"tile bitmaps must be an array");
    for(std::uint32_t i=0;i<std::min(length,std::uint32_t(bitmaps.size()));++i) {
      napi_value value;check(env,napi_get_element(env,args[10],i,&value),"cannot read tile bitmap");napi_valuetype type;check(env,napi_typeof(env,value,&type),"cannot inspect tile bitmap");
      if(type!=napi_null&&type!=napi_undefined)bitmaps[i]=bitmapForRuntime(env,value,owner.services->owner->core);
    }
    tilemap->bitmapOwners=std::move(bitmaps);for(std::size_t i=0;i<tilemap->bitmaps.size();++i)tilemap->bitmaps[i]=tilemap->bitmapOwners[i].get();
    tilemap->refresh();return undefined(env);
  }
  if(method=="windowLayerMask") {
    const auto layer=std::dynamic_pointer_cast<WindowLayer>(owner.node);
    if(!layer)throw std::invalid_argument("window mask requires a window layer");
    if(args.size()>2) {
      napi_valuetype type;check(env,napi_typeof(env,args[2],&type),"cannot inspect window mask hook");
      if(type==napi_null)layer->maskHook={};
      else {
        struct Callback {
          napi_env env;napi_ref reference=nullptr;std::weak_ptr<DisplayServices> services;std::weak_ptr<WindowLayer> layer;
          ~Callback(){if(reference)napi_delete_reference(env,reference);}
        };
        auto callback=std::make_shared<Callback>();callback->env=env;callback->services=owner.services;callback->layer=layer;
        check(env,napi_create_reference(env,args[2],0,&callback->reference),"cannot retain window mask hook");
        layer->maskHook=[callback](Window& window)->std::optional<Rectangle> {
          const auto owner=callback->services.lock();const auto layer=callback->layer.lock();if(!owner||!layer)return {};
          napi_value function=nullptr,receiver,result;check(callback->env,napi_get_reference_value(callback->env,callback->reference,&function),"cannot read window mask hook");if(!function)return {};
          const auto node=std::find_if(layer->children.begin(),layer->children.end(),[&](const auto& child){return child.get()==&window;});
          if(node==layer->children.end())return {};
          const auto argument=wrap(callback->env,owner,*node);
          check(callback->env,napi_get_global(callback->env,&receiver),"cannot read window mask receiver");
          check(callback->env,napi_call_function(callback->env,receiver,function,1,&argument,&result),"window mask hook failed");
          std::array<double,4> values;
          for(std::uint32_t index=0;index<values.size();++index) {
            napi_value value;check(callback->env,napi_get_element(callback->env,result,index,&value),"cannot read window mask rectangle");values[index]=asNumber(callback->env,value);
            if(!std::isfinite(values[index]))throw std::invalid_argument("window mask rectangle must be finite");
          }
          return Rectangle{values[0],values[1],values[2],values[3]};
        };
      }
    }
    const auto& rectangle=layer->windowMaskRect; napi_value result;
    check(env,napi_create_array_with_length(env,4,&result),"cannot create window mask rectangle");
    const std::array values{rectangle.x,rectangle.y,rectangle.width,rectangle.height};
    for(std::uint32_t index=0;index<values.size();++index)check(env,napi_set_element(env,result,index,number(env,values[index])),"cannot return window mask rectangle");
    return result;
  }
  if(method=="displayTreeHooks") {
    struct Callback {
      napi_env env;napi_ref reference;std::weak_ptr<DisplayServices> services;
      ~Callback(){napi_delete_reference(env,reference);}
      bool invoke(Container& parent)const {
        const auto owner=services.lock();if(!owner)return false;
        napi_value function=nullptr,receiver,result;
        check(env,napi_get_reference_value(env,reference,&function),"cannot read display tree hook");if(!function)return false;
        const auto found=owner->nodes.find(&parent);
        const auto argument=found==owner->nodes.end()?null(env):wrap(env,owner,found->second.lock());
        check(env,napi_get_global(env,&receiver),"cannot read display tree receiver");
        check(env,napi_call_function(env,receiver,function,1,&argument,&result),"display tree hook failed");
        return asBoolean(env,result);
      }
    };
    const auto callback=[&](napi_value function) {
      auto value=std::make_shared<Callback>();value->env=env;value->services=owner.services;value->reference=nullptr;
      check(env,napi_create_reference(env,function,0,&value->reference),"cannot retain display tree hook");return value;
    };
    const auto added=callback(args.at(2)),removed=callback(args.at(3));
    node.addedHook=[added](Container& parent){added->invoke(parent);};
    node.removedHook=[removed](Container& parent){return removed->invoke(parent);};
    return undefined(env);
  }
  if((method=="windowPrepare" && window) || method=="displayPrepare") {
    struct Callback {
      napi_env env; napi_ref reference;
      ~Callback(){napi_delete_reference(env,reference);}
    };
    napi_ref reference;check(env,napi_create_reference(env,args.at(2),0,&reference),"cannot reference window preparation");
    auto callback=std::shared_ptr<Callback>(new Callback{env,reference});
    auto prepare=[callback] {
      napi_value function;check(callback->env,napi_get_reference_value(callback->env,callback->reference,&function),"cannot resolve window preparation");
      if(!function)return;
      napi_value receiver,result;check(callback->env,napi_get_global(callback->env,&receiver),"cannot resolve window receiver");
      check(callback->env,napi_call_function(callback->env,receiver,function,0,nullptr,&result),"window preparation failed");
    };
    if(method=="windowPrepare")window->prepareParts=std::move(prepare);else node.prepareRender=std::move(prepare);
    return undefined(env);
  }
  if(method=="windowCustomParts" && window){window->enableCustomParts();return undefined(env);}
  if(method=="windowTone" && window) {
    if(args.size()==5)window->setTone(scalar(2),scalar(3),scalar(4));
    napi_value result;check(env,napi_create_array_with_length(env,3,&result),"cannot create window tone");
    for(std::uint32_t i=0;i<3;++i)check(env,napi_set_element(env,result,i,number(env,window->tone[i])),"cannot write window tone");return result;
  }
  if(method=="cursorRect" && window) {
    napi_value result;check(env,napi_create_array_with_length(env,4,&result),"cannot create cursor rectangle");
    const auto& rect=window->cursorRect;const double values[]{rect.x,rect.y,rect.width,rect.height};
    for(std::uint32_t i=0;i<4;++i)check(env,napi_set_element(env,result,i,number(env,values[i])),"cannot write cursor rectangle");return result;
  }
  if(method=="windowPart" && window) {
    if(args.size()!=3 || asString(env,args[2])!="container")throw std::invalid_argument("window part is not bound");
    window->skinContainerExposed=true; window->refreshSkinContainer();
    return wrap(env,owner.services,window->skinContainer);
  }
  if (method=="canvasLocalX" || method=="canvasLocalY") {
    double value=scalar(2); for (auto* current=&node;current;current=current->parent) value-=method=="canvasLocalX" ? current->position.x : current->position.y;
    return number(env,value);
  }
  if (method=="buttonCold" || method=="buttonHot" || method=="buttonFrame" || method=="buttonTouch" || method=="buttonHit") {
    const auto target=std::dynamic_pointer_cast<BoundSprite>(owner.node);
    if (!target) throw std::invalid_argument("button operation requires a sprite");
    auto& button=target->button;
    if (method=="buttonCold") button.setColdFrame(scalar(2),scalar(3),scalar(4),scalar(5));
    else if (method=="buttonHot") button.setHotFrame(scalar(2),scalar(3),scalar(4),scalar(5));
    else if (method=="buttonFrame") { button.updateFrame(); const auto& f=button.frame; target->setFrame(f.x,f.y,f.width,f.height); }
    else if (method=="buttonTouch") return boolean(env,button.updateTouchState(asBoolean(env,args.at(2)),asBoolean(env,args.at(3)),asBoolean(env,args.at(4)),asBoolean(env,args.at(5))));
    else {
      double x=scalar(2),y=scalar(3); for (auto* current=&node;current;current=current->parent) { x-=current->position.x; y-=current->position.y; }
      button.visible=node.visible; button.position={}; button.frame={0,0,int(target->width()),int(target->height())};
      return boolean(env,button.isButtonTouched(x,y));
    }
    return undefined(env);
  }
  if(method=="spriteBitmapAssignedHook") {
    if(!sprite)throw std::invalid_argument("bitmap load hook requires a sprite");
    struct Callback {napi_env env;napi_ref reference;std::weak_ptr<DisplayServices> services;~Callback(){napi_delete_reference(env,reference);}};
    auto callback=std::make_shared<Callback>();callback->env=env;callback->services=owner.services;
    check(env,napi_create_reference(env,args.at(2),0,&callback->reference),"cannot retain bitmap load hook");
    sprite->resetBitmapListener();
    sprite->bitmapAssignedHook=[callback](const std::shared_ptr<PixelBitmap>& bitmap) {
      const auto services=callback->services.lock();if(!services)return false;
      napi_value function=nullptr,receiver,result;check(callback->env,napi_get_reference_value(callback->env,callback->reference,&function),"cannot read bitmap load hook");if(!function)return false;
      const auto argument=wrapRuntimeBitmap(callback->env,bitmap,services->owner->core);
      check(callback->env,napi_get_global(callback->env,&receiver),"cannot read bitmap load hook receiver");check(callback->env,napi_call_function(callback->env,receiver,function,1,&argument,&result),"sprite bitmap load hook failed");return true;
    };
    return undefined(env);
  }
  if(method=="renderWorld") {
    if(!sprite||!sprite->renderContext)return null(env);
    napi_value result;check(env,napi_create_array_with_length(env,6,&result),"cannot read sprite rendering transform");
    for(int i=0;i<6;++i)check(env,napi_set_element(env,result,i,number(env,sprite->renderContext->callbackWorld[i])),"cannot read sprite rendering transform");return result;
  }
  if(method=="renderSprite") {
    if(!sprite||!sprite->renderContext)throw std::logic_error("sprite default rendering requires an active sprite render hook");
    const auto context=*sprite->renderContext;const auto first=context.renderer->queuedCommandCount();
    std::optional<std::array<std::array<float,2>,4>> vertices;
    if(args.size()>2) {
      if(args.size()!=10)throw std::invalid_argument("sprite rendering requires eight vertex coordinates");
      vertices.emplace();for(int i=0;i<4;++i)for(int axis=0;axis<2;++axis) {const auto value=scalar(2+i*2+axis);if(!std::isfinite(value))throw std::invalid_argument("sprite vertices must be finite");(*vertices)[i][axis]=float(value);}
    }
    sprite->drawDefault(*context.renderer,context.world,context.opacity);
    if(vertices)context.renderer->setQueuedSpriteVertices(first,*vertices);
    return undefined(env);
  }
  if(method=="spriteRenderHook") {
    if(!sprite)throw std::invalid_argument("render hook requires a sprite");
    napi_valuetype type;check(env,napi_typeof(env,args.at(2),&type),"cannot inspect sprite render hook");
    if(type==napi_null){sprite->renderHook={};return undefined(env);}
    if(type!=napi_function)throw std::invalid_argument("sprite render hook must be callable");
    struct Callback {napi_env env;napi_ref reference;~Callback(){napi_delete_reference(env,reference);}};
    auto callback=std::make_shared<Callback>();callback->env=env;check(env,napi_create_reference(env,args[2],0,&callback->reference),"cannot retain sprite render hook");
    sprite->renderHook=[callback] {napi_value function,receiver,result;check(callback->env,napi_get_reference_value(callback->env,callback->reference,&function),"cannot read sprite render hook");if(!function)return false;
      check(callback->env,napi_get_global(callback->env,&receiver),"cannot read render hook receiver");check(callback->env,napi_call_function(callback->env,receiver,function,0,nullptr,&result),"sprite render hook failed");return asBoolean(callback->env,result);};
    return undefined(env);
  }
  if(method=="spriteTexture") {
    if(!sprite)throw std::invalid_argument("texture requires a sprite");
    napi_valuetype type;check(env,napi_typeof(env,args.at(2),&type),"cannot inspect sprite texture");
    if(type==napi_null) sprite->textureOverride.reset();
    else {if(args.size()!=8)throw std::invalid_argument("sprite texture requires bitmap, frame and resolution");const auto resolution=scalar(7);if(!std::isfinite(resolution)||resolution<=0)throw std::invalid_argument("texture resolution must be positive");sprite->textureOverride=Sprite::TextureOverride{bitmapForRuntime(env,args[2],owner.services->owner->core),{scalar(3),scalar(4),scalar(5),scalar(6)},resolution};}
    return undefined(env);
  }
  if(method=="filterGroups") {
    const auto groups=args.at(2);std::uint32_t length;check(env,napi_get_array_length(env,groups,&length),"cannot count native filter groups");
    std::vector<RenderCommand> commands;commands.reserve(length);
    const auto property=[&](napi_value object,const char* key) {napi_value value;check(env,napi_get_named_property(env,object,key,&value),"cannot read native filter group");return value;};
    for(std::uint32_t i=0;i<length;++i) {
      napi_value group;check(env,napi_get_element(env,groups,i,&group),"cannot read native filter group");
      const auto values=property(group,"parameters");std::uint32_t count;check(env,napi_get_array_length(env,values,&count),"cannot count native filter parameters");
      std::vector<float> parameters;parameters.reserve(count);
      for(std::uint32_t j=0;j<count;++j) {napi_value value;check(env,napi_get_element(env,values,j,&value),"cannot read native filter parameter");parameters.push_back(float(asNumber(env,value)));}
      auto resolution=property(group,"resolution");napi_valuetype type;check(env,napi_typeof(env,resolution,&type),"cannot inspect filter resolution");
      commands.push_back(owner.services->owner->renderer.nativeFilter(asUint32(env,property(group,"kind")),asUint32(env,property(group,"resource")),parameters,type==napi_undefined?1:float(asNumber(env,resolution))));
    }
    node.filterGroups=std::move(commands);node.glitchFilters.clear();return undefined(env);
  }
  if (method=="filterMatrix") {
    auto filter=std::dynamic_pointer_cast<BoundGlitchFilter>(owner.node);
    if (!filter || args.size()!=4) throw std::invalid_argument("color filter requires a matrix and alpha");
    napi_value length;check(env,napi_get_named_property(env,args[2],"length",&length),"cannot read color matrix length");
    if(asUint32(env,length)!=20)throw std::invalid_argument("color matrix requires twenty values");
    std::array<float,20> matrix;
    for (std::uint32_t i=0;i<matrix.size();++i) {napi_value value;check(env,napi_get_element(env,args[2],i,&value),"cannot read color matrix");matrix[i]=float(asNumber(env,value));}
    filter->value->colorMatrix=matrix;filter->value->alpha=asNumber(env,args[3]);
    return undefined(env);
  }
  if (method=="toneColor") {
    auto tone=std::dynamic_pointer_cast<ToneSprite>(owner.node);
    if (!tone || args.size()!=6) throw std::invalid_argument("tone requires four channels");
    tone->setTone(scalar(2),scalar(3),scalar(4),scalar(5));return undefined(env);
  }
  if (method == "add" || method == "addBack" || method == "remove") {
    if (args.size() < 3) throw std::invalid_argument("missing display child");
    auto& child = display(env, args[2]); if (child.services != owner.services) throw std::invalid_argument("display child belongs to another runtime");
    if (child.kind == "glitch") throw std::invalid_argument("filter is not a display child");
    if (method == "addBack") {
      if (!window) throw std::invalid_argument("back children require a window");
      window->addChildToBack(child.node);
    } else if (method == "add") node.addChildAt(child.node, args.size() > 3 ? asUint32(env, args[3]) : node.children.size());
    else node.removeChild(child.node.get());
  } else if (method == "replaceChildren") {
    std::vector<std::shared_ptr<Container>> replacement;
    for (std::size_t i=2;i<args.size();++i) {
      auto& child=display(env,args[i]);
      if (child.services!=owner.services || child.kind=="glitch") throw std::invalid_argument("invalid display child");
      for (auto* parent=&node;parent;parent=parent->parent)
        if (parent==child.node.get()) throw std::invalid_argument("cyclic display hierarchy");
      if (std::find(replacement.begin(),replacement.end(),child.node)!=replacement.end()) throw std::invalid_argument("duplicate display child");
      replacement.push_back(child.node);
    }
    const auto previous=node.children;
    for (const auto& child:previous)
      if (std::find(replacement.begin(),replacement.end(),child)==replacement.end()) node.removeChild(child.get());
    for (const auto& child:replacement) {
      if (child->parent && child->parent!=&node) child->parent->removeChild(child.get());
      if (child->parent != &node) { child->parent=&node; ++child->parentRevision; }
    }
    node.children=std::move(replacement); ++node.childrenRevision;
  } else if (method == "removeChildren") node.removeChildren();
  else if (method == "filters") {
    std::vector<std::shared_ptr<GlitchFilter>> filters;
    for (std::size_t i = 2; i < args.size(); ++i) {
      auto& filter = display(env, args[i]);
      if (filter.services != owner.services) throw std::invalid_argument("filter belongs to another runtime");
      auto glitch = std::dynamic_pointer_cast<BoundGlitchFilter>(filter.node);
      if (!glitch) throw std::invalid_argument("filter type is not bound");
      filters.push_back(glitch->value);
    }
    node.glitchFilters = std::move(filters);node.filterGroups.clear();
  }
  else if (method == "bitmap" || method == "contents" || method == "windowskin") {
    if(args.size()==2) {
      const auto bitmap=method=="bitmap"&&sprite?sprite->bitmap():method=="contents"&&window?window->contents:method=="windowskin"&&window?window->windowskin:nullptr;
      return wrapRuntimeBitmap(env,bitmap,owner.services->owner->core);
    }
    if (args.size() != 3) throw std::invalid_argument("bitmap assignment requires bitmap or null");
    napi_valuetype type; check(env, napi_typeof(env, args[2], &type), "cannot inspect bitmap");
    auto bitmap = type == napi_null ? nullptr : bitmapForRuntime(env, args[2], owner.services->owner->core);
    if (method == "bitmap" && sprite) sprite->setBitmap(std::move(bitmap));
    else if (method == "contents" && window) { window->contents = std::move(bitmap); window->model->setDrawingContents(window->contents); }
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
    mv::Window_Selectable::moveCursor(window->selection().index, window->selection().topRow, asInt32(env, args[2]), asInt32(env, args[3]), asInt32(env, args[4]), asInt32(env, args[5]), asBoolean(env, args[6]));
  } else if (method == "itemRect" && window) {
    if (args.size() != 7) throw std::invalid_argument("item rectangle requires index, columns, height, spacing and width");
    const int columns = asInt32(env, args[3]), spacing = asInt32(env, args[5]);
    const int contentsWidth = columns * (asInt32(env, args[6]) + spacing) - spacing;
    const auto rect = mv::Window_Selectable::itemRectFor(asInt32(env, args[2]), contentsWidth,
      asInt32(env, args[3]), asInt32(env, args[4]), asInt32(env, args[5]), window->selection().topRow);
    napi_value result; check(env, napi_create_array_with_length(env, 4, &result), "cannot return item rectangle");
    const std::array values{rect.x, rect.y, rect.width, rect.height};
    for (int i = 0; i < 4; ++i) check(env, napi_set_element(env, result, i, number(env, values[i])), "cannot return item rectangle component");
    return result;
  } else if (method == "cursorVisible" && window) {
    if (args.size() != 4) throw std::invalid_argument("cursor visibility requires columns and page rows");
    window->selection().maxCols = asInt32(env, args[2]);
    const int row = window->selection().row();
    return boolean(env, row >= window->selection().topRow && row <= std::max(0, window->selection().topRow + asInt32(env, args[3]) - 1));
  } else if (method == "setCommand" && window) {
    const auto index = asUint32(env, args.at(2));
    if (index >= window->command().commands.size()) throw std::out_of_range("command index is outside the list");
    auto& value = window->command().commands[index];
    value.name = asString(env, args.at(3)); value.symbol = asString(env, args.at(4)); value.enabled = asBoolean(env, args.at(5));
  } else if (method == "clearCommands" && window) window->command().commands.clear();
  else if (method == "addCommand" && window) {
    if (args.size() != 5) throw std::invalid_argument("command requires name, symbol and enabled flag");
    window->command().addCommand(asString(env, args[2]), asString(env, args[3]), asBoolean(env, args[4]));
  } else if (method == "cursorMovable" && window) {
    return boolean(env, mv::Window_Selectable::cursorMovable(asBoolean(env,args.at(2)), asBoolean(env,args.at(3)),
      asBoolean(env,args.at(4)), asInt32(env,args.at(5))));
  } else if (method == "ensureCursorVisible" && window) {
    window->selection().topRow = mv::Window_Selectable::visibleTopRow(window->selection().index, window->selection().topRow,
      asInt32(env,args.at(2)), asInt32(env,args.at(3)), asInt32(env,args.at(4)));
  } else if (method == "cursorStep" && window) {
    const int count = asInt32(env,args.at(2)), columns = asInt32(env,args.at(3)), rows = asInt32(env,args.at(4));
    const auto action = asString(env,args.at(5));
    int nextIndex = window->selection().index, nextTopRow = window->selection().topRow;
    if (action == "cursorPagedown" || action == "cursorPageup") {
      mv::Window_Selectable::pageCursor(nextIndex, nextTopRow, count, columns, rows, action == "cursorPagedown");
      window->selection().topRow = nextTopRow;
    }
    else {
      const int direction = action == "cursorDown" ? 2 : action == "cursorUp" ? 8 : action == "cursorRight" ? 6 : action == "cursorLeft" ? 4 : 0;
      if (!direction) throw std::invalid_argument("unknown cursor action");
      mv::Window_Selectable::moveCursor(nextIndex, nextTopRow, count, columns, rows, direction, asBoolean(env,args.at(6)));
    }
    return number(env,nextIndex);
  } else if (method == "processCursorMove" && window) {
    const auto self = args.at(2), source = args.at(3);
    if (!windowBoolean(env,self,"isCursorMovable")) return undefined(env);
    const auto repeated = [&](const char* key) { return windowBoolean(env,source,"isRepeated",{string(env,key)}); };
    const auto triggered = [&](const char* key) { return windowBoolean(env,source,"isTriggered",{string(env,key)}); };
    const bool down = repeated("down"), downTrigger = down && triggered("down");
    const bool up = repeated("up"), upTrigger = up && triggered("up");
    const bool right = repeated("right"), rightTrigger = right && triggered("right");
    const bool left = repeated("left"), leftTrigger = left && triggered("left");
    const bool pageDownHandled = windowBoolean(env,self,"isHandled",{string(env,"pagedown")});
    const bool pageUpHandled = windowBoolean(env,self,"isHandled",{string(env,"pageup")});
    const mv::Window_Selectable::CursorInput input{down,downTrigger,up,upTrigger,right,rightTrigger,left,leftTrigger,
      !pageDownHandled && triggered("pagedown"),!pageUpHandled && triggered("pageup"),pageDownHandled,pageUpHandled};
    static constexpr const char* methods[]{"cursorDown","cursorUp","cursorRight","cursorLeft","cursorPagedown","cursorPageup"};
    mv::Window_Selectable::dispatchCursorMove(true,input,[&](auto action, bool wrap) {
      callWindow(env,self,methods[static_cast<int>(action)],{boolean(env,wrap)});
    });
  } else if (method == "processHandling" && window) {
    const auto self = args.at(2), input = args.at(3);
    mv::Window_Selectable::dispatchHandling(windowBoolean(env,self,"isOpenAndActive"), [&](const char* action) {
      if (std::string(action) == "ok") return windowBoolean(env,self,"isOkEnabled");
      if (std::string(action) == "cancel") return windowBoolean(env,self,"isCancelEnabled");
      return windowBoolean(env,self,"isHandled",{string(env,action)});
    }, [&](const char* action) {
      if (std::string(action) == "ok") return windowBoolean(env,self,"isOkTriggered");
      if (std::string(action) == "cancel") return windowBoolean(env,self,"isCancelTriggered");
      return windowBoolean(env,input,"isTriggered",{string(env,action)});
    }, [&](const char* action) {
      callWindow(env,self,std::string(action) == "ok" ? "processOk" : std::string(action) == "cancel" ? "processCancel" : std::string(action) == "pagedown" ? "processPagedown" : "processPageup");
    });
  } else if ((method == "processOk" || method == "processCancel" || method == "processPagedown" || method == "processPageup") && window) {
    const auto self = args.at(2);
    if (method == "processOk" && !windowBoolean(env,self,"isCurrentItemEnabled")) callWindow(env,self,"playBuzzerSound");
    else {
      if (method == "processOk") callWindow(env,self,"playOkSound");
      else if (args.size() > 3) {
        napi_valuetype type; check(env,napi_typeof(env,args[3],&type),"cannot inspect sound manager");
        if (type != napi_undefined) callWindow(env,args[3],method == "processCancel" ? "playCancel" : "playCursor");
      }
      callWindow(env,self,"updateInputData"); callWindow(env,self,"deactivate");
      if (method == "processOk") callWindow(env,self,"callOkHandler");
      else if (method == "processCancel") callWindow(env,self,"callCancelHandler");
      else callWindow(env,self,"callHandler",{string(env,method == "processPagedown" ? "pagedown" : "pageup")});
    }
  } else if (method == "commandCount" && window) return number(env, window->command().maxItems());
  else if (method == "command" && window) {
    const int index = asInt32(env, args.at(2));
    if (index < 0 || index >= window->command().maxItems()) return null(env);
    const auto& command = window->command().commands[index]; auto result = moduleObject(env);
    check(env, napi_set_named_property(env, result, "name", string(env, command.name)), "cannot return command name");
    check(env, napi_set_named_property(env, result, "symbol", string(env, command.symbol)), "cannot return command symbol");
    check(env, napi_set_named_property(env, result, "enabled", boolean(env, command.enabled)), "cannot return command state");
    check(env,napi_set_named_property(env,result,"ext",number(env,command.ext)),"cannot return command extension");
    return result;
  } else if (method == "fadeSprite" && scene) {
    if (args.size() > 2) scene->fadeSprite = std::dynamic_pointer_cast<ScreenSprite>(display(env, args[2]).node);
    if (!scene->fadeSprite) { scene->fadeSprite = std::make_shared<ScreenSprite>(); scene->addChild(scene->fadeSprite); }
    return wrap(env, owner.services, scene->fadeSprite);
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
  } else if (method == "update" || method == "change" || method == "updateScene") {
    if (args.size() != 3) throw std::invalid_argument("scene update requires dispatcher");
    const auto dispatch=dispatcher(env, args[2], runtime);
    if (method == "change") scenes.changeScene(dispatch);
    else if (method == "updateScene") scenes.updateScene(dispatch);
    else scenes.update(dispatch);
  } else if (method == "current") return wrap(env, runtime, scenes.scene);
  else if (method == "next") return wrap(env, runtime, scenes.nextScene);
  else if (method == "changing") return boolean(env, scenes.changing);
  else if (method == "started") { if (args.size() == 3) scenes.started = asBoolean(env, args[2]); return boolean(env, scenes.started); }
  else if (method == "frameCount") { if (args.size()==3) { Graphics::frameCount=static_cast<std::uint64_t>(asNumber(env,args[2])); Graphics::frameCountWritten=true; } return number(env,Graphics::frameCount); }
  else if (method == "stopped") { if (args.size() == 3) scenes.stopped = asBoolean(env, args[2]); return boolean(env, scenes.stopped); }
  else throw std::invalid_argument("scene operation is not bound: " + method);
  return undefined(env);
} catch (const std::exception& error) { return throwException(env, error); }
napi_value inputOperation(napi_env env, napi_callback_info info) try {
  const auto args = arguments(env, info); if (args.size() < 2) throw std::invalid_argument("input operation requires runtime and operation");
  auto runtime = services(env, args[0]); auto& input = runtime->input; const auto method = asString(env, args[1]);
  if (method == "keyRepeatWait" || method == "keyRepeatInterval") {
    auto& value = method == "keyRepeatWait" ? input.keyRepeatWait : input.keyRepeatInterval;
    if (args.size() == 3) value = asNumber(env, args[2]);
    return number(env, value);
  }
  if (method=="_dir4" || method=="_dir8") {auto& value=method=="_dir4"?input.direction4():input.direction8();if(args.size()==3)value=asInt32(env,args[2]);return number(env,value);}
  if(method=="_date") {if(args.size()==3)input.dateState()=asNumber(env,args[2]);return number(env,input.date());}
  if (method=="_pressedTime") {
    if(args.size()==3)input.pressedTime()=asNumber(env,args[2]);return number(env,input.pressedTime());
  }
  if (method=="_preferredAxis") {
    if(args.size()==3) {const auto value=asString(env,args[2]);input.preferredAxis()=value.empty()?0:value[0];}
    return string(env,input.preferredAxis()?std::string(1,input.preferredAxis()):"");
  }
  if (method=="_gamepadStates") {
    auto& states=input.gamepadStates();
    const auto read=[&](napi_value array) {
      std::uint32_t count;check(env,napi_get_array_length(env,array,&count),"cannot count gamepad states");
      std::vector<std::optional<bool>> values;values.reserve(count);
      for(std::uint32_t i=0;i<count;++i) {napi_value item;napi_valuetype type;check(env,napi_get_element(env,array,i,&item),"cannot read gamepad state");check(env,napi_typeof(env,item,&type),"cannot inspect gamepad state");values.push_back(type==napi_undefined||type==napi_null?std::optional<bool>{}:asBoolean(env,item));}
      return values;
    };
    if(args.size()==4) {
      const int index=asInt32(env,args[2]);napi_valuetype type;check(env,napi_typeof(env,args[3],&type),"cannot inspect gamepad states");
      if(type==napi_null)states.erase(index);else states[index]=read(args[3]);
    } else if(args.size()==3) {
      napi_value keys;check(env,napi_get_property_names(env,args[2],&keys),"cannot inspect gamepad state indices");
      std::uint32_t count;check(env,napi_get_array_length(env,keys,&count),"cannot count gamepad state indices");states.clear();
      for(std::uint32_t i=0;i<count;++i) {napi_value key,value;check(env,napi_get_element(env,keys,i,&key),"cannot read gamepad index");check(env,napi_get_property(env,args[2],key,&value),"cannot read gamepad states");states[std::stoi(asString(env,key))]=read(value);}
    }
    napi_value result;check(env,napi_create_array(env,&result),"cannot create gamepad states");
    for(const auto& [index,values]:states) {
      napi_value array;check(env,napi_create_array_with_length(env,values.size(),&array),"cannot create gamepad buttons");
      for(std::uint32_t i=0;i<values.size();++i)if(values[i])check(env,napi_set_element(env,array,i,boolean(env,*values[i])),"cannot return gamepad button");
      check(env,napi_set_element(env,result,index,array),"cannot return gamepad states");
    }
    return result;
  }
  if (method=="_previousState") {
    auto& previous=input.previousState();
    if(args.size()==4) {
      const auto key=asString(env,args[2]);napi_valuetype type;check(env,napi_typeof(env,args[3],&type),"cannot inspect previous input state");
      if(type==napi_null)previous.erase(key);else previous[key]=asBoolean(env,args[3]);
    } else if(args.size()==3) {
      napi_value keys;check(env,napi_get_property_names(env,args[2],&keys),"cannot inspect previous input keys");
      std::uint32_t count;check(env,napi_get_array_length(env,keys,&count),"cannot count previous input keys");previous.clear();
      for(std::uint32_t i=0;i<count;++i) {napi_value key,value;check(env,napi_get_element(env,keys,i,&key),"cannot read previous input key");check(env,napi_get_property(env,args[2],key,&value),"cannot read previous input value");previous[asString(env,key)]=asBoolean(env,value);}
    }
    auto result=moduleObject(env);for(const auto& [key,value]:previous)check(env,napi_set_named_property(env,result,key.c_str(),boolean(env,value)),"cannot return previous input state");return result;
  }
  if (method == "_latestButton") {
    if (args.size() == 3) { napi_valuetype type; check(env,napi_typeof(env,args[2],&type),"cannot inspect latest button");
      input.setLatestButton(type == napi_null || type == napi_undefined ? std::optional<std::string>{} : asString(env,args[2])); }
    return input.latestButton() ? string(env,*input.latestButton()) : null(env);
  }
  if (method == "_currentState") {
    if (args.size() == 4) {
      const auto key = asString(env,args[2]); napi_valuetype type; check(env,napi_typeof(env,args[3],&type),"cannot inspect button state");
      if (type == napi_null) input.eraseCurrent(key); else input.setCurrent(key,asBoolean(env,args[3]));
    } else if (args.size() == 3) {
      napi_value keys; check(env,napi_get_property_names(env,args[2],&keys),"cannot inspect button states");
      std::uint32_t length; check(env,napi_get_array_length(env,keys,&length),"cannot inspect button state keys");
      std::vector<std::pair<std::string,bool>> values;
      for (std::uint32_t i=0;i<length;++i) { napi_value key,value;
        check(env,napi_get_element(env,keys,i,&key),"cannot read button state key");
        check(env,napi_get_property(env,args[2],key,&value),"cannot read button state"); values.emplace_back(asString(env,key),asBoolean(env,value)); }
      input.replaceCurrent(values);
    }
    auto result=moduleObject(env);
    for (const auto& [key,value]:input.currentState()) check(env,napi_set_named_property(env,result,key.c_str(),boolean(env,value)),"cannot return button state");
    return result;
  }
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
  if (method=="events") {
    auto& platform=runtime->owner->platform;const bool focused=platform.windowFocused();
    napi_value result;check(env,napi_create_array(env,&result),"cannot create input events");std::uint32_t index=0;
    const auto append=[&](const char* type,int code) {auto event=moduleObject(env);check(env,napi_set_named_property(env,event,"type",string(env,type)),"cannot write input type");check(env,napi_set_named_property(env,event,"keyCode",number(env,code)),"cannot write input key");check(env,napi_set_element(env,result,index++,event),"cannot append input event");};
    if(!focused&&runtime->focused)append("blur",0);runtime->focused=focused;
    if(focused)for(const auto& event:platform.keyEvents())append(event.down?"keydown":"keyup",event.keyCode);
    return result;
  }
  if (method=="advance") {
    const auto now=args.size()>2?asNumber(env,args[2]):double(std::chrono::duration_cast<std::chrono::milliseconds>(std::chrono::system_clock::now().time_since_epoch()).count());
    input.advance(double(now));return undefined(env);
  }
  if (method=="updateDirection") {input.updateDirection();return undefined(env);}
  if (method=="updateGamepad") {
    const auto object=args.at(2);Gamepad pad;
    const auto get=[&](napi_value parent,const char* key){napi_value value;check(env,napi_get_named_property(env,parent,key,&value),"cannot read gamepad");return value;};
    pad.index=asInt32(env,get(object,"index"));pad.connected=asBoolean(env,get(object,"connected"));
    for(const char* key:{"buttons","axes"}) {
      const auto array=get(object,key);std::uint32_t length;check(env,napi_get_array_length(env,array,&length),"cannot count gamepad values");
      for(std::uint32_t i=0;i<length;++i) {napi_value value;check(env,napi_get_element(env,array,i,&value),"cannot read gamepad value");if(std::string_view(key)=="axes")pad.axes.push_back(asNumber(env,value));else pad.buttons.push_back(asBoolean(env,get(value,"pressed")));}
    }
    input.updateGamepad(pad);return undefined(env);
  }
  if (method == "update") {
    auto& platform = runtime->owner->platform; const bool focused = platform.windowFocused();
    if (!focused && runtime->focused) input.clear();
    runtime->focused = focused;
    if (focused) for (const auto& event : platform.keyEvents()) { if (event.down) input.keyDown(event.keyCode); else input.keyUp(event.keyCode); }
    std::vector<Gamepad> pads;
    for (const auto& source : platform.gamepads()) {
      Gamepad pad; pad.index = source.index; pad.connected = source.connected; pad.axes = source.axes; pad.buttons.resize(17);
      for (const int button : source.buttonsDown) if (button >= 0 && button < 17) pad.buttons[button] = true;
      pads.push_back(std::move(pad));
    }
    const auto now = args.size()>2?asNumber(env,args[2]):double(std::chrono::duration_cast<std::chrono::milliseconds>(std::chrono::system_clock::now().time_since_epoch()).count());
    input.update(pads, now);
  } else if (method == "clear") { input.clear();runtime->focused=runtime->owner->platform.windowFocused(); }
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
napi_value wrapRuntimeDisplay(napi_env env, napi_value object, const std::shared_ptr<mv::core::Container>& node, RuntimeCore& runtime) {
  auto owner = services(env, object);
  if (&owner->owner->core != &runtime) throw std::invalid_argument("display belongs to another host");
  return wrap(env, owner, node);
}
std::shared_ptr<mv::Window_Base> windowModelForRuntime(napi_env env,napi_value object,RuntimeCore& runtime) {
  const auto window=std::dynamic_pointer_cast<BoundWindow>(displayForRuntime(env,object,runtime));
  if (!window) throw std::invalid_argument("window model requires a window display");
  window->synchronizeModel(); return window->model;
}
void setWindowModelForRuntime(napi_env env,napi_value object,RuntimeCore& runtime,std::shared_ptr<mv::Window_Base> model) {
  const auto window=std::dynamic_pointer_cast<BoundWindow>(displayForRuntime(env,object,runtime));
  if (!window) throw std::invalid_argument("window model requires a window display");
  window->model=std::move(model); window->model->setDrawingContents(window->contents);
  const auto& rect=window->model->rect;
  window->move(rect.x,rect.y,rect.width,rect.height); window->padding=window->model->padding;
  window->active=window->model->active; window->openness=window->model->openness;
  window->synchronizeSkinContainer();
}
void startDisplayAnimation(napi_env env, napi_value object, RuntimeCore& runtime, const mv::Value& animation, bool mirror, int delay, int rate) {
  auto sprite = std::dynamic_pointer_cast<BoundSprite>(displayForRuntime(env, object, runtime));
  if (!sprite) throw std::invalid_argument("animation target must be a sprite");
  for (int frame = 0; frame < static_cast<int>(animation["frames"].arrayLength()); ++frame)
    if (!mv::Sprite_Animation::cells(animation, frame, mirror).empty() || !mv::Sprite_Animation::timings(animation, frame).empty())
      throw std::runtime_error("display animation cells and timings are not bound");
  sprite->animations.push_back(std::make_shared<BoundSprite::Animation>(animation, mirror, delay, rate));
}
void registerDisplayBindings(napi_env env, napi_value exports) {
  auto api = moduleObject(env);
  method(env, api, "open", open); method(env, api, "create", create); method(env, api, "field", field);
  method(env, api, "children", children); method(env, api, "childSnapshot", childSnapshot); method(env, api, "invoke", invoke); method(env, api, "scene", sceneOperation);
  method(env, api, "input", inputOperation); method(env, api, "numericState", numericState);
  check(env, napi_set_named_property(env, exports, "mvDisplay", api), "cannot export display bindings");
}
}
