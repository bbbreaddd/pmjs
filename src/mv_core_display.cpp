#include "mv_core_display.hpp"
#include <algorithm>
#include <atomic>
#include <cmath>
#include <stdexcept>

namespace pmjs::mv::core {
namespace {
Matrix translated(const Matrix& world,double x,double y,double sx=1,double sy=1){return multiply(world,{float(sx),0,0,float(sy),float(x),float(y)});}
std::array<int,4> bounds(const Matrix& matrix,const Rectangle& rect) {
  const auto point=[&](double x,double y){return Point{matrix[0]*x+matrix[2]*y+matrix[4],matrix[1]*x+matrix[3]*y+matrix[5]};};
  const std::array points{point(rect.x,rect.y),point(rect.right(),rect.y),point(rect.right(),rect.bottom()),point(rect.x,rect.bottom())};
  double left=points[0].x,right=left,top=points[0].y,bottom=top;
  for(const auto& p:points){left=std::min(left,p.x);right=std::max(right,p.x);top=std::min(top,p.y);bottom=std::max(bottom,p.y);}
  return {int(std::floor(left)),int(std::floor(top)),int(std::ceil(right)),int(std::ceil(bottom))};
}
}
SpriteFrame spriteFrame(const Rectangle& requested,double bitmapWidth,double bitmapHeight) {
  SpriteFrame result;result.requested={std::floor(requested.x),std::floor(requested.y),std::floor(requested.width),std::floor(requested.height)};
  auto& f=result.requested;auto& r=result.real;
  r.x=std::clamp(f.x,0.0,bitmapWidth);r.y=std::clamp(f.y,0.0,bitmapHeight);
  r.width=std::clamp(f.width-r.x+f.x,0.0,bitmapWidth-r.x);r.height=std::clamp(f.height-r.y+f.y,0.0,bitmapHeight-r.y);
  result.pivot={f.x-r.x,f.y-r.y};return result;
}
Container::Container(){static std::atomic<std::uint64_t> count{0};displayId=count++;}
Container::~Container(){removeChildren();}
void Container::update(){const auto count=children.size();for(std::size_t i=0;i<count&&i<children.size();++i){auto child=children[i];if(child)child->update();}}
void Container::addChild(std::shared_ptr<Container> child){addChildAt(std::move(child),children.size());}
void Container::addChildAt(std::shared_ptr<Container> child,std::size_t index) {
  if(!child||child.get()==this||index>children.size())throw std::invalid_argument("invalid display child");
  for(auto* p=this;p;p=p->parent)if(p==child.get())throw std::invalid_argument("cyclic display hierarchy");
  if(child->parent)child->parent->removeChild(child.get());
  index=std::min(index,children.size());child->parent=this;children.insert(children.begin()+index,std::move(child));
}
std::shared_ptr<Container> Container::removeChild(Container* child) {
  auto it=std::find_if(children.begin(),children.end(),[&](const auto& p){return p.get()==child;});if(it==children.end())return {};
  auto result=*it;children.erase(it);result->parent=nullptr;result->onRemoveAsAChild();return result;
}
void Container::removeChildren() {
  auto removed=std::move(children);
  children.clear();
  for(auto& child:removed)if(child)child->parent=nullptr;
  for(auto& child:removed)if(child)child->onRemoveAsAChild();
}
Matrix Container::localTransform()const {
  const double a=std::cos(rotation+skew.y)*scale.x,b=std::sin(rotation+skew.y)*scale.x;
  const double c=-std::sin(rotation-skew.x)*scale.y,d=std::cos(rotation-skew.x)*scale.y;
  return {float(a),float(b),float(c),float(d),float(position.x-pivot.x*a-pivot.y*c),float(position.y-pivot.x*b-pivot.y*d)};
}
void Container::render(Renderer& renderer,const Matrix& parentWorld,double opacity) {
  if(!visible||!renderable||alpha<=0)return;
  int filters = 0;
  for (const auto& filter : glitchFilters) if (filter && filter->enabled && filter->slices > 0) {
    renderer.beginNoiseGlitch(filter->seed, filter->slices, filter->offset); ++filters;
  }
  const auto world=multiply(parentWorld,localTransform());const double worldAlpha=opacity*alpha;
  draw(renderer,world,worldAlpha);const auto count=children.size();
  for(std::size_t i=0;i<count&&i<children.size();++i){auto child=children[i];if(child)child->render(renderer,world,worldAlpha);}
  while (filters-- > 0) renderer.endCompositionGroup();
}
Sprite::Sprite(){spriteId=displayId;}
Sprite::~Sprite(){bitmapLifetime_.reset();}
void Sprite::onBitmapLoad(){if(refreshFrame_&&bitmap_){frame_.width=bitmap_->width;frame_.height=bitmap_->height;refreshFrame_=false;}refreshFrameGeometry();}
void Sprite::refreshFrameGeometry(){pivot=spriteFrame(frame_,bitmap_?bitmap_->width:0,bitmap_?bitmap_->height:0).pivot;}
void Sprite::setBitmap(std::shared_ptr<PixelBitmap> value){if(bitmap_==value)return;bitmap_=std::move(value);refreshFrame_=bool(bitmap_);if(!bitmap_)return;
  const std::weak_ptr<int> lifetime=bitmapLifetime_;const std::weak_ptr<PixelBitmap> source=bitmap_;
  bitmap_->addLoadListener([this,lifetime,source]{if(lifetime.expired())return;if(auto bitmap=source.lock()){if(bitmap==bitmap_)onBitmapLoad();else refreshFrameGeometry();}});
}
void Sprite::setFrame(double x,double y,double width,double height){refreshFrame_=false;if(frame_.x!=x||frame_.y!=y||frame_.width!=width||frame_.height!=height){frame_={x,y,width,height};refreshFrameGeometry();}}
bool Sprite::queueFrame(Renderer& renderer,const ImageInfo& image,const Rectangle& requested,const Matrix& world,double opacity,BlendMode blend,Point anchor,std::array<double,4> tone,std::array<double,4> color,bool nearest) {
  const auto frame=spriteFrame(requested,image.width,image.height);if(frame.real.width<=0||frame.real.height<=0)return true;
  const auto placed=translated(world,-anchor.x*frame.real.width-frame.pivot.x,-anchor.y*frame.real.height-frame.pivot.y);
  std::array<float,4> normalizedTone{},normalizedColor{};
  for(int i=0;i<4;++i){normalizedTone[i]=float(tone[i]/255);normalizedColor[i]=float(color[i]/255);}
  return renderer.queueImage(image.handle,placed,{float(frame.real.x),float(frame.real.y),float(frame.real.width),float(frame.real.height)},float(opacity),0xffffff,blend,normalizedTone,normalizedColor,nearest);
}
void Sprite::draw(Renderer& renderer,const Matrix& world,double opacity) {
  if(!bitmap_)return;bitmap_->touch();if(!bitmap_->isReady())return;
  const auto image=bitmap_->texture();if(!image)return;
  const auto clipping=spriteFrame(frame_,image->width,image->height).pivot;
  if(!queueFrame(renderer,*image,frame_,translated(world,clipping.x,clipping.y),opacity,blendMode,anchor,colorTone_,blendColor_,!bitmap_->smooth))throw std::runtime_error("cannot queue core sprite");
}
void TilingSprite::draw(Renderer& renderer,const Matrix& world,double opacity) {
  if(!bitmap_||!bitmap_->isReady()||areaWidth<=0||areaHeight<=0)return;bitmap_->touch();const auto image=bitmap_->texture();if(!image)return;
  Rectangle region=frame_;if(region.width==0&&region.height==0){region.width=bitmap_->width;region.height=bitmap_->height;}
  if(region.width<=0||region.height<=0)return;
  if(region.x<0||region.y<0||region.right()>image->width||region.bottom()>image->height)throw std::invalid_argument("tiling frame outside bitmap");
  renderer.queueTilingFrame(image->handle,world,{float(region.x),float(region.y),float(region.width),float(region.height)},
    {float(areaWidth),float(areaHeight)},{float(-std::floor(-origin.x+0.5)),float(-std::floor(-origin.y+0.5))},float(opacity),blendMode,!bitmap_->smooth);
}
void ScreenSprite::setColor(double r,double g,double b) {
  const std::array<double,3> requested{r,g,b};
  if(channels_==requested)return;
  for(std::size_t index=0;index<channels_.size();++index) {
    const double value=std::isnan(requested[index])?0.0:requested[index];
    channels_[index]=std::clamp(std::floor(value+.5),0.0,255.0);
    color[index]=float(channels_[index]/255);
  }
  fillRect_={-Graphics::width*5.0,-Graphics::height*5.0,Graphics::width*10.0,Graphics::height*10.0};
}
void ScreenSprite::draw(Renderer& renderer,const Matrix& world,double opacity) {
  const auto first=renderer.queuedCommandCount();renderer.queueQuad(fillRect_.x,fillRect_.y,fillRect_.width,fillRect_.height,{color[0],color[1],color[2],float(opacity)},blendMode);
  renderer.transformQueuedCommands(first,world);
}
void ToneFilter::reset(){matrix={1,0,0,0,0,0,1,0,0,0,0,0,1,0,0,0,0,0,1,0};}
void ToneFilter::multiply(const std::array<float,20>& right) {
  auto left=matrix;for(int row=0;row<4;++row)for(int column=0;column<5;++column){double value=column==4?left[row*5+4]:0;for(int k=0;k<4;++k)value+=left[row*5+k]*right[k*5+column];matrix[row*5+column]=float(value);}
}
void ToneFilter::adjustTone(double r,double g,double b){const auto n=[](double value){return float(std::clamp(std::isnan(value)?0:value,-255.0,255.0)/255);};multiply({1,0,0,n(r),0,0,1,0,n(g),0,0,0,1,n(b),0,0,0,0,1,0});}
void ToneFilter::adjustSaturation(double value){const float x=float(std::clamp(std::isnan(value)?0:value,-255.0,255.0)/255)*2/3+1,y=(1-x)/2;multiply({x,y,y,0,0,y,x,y,0,0,y,y,x,0,0,0,0,0,1,0});}
void ToneFilter::adjustHue(double degrees) {
  const double angle=degrees*3.14159265358979323846/180,c=std::cos(angle),s=std::sin(angle);
  multiply({float(.213+c*.787-s*.213),float(.715-c*.715-s*.715),float(.072-c*.072+s*.928),0,0,
    float(.213-c*.213+s*.143),float(.715+c*.285+s*.140),float(.072-c*.072-s*.283),0,0,
    float(.213-c*.213-s*.787),float(.715-c*.715+s*.715),float(.072+c*.928+s*.072),0,0,0,0,0,1,0});
}
void ToneFilter::adjustBrightness(double value){const float v=float(value);multiply({v,0,0,0,0,0,v,0,0,0,0,0,v,0,0,0,0,0,1,0});}
void ToneFilter::adjustContrast(double value){const float v=float(value+1),offset=-.5F*(v-1);multiply({v,0,0,0,offset,0,v,0,0,offset,0,0,v,0,offset,0,0,0,1,0});}
void ToneSprite::setTone(double r,double g,double b,double gray){const auto tone=[](double value,double low,double high){const double clean=std::isnan(value)?0.0:value;return std::clamp(std::floor(clean+.5),low,high);};tone_={tone(r,-255,255),tone(g,-255,255),tone(b,-255,255),tone(gray,0,255)};}
void ToneSprite::draw(Renderer& renderer,const Matrix& world,double) {
  if(std::all_of(tone_.begin(),tone_.end(),[](double value){return value==0;}))return;
  std::array<float,4> tone;
  for(std::size_t index=0;index<tone.size();++index)tone[index]=float(tone_[index]/255);
  renderer.queueTone(tone,world,{float(Graphics::width),float(Graphics::height)});
}
void Window::addChildToBack(std::shared_ptr<Container> child){std::erase_if(backChildren_,[&](const auto& weak){auto item=weak.lock();return !item||item==child;});Container::addChild(child);backChildren_.insert(backChildren_.begin(),child);}
void Window::update(){if(active)++animationCount;Container::update();}
void Window::synchronize(std::uint64_t frame){const auto delta=!lastFrame_?1:frame>=*lastFrame_?frame-*lastFrame_:0;lastFrame_=frame;if(active)animationCount+=delta;}
Rectangle Window::openBounds()const{return {0,height*(1-std::clamp(openness,0.0,255.0)/255)/2,double(width),height*std::clamp(openness,0.0,255.0)/255};}
double Window::cursorAlpha()const{const int count=animationCount%40;return std::max(0.0,contentsOpacity-(active?(count<20?count:40-count)*8:0))/255;}
void Window::refreshBack() {
  const std::array<double,6> key{width,height,margin,tone[0],tone[1],tone[2]};
  if(frameBitmap_&&backKey_==key&&skinKey_==windowskin.get())return;
  back_.reset();frameBitmap_.reset();backKey_=key;skinKey_=windowskin.get();
  if(!windowskin||!windowskin->isReady())return;
  const double w=width-margin*2,h=height-margin*2;
  if(w>0&&h>0){back_=std::make_shared<PixelBitmap>(int(w),int(h));back_->blt(*windowskin,0,0,96,96,0,0,w,h);
    for(double y=0;y<h;y+=96)for(double x=0;x<w;x+=96)back_->blt(*windowskin,0,96,96,96,x,y,96,96);
    back_->adjustTone(tone[0],tone[1],tone[2]);}
  if(width<=0||height<=0)return;
  frameBitmap_=std::make_shared<PixelBitmap>(int(width),int(height));
  constexpr std::array<std::array<int,2>,8> frameParts{{{1,0},{1,2},{0,1},{2,1},{0,0},{2,0},{0,2},{2,2}}};
  for(const auto& part:frameParts){const int col=part[0],row=part[1];
    const double sw=col==1?48:24,sh=row==1?48:24,dw=col==1?width-48:24,dh=row==1?height-48:24;
    frameBitmap_->blt(*windowskin,col==0?96:col==1?120:168,row==0?0:row==1?24:72,sw,sh,col==0?0:col==1?24:width-24,row==0?0:row==1?24:height-24,dw,dh);
  }
}
void Window::refreshCursor(){
  const std::array<double,10> key{cursorRect.x,cursorRect.y,cursorRect.width,cursorRect.height,width,height,padding,origin.x,origin.y,0};
  if(cursorBitmap_&&cursorKey_==key&&cursorSkin_==windowskin.get())return;
  cursorKey_=key;cursorSkin_=windowskin.get();cursorBitmap_.reset();
  const double x=cursorRect.x+padding-origin.x,y=cursorRect.y+padding-origin.y,cw=cursorRect.width,ch=cursorRect.height;
  const double x2=std::max(x,padding),y2=std::max(y,padding),w2=std::min(cw,width-padding-x2),h2=std::min(ch,height-padding-y2);
  if(!windowskin||!windowskin->isReady()||w2<=0||h2<=0||cw<=0||ch<=0)return;
  cursorBitmap_=std::make_shared<PixelBitmap>(int(w2),int(h2));const double ox=x-x2,oy=y-y2;
  constexpr std::array<std::array<int,2>,9> cursorParts{{{1,1},{1,0},{1,2},{0,1},{2,1},{0,0},{2,0},{0,2},{2,2}}};
  for(const auto& part:cursorParts){const int col=part[0],row=part[1];
    const double sw=col==1?40:4,sh=row==1?40:4,dw=col==1?cw-8:4,dh=row==1?ch-8:4;
    cursorBitmap_->blt(*windowskin,col==0?96:col==1?100:140,row==0?96:row==1?100:140,sw,sh,ox+(col==0?0:col==1?4:cw-4),oy+(row==0?0:row==1?4:ch-4),dw,dh);
  }
}
void Window::render(Renderer& renderer,const Matrix& parentWorld,double parentAlpha) {
  if(!visible||!renderable||alpha<=0)return;
  pauseAlpha_=pause?std::min(1.0,pauseAlpha_+.1):0;
  const auto world=multiply(parentWorld,localTransform());const double worldAlpha=alpha*parentAlpha;
  const auto open=openBounds();const auto body=translated(world,0,open.y,1,std::clamp(openness,0.0,255.0)/255);
  refreshBack();const auto skin=windowskin?windowskin->texture():std::nullopt;
  const auto piece=[&](const Rectangle& source,const Rectangle& destination,double opacity,const Matrix& matrix) {
    if(!skin||source.width<=0||source.height<=0||destination.width<=0||destination.height<=0)return;
    Sprite::queueFrame(renderer,*skin,source,translated(matrix,destination.x,destination.y,destination.width/source.width,destination.height/source.height),opacity,BlendMode::normal,{},{},{},!windowskin->smooth);
  };
  if(openness>0&&skin) {
    if(back_)if(auto back=back_->texture())Sprite::queueFrame(renderer,*back,{0,0,double(back_->width),double(back_->height)},translated(body,margin,margin),worldAlpha*std::clamp(opacity,0.0,255.0)/255*std::clamp(backOpacity,0.0,255.0)/255,BlendMode::normal,{},{},{},!back_->smooth);
    if(frameBitmap_)if(auto frame=frameBitmap_->texture())Sprite::queueFrame(renderer,*frame,{0,0,width,height},body,worldAlpha*std::clamp(opacity,0.0,255.0)/255,BlendMode::normal,{},{},{},!frameBitmap_->smooth);
  }
  for(const auto& weak:backChildren_)if(auto child=weak.lock();child&&child->parent==this)child->render(renderer,world,worldAlpha);
  if(isOpen()) {
    refreshCursor();
    if(cursorBitmap_)if(auto cursor=cursorBitmap_->texture())Sprite::queueFrame(renderer,*cursor,{0,0,double(cursorBitmap_->width),double(cursorBitmap_->height)},
      translated(world,std::max(padding+cursorRect.x-origin.x,padding),std::max(padding+cursorRect.y-origin.y,padding)),worldAlpha*cursorAlpha(),BlendMode::normal,{},{},{},!cursorBitmap_->smooth);
    if(contents)if(auto texture=contents->texture())Sprite::queueFrame(renderer,*texture,{origin.x,origin.y,double(width-padding*2),double(height-padding*2)},translated(world,padding,padding),worldAlpha*std::clamp(contentsOpacity,0.0,255.0)/255,BlendMode::normal,{},{},{},!contents->smooth);

    if(downArrowVisible)piece({132,60,24,12},{width/2.0-12,double(height-18),24,12},worldAlpha,world);
    if(upArrowVisible)piece({132,24,24,12},{width/2.0-12,6,24,12},worldAlpha,world);
    if(pause&&pauseAlpha_>0)piece({double(144+(animationCount/16%2)*24),double(96+(animationCount/32%2)*24),24,24},{width/2.0-12,double(height-24),24,24},worldAlpha*pauseAlpha_,world);
  }
  for(const auto& child:children)if(child&&std::none_of(backChildren_.begin(),backChildren_.end(),[&](const auto& weak){return weak.lock()==child;}))child->render(renderer,world,worldAlpha);
}
WindowLayer::StreamState WindowLayer::begin(Renderer& renderer,const Matrix& parentWorld,double parentAlpha)const {
  StreamState state{multiply(parentWorld,localTransform()),alpha*parentAlpha,renderer.queuedCommandCount()};
  renderer.beginCompositionGroup();
  return state;
}
void WindowLayer::renderWindow(Renderer& renderer,const StreamState& state,Window& window)const {
  if(!window.visible||window.isClosed())return;
  const auto region=bounds(multiply(state.world,window.localTransform()),window.openBounds());
  renderer.clearCompositionRect(region[0],region[1],region[2]-region[0],region[3]-region[1]);
  window.render(renderer,state.world,state.opacity);
}
void WindowLayer::end(Renderer& renderer,const StreamState& state)const {
  renderer.endCompositionGroup();
  renderer.clipQueuedCommands(state.firstCommand,bounds(state.world,{0,0,width,height}));
}
void WindowLayer::render(Renderer& renderer,const Matrix& parentWorld,double parentAlpha) {
  if(!visible||!renderable)return;
  const auto state=begin(renderer,parentWorld,parentAlpha);
  for(const auto& child:children)if(auto* window=dynamic_cast<Window*>(child.get()))renderWindow(renderer,state,*window);
  end(renderer,state);
  for(const auto& child:children)if(child&&!dynamic_cast<Window*>(child.get()))child->render(renderer,state.world,state.opacity);
}
}
