#include "node_addon_internal.hpp"
#include "mv_core_audio_graphics.hpp"
#include "mv_core_utils.hpp"
#include <algorithm>

namespace pmjs::addon {
namespace {
struct BitmapServices {
  std::shared_ptr<State> owner;
  mv::ImageCache imageCache;
  mv::RequestQueue requests;
  explicit BitmapServices(std::shared_ptr<State> value) : owner(std::move(value)) {
    if (mv::core::boundRuntime() && mv::core::boundRuntime() != &owner->core)
      throw std::runtime_error("bitmap graphics services belong to another runtime");
    mv::core::bindRuntime(owner->core);
  }
  ~BitmapServices() { requests.clear(); imageCache.clear(); mv::core::unbindRuntime(owner->core); }
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
napi_value wrapBitmap(napi_env env, const std::shared_ptr<BitmapServices>& runtime, const std::shared_ptr<mv::core::PixelBitmap>& bitmap);
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
  return wrapBitmap(env, runtime, bitmap);
} catch (const std::exception& error) { return throwException(env, error); }
napi_value wrapBitmap(napi_env env, const std::shared_ptr<BitmapServices>& runtime, const std::shared_ptr<mv::core::PixelBitmap>& bitmap) {
  auto owner = std::make_unique<BitmapOwner>(BitmapOwner{runtime, bitmap});
  napi_value result = moduleObject(env);
  check(env, napi_type_tag_object(env, result, &bitmapTag), "cannot identify bitmap");
  check(env, napi_wrap(env, result, owner.get(), [](napi_env, void* data, void*) {
    delete static_cast<BitmapOwner*>(data);
  }, nullptr, nullptr), "cannot own bitmap");
  owner.release();
  return result;
}

napi_value managedImage(napi_env env, napi_callback_info info) try {
  const auto args = arguments(env, info);
  if (args.size() != 6) throw std::invalid_argument("managed image requires runtime, path, hue, smooth, mode and reservation");
  auto runtime = services(env, args[0]);
  const auto path = asString(env, args[1]); const int hue = asInt32(env, args[2]);
  const auto mode = asString(env, args[4]);
  const auto key = mv::ImageManager::generateCacheKey(path, hue);
  auto* cached = runtime->imageCache.get(key);
  if (!cached || !cached->bitmap) {
    auto bitmap = path.empty() ? std::make_shared<mv::core::PixelBitmap>() :
      mode == "request" ? mv::core::PixelBitmap::request(path) : mv::core::PixelBitmap::load(path);
    if (hue) {
      std::weak_ptr<mv::core::PixelBitmap> weak = bitmap;
      bitmap->addLoadListener([weak, hue] { if (auto image = weak.lock()) image->rotateHue(hue); });
    }
    runtime->imageCache.reserve(key, 0, 0);
    cached = runtime->imageCache.get(key); cached->bitmap = std::move(bitmap);
    cached->bitmapIdentity = mv::nextRuntimeIdentity(); cached->requestOnly = mode == "request";
    if (mode == "request") {
      std::weak_ptr<mv::core::PixelBitmap> weak = cached->bitmap;
      runtime->requests.enqueue(key, [weak] { if (auto image = weak.lock()) image->startRequest(); },
        [weak] { const auto image = weak.lock(); return !image || image->isRequestReady(); });
    }
  } else if (mode == "request") runtime->requests.raisePriority(key);
  if (mode != "request") { cached->requestOnly = false; cached->bitmap->decode(); }
  if (mode == "reserve") {
    std::uint64_t id; bool lossless;
    check(env, napi_get_value_bigint_uint64(env, args[5], &id, &lossless), "invalid image reservation");
    if (!lossless) throw std::invalid_argument("image reservation outside supported range");
    cached->reservationId = id;
  }
  cached->bitmap->smooth = asBoolean(env, args[3]);
  cached->ready = cached->bitmap->isReady(); cached->error = cached->bitmap->isError();
  cached->pixelCount = static_cast<std::size_t>(cached->bitmap->width) * cached->bitmap->height;
  const auto bitmap = cached->bitmap; const auto identity = cached->bitmapIdentity;
  runtime->imageCache.truncateCache();
  napi_value result = moduleObject(env), id;
  check(env, napi_create_bigint_uint64(env, identity, &id), "cannot identify managed bitmap");
  check(env, napi_set_named_property(env, result, "identity", id), "cannot set managed bitmap identity");
  check(env, napi_set_named_property(env, result, "handle", wrapBitmap(env, runtime, bitmap)), "cannot wrap managed bitmap");
  return result;
} catch (const std::exception& error) { return throwException(env, error); }

napi_value imageManagerOperation(napi_env env, napi_callback_info info) try {
  const auto args = arguments(env, info);
  auto runtime = services(env, args.at(0)); const auto operation = asString(env, args.at(1));
  if (operation == "clear") runtime->imageCache.clear();
  else if (operation == "release") {
    std::uint64_t id; bool lossless;
    check(env, napi_get_value_bigint_uint64(env, args.at(2), &id, &lossless), "invalid image reservation");
    if (!lossless) throw std::invalid_argument("image reservation outside supported range");
    runtime->imageCache.releaseReservation(id);
  } else if (operation == "clearRequests") runtime->requests.clear();
  else if (operation == "limit") runtime->imageCache.limit = std::max(0, asInt32(env, args.at(2)));
  else if (operation == "update") {
    runtime->requests.update();
    mv::core::updateServices();
    for (auto& [key, entry] : runtime->imageCache.items) {
      (void)key;
      if (!entry.bitmap) continue;
      entry.ready = entry.bitmap->isReady(); entry.error = entry.bitmap->isError();
      entry.pixelCount = static_cast<std::size_t>(entry.bitmap->width) * entry.bitmap->height;
    }
    runtime->imageCache.truncateCache();
  } else if (operation != "state") throw std::invalid_argument("unknown image manager operation");
  for (auto& [key, entry] : runtime->imageCache.items) {
    (void)key;
    if (entry.bitmap) { entry.ready = entry.bitmap->isReady(); entry.error = entry.bitmap->isError(); }
  }
  napi_value result = moduleObject(env), ids;
  check(env, napi_create_array(env, &ids), "cannot create managed bitmap identities");
  std::uint32_t index = 0;
  for (const auto& [key, entry] : runtime->imageCache.items) {
    (void)key; napi_value id;
    check(env, napi_create_bigint_uint64(env, entry.bitmapIdentity, &id), "cannot identify managed bitmap");
    check(env, napi_set_element(env, ids, index++, id), "cannot list managed bitmaps");
  }
  check(env, napi_set_named_property(env, result, "identities", ids), "cannot set managed bitmap identities");
  check(env, napi_set_named_property(env, result, "ready", boolean(env, runtime->imageCache.isReady())), "cannot set image readiness");
  const auto* error = runtime->imageCache.getErrorBitmap();
  check(env, napi_set_named_property(env, result, "error", error ? string(env, error->key) : null(env)), "cannot set image error");
  return result;
} catch (const std::exception& error) { return throwException(env, error); }
napi_value imagePath(napi_env env, napi_callback_info info) try {
  const auto args = arguments(env, info, 2);
  return string(env, mv::ImageManager::pathForFolder(asString(env, args.at(0)), asString(env, args.at(1))));
} catch (const std::exception& error) { return throwException(env, error); }
napi_value imageNameFlag(napi_env env, napi_callback_info info) try {
  const auto args = arguments(env, info, 2); const auto name = asString(env, args.at(1));
  const auto flag = asString(env, args.at(0));
  if (flag == "object") return boolean(env, mv::ImageManager::isObjectCharacter(name));
  if (flag == "big") return boolean(env, mv::ImageManager::isBigCharacter(name));
  if (flag == "zero") return boolean(env, mv::ImageManager::isZeroParallax(name));
  throw std::invalid_argument("unknown image filename flag");
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
    if (write) bitmap.paintOpacity = asNumber(env,args[2]);
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
  else if (name == "reset") bitmap = mv::core::PixelBitmap(asInt32(env,value(0)),asInt32(env,value(1)));
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
  else if (name == "drawText") {
    if (args.size() <= 2) return undefined(env);
    napi_valuetype type;
    check(env,napi_typeof(env,value(0),&type),"cannot inspect bitmap text");
    if (type != napi_undefined) bitmap.drawText(s(0),n(1),n(2),n(3),n(4),s(5));
  }
  else if (name == "measureTextWidth") return number(env,bitmap.measureTextWidth(s(0)));
  else if (name == "getPixel") return string(env,bitmap.getPixel(asInt32(env,value(0)),asInt32(env,value(1))));
  else if (name == "getAlphaPixel") return number(env,bitmap.getAlphaPixel(asInt32(env,value(0)),asInt32(env,value(1))));
  else if (name == "blt" || name == "bltImage") {
    auto& source = unwrapBitmap(env,value(0));
    if (source.services != owner.services) throw std::invalid_argument("cannot blit between bitmap runtimes");
    if (name == "blt") bitmap.blt(*source.bitmap,n(1),n(2),n(3),n(4),n(5),n(6),n(7),n(8));
    else bitmap.bltImage(*source.bitmap,n(1),n(2),n(3),n(4),n(5),n(6),n(7),n(8));
  } else if (name == "canvasSurface") {
    return imageInfo(env,bitmap.nativeCanvas(),bitmap.canvasWidth(),bitmap.canvasHeight());
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
std::shared_ptr<mv::core::PixelBitmap> bitmapForRuntime(napi_env env, napi_value object, RuntimeCore& runtime) {
  auto& bitmap = unwrapBitmap(env, object);
  bitmap.services->checkRuntime();
  if (&bitmap.services->owner->core != &runtime) throw std::invalid_argument("bitmap belongs to another graphics runtime");
  return bitmap.bitmap;
}
void registerBitmapBindings(napi_env env, napi_value exports) {
  auto bindings = moduleObject(env);
  method(env,bindings,"open",openBitmapRuntime);
  method(env,bindings,"create",createBitmap);
  method(env,bindings,"loadFont",loadBitmapFont);
  method(env,bindings,"property",bitmapProperty);
  method(env,bindings,"invoke",bitmapOperation);
  method(env,bindings,"updateLoads",updateBitmapLoads);
  method(env,bindings,"managedImage",managedImage); method(env,bindings,"imageManager",imageManagerOperation);
  method(env,bindings,"imagePath",imagePath);
  method(env,bindings,"imageNameFlag",imageNameFlag);
  check(env,napi_set_named_property(env,exports,"mvBitmap",bindings),"cannot register bitmap API");
}
}
