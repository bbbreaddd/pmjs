#include "mv_core_audio_graphics.hpp"
#include "mv_core_utils.hpp"
#include "runtime_core.hpp"
#include "canvas.hpp"
#include <algorithm>
#include <chrono>
#include <cmath>
#include <cstdio>
#include <cstdlib>
#include <fstream>
#include <sstream>
#include <map>
#include <set>
#include <stdexcept>
#include <regex>
#include <cctype>
#include "encrypted_audio_file.hpp"
extern "C" {
#include <libavutil/base64.h>
#include <libavcodec/avcodec.h>
}

namespace pmjs::mv::core {
struct CoreServiceBinding {
  RuntimeCore* runtime = nullptr;
  std::weak_ptr<void> lifetime;
  int users = 0;
  bool audioDisabled = false;
  AudioEncryptionKey audioKey{}; bool encryptedAudio = false;
  std::function<void()> stop, resume;
  std::function<std::optional<ImageInfo>(const std::string&)> imageLoader;
  std::function<void(const std::string&)> videoPlay;
  std::function<bool()> videoPlaying;
  std::function<void(double)> videoVolume;
  std::map<std::string,std::filesystem::path> fonts;
};
struct BitmapBacking {
  std::shared_ptr<CoreServiceBinding> services;
  std::uint32_t canvas = 0, image = 0;
  ~BitmapBacking() { if (services && services->runtime && !services->lifetime.expired()) { if(canvas)services->runtime->canvases().release(canvas);if(image)services->runtime->images().release(image); } }
};
namespace {
std::shared_ptr<CoreServiceBinding> active;
std::map<RuntimeCore*,std::weak_ptr<CoreServiceBinding>> bindings;
std::vector<std::weak_ptr<BitmapBacking>> surfaces;
std::set<WebAudio*> voices;
std::vector<std::function<void()>> pendingLoads;
std::unique_ptr<WebAudio> htmlAudio;
std::vector<std::function<void()>> htmlLoadListeners;
std::shared_ptr<PixelBitmap> loadingBitmap;
std::shared_ptr<PixelBitmap> overlayBitmap;
auto previousUpdate = std::chrono::steady_clock::now();
auto startedFrame = previousUpdate;
auto previousFrame = previousUpdate;
RuntimeCore& runtime(const std::shared_ptr<CoreServiceBinding>& services = active) {
  if (!services || !services->runtime || services->lifetime.expired()) throw std::logic_error("native graphics/audio services are not bound");
  return *services->runtime;
}
std::string sourcePath(std::string value) {
  if (value.starts_with("url(")) { value = value.substr(4,value.size()-5); if (value.size()>1 && (value.front()=='\'' || value.front()=='\"')) value = value.substr(1,value.size()-2); }
  if (value.starts_with("file://")) value.erase(0,7);
  std::string decoded;
  for (std::size_t index=0;index<value.size();++index) {
    if (value[index]=='%' && index+2<value.size()) { char* end=nullptr; const auto pair=value.substr(index+1,2); const auto byte=std::strtol(pair.c_str(),&end,16); if (end && *end==0) { decoded+=static_cast<char>(byte);index+=2;continue; } }
    decoded+=value[index];
  }
  return decoded;
}
std::optional<std::filesystem::path> resolve(const std::string& source,RuntimeCore& core) {
  const auto value=sourcePath(source);
  const std::filesystem::path path(value);
  if (path.is_absolute() && std::filesystem::is_regular_file(path)) return path;
  return core.vfs().resolve(value);
}
std::optional<std::vector<std::uint8_t>> dataUrl(const std::string& url) {
  if(!url.starts_with("data:"))return std::nullopt;
  const auto comma=url.find(',');if(comma==std::string::npos)throw std::invalid_argument("invalid data URL");
  const auto header=url.substr(0,comma),body=url.substr(comma+1);
  if(header.ends_with(";base64")) {
    std::vector<std::uint8_t> bytes(body.size()*3/4+4);
    const int count=av_base64_decode(bytes.data(),body.c_str(),bytes.size());
    if(count<0)throw std::invalid_argument("invalid base64 data URL");bytes.resize(count);return bytes;
  }
  const auto decoded=sourcePath(body);return std::vector<std::uint8_t>(decoded.begin(),decoded.end());
}
struct LoadedImage { ImageInfo info;bool owned=false; };
std::optional<LoadedImage> bitmapSource(const std::string& url,RuntimeCore& core) {
  if(const auto bytes=dataUrl(url)) {
    auto pixels=ImageStore::decodeMemory(bytes->data(),bytes->size());
    if(!pixels)return std::nullopt;
    const auto image=core.images().installDecodedMemory(std::move(*pixels),true);
    return image?std::optional<LoadedImage>{{*image,true}}:std::nullopt;
  }
  if(active->imageLoader) { const auto image=active->imageLoader(url);return image?std::optional<LoadedImage>{{*image,false}}:std::nullopt; }
  const auto path=resolve(url,core);if(!path)return std::nullopt;
  const auto image=core.images().loadPng(*path,true);return image?std::optional<LoadedImage>{{*image,true}}:std::nullopt;
}
std::uint32_t color(const std::string& text,double opacity=255) {
  const auto rgba=PixelBitmap::parseCssColor(text);
  return (std::uint32_t(rgba[0])<<24)|(std::uint32_t(rgba[1])<<16)|(std::uint32_t(rgba[2])<<8)|std::uint32_t(std::clamp(int(std::round(rgba[3]*opacity/255.0)),0,255));
}
}
RuntimeCore* boundRuntime() { return active && !active->lifetime.expired() ? active->runtime : nullptr; }
void bindRuntime(RuntimeCore& core) {
  auto existing=bindings[&core].lock();
  if (!existing || existing->lifetime.expired()) { existing=std::make_shared<CoreServiceBinding>();existing->runtime=&core;existing->lifetime=core.lifetime();bindings[&core]=existing; }
  active=existing;++active->users;
  auto& resources=::pmjs::mv::ResourceHandler::shared();
  resources.printLoadingError=[](const std::string& url){Graphics::printLoadingError(url);};
  resources.eraseLoadingError=[]{Graphics::eraseLoadingError();};
}
void unbindRuntime(RuntimeCore& core) {
  auto services=bindings[&core].lock(); if (!services || --services->users>0) return;
  for (auto* voice:voices) if (voice->services_==services) voice->release();
  if (active==services) {
    Html5Audio::clear();
    Html5Audio::initialized=false;
    Html5Audio::staticSeUrl.clear();
    pendingLoads.clear();
  }
  for (auto iterator=surfaces.begin();iterator!=surfaces.end();) {
    if (auto surface=iterator->lock()) { if (surface->services==services) { if(surface->canvas)core.canvases().release(surface->canvas);if(surface->image)core.images().release(surface->image);surface->canvas=0;surface->image=0; }++iterator; }
    else iterator=surfaces.erase(iterator);
  }
  services->runtime=nullptr;services->imageLoader={};services->videoPlay={};services->videoPlaying={};services->videoVolume={};
  if (active==services) { ::pmjs::mv::ResourceHandler::shared().clear();active.reset(); loadingBitmap.reset();overlayBitmap.reset();Graphics::loadedFonts.clear(); }
  bindings.erase(&core);
}
void updateServices() {
  const auto now=std::chrono::steady_clock::now();
  const double elapsed=std::chrono::duration<double,std::milli>(now-previousUpdate).count();previousUpdate=now;
  auto loads=std::move(pendingLoads);pendingLoads.clear();for(auto& load:loads)if(load)load();
  ::pmjs::mv::ResourceHandler::shared().update(elapsed);
  if(boundRuntime())Graphics::updateScale();
  const std::vector<WebAudio*> current(voices.begin(),voices.end());
  for (auto* voice:current) if (voices.contains(voice)) voice->update();
  if (htmlAudio) {
    htmlAudio->setVolume(Html5Audio::volume);
    Html5Audio::ready=htmlAudio->isReady();
    Html5Audio::error=htmlAudio->isError();
    const bool nowPlaying=htmlAudio->isPlaying();
    if (!Html5Audio::loop && Html5Audio::playing && !nowPlaying) Html5Audio::stop();
    else Html5Audio::playing=nowPlaying;
    Html5Audio::currentTime=htmlAudio->playbackPosition();
  }
}
PixelBitmap::PixelBitmap() { width=height=1; }
bool PixelBitmap::isReady() const { return (loadingState=="none"||loaded)&&(!backing_||(backing_->services&&backing_->services->runtime&&!backing_->services->lifetime.expired())); }
PixelBitmap::PixelBitmap(int w,int h) { resize(w,h); }
PixelBitmap::PixelBitmap(RuntimeCore& core,int w,int h) { if (boundRuntime()!=&core) bindRuntime(core);resize(w,h); }
PixelBitmap::PixelBitmap(const PixelBitmap& source) { *this=source; }
PixelBitmap::PixelBitmap(PixelBitmap&& source) noexcept
    : width(source.width), height(source.height), url(std::move(source.url)), smooth(source.smooth),
      dirty(source.dirty), loaded(source.loaded), error(source.error),
      paintOpacity(source.paintOpacity), fontSize(source.fontSize), fontFace(std::move(source.fontFace)),
      fontItalic(source.fontItalic), textColor(std::move(source.textColor)),
      outlineColor(std::move(source.outlineColor)), outlineWidth(source.outlineWidth),
      pixels(std::move(source.pixels)), loadListeners(std::move(source.loadListeners)),
      cacheEntry(std::move(source.cacheEntry)), loadingState(std::move(source.loadingState)), touchedAt(source.touchedAt),
      backing_(std::move(source.backing_)), requestedImage_(std::move(source.requestedImage_)),
      originalImage_(std::move(source.originalImage_)), failure_(std::move(source.failure_)),
      decodeAfterRequest_(source.decodeAfterRequest_), lifetime_(std::move(source.lifetime_)) {
  source.width = source.height = 0;
  source.dirty = false;
  source.loaded = false;
  source.error = false;
  source.loadingState = "none";
}
PixelBitmap& PixelBitmap::operator=(PixelBitmap&& source) noexcept {
  if (this == &source) return *this;
  backing_ = std::move(source.backing_);
  requestedImage_ = std::move(source.requestedImage_);
  originalImage_ = std::move(source.originalImage_);
  failure_ = std::move(source.failure_);
  decodeAfterRequest_ = source.decodeAfterRequest_;
  lifetime_ = std::move(source.lifetime_);
  width = source.width; height = source.height;
  url = std::move(source.url); smooth = source.smooth; dirty = source.dirty;
  loaded = source.loaded; error = source.error; loadingState = std::move(source.loadingState);
  touchedAt = source.touchedAt; paintOpacity = source.paintOpacity;
  fontSize = source.fontSize; fontFace = std::move(source.fontFace); fontItalic = source.fontItalic;
  textColor = std::move(source.textColor); outlineColor = std::move(source.outlineColor);
  outlineWidth = source.outlineWidth; pixels = std::move(source.pixels);
  loadListeners = std::move(source.loadListeners);
  cacheEntry = std::move(source.cacheEntry);
  source.width = source.height = 0;
  source.dirty = false;
  source.loaded = false;
  source.error = false;
  source.loadingState = "none";
  return *this;
}
PixelBitmap& PixelBitmap::operator=(const PixelBitmap& source) {
  if (this==&source) return *this;
  backing_.reset();requestedImage_.reset();originalImage_=source.originalImage_;lifetime_=std::make_shared<int>(0);failure_={};loadListeners.clear();
  width=source.width;height=source.height;url=source.url;smooth=source.smooth;loaded=source.loaded;error=source.error;loadingState=source.loadingState;
  paintOpacity=source.paintOpacity;fontSize=source.fontSize;fontFace=source.fontFace;fontItalic=source.fontItalic;textColor=source.textColor;outlineColor=source.outlineColor;outlineWidth=source.outlineWidth;
  pixels=source.pixels;
  if (!pixels.empty()) commitPixels();
  dirty=true;return *this;
}
std::uint32_t PixelBitmap::nativeCanvas() const {
  if (!backing_) {
    auto& core=runtime();const auto surface=core.canvases().create(std::max(1,width),std::max(1,height));
    if (!surface) throw std::runtime_error("cannot allocate bitmap surface");
    backing_=std::make_shared<BitmapBacking>();backing_->services=active;backing_->canvas=surface->handle;surfaces.push_back(backing_);
  }
  runtime(backing_->services);return backing_->canvas;
}
std::optional<ImageInfo> PixelBitmap::texture() const {
  auto& core=runtime(backing_ ? backing_->services : active);const auto image=core.canvases().prepareImage(nativeCanvas());
  return image ? core.images().inspect(*image) : std::optional<ImageInfo>{};
}
void PixelBitmap::syncPixels() {
  auto& core=runtime(backing_ ? backing_->services : active);
  const auto data=core.canvases().readPixels(nativeCanvas(),0,0,width,height);
  if (!data) throw std::runtime_error("cannot read bitmap pixels");pixels=data->rgba;
}
void PixelBitmap::commitPixels() {
  if (pixels.size()!=static_cast<std::size_t>(width)*height*4) throw std::invalid_argument("invalid bitmap pixel count");
  auto& core=runtime(backing_ ? backing_->services : active);
  if (!core.canvases().replacePixels(nativeCanvas(),pixels,PixelEncoding::StraightRGBA8)) throw std::runtime_error("cannot write bitmap pixels");
  dirty=true;
}
void PixelBitmap::changed() { dirty=true;syncPixels(); }
void PixelBitmap::resize(int w,int h) {
  width=std::max(1,w);height=std::max(1,h);backing_.reset();nativeCanvas();changed();
}
void PixelBitmap::touch() { touchedAt=std::chrono::duration_cast<std::chrono::milliseconds>(std::chrono::steady_clock::now().time_since_epoch()).count();if(cacheEntry)cacheEntry->touch(); }
void PixelBitmap::checkDirty() { if (dirty) { texture();dirty=false; } }
void PixelBitmap::setImageLoader(std::function<std::optional<ImageInfo>(const std::string&)> loader) { runtime();active->imageLoader=std::move(loader); }
std::shared_ptr<PixelBitmap> PixelBitmap::load(const std::string& source) { auto bitmap=std::make_shared<PixelBitmap>();bitmap->loadUrl(source);return bitmap; }
std::shared_ptr<PixelBitmap> PixelBitmap::request(const std::string& source) { auto bitmap=std::make_shared<PixelBitmap>();bitmap->url=source;bitmap->width=bitmap->height=0;bitmap->loadingState="pending";bitmap->loaded=false;return bitmap; }
void PixelBitmap::startRequest() {
  if (loadingState!="pending") return;
  loadingState="requesting";
  try {
    auto& core=runtime();const auto source=bitmapSource(url,core);
    if(!source)throw std::runtime_error("cannot request bitmap");
    if(!source->owned&&!core.images().retain(source->info.handle))throw std::runtime_error("cannot retain requested bitmap");
    requestedImage_=std::make_shared<BitmapBacking>();requestedImage_->services=active;requestedImage_->image=source->info.handle;surfaces.push_back(requestedImage_);
    width=source->info.width;height=source->info.height;loadingState="requestCompleted";
  } catch(const std::exception&) {
    if(!failure_) { const std::weak_ptr<int> alive=lifetime_;
      failure_=::pmjs::mv::ResourceHandler::shared().createLoader(url,[this,alive]{if(!alive.expired()){if(decodeAfterRequest_)loadNow();else{loadingState="pending";startRequest();}}},[this,alive]{if(!alive.expired()){error=true;loadingState="error";}});
    }
    failure_();
  }
}
bool PixelBitmap::isRequestReady() const { return loadingState!="pending" && loadingState!="requesting" && loadingState!="decrypting"; }
bool PixelBitmap::isRequestOnly() const { return !decodeAfterRequest_&&!isReady(); }
void PixelBitmap::decode() { if (!loaded) loadUrl(url); }
void PixelBitmap::loadUrl(const std::string& source) {
  url=source;loaded=false;error=false;decodeAfterRequest_=true;loadingState="requesting";if(!backing_)width=height=0;
  if (!failure_) {
    const std::weak_ptr<int> alive=lifetime_;
    failure_=::pmjs::mv::ResourceHandler::shared().createLoader(url,[alive,this]{if(!alive.expired())loadNow();},[alive,this]{if(!alive.expired()){error=true;loadingState="error";}});
  }
  const std::weak_ptr<int> alive=lifetime_;
  pendingLoads.push_back([this,alive]{if(!alive.expired())loadNow();});
}
void PixelBitmap::loadNow() {
  try {
    auto& core=runtime();std::optional<ImageInfo> source;
    const bool requested=bool(requestedImage_);bool borrowed=requested;
    if(requested)source=core.images().inspect(requestedImage_->image);
    else if(const auto loaded=bitmapSource(url,core)){source=loaded->info;borrowed=!loaded->owned;}
    if (!source) throw std::runtime_error("cannot load bitmap");
    resize(source->width,source->height);
    const bool copied=core.canvases().drawImage(nativeCanvas(),source->handle,0,0,width,height,0,0,width,height,1,smooth);
    if (!copied) { if(!borrowed)core.images().release(source->handle);throw std::runtime_error("cannot realize loaded bitmap"); }
    if(requested)originalImage_=requestedImage_;
    else {
      if(borrowed&&!core.images().retain(source->handle))throw std::runtime_error("cannot retain bitmap source image");
      originalImage_=std::make_shared<BitmapBacking>();originalImage_->services=active;originalImage_->image=source->handle;surfaces.push_back(originalImage_);
    }
    requestedImage_.reset();
    loaded=true;error=false;loadingState="loaded";changed();
  } catch (const std::exception&) { loaded=false;loadingState="requesting";if(failure_)failure_();else{error=true;loadingState="error";} }
  if(loaded)callLoadListeners();
}
std::shared_ptr<PixelBitmap> PixelBitmap::snap(const std::function<void()>& draw) {
  auto& core=runtime();
  auto bitmap=std::make_shared<PixelBitmap>(Graphics::width,Graphics::height);bitmap->pixels=core.renderer().snapshotScene(Graphics::width,Graphics::height,draw);bitmap->commitPixels();return bitmap;
}
void PixelBitmap::addLoadListener(std::function<void()> listener) { if(isReady())listener();else loadListeners.push_back(std::move(listener)); }
void PixelBitmap::callLoadListeners() { auto pending=std::move(loadListeners);loadListeners.clear();for(auto& listener:pending)if(listener)listener(); }
void PixelBitmap::clearRect(double x,double y,double w,double h) {
  if(!std::isfinite(x)||!std::isfinite(y)||!std::isfinite(w)||!std::isfinite(h))return;
  CanvasPathPaint path;path.paths={{{x,y},{x+w,y},{x+w,y+h},{x,y+h}}};path.closed={1};path.clear=true;
  if(!runtime(backing_?backing_->services:active).canvases().paintPath(nativeCanvas(),path))throw std::runtime_error("cannot clear bitmap rectangle");
  changed();
}
void PixelBitmap::clear() { runtime(backing_ ? backing_->services : active).canvases().clear(nativeCanvas());changed(); }
void PixelBitmap::fillRect(double x,double y,double w,double h,const std::string& value) {
  if(w<0){x+=w;w=-w;}if(h<0){y+=h;h=-h;}
  if(!std::isfinite(x)||!std::isfinite(y)||!std::isfinite(w)||!std::isfinite(h))return;
  if(!runtime(backing_?backing_->services:active).canvases().paintRect(nativeCanvas(),{float(x),float(y),float(w),float(h)},color(value,paintOpacity),0,{},{},{}))throw std::runtime_error("cannot fill bitmap rectangle");
  changed();
}
void PixelBitmap::fillAll(const std::string& value) { fillRect(0,0,width,height,value); }
void PixelBitmap::gradientFillRect(double x,double y,double w,double h,const std::string& first,const std::string& second,bool vertical) {
  const std::array<float,4> gradient{float(x),float(y),float(x+(vertical ? 0 : w)),float(y+(vertical ? h : 0))};
  if(w<0){x+=w;w=-w;}if(h<0){y+=h;h=-h;}
  runtime(backing_ ? backing_->services : active).canvases().paintRect(nativeCanvas(),{float(x),float(y),float(w),float(h)},0,0,gradient,{0,1},{color(first,paintOpacity),color(second,paintOpacity)});changed();
}
void PixelBitmap::drawCircle(double x,double y,double radius,const std::string& value) {
  CanvasCirclePaint circle;circle.x=x;circle.y=y;circle.radius=radius;circle.paint.color=color(value);circle.alpha=paintOpacity/255.0;
  runtime(backing_ ? backing_->services : active).canvases().paintCircle(nativeCanvas(),circle);changed();
}
void PixelBitmap::blt(const PixelBitmap& source,double sx,double sy,double sw,double sh,double dx,double dy,double dw,double dh) {
  if(std::isnan(dw)||dw==0)dw=sw;if(std::isnan(dh)||dh==0)dh=sh;
  if(sx<0||sy<0||sw<=0||sh<=0||sx+sw>source.width||sy+sh>source.height||dw<=0||dh<=0)return;
  runtime(backing_ ? backing_->services : active).canvases().drawImage(nativeCanvas(),source.nativeCanvas(),sx,sy,sw,sh,dx,dy,dw,dh,paintOpacity/255.0,true);changed();
}
void PixelBitmap::bltImage(const PixelBitmap& source,double sx,double sy,double sw,double sh,double dx,double dy,double dw,double dh) {
  if(std::isnan(dw)||dw==0)dw=sw;if(std::isnan(dh)||dh==0)dh=sh;
  if(sx<0||sy<0||sw<=0||sh<=0||sx+sw>source.width||sy+sh>source.height||dw<=0||dh<=0)return;
  if(!source.originalImage_||!source.originalImage_->image)throw std::invalid_argument("bitmap has no decoded image source");
  runtime(backing_?backing_->services:active).canvases().drawImage(nativeCanvas(),source.originalImage_->image,sx,sy,sw,sh,dx,dy,dw,dh,paintOpacity/255.0,true);changed();
}
std::string PixelBitmap::getPixel(int x,int y) const {
  if(x<0||y<0||x>=width||y>=height)return "#000000";
  const auto value=runtime(backing_ ? backing_->services : active).canvases().pixel(nativeCanvas(),x,y).value_or(0);
  char text[8];std::snprintf(text,sizeof(text),"#%06x",unsigned(value>>8));return text;
}
std::uint8_t PixelBitmap::getAlphaPixel(int x,int y) const {
  if(x<0||y<0||x>=width||y>=height)return 0;
  return runtime(backing_ ? backing_->services : active).canvases().pixel(nativeCanvas(),x,y).value_or(0)&255;
}
void PixelBitmap::adjustTone(double r,double g,double b) { runtime(backing_ ? backing_->services : active).canvases().adjustTone(nativeCanvas(),r,g,b);changed(); }
void PixelBitmap::rotateHue(double offset) { runtime(backing_ ? backing_->services : active).canvases().rotateHue(nativeCanvas(),offset);changed(); }
void PixelBitmap::blur() { if(!runtime(backing_ ? backing_->services : active).canvases().blurMv(nativeCanvas()))throw std::runtime_error("bitmap blur failed");changed(); }
std::string PixelBitmap::makeFontNameText() const { return std::string(fontItalic ? "Italic " : "")+numberString(fontSize)+"px "+fontFace; }
double PixelBitmap::measureTextWidth(const std::string& text) const {
  CanvasTextStyle style;style.italic=fontItalic;
  const auto width=runtime(backing_ ? backing_->services : active).canvases().measureText(Graphics::fonts(fontFace),text,fontSize,style);
  if(!width)throw std::runtime_error("bitmap font is unavailable");return *width;
}
void PixelBitmap::drawText(const std::string& text,double x,double y,double maxWidth,double lineHeight,const std::string& align) {
  auto& core=runtime(backing_ ? backing_->services : active);CanvasTextStyle style;style.italic=fontItalic;
  if(!maxWidth)maxWidth=0xffffffff;
  const double natural=measureTextWidth(text), actual=maxWidth>0?std::min(natural,maxWidth):natural;
  if(align=="center")x+=(maxWidth-actual)/2;else if(align=="right")x+=maxWidth-actual;
  const double baseline=y+(lineHeight+fontSize*0.7)/2;
  if(natural>0&&actual<natural) {style.transformed=true;style.transform={float(actual/natural),0,0,1,float(x*(1-actual/natural)),0};}
  const auto fonts=Graphics::fonts(fontFace);
  if(outlineWidth>0)core.canvases().drawText(nativeCanvas(),fonts,text,x,baseline,fontSize,color(outlineColor),outlineWidth,style);
  core.canvases().drawText(nativeCanvas(),fonts,text,x,baseline,fontSize,color(textColor,paintOpacity),0,style);changed();
}

std::array<std::uint8_t,4> PixelBitmap::parseCssColor(const std::string& source) {
  static const std::map<std::string,std::uint32_t> named{
    {"aliceblue",0xf0f8ff},
    {"antiquewhite",0xfaebd7},
    {"aqua",0x00ffff},
    {"aquamarine",0x7fffd4},
    {"azure",0xf0ffff},
    {"beige",0xf5f5dc},
    {"bisque",0xffe4c4},
    {"black",0x000000},
    {"blanchedalmond",0xffebcd},
    {"blue",0x0000ff},
    {"blueviolet",0x8a2be2},
    {"brown",0xa52a2a},
    {"burlywood",0xdeb887},
    {"cadetblue",0x5f9ea0},
    {"chartreuse",0x7fff00},
    {"chocolate",0xd2691e},
    {"coral",0xff7f50},
    {"cornflowerblue",0x6495ed},
    {"cornsilk",0xfff8dc},
    {"crimson",0xdc143c},
    {"cyan",0x00ffff},
    {"darkblue",0x00008b},
    {"darkcyan",0x008b8b},
    {"darkgoldenrod",0xb8860b},
    {"darkgray",0xa9a9a9},
    {"darkgreen",0x006400},
    {"darkgrey",0xa9a9a9},
    {"darkkhaki",0xbdb76b},
    {"darkmagenta",0x8b008b},
    {"darkolivegreen",0x556b2f},
    {"darkorange",0xff8c00},
    {"darkorchid",0x9932cc},
    {"darkred",0x8b0000},
    {"darksalmon",0xe9967a},
    {"darkseagreen",0x8fbc8f},
    {"darkslateblue",0x483d8b},
    {"darkslategray",0x2f4f4f},
    {"darkslategrey",0x2f4f4f},
    {"darkturquoise",0x00ced1},
    {"darkviolet",0x9400d3},
    {"deeppink",0xff1493},
    {"deepskyblue",0x00bfff},
    {"dimgray",0x696969},
    {"dimgrey",0x696969},
    {"dodgerblue",0x1e90ff},
    {"firebrick",0xb22222},
    {"floralwhite",0xfffaf0},
    {"forestgreen",0x228b22},
    {"fuchsia",0xff00ff},
    {"gainsboro",0xdcdcdc},
    {"ghostwhite",0xf8f8ff},
    {"gold",0xffd700},
    {"goldenrod",0xdaa520},
    {"gray",0x808080},
    {"green",0x008000},
    {"greenyellow",0xadff2f},
    {"grey",0x808080},
    {"honeydew",0xf0fff0},
    {"hotpink",0xff69b4},
    {"indianred",0xcd5c5c},
    {"indigo",0x4b0082},
    {"ivory",0xfffff0},
    {"khaki",0xf0e68c},
    {"lavender",0xe6e6fa},
    {"lavenderblush",0xfff0f5},
    {"lawngreen",0x7cfc00},
    {"lemonchiffon",0xfffacd},
    {"lightblue",0xadd8e6},
    {"lightcoral",0xf08080},
    {"lightcyan",0xe0ffff},
    {"lightgoldenrodyellow",0xfafad2},
    {"lightgray",0xd3d3d3},
    {"lightgreen",0x90ee90},
    {"lightgrey",0xd3d3d3},
    {"lightpink",0xffb6c1},
    {"lightsalmon",0xffa07a},
    {"lightseagreen",0x20b2aa},
    {"lightskyblue",0x87cefa},
    {"lightslategray",0x778899},
    {"lightslategrey",0x778899},
    {"lightsteelblue",0xb0c4de},
    {"lightyellow",0xffffe0},
    {"lime",0x00ff00},
    {"limegreen",0x32cd32},
    {"linen",0xfaf0e6},
    {"magenta",0xff00ff},
    {"maroon",0x800000},
    {"mediumaquamarine",0x66cdaa},
    {"mediumblue",0x0000cd},
    {"mediumorchid",0xba55d3},
    {"mediumpurple",0x9370db},
    {"mediumseagreen",0x3cb371},
    {"mediumslateblue",0x7b68ee},
    {"mediumspringgreen",0x00fa9a},
    {"mediumturquoise",0x48d1cc},
    {"mediumvioletred",0xc71585},
    {"midnightblue",0x191970},
    {"mintcream",0xf5fffa},
    {"mistyrose",0xffe4e1},
    {"moccasin",0xffe4b5},
    {"navajowhite",0xffdead},
    {"navy",0x000080},
    {"oldlace",0xfdf5e6},
    {"olive",0x808000},
    {"olivedrab",0x6b8e23},
    {"orange",0xffa500},
    {"orangered",0xff4500},
    {"orchid",0xda70d6},
    {"palegoldenrod",0xeee8aa},
    {"palegreen",0x98fb98},
    {"paleturquoise",0xafeeee},
    {"palevioletred",0xdb7093},
    {"papayawhip",0xffefd5},
    {"peachpuff",0xffdab9},
    {"peru",0xcd853f},
    {"pink",0xffc0cb},
    {"plum",0xdda0dd},
    {"powderblue",0xb0e0e6},
    {"purple",0x800080},
    {"rebeccapurple",0x663399},
    {"red",0xff0000},
    {"rosybrown",0xbc8f8f},
    {"royalblue",0x4169e1},
    {"saddlebrown",0x8b4513},
    {"salmon",0xfa8072},
    {"sandybrown",0xf4a460},
    {"seagreen",0x2e8b57},
    {"seashell",0xfff5ee},
    {"sienna",0xa0522d},
    {"silver",0xc0c0c0},
    {"skyblue",0x87ceeb},
    {"slateblue",0x6a5acd},
    {"slategray",0x708090},
    {"slategrey",0x708090},
    {"snow",0xfffafa},
    {"springgreen",0x00ff7f},
    {"steelblue",0x4682b4},
    {"tan",0xd2b48c},
    {"teal",0x008080},
    {"thistle",0xd8bfd8},
    {"tomato",0xff6347},
    {"turquoise",0x40e0d0},
    {"violet",0xee82ee},
    {"wheat",0xf5deb3},
    {"white",0xffffff},
    {"whitesmoke",0xf5f5f5},
    {"yellow",0xffff00},
    {"yellowgreen",0x9acd32},
  };
  auto text=source;std::transform(text.begin(),text.end(),text.begin(),[](unsigned char c){return std::tolower(c);});
  const auto first=text.find_first_not_of(" \t\r\n"),last=text.find_last_not_of(" \t\r\n");
  if(first==std::string::npos)throw std::invalid_argument("invalid bitmap color");text=text.substr(first,last-first+1);
  if(text=="transparent")return {0,0,0,0};
  if(const auto found=named.find(text);found!=named.end())return {std::uint8_t(found->second>>16),std::uint8_t(found->second>>8),std::uint8_t(found->second),255};
  if(text.front()=='#') {
    auto digits=text.substr(1);if(digits.size()==3||digits.size()==4){std::string expanded;for(char c:digits){expanded+=c;expanded+=c;}digits=expanded;}
    if((digits.size()!=6&&digits.size()!=8)||digits.find_first_not_of("0123456789abcdef")!=std::string::npos)throw std::invalid_argument("invalid bitmap color");
    if(digits.size()==6)digits+="ff";const auto value=std::stoul(digits,nullptr,16);return {std::uint8_t(value>>24),std::uint8_t(value>>16),std::uint8_t(value>>8),std::uint8_t(value)};
  }
  const auto open=text.find('(');if(open==std::string::npos||text.back()!=')')throw std::invalid_argument("invalid bitmap color");
  const auto mode=text.substr(0,open);auto body=text.substr(open+1,text.size()-open-2);for(auto& ch:body)if(ch==','||ch=='/')ch=' ';
  std::istringstream stream(body);std::vector<std::string> parts;for(std::string part;stream>>part;)parts.push_back(part);
  if(parts.size()<3||parts.size()>4)throw std::invalid_argument("invalid bitmap color");
  const auto component=[](const std::string& value,double scale){return value=="none"?0:std::stod(value)*(value.back()=='%'?scale/100:1);};
  const double alpha=parts.size()==4?component(parts[3],1):1;std::array<double,3> channels{};
  if(mode=="rgb"||mode=="rgba")for(int index=0;index<3;++index)channels[index]=component(parts[index],255);
  else if(mode=="hsl"||mode=="hsla"||mode=="hwb") {
    double hue=component(parts[0],1);if(parts[0].ends_with("turn"))hue*=360;else if(parts[0].ends_with("rad")&&!parts[0].ends_with("grad"))hue*=180/3.14159265358979323846;else if(parts[0].ends_with("grad"))hue*=0.9;
    hue=std::fmod(std::fmod(hue,360)+360,360)/60;const double second=std::clamp(component(parts[1],1),0.0,1.0),third=std::clamp(component(parts[2],1),0.0,1.0);
    const double chroma=mode=="hwb"?1:(1-std::abs(2*third-1))*second, x=chroma*(1-std::abs(std::fmod(hue,2)-1)),m=mode=="hwb"?0:third-chroma/2;
    channels=hue<1?std::array<double,3>{chroma,x,0}:hue<2?std::array<double,3>{x,chroma,0}:hue<3?std::array<double,3>{0,chroma,x}:hue<4?std::array<double,3>{0,x,chroma}:hue<5?std::array<double,3>{x,0,chroma}:std::array<double,3>{chroma,0,x};
    for(auto& channel:channels)channel=mode=="hwb"?(second+third>=1?second/(second+third):channel*(1-second-third)+second)*255:(channel+m)*255;
  } else throw std::invalid_argument("invalid bitmap color");
  const auto byte=[](double value){return std::uint8_t(std::clamp(std::round(value),0.0,255.0));};return {byte(channels[0]),byte(channels[1]),byte(channels[2]),byte(alpha*255)};
}
bool Graphics::initialize(int w,int h,const std::string& type) {
  if(type!="auto"&&type!="webgl"&&type!="canvas")throw std::invalid_argument("invalid graphics renderer type");
  resize(w,h);boxWidth=w;boxHeight=h;frameCount=0;loading=false;loadingCount=0;errorName.clear();errorMessage.clear();loadingError.clear();
  webgl=true;previousFrame=std::chrono::steady_clock::now();return boundRuntime()!=nullptr;
}
void Graphics::resize(int w,int h) {
  if(w<=0||h<=0)throw std::invalid_argument("invalid graphics size");
  width=w;height=h;runtime().resizeLogicalScreen(w,h);
  updateScale();overlayBitmap.reset();
}
void Graphics::tickStart() {
  const auto now=std::chrono::steady_clock::now();const auto interval=std::chrono::duration<double>(now-previousFrame).count();
  if(interval>0)fps=fps>0?fps*0.9+0.1/interval:1/interval;previousFrame=now;startedFrame=now;
}
void Graphics::tickEnd() { frameTime=std::chrono::duration<double,std::milli>(std::chrono::steady_clock::now()-startedFrame).count(); }
void Graphics::render() { updateServices();presentOverlay();runtime().canvases().uploadDirty();runtime().renderer().render();++frameCount; }
void Graphics::setLoadingImage(const std::string& source) { loadingImage=source;loadingBitmap=PixelBitmap::load(source); }
void Graphics::startLoading() { loading=true;loadingCount=0; }
void Graphics::updateLoading() { if(loading)++loadingCount; }
void Graphics::endLoading() { loading=false;loadingCount=0; }
void Graphics::printLoadingError(const std::string& source) { loadingError=source;if(active&&active->stop)active->stop(); }
void Graphics::eraseLoadingError() { loadingError.clear();if(active&&active->resume)active->resume(); }
void Graphics::printError(const std::string& name,const std::string& message) {
  errorName=name;errorMessage=message;loading=false;if(active&&active->stop)active->stop();
  std::fprintf(stderr,"%s: %s\n",name.c_str(),message.c_str());
}
void Graphics::setLoadingCallbacks(std::function<void()> stop,std::function<void()> resume) {
  runtime();active->stop=std::move(stop);active->resume=std::move(resume);
  ::pmjs::mv::ResourceHandler::shared().stop=[]{if(active&&active->stop)active->stop();};
  ::pmjs::mv::ResourceHandler::shared().resume=[]{if(active&&active->resume)active->resume();};
}
void Graphics::loadFont(const std::string& family,const std::string& source) {
  auto& core=runtime();const auto path=resolve(source,core);
  if(!path||!core.canvases().canLoadFont(*path))return;
  active->fonts[family]=*path;
  if(std::find(loadedFonts.begin(),loadedFonts.end(),family)==loadedFonts.end())loadedFonts.push_back(family);
}
bool Graphics::isFontLoaded(const std::string& family) { return active&&active->fonts.contains(family); }
std::vector<std::filesystem::path> Graphics::fonts(const std::string& families) {
  runtime();std::vector<std::filesystem::path> result;std::istringstream input(families);
  for(std::string family;std::getline(input,family,',');) {
    const auto begin=family.find_first_not_of(" \t\"'"),end=family.find_last_not_of(" \t\"'");
    if(begin==std::string::npos)continue;family=family.substr(begin,end-begin+1);
    if(const auto found=active->fonts.find(family);found!=active->fonts.end())result.push_back(found->second);
  }
  if(result.empty())if(const auto found=active->fonts.find("GameFont");found!=active->fonts.end())result.push_back(found->second);
  return result;
}
std::string Graphics::canPlayVideoType(const std::string& type) {
  const auto codec=[](const char* name){return avcodec_find_decoder_by_name(name)!=nullptr;};
  const auto base=type.substr(0,type.find(';'));
  const bool available=base=="video/webm"?(codec("vp8")||codec("vp9")):base=="video/mp4"||base=="video/x-m4v"||base=="video/quicktime"?(codec("h264")||codec("mpeg4")):base=="video/ogg"?codec("theora"):false;
  return available?"probably":"";
}
void Graphics::setVideoCallbacks(std::function<void(const std::string&)> play,std::function<bool()> playing,std::function<void(double)> volume) {
  runtime();active->videoPlay=std::move(play);active->videoPlaying=std::move(playing);active->videoVolume=std::move(volume);
}
void Graphics::playVideo(const std::string& source) {
  runtime();if(!active->videoPlay)throw std::logic_error("native video presentation is not attached");
  active->videoPlay(source);videoPlaying=active->videoPlaying?active->videoPlaying():true;
}
bool Graphics::isVideoPlaying() { videoPlaying=active&&active->videoPlaying&&active->videoPlaying();return videoPlaying; }
void Graphics::setVideoVolume(double value) { videoVolume=std::clamp(value,0.0,1.0);if(active&&active->videoVolume)active->videoVolume(videoVolume); }
void Graphics::updateScale() {
  if(!boundRuntime())return;
  auto& core=runtime();core.syncDrawableSize();
  const auto drawable=core.platform().drawableSize();
  const double ratio=double(drawable.first)/std::max(1,core.platform().windowWidth());
  if(stretchEnabled)core.renderer().setPresentationViewport(0,0,0);
  else core.renderer().setPresentationViewport(std::max(1,int(std::round(width*scale*ratio))),std::max(1,int(std::round(height*scale*ratio))),0);
  const auto geometry=core.renderer().presentationGeometry();
  realScale=geometry.viewportWidth>0?double(geometry.viewportWidth)/width/std::max(0.001,ratio):scale;
}
void Graphics::onKeyDown(int key,bool control,bool alt) {
  if(control||alt)return;
  if(key==113){fpsMode=(fpsMode+1)%3;fpsVisible=fpsMode!=0;}
  else if(key==114){stretchEnabled=!stretchEnabled;updateScale();}
  else if(key==115){auto& platform=runtime().platform();platform.setFullscreen(!platform.fullscreen());updateScale();}
}
bool Graphics::onPointerDown(double x,double y) {
  if(!isInsideCanvas(x,y)||!::pmjs::mv::ResourceHandler::shared().exists())return false;
  ::pmjs::mv::ResourceHandler::shared().retry();return true;
}
double Graphics::pageToCanvasX(double x,double left) {
  if(std::isnan(left))left=boundRuntime()?(runtime().platform().windowWidth()-width*realScale)/2:0;
  return std::floor((x-left)/std::max(0.001,realScale)+0.5);
}
double Graphics::pageToCanvasY(double y,double top) {
  if(std::isnan(top))top=boundRuntime()?(runtime().platform().windowHeight()-height*realScale)/2:0;
  return std::floor((y-top)/std::max(0.001,realScale)+0.5);
}
bool Graphics::isInsideCanvas(double x,double y) { return x>=0&&x<width&&y>=0&&y<height; }
void Graphics::callGC() { runtime().images().trimPreparedPageTextures(); }
void Graphics::presentOverlay() {
  if(!active||!active->runtime||active->lifetime.expired())return;
  auto& core=runtime();
  if(loading && loadingCount>=20 && loadingBitmap && loadingBitmap->isReady()) {
    if(const auto image=loadingBitmap->texture())core.renderer().queueImage(image->handle,{1,0,0,1,float((width-image->width)/2),float((height-image->height)/2)},
      {0,0,float(image->width),float(image->height)},float(std::clamp((loadingCount-20)/30.0,0.0,1.0)),0xffffff,BlendMode::normal);
  }
  if(errorName.empty()&&loadingError.empty()&&!fpsVisible)return;
  if(!overlayBitmap||overlayBitmap->width!=width||overlayBitmap->height!=height)overlayBitmap=std::make_shared<PixelBitmap>(width,height);
  overlayBitmap->clear();overlayBitmap->fontSize=errorName.empty()&&loadingError.empty()?20:28;
  if(!errorName.empty()||!loadingError.empty()) {
    core.renderer().queueQuad(0,0,width,height,{0,0,0,0.6F});
    const auto heading=errorName.empty()?"Loading Error":errorName;
    const auto detail=errorName.empty()?"Failed to load: "+loadingError+"\nRetry to continue.":errorMessage;
    if(!fonts("GameFont").empty()) {
      overlayBitmap->drawText(heading,20,20,width-40,48);
      std::istringstream lines(detail);int y=80;for(std::string line;std::getline(lines,line);y+=36)overlayBitmap->drawText(line,20,y,width-40,36);
    }
  } else if(!fonts("GameFont").empty())overlayBitmap->drawText((fpsMode==2?std::to_string(int(std::round(frameTime)))+" ms":std::to_string(int(std::round(fps)))+" FPS"),8,4,width-16,28);
  if(const auto image=overlayBitmap->texture())core.renderer().queueImage(image->handle,{1,0,0,1,0,0},{0,0,float(width),float(height)},1,0xffffff,BlendMode::normal);
}
WebAudio::WebAudio(std::string source, bool deferLoad, bool reportResourceErrors)
    : url(std::move(source)), services_(active), useResourceHandler_(reportResourceErrors) {
  voices.insert(this);
  if (url.empty() || !services_ || !services_->runtime || services_->lifetime.expired()) return;
  if (!deferLoad) {
    loadNow();
    return;
  }
  loading_ = true;
  const std::weak_ptr<int> alive = lifetime_;
  pendingLoads.push_back([this, alive] { if (!alive.expired()) loadNow(); });
}
WebAudio::~WebAudio() { lifetime_.reset(); release(); voices.erase(this); }
bool WebAudio::initialize(bool noAudio) {
  if (!boundRuntime()) return false;
  active->audioDisabled = noAudio;
  initialized = true;
  return !noAudio && runtime().media().audioAvailable();
}
void WebAudio::setMasterVolume(double value) {
  masterVolume = std::clamp(value, 0.0, 1.0);
  if (auto* core = boundRuntime()) core->media().setMasterVolume(static_cast<float>(masterVolume));
}
void WebAudio::setEncryptionKey(const std::string& hex) {
  if (!active || active->lifetime.expired()) return;
  active->encryptedAudio = hex.size() == 32;
  if (active->encryptedAudio) {
    for (std::size_t index = 0; index < 16; ++index) {
      active->audioKey[index] = static_cast<std::uint8_t>(std::stoul(hex.substr(index * 2, 2), nullptr, 16));
    }
  } else {
    active->audioKey = {};
  }
}
void WebAudio::loadNow() {
  if (!services_) services_ = active;
  if (!services_ || !services_->runtime || services_->lifetime.expired()) { loading_ = false; return; }
  try {
    auto& core = runtime(services_);
    release();
    error = false;
    loading_ = false;
    loopStart = 0;
    loopLength = 0;
    sampleRate = 0;
    std::vector<std::uint8_t> data;
    std::optional<std::filesystem::path> path;
    bool encrypted = false;
    if (const auto bytes = dataUrl(url)) {
      data = *bytes;
    } else {
      const auto logical = sourcePath(url);
      const auto encryptedPath = ::pmjs::mv::Decrypter::extToEncryptExt(logical);
      if (::pmjs::mv::Decrypter::hasEncryptedAudio && encryptedPath != logical) {
        path = resolve(encryptedPath, core);
        encrypted = bool(path);
      }
      if (!path) path = resolve(url, core);
      if (!path && services_->encryptedAudio && encryptedPath != logical) {
        path = resolve(encryptedPath, core);
        encrypted = bool(path);
      }
    }
    if (!path && data.empty()) { failLoad(); return; }
    AudioLoadOptions options;
    if (url.find("/bgm/") != std::string::npos) options.intent = AudioIntent::music;
    else if (url.find("/bgs/") != std::string::npos) options.intent = AudioIntent::ambient;
    else if (url.find("/me/") != std::string::npos) options.intent = AudioIntent::jingle;
    else options.intent = AudioIntent::effect;
    options.resourceIdentity = url;
    if (path) options.sourcePath = *path;
    const auto& key = services_->encryptedAudio ? services_->audioKey : ::pmjs::mv::Decrypter::encryptionKey;
    std::string failure;
    handle_ = !data.empty()
        ? core.media().loadAudioBytes(data, &failure, options)
        : encrypted
            ? core.media().loadEncryptedAudio(*path, key, &failure, options)
            : core.media().loadAudio(path->string(), &failure, options);
    if (!handle_) { failLoad(); return; }
    totalTime = core.media().duration(handle_);
    if (path && !encrypted) {
      if (const auto info = MediaDecoder::probe(*path)) sampleRate = info->audioSampleRate;
    }
    if (path) {
      std::ifstream file(*path, std::ios::binary);
      data.assign(std::istreambuf_iterator<char>(file), {});
    }
    if (encrypted) data = ::pmjs::mv::Decrypter::decryptArrayBuffer(data, key);
    readLoopComments(data);
    if (loopLength <= 0) {
      loopStart = 0;
      loopLength = totalTime;
    }
    ready = true;
  } catch (const std::exception&) {
    failLoad();
    return;
  }
  const std::weak_ptr<int> alive = lifetime_;
  auto pending = std::move(loadListeners);
  loadListeners.clear();
  for (auto& callback : pending) {
    if (callback) callback();
    if (alive.expired()) return;
  }
  if (autoPlay_) play(loop, startTime);
}
void WebAudio::failLoad() {
  ready = false;
  if (standAlone || !useResourceHandler_) {
    error = true;
    loading_ = false;
    return;
  }
  loading_ = true;
  if (!failure_) {
    const std::weak_ptr<int> alive = lifetime_;
    failure_ = ::pmjs::mv::ResourceHandler::shared().createLoader(
        url,
        [this, alive] { if (!alive.expired()) loadNow(); },
        [this, alive] { if (!alive.expired()) { error = true; loading_ = false; } });
  }
  failure_();
}
void WebAudio::release() {
  if (handle_ && services_ && services_->runtime && !services_->lifetime.expired()) {
    services_->runtime->media().stop(handle_);
    services_->runtime->media().release(handle_);
  }
  handle_ = 0;
  playing = false;
  ready = false;
}
void WebAudio::clear() {
  stop();
  release();
  volume = 1;
  pitch = 1;
  pan = 0;
  loop = false;
  loopStart = 0;
  loopLength = 0;
  totalTime = 0;
  sampleRate = 0;
  startTime = 0;
  pauseTime = 0;
  error = false;
  loadListeners.clear();
  stopListeners.clear();
  pendingFadeIn_ = -1;
  loading_ = false;
  failure_ = {};
  lifetime_ = std::make_shared<int>(0);
}
bool WebAudio::isReady() const { return ready && services_ && services_->runtime && !services_->lifetime.expired(); }
bool WebAudio::isPlaying() const { return handle_ && services_ && services_->runtime && !services_->lifetime.expired() && services_->runtime->media().isPlaying(handle_); }
void WebAudio::setVolume(double value) { volume = value; update(); }
void WebAudio::setPitch(double value) {
  if (pitch == value) return;
  const double pos = isPlaying() ? seek() : pauseTime;
  pitch = value;
  if (isPlaying() && services_ && services_->runtime && !services_->lifetime.expired()) {
    startTime = services_->runtime->media().contextTime() - pos / std::max(0.000001, pitch);
  }
  update();
}
void WebAudio::setPan(double value) { pan = value; update(); }
void WebAudio::update() {
  if (!handle_ || !services_ || !services_->runtime || services_->lifetime.expired()) return;
  auto& media = services_->runtime->media();
  media.setParameters(handle_, static_cast<float>(volume), static_cast<float>(pitch), 0.0F);
  media.setEqualPowerPan(handle_, static_cast<float>(std::clamp(pan, -1.0, 1.0)));
  if (!media.audioError(handle_).empty()) { error = true; stop(); return; }
  if (playing && !media.isPlaying(handle_)) {
    playing = false;
    const std::weak_ptr<int> alive = lifetime_;
    auto callbacks = std::move(stopListeners);
    stopListeners.clear();
    for (auto& callback : callbacks) {
      if (callback) callback();
      if (alive.expired()) return;
    }
  }
}
void WebAudio::play(bool loopFlag, double offset) {
  loop = loopFlag;
  autoPlay_ = true;
  offset = std::max(0.0, offset);
  if (!ready) {
    startTime = offset;
    if (!error && !loading_ && !url.empty() && services_ && services_->runtime && !services_->lifetime.expired()) loadNow();
    return;
  }
  auto& core = runtime(services_);
  if (services_->audioDisabled) return;
  if (loopLength > 0 && offset >= loopStart + loopLength) {
    offset = loopStart + std::fmod(offset - loopStart, loopLength);
  }
  core.media().setParameters(handle_, static_cast<float>(volume), static_cast<float>(pitch), 0.0F);
  core.media().setEqualPowerPan(handle_, static_cast<float>(std::clamp(pan, -1.0, 1.0)));
  playing = core.media().play(handle_, loop, offset);
  pauseTime = offset;
  startTime = core.media().contextTime() - offset / std::max(0.000001, pitch);
  if (pendingFadeIn_ >= 0) {
    core.media().fade(handle_, 0.0F, 1.0F, std::max(0.0, pendingFadeIn_), false);
    pendingFadeIn_ = -1;
  }
}
void WebAudio::stop() {
  autoPlay_ = false;
  pendingFadeIn_ = -1;
  if (handle_ && services_ && services_->runtime && !services_->lifetime.expired()) {
    pauseTime = services_->runtime->media().position(handle_);
    services_->runtime->media().stop(handle_);
  }
  playing = false;
  const std::weak_ptr<int> alive = lifetime_;
  auto callbacks = std::move(stopListeners);
  stopListeners.clear();
  for (auto& callback : callbacks) {
    if (callback) callback();
    if (alive.expired()) return;
  }
}
void WebAudio::fadeIn(double duration) {
  if (ready && handle_ && services_ && services_->runtime && !services_->lifetime.expired()) {
    services_->runtime->media().fade(handle_, 0.0F, 1.0F, std::max(0.0, duration), false);
  } else if (autoPlay_) {
    pendingFadeIn_ = duration;
  }
}
void WebAudio::fadeOut(double duration) {
  if (handle_ && services_ && services_->runtime && !services_->lifetime.expired()) {
    services_->runtime->media().fade(handle_, -1.0F, 0.0F, std::max(0.0, duration), false);
  }
  autoPlay_ = false;
  pendingFadeIn_ = -1;
}
double WebAudio::playbackPosition() const {
  return handle_ && services_ && services_->runtime && !services_->lifetime.expired()
      ? services_->runtime->media().position(handle_)
      : pauseTime;
}
double WebAudio::seek() const {
  if (!isPlaying()) return pauseTime;
  double position = (services_->runtime->media().contextTime() - startTime) * pitch;
  if (loopLength > 0 && position >= loopStart + loopLength) {
    position = loopStart + std::fmod(position - loopStart, loopLength);
  }
  return position;
}
void WebAudio::addLoadListener(std::function<void()> listener) { if(ready)listener();else loadListeners.push_back(std::move(listener)); }
void WebAudio::addStopListener(std::function<void()> listener) { stopListeners.push_back(std::move(listener)); }
std::uint32_t WebAudio::readLittleEndian(const std::vector<std::uint8_t>& data, std::size_t index) {
  if (index + 4 > data.size()) return 0;
  return static_cast<std::uint32_t>(data[index]) |
         (static_cast<std::uint32_t>(data[index + 1]) << 8) |
         (static_cast<std::uint32_t>(data[index + 2]) << 16) |
         (static_cast<std::uint32_t>(data[index + 3]) << 24);
}

std::uint32_t WebAudio::readBigEndian(const std::vector<std::uint8_t>& data, std::size_t index) {
  if (index + 4 > data.size()) return 0;
  return (static_cast<std::uint32_t>(data[index]) << 24) |
         (static_cast<std::uint32_t>(data[index + 1]) << 16) |
         (static_cast<std::uint32_t>(data[index + 2]) << 8) |
         static_cast<std::uint32_t>(data[index + 3]);
}

std::string WebAudio::readFourCharacters(const std::vector<std::uint8_t>& data, std::size_t index) {
  if (index + 4 > data.size()) return "";
  return std::string(reinterpret_cast<const char*>(data.data() + index), 4);
}

void WebAudio::readLoopComments(const std::vector<std::uint8_t>& data) {
  loopStart = 0;
  loopLength = 0;
  readOgg(data);
  readMp4(data);
  if (loopLength > 0 && sampleRate > 0) {
    loopStart /= sampleRate;
    loopLength /= sampleRate;
  } else {
    loopStart = 0;
    loopLength = 0;
  }
}

void WebAudio::readOgg(const std::vector<std::uint8_t>& data) {
  std::size_t index = 0;
  while (index < data.size()) {
    if (readFourCharacters(data, index) == "OggS") {
      index += 26;
      if (index >= data.size()) break;
      bool vorbisHeaderFound = false;
      const std::uint8_t numSegments = data[index++];
      std::vector<std::uint8_t> segments;
      segments.reserve(numSegments);
      for (std::uint8_t i = 0; i < numSegments && index < data.size(); ++i) {
        segments.push_back(data[index++]);
      }
      for (std::size_t i = 0; i < segments.size(); ++i) {
        if (segments[i] > data.size() - index) break;
        if (index + 5 <= data.size() && readFourCharacters(data, index + 1) == "vorb") {
          const std::uint8_t headerType = data[index];
          if (headerType == 1) {
            sampleRate = static_cast<int>(readLittleEndian(data, index + 12));
          } else if (headerType == 3) {
            readMetaData(data, index, segments[i]);
          }
          vorbisHeaderFound = true;
        }
        index += segments[i];
      }
      if (!vorbisHeaderFound) break;
    } else {
      break;
    }
  }
}

void WebAudio::readMp4(const std::vector<std::uint8_t>& data) {
  if (readFourCharacters(data, 4) != "ftyp") return;
  std::size_t index = 0;
  while (index + 8 <= data.size()) {
    const std::uint32_t size = readBigEndian(data, index);
    const std::string name = readFourCharacters(data, index + 4);
    if (name == "moov") {
      index += 8;
    } else {
      if (name == "mvhd") {
        sampleRate = static_cast<int>(readBigEndian(data, index + 20));
      }
      if (name == "udta" || name == "meta") {
        readMetaData(data, index, size);
      }
      if (size <= 1 || size > data.size() - index) break;
      index += size;
    }
  }
}

void WebAudio::readMetaData(const std::vector<std::uint8_t>& data, std::size_t index, std::size_t size) {
  static const std::regex loopStartRegex("LOOPSTART=([0-9]+)");
  static const std::regex loopLengthRegex("LOOPLENGTH=([0-9]+)");
  const auto limit = std::min(data.size(), index + std::min(size, data.size() - std::min(index, data.size())));
  for (std::size_t cursor = index; cursor + 10 < limit; ++cursor) {
    if (readFourCharacters(data, cursor) != "LOOP") continue;
    std::string text;
    while (cursor < limit && data[cursor] > 0) text += char(data[cursor++]);
    std::smatch match;
    if (std::regex_search(text, match, loopStartRegex)) loopStart = std::strtod(match[1].str().c_str(), nullptr);
    if (std::regex_search(text, match, loopLengthRegex)) loopLength = std::strtod(match[1].str().c_str(), nullptr);
    if (text == "LOOPSTART" || text == "LOOPLENGTH") {
      cursor = std::min(limit, cursor + 16);
      std::string value;
      while (cursor < limit && data[cursor] > 0) value += char(data[cursor++]);
      if (text == "LOOPSTART") loopStart = std::strtod(value.c_str(), nullptr);
      else loopLength = std::strtod(value.c_str(), nullptr);
    }
  }
}

bool Html5Audio::initialize() {
  if (!initialized) {
    clear();
    initialized = boundRuntime() && runtime().media().audioAvailable();
  }
  return initialized;
}
void Html5Audio::setup(const std::string& source) {
  if (!initialized) initialize();
  clear();
  url = source;
  htmlAudio = std::make_unique<WebAudio>(url, /*deferLoad=*/true, /*reportResourceErrors=*/false);
  ready = htmlAudio->isReady();
  error = htmlAudio->isError();
}
void Html5Audio::clear() {
  htmlAudio.reset();
  htmlLoadListeners.clear();
  url.clear();
  volume = 1;
  ready = false;
  error = false;
  playing = false;
  currentTime = 0;
  loop = false;
}
void Html5Audio::setStaticSe(const std::string& source) {
  if (!initialized) initialize();
  staticSeUrl = source;
}
bool Html5Audio::isReady() { ready = htmlAudio && htmlAudio->isReady(); return ready; }
bool Html5Audio::isError() { error = htmlAudio && htmlAudio->isError(); return error; }
bool Html5Audio::isPlaying() { playing = htmlAudio && htmlAudio->isPlaying(); return playing; }
void Html5Audio::play(bool repeat, double offset) {
  if (!htmlAudio && !url.empty()) setup(url);
  if (htmlAudio) {
    htmlAudio->setVolume(volume);
    htmlAudio->play(repeat, offset);
    loop = repeat;
    playing = htmlAudio->isPlaying();
  }
}
void Html5Audio::stop() {
  if (htmlAudio) {
    currentTime = htmlAudio->playbackPosition();
    htmlAudio->stop();
  }
  playing = false;
}
void Html5Audio::fadeIn(double duration) { if (htmlAudio) { htmlAudio->setVolume(volume); htmlAudio->fadeIn(duration); } }
void Html5Audio::fadeOut(double duration) { if (htmlAudio) htmlAudio->fadeOut(duration); }
double Html5Audio::seek() { currentTime = htmlAudio ? htmlAudio->playbackPosition() : 0; return currentTime; }
void Html5Audio::addLoadListener(std::function<void()> listener) {
  if (htmlAudio) htmlAudio->addLoadListener(std::move(listener));
  else htmlLoadListeners.push_back(std::move(listener));
}
}  // namespace pmjs::mv::core
