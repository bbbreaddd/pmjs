#include "node_addon_internal.hpp"
#include "mv_core_audio_graphics.hpp"
#include <algorithm>

namespace pmjs::addon {
namespace {
struct BitmapServices {
  std::shared_ptr<State> owner;
  explicit BitmapServices(std::shared_ptr<State> value) : owner(std::move(value)) {
    if (mv::core::boundRuntime() && mv::core::boundRuntime() != &owner->core)
      throw std::runtime_error("bitmap graphics services belong to another runtime");
    mv::core::bindRuntime(owner->core);
  }
  ~BitmapServices() { mv::core::unbindRuntime(owner->core); }
  void checkRuntime() const {
    if (mv::core::boundRuntime() != &owner->core)
      throw std::runtime_error("bitmap graphics runtime is no longer active");
  }
};
std::weak_ptr<BitmapServices> bitmapServices;
constexpr napi_type_tag bitmapServicesTag{0x26af92118dd84c3bULL, 0x9cb79133a6cb8ef0ULL};
std::shared_ptr<BitmapServices> services(napi_env env, napi_value object) {
  bool tagged = false;
  check(env,napi_check_object_type_tag(env,object,&bitmapServicesTag,&tagged),"invalid bitmap runtime");
  if (!tagged) throw std::invalid_argument("invalid bitmap runtime");
  std::shared_ptr<BitmapServices>* result = nullptr;
  check(env,napi_unwrap(env,object,reinterpret_cast<void**>(&result)),"invalid bitmap runtime");
  if (!result) throw std::invalid_argument("invalid bitmap runtime");
  (*result)->checkRuntime();
  return *result;
}
napi_value openBitmapRuntime(napi_env env, napi_callback_info) try {
  host(env);
  auto value = bitmapServices.lock();
  if (!value) { value = std::make_shared<BitmapServices>(state); bitmapServices = value; }
  if (value->owner != state) throw std::runtime_error("bitmap belongs to another host");
  value->checkRuntime();
  auto owner = std::make_unique<std::shared_ptr<BitmapServices>>(value);
  auto result = moduleObject(env);
  check(env,napi_type_tag_object(env,result,&bitmapServicesTag),"cannot identify bitmap runtime");
  check(env,napi_wrap(env,result,owner.get(),[](napi_env,void* data,void*) {
    delete static_cast<std::shared_ptr<BitmapServices>*>(data);
  },nullptr,nullptr),"cannot own bitmap runtime");
  owner.release();
  return result;
} catch (const std::exception& error) { return throwException(env,error); }
struct BitmapOwner {
  std::shared_ptr<BitmapServices> services;
  std::shared_ptr<mv::core::PixelBitmap> bitmap;
};
constexpr napi_type_tag bitmapTag{0xcff2e109a3e94cc1ULL, 0xa3a765dc21c1ec70ULL};
BitmapOwner& unwrapBitmap(napi_env env, napi_value object) {
  bool tagged = false;
  check(env, napi_check_object_type_tag(env, object, &bitmapTag, &tagged), "invalid bitmap handle");
  if (!tagged) throw std::invalid_argument("invalid bitmap handle");
  BitmapOwner* result = nullptr;
  check(env, napi_unwrap(env, object, reinterpret_cast<void**>(&result)), "invalid bitmap handle");
  if (!result) throw std::invalid_argument("invalid bitmap handle");
  result->services->checkRuntime();
  return *result;
}
napi_value createBitmap(napi_env env, napi_callback_info info) try {
  const auto args = arguments(env, info);
  if (args.size() != 2 && args.size() != 3) throw std::invalid_argument("bitmap creation requires runtime and dimensions or a URL");
  auto runtime = services(env,args[0]);
  auto bitmap = std::make_shared<mv::core::PixelBitmap>();
  if (args.size() == 2) bitmap->loadUrl(asString(env,args[1]));
  else {
    napi_valuetype type;
    check(env,napi_typeof(env,args[2],&type),"cannot inspect bitmap creation mode");
    if (type == napi_boolean && asBoolean(env,args[2])) bitmap = mv::core::PixelBitmap::request(asString(env,args[1]));
    else bitmap->resize(asInt32(env,args[1]),asInt32(env,args[2]));
  }
  auto owner = std::make_unique<BitmapOwner>(BitmapOwner{runtime, bitmap});
  napi_value result = moduleObject(env);
  check(env, napi_type_tag_object(env, result, &bitmapTag), "cannot identify bitmap");
  check(env, napi_wrap(env, result, owner.get(), [](napi_env, void* data, void*) {
    delete static_cast<BitmapOwner*>(data);
  }, nullptr, nullptr), "cannot own bitmap");
  owner.release();
  return result;
} catch (const std::exception& error) { return throwException(env, error); }

napi_value bitmapProperty(napi_env env, napi_callback_info info) try {
  const auto args = arguments(env, info);
  if (args.size() != 2 && args.size() != 3) throw std::invalid_argument("bitmap property requires handle, name and optional value");
  auto& bitmap = *unwrapBitmap(env, args[0]).bitmap;
  const auto name = asString(env, args[1]);
  const bool write = args.size() == 3;
  if (name == "width" && !write) return number(env, bitmap.width);
  if (name == "height" && !write) return number(env, bitmap.height);
  if ((name == "url" || name == "_url") && !write) return string(env, bitmap.url);
  if (name == "_loadingState" && !write) return string(env, bitmap.loadingState);
  const auto numeric = [&](double& value) { if (write) value = asNumber(env,args[2]); return number(env,value); };
  const auto text = [&](std::string& value) { if (write) value = asString(env,args[2]); return string(env,value); };
  const auto flag = [&](bool& value) { if (write) value = asBoolean(env,args[2]); return boolean(env,value); };
  if (name == "paintOpacity") {
    if (write) bitmap.paintOpacity = std::clamp(asNumber(env,args[2]),0.0,255.0);
    return number(env,bitmap.paintOpacity);
  }
  if (name == "fontSize") return numeric(bitmap.fontSize);
  if (name == "outlineWidth") return numeric(bitmap.outlineWidth);
  if (name == "fontFace") return text(bitmap.fontFace);
  if (name == "textColor") return text(bitmap.textColor);
  if (name == "outlineColor") return text(bitmap.outlineColor);
  if (name == "fontItalic") return flag(bitmap.fontItalic);
  if (name == "smooth") return flag(bitmap.smooth);
  throw std::invalid_argument("unknown or read-only bitmap property: " + name);
} catch (const std::exception& error) { return throwException(env, error); }

napi_value bitmapOperation(napi_env env, napi_callback_info info) try {
  const auto args = arguments(env, info);
  if (args.size() < 2) throw std::invalid_argument("bitmap operation requires handle and method");
  auto& owner = unwrapBitmap(env,args[0]);
  auto& bitmap = *owner.bitmap;
  const auto name = asString(env,args[1]);
  const auto value = [&](std::size_t index) { if (index+2 >= args.size()) throw std::invalid_argument("missing bitmap argument"); return args[index+2]; };
  const auto n = [&](std::size_t index) { return asNumber(env,value(index)); };
  const auto s = [&](std::size_t index) { return asString(env,value(index)); };
  if (name == "isReady") return boolean(env,bitmap.isReady());
  if (name == "isError") return boolean(env,bitmap.isError());
  if (name == "isRequestOnly") return boolean(env,bitmap.isRequestOnly());
  if (name == "isRequestReady") return boolean(env,bitmap.isRequestReady());
  if (name == "resize") bitmap.resize(asInt32(env,value(0)),asInt32(env,value(1)));
  else if (name == "decode") bitmap.decode();
  else if (name == "startRequest") bitmap.startRequest();
  else if (name == "touch") bitmap.touch();
  else if (name == "rotateHue") bitmap.rotateHue(n(0));
  else if (name == "adjustTone") bitmap.adjustTone(n(0),n(1),n(2));
  else if (name == "blur") bitmap.blur();
  else if (name == "clear") bitmap.clear();
  else if (name == "clearRect") bitmap.clearRect(n(0),n(1),n(2),n(3));
  else if (name == "fillRect") bitmap.fillRect(n(0),n(1),n(2),n(3),s(4));
  else if (name == "fillAll") bitmap.fillAll(s(0));
  else if (name == "gradientFillRect") bitmap.gradientFillRect(n(0),n(1),n(2),n(3),s(4),s(5),asBoolean(env,value(6)));
  else if (name == "drawCircle") bitmap.drawCircle(n(0),n(1),n(2),s(3));
  else if (name == "drawText") bitmap.drawText(s(0),n(1),n(2),n(3),n(4),s(5));
  else if (name == "measureTextWidth") return number(env,bitmap.measureTextWidth(s(0)));
  else if (name == "getPixel") return string(env,bitmap.getPixel(asInt32(env,value(0)),asInt32(env,value(1))));
  else if (name == "getAlphaPixel") return number(env,bitmap.getAlphaPixel(asInt32(env,value(0)),asInt32(env,value(1))));
  else if (name == "blt" || name == "bltImage") {
    auto& source = unwrapBitmap(env,value(0));
    if (source.services != owner.services) throw std::invalid_argument("cannot blit between bitmap runtimes");
    if (name == "blt") bitmap.blt(*source.bitmap,n(1),n(2),n(3),n(4),n(5),n(6),n(7),n(8));
    else bitmap.bltImage(*source.bitmap,n(1),n(2),n(3),n(4),n(5),n(6),n(7),n(8));
  } else if (name == "canvasSurface") {
    return imageInfo(env,bitmap.nativeCanvas(),bitmap.width,bitmap.height);
  } else if (name == "canvasChanged") {
    bitmap.pixels.clear();
    bitmap.dirty = true;
  } else if (name == "surface") {
    const auto image = bitmap.texture();
    if (!image) throw std::runtime_error("cannot prepare bitmap texture");
    return imageInfo(env,image->handle,image->width,image->height);
  } else throw std::invalid_argument("unknown bitmap operation: " + name);
  return undefined(env);
} catch (const std::exception& error) { return throwException(env, error); }

napi_value updateBitmapLoads(napi_env env, napi_callback_info info) try {
  const auto args = arguments(env,info);
  if (args.size() != 1) throw std::invalid_argument("bitmap update requires runtime");
  auto runtime = services(env,args[0]);
  mv::core::updateServices();
  return undefined(env);
} catch (const std::exception& error) { return throwException(env,error); }
napi_value loadBitmapFont(napi_env env, napi_callback_info info) try {
  const auto args = arguments(env,info);
  if (args.size() != 3) throw std::invalid_argument("bitmap font requires runtime, family and source");
  auto runtime = services(env,args[0]);
  const auto family = asString(env,args[1]), source = asString(env,args[2]);
  mv::core::Graphics::loadFont(family,source);
  if (!mv::core::Graphics::isFontLoaded(family)) throw std::runtime_error("cannot load bitmap font: " + source);
  return undefined(env);
} catch (const std::exception& error) { return throwException(env,error); }

}
void registerBitmapBindings(napi_env env, napi_value exports) {
  auto bindings = moduleObject(env);
  method(env,bindings,"open",openBitmapRuntime);
  method(env,bindings,"create",createBitmap);
  method(env,bindings,"loadFont",loadBitmapFont);
  method(env,bindings,"property",bitmapProperty);
  method(env,bindings,"invoke",bitmapOperation);
  method(env,bindings,"updateLoads",updateBitmapLoads);
  check(env,napi_set_named_property(env,exports,"mvBitmap",bindings),"cannot register bitmap API");
}
}
