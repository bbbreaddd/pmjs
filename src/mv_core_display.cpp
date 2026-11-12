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
Container::~Container(){removeChildren();}
void Container::update(){const auto copy=children;for(const auto& child:copy)if(child&&child->parent==this)child->update();}
void Container::addChild(std::shared_ptr<Container> child){addChildAt(std::move(child),children.size());}
void Container::addChildAt(std::shared_ptr<Container> child,std::size_t index) {
  if(!child||child.get()==this||index>children.size())throw std::invalid_argument("invalid display child");
  for(auto* p=this;p;p=p->parent)if(p==child.get())throw std::invalid_argument("cyclic display hierarchy");
  if(child->parent)child->parent->removeChild(child.get());
  index=std::min(index,children.size());child->parent=this;children.insert(children.begin()+index,std::move(child));
}
std::shared_ptr<Container> Container::removeChild(Container* child) {
  auto it=std::find_if(children.begin(),children.end(),[&](const auto& p){return p.get()==child;});if(it==children.end())return {};
  auto result=*it;children.erase(it);result->parent=nullptr;return result;
}
void Container::removeChildren(){for(auto& child:children)if(child)child->parent=nullptr;children.clear();}
Matrix Container::localTransform()const {
  const double a=std::cos(rotation+skew.y)*scale.x,b=std::sin(rotation+skew.y)*scale.x;
  const double c=-std::sin(rotation-skew.x)*scale.y,d=std::cos(rotation-skew.x)*scale.y;
  return {float(a),float(b),float(c),float(d),float(position.x-pivot.x*a-pivot.y*c),float(position.y-pivot.x*b-pivot.y*d)};
}
void Container::render(Renderer& renderer,const Matrix& parentWorld,double opacity) {
  if(!visible||!renderable||alpha<=0)return;
  const auto world=multiply(parentWorld,localTransform());const double worldAlpha=opacity*alpha;
  draw(renderer,world,worldAlpha);const auto copy=children;
  for(const auto& child:copy)if(child&&child->parent==this)child->render(renderer,world,worldAlpha);
}
Sprite::Sprite(){static std::atomic<std::uint64_t> counter{0};spriteId=counter++;}
void Sprite::setBitmap(std::shared_ptr<PixelBitmap> value){if(bitmap_!=value){bitmap_=std::move(value);refreshFrame_=bool(bitmap_);if(!bitmap_)frame_={};}}
void Sprite::setFrame(double x,double y,double width,double height){frame_={x,y,width,height};refreshFrame_=false;}
bool Sprite::queueFrame(Renderer& renderer,const ImageInfo& image,const Rectangle& requested,const Matrix& world,double opacity,BlendMode blend,Point anchor,std::array<double,4> tone,std::array<double,4> color) {
  const auto frame=spriteFrame(requested,image.width,image.height);if(frame.real.width<=0||frame.real.height<=0)return true;
  const auto placed=translated(world,-anchor.x*frame.real.width-frame.pivot.x,-anchor.y*frame.real.height-frame.pivot.y);
  std::array<float,4> normalizedTone{},normalizedColor{};
  for(int i=0;i<4;++i){normalizedTone[i]=float(tone[i]/255);normalizedColor[i]=float(color[i]/255);}
  return renderer.queueImage(image.handle,placed,{float(frame.real.x),float(frame.real.y),float(frame.real.width),float(frame.real.height)},float(opacity),0xffffff,blend,normalizedTone,normalizedColor);
}
void Sprite::draw(Renderer& renderer,const Matrix& world,double opacity) {
  if(!bitmap_)return;bitmap_->touch();if(!bitmap_->isReady())return;
  const auto image=bitmap_->texture();if(!image)return;
  if(refreshFrame_){frame_={0,0,double(bitmap_->width),double(bitmap_->height)};refreshFrame_=false;}
  if(!queueFrame(renderer,*image,frame_,world,opacity,blendMode,anchor,colorTone_,blendColor_))throw std::runtime_error("cannot queue core sprite");
}
void TilingSprite::draw(Renderer& renderer,const Matrix& world,double opacity) {
  if(!bitmap_||!bitmap_->isReady()||areaWidth<=0||areaHeight<=0)return;bitmap_->touch();const auto image=bitmap_->texture();if(!image)return;
  if(refreshFrame_){frame_={0,0,double(bitmap_->width),double(bitmap_->height)};refreshFrame_=false;}
  const auto frame=spriteFrame(frame_,image->width,image->height);
  if(frame.real.width<=0||frame.real.height<=0)return;
  renderer.queueTilingFrame(image->handle,world,{float(frame.real.x),float(frame.real.y),float(frame.real.width),float(frame.real.height)},
    {float(areaWidth),float(areaHeight)},{float(-std::floor(-origin.x+0.5)),float(-std::floor(-origin.y+0.5))},float(opacity),blendMode);
}
void ScreenSprite::draw(Renderer& renderer,const Matrix& world,double opacity) {
  const auto first=renderer.queuedCommandCount();renderer.queueQuad(-50000,-50000,100000,100000,{color[0],color[1],color[2],float(opacity)});
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
void ToneSprite::setTone(double r,double g,double b,double gray){tone_={std::clamp(std::round(r),-255.0,255.0),std::clamp(std::round(g),-255.0,255.0),std::clamp(std::round(b),-255.0,255.0),std::clamp(std::round(gray),0.0,255.0)};}
void ToneSprite::draw(Renderer& renderer,const Matrix&,double){ToneFilter filter;filter.adjustTone(tone_[0],tone_[1],tone_[2]);filter.adjustSaturation(-tone_[3]);filter.apply(renderer);}
void Window::update(){if(active)++animationCount;pauseAlpha_=pause?std::min(1.0,pauseAlpha_+.1):0;Container::update();}
Rectangle Window::openBounds()const{return {0,height*(1-std::clamp(openness,0.0,255.0)/255)/2,double(width),height*std::clamp(openness,0.0,255.0)/255};}
double Window::cursorAlpha()const{const int count=animationCount%40;return std::max(0.0,contentsOpacity-(active?(count<20?count:40-count)*8:0))/255;}
void Window::refreshBack() {
  const std::array<double,6> key{double(width),double(height),double(margin),tone[0],tone[1],tone[2]};
  if(back_&&backKey_==key&&skinKey_==windowskin.get())return;
  back_.reset();backKey_=key;skinKey_=windowskin.get();const int w=width-margin*2,h=height-margin*2;
  if(!windowskin||!windowskin->isReady()||w<=0||h<=0)return;
  back_=std::make_shared<PixelBitmap>(w,h);back_->blt(*windowskin,0,0,96,96,0,0,w,h);
  for(int y=0;y<h;y+=96)for(int x=0;x<w;x+=96)back_->blt(*windowskin,0,96,std::min(96,w-x),std::min(96,h-y),x,y);
  back_->adjustTone(int(tone[0]),int(tone[1]),int(tone[2]));
}
void Window::render(Renderer& renderer,const Matrix& parentWorld,double parentAlpha) {
  if(!visible||!renderable||alpha<=0)return;
  const auto world=multiply(parentWorld,localTransform());const double worldAlpha=alpha*parentAlpha;
  const auto open=openBounds();const auto body=translated(world,0,open.y,1,std::clamp(openness,0.0,255.0)/255);
  refreshBack();const auto skin=windowskin?windowskin->texture():std::nullopt;
  const auto piece=[&](const Rectangle& source,const Rectangle& destination,double opacity,const Matrix& matrix) {
    if(!skin||source.width<=0||source.height<=0||destination.width<=0||destination.height<=0)return;
    Sprite::queueFrame(renderer,*skin,source,translated(matrix,destination.x,destination.y,destination.width/source.width,destination.height/source.height),opacity);
  };
  if(openness>0&&skin) {
    if(back_)if(auto back=back_->texture())Sprite::queueFrame(renderer,*back,{0,0,double(back_->width),double(back_->height)},translated(body,margin,margin),worldAlpha*opacity/255*backOpacity/255);
    constexpr int border=24;
    for(int row=0;row<3;++row)for(int col=0;col<3;++col) {
      if(row==1&&col==1)continue;
      piece({double(col==0?96:col==1?120:168),double(row==0?0:row==1?24:72),double(col==1?48:border),double(row==1?48:border)},
        {double(col==0?0:col==1?border:width-border),double(row==0?0:row==1?border:height-border),double(col==1?width-border*2:border),double(row==1?height-border*2:border)},worldAlpha*opacity/255,body);
    }
  }
  if(isOpen()) {
    if(contents)if(auto texture=contents->texture())Sprite::queueFrame(renderer,*texture,{origin.x,origin.y,double(width-padding*2),double(height-padding*2)},translated(world,padding,padding),worldAlpha*contentsOpacity/255);
    const auto first=renderer.queuedCommandCount();
    const double cw=cursorRect.width,ch=cursorRect.height,cx=padding+cursorRect.x-origin.x,cy=padding+cursorRect.y-origin.y;
    if(cw>0&&ch>0)for(int row=0;row<3;++row)for(int col=0;col<3;++col)piece({double(col==0?96:col==1?100:140),double(row==0?96:row==1?100:140),double(col==1?40:4),double(row==1?40:4)},
      {cx+(col==0?0:col==1?4:cw-4),cy+(row==0?0:row==1?4:ch-4),double(col==1?cw-8:4),double(row==1?ch-8:4)},worldAlpha*cursorAlpha(),world);
    renderer.clipQueuedCommands(first,bounds(world,{double(padding),double(padding),double(std::max(0,width-padding*2)),double(std::max(0,height-padding*2))}));
    if(downArrowVisible)piece({132,60,24,12},{width/2.0-12,double(height-18),24,12},worldAlpha,world);
    if(upArrowVisible)piece({132,24,24,12},{width/2.0-12,6,24,12},worldAlpha,world);
    if(pause&&pauseAlpha_>0)piece({double(144+(animationCount/16%2)*24),double(96+(animationCount/32%2)*24),24,24},{width/2.0-12,double(height-24),24,24},worldAlpha*pauseAlpha_,world);
  }
  for(const auto& child:children)if(child)child->render(renderer,world,worldAlpha);
}
void WindowLayer::render(Renderer& renderer,const Matrix& parentWorld,double parentAlpha) {
  if(!visible||!renderable)return;const auto world=multiply(parentWorld,localTransform());const auto first=renderer.queuedCommandCount();
  renderer.beginCompositionGroup();
  for(const auto& child:children)if(auto* window=dynamic_cast<Window*>(child.get());window&&window->visible&&!window->isClosed()) {
    const auto region=bounds(multiply(world,window->localTransform()),window->openBounds());
    renderer.clearCompositionRect(region[0],region[1],region[2]-region[0],region[3]-region[1]);window->render(renderer,world,alpha*parentAlpha);
  }
  renderer.endCompositionGroup();renderer.clipQueuedCommands(first,bounds(world,{0,0,width,height}));
  for(const auto& child:children)if(child&&!dynamic_cast<Window*>(child.get()))child->render(renderer,world,alpha*parentAlpha);
}
}
