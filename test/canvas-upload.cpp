#include "canvas.hpp"
#include <EGL/egl.h>
#include <GLES3/gl3.h>
#include <algorithm>
#include <cassert>
#include <iostream>
#include <vector>

namespace {
std::vector<uint8_t> texture;
int textureWidth, textureHeight, rowLength, fullUploads, regionUploads;
std::array<int, 4> readRectangle{};
GLenum pendingError = GL_NO_ERROR;
bool failUpload = false;
bool failRead = false;
}
// Capture the actual GLES transfer boundary without a window or driver.
extern "C" {
EGLContext eglGetCurrentContext() { return reinterpret_cast<EGLContext>(1); }
void glGenTextures(GLsizei count, GLuint* names) { for(int i=0;i<count;++i) names[i]=i+1; }
void glDeleteTextures(GLsizei, const GLuint*) {}
void glBindTexture(GLenum, GLuint) {}
void glTexParameteri(GLenum, GLenum, GLint) {}
void glPixelStorei(GLenum parameter, GLint value) { if(parameter==GL_UNPACK_ROW_LENGTH) rowLength=value; }
GLenum glGetError() { const auto error=pendingError; pendingError=GL_NO_ERROR; return error; }
void glTexImage2D(GLenum, GLint, GLint, GLsizei width, GLsizei height, GLint,
                  GLenum format, GLenum type, const void* data) {
  assert(format==GL_RGBA && type==GL_UNSIGNED_BYTE);
  textureWidth=width;textureHeight=height;
  const auto* bytes=static_cast<const uint8_t*>(data);
  texture.assign(static_cast<size_t>(width)*height*4, 0);
  if(bytes) std::copy_n(bytes,texture.size(),texture.begin());
  ++fullUploads;
}
void glTexSubImage2D(GLenum, GLint, GLint x, GLint y, GLsizei width, GLsizei height,
                     GLenum format, GLenum type, const void* data) {
  assert(format==GL_RGBA && type==GL_UNSIGNED_BYTE);
  if(failUpload) { pendingError=GL_OUT_OF_MEMORY; return; }
  assert(x>=0 && y>=0 && x+width<=textureWidth && y+height<=textureHeight);
  const auto* bytes=static_cast<const uint8_t*>(data);
  const int stride=rowLength?rowLength:width;
  for(int row=0;row<height;++row)
    std::copy_n(bytes+static_cast<size_t>(row)*stride*4,width*4,
      texture.data()+(static_cast<size_t>(y+row)*textureWidth+x)*4);
  ++regionUploads;
}
void glGenerateMipmap(GLenum) {}
void glGetIntegerv(GLenum, GLint* value) { *value=0; }
void glGenFramebuffers(GLsizei count, GLuint* names) { for (int i=0;i<count;i++) names[i]=i+1; }
void glBindFramebuffer(GLenum, GLuint) {}
void glFramebufferTexture2D(GLenum, GLenum, GLenum, GLuint, GLint) {}
GLenum glCheckFramebufferStatus(GLenum) { return GL_FRAMEBUFFER_COMPLETE; }
void glBindBuffer(GLenum, GLuint) {}
void glReadPixels(GLint x, GLint y, GLsizei width, GLsizei height, GLenum format, GLenum type, void* pixels) {
  assert(x>=0 && y>=0 && x+width<=textureWidth && y+height<=textureHeight && format==GL_RGBA && type==GL_UNSIGNED_BYTE);
  readRectangle = {x, y, width, height};
  if (failRead) { pendingError=GL_INVALID_OPERATION; return; }
  for (int row=0;row<height;++row)
    std::copy_n(texture.data()+((y+row)*textureWidth+x)*4,width*4,static_cast<uint8_t*>(pixels)+row*width*4);
}
void glDeleteFramebuffers(GLsizei, const GLuint*) {}
}
int main() {
  pmjs::ImageStore images;
  pmjs::CanvasStore canvases(images);
  const auto canvas=canvases.create(5,3); assert(canvas);
  assert(canvases.writePixels(canvas->handle,0,0,1,1,{37,67,103,157}));
  auto image=canvases.prepareImage(canvas->handle); assert(image);
  assert(images.lookup(*image)->premultiplied);
  assert((std::vector<uint8_t>(texture.begin(),texture.begin()+4)==std::vector<uint8_t>{23,41,63,157}));
  const auto before=texture;
  const std::vector<uint8_t> raw={255,127,0,0,128,0,0,127};
  assert(canvases.writePixels(canvas->handle,2,1,2,1,raw,pmjs::PixelEncoding::PremultipliedRGBA8));
  failUpload=true;
  assert(!canvases.prepareImage(canvas->handle));
  assert(texture==before);
  failUpload=false;
  assert(canvases.prepareImage(canvas->handle));
  assert(regionUploads==1 && fullUploads==1 && rowLength==0);
  for(int pixel=0;pixel<15;++pixel) {
    const auto* expected = pixel==7 ? raw.data() : pixel==8 ? raw.data()+4 : before.data()+pixel*4;
    assert(std::equal(texture.data()+pixel*4,texture.data()+pixel*4+4,expected));
  }
  const auto stats=canvases.textBackendStats();
  assert(stats.scratchBytes==0);

  const auto clearUploads=regionUploads;
  assert(canvases.clear(canvas->handle));
  assert(canvases.prepareImage(canvas->handle));
  assert(regionUploads==clearUploads+1);
  assert(std::all_of(texture.begin(), texture.end(), [](uint8_t v) { return v == 0; }));
  const auto clearRevision=images.contentRevision(*image);
  for(int i=0;i<7;++i) {
    assert(canvases.clear(canvas->handle));
    assert(canvases.clearRect(canvas->handle,1,1,2,1));
    assert(canvases.prepareImage(canvas->handle));
  }
  assert(regionUploads==clearUploads+1);
  assert(images.contentRevision(*image)==clearRevision);
  assert(std::all_of(texture.begin(),texture.end(),[](uint8_t v){return v==0;}));

  const std::vector<uint8_t> redPixel={255,0,0,255};
  assert(canvases.writePixels(canvas->handle,0,0,1,1,redPixel));
  assert(canvases.clearRect(canvas->handle,2,1,1,1));
  assert(canvases.prepareImage(canvas->handle));
  assert(regionUploads==clearUploads+2);
  assert((std::vector<uint8_t>(texture.begin(),texture.begin()+4)==redPixel));
  const auto retained=canvases.create(5,3); assert(retained);
  assert(canvases.drawImage(retained->handle,canvas->handle,0,0,5,3,0,0,5,3,1,false));
  assert(canvases.clear(canvas->handle));
  assert(canvases.prepareImage(canvas->handle));
  assert(regionUploads==clearUploads+3);
  const auto oldPixels=canvases.readPixels(retained->handle,0,0,5,3); assert(oldPixels);
  assert(std::equal(redPixel.begin(),redPixel.end(),oldPixels->rgba.begin()));
  assert(canvases.release(retained->handle));
  assert(!canvases.clear(retained->handle));

  std::vector<uint8_t> externalPixels(5*3*4,255);
  assert(images.updateRgba(*image,externalPixels.data()));
  assert(!images.lookup(*image)->knownAllZero);
  const int externalUploads=regionUploads;
  assert(canvases.clear(canvas->handle));
  assert(canvases.prepareImage(canvas->handle));
  assert(regionUploads==externalUploads+1);
  assert(std::all_of(texture.begin(),texture.end(),[](uint8_t v){return v==0;}));
  assert(canvases.fillRect(canvas->handle, 1, 1, 1, 1, 0xff0000ff));
  assert(canvases.prepareImage(canvas->handle));
  assert(images.updateRgba(*image, externalPixels.data()));
  assert(canvases.clear(canvas->handle));
  assert(canvases.prepareImage(canvas->handle));
  assert(std::all_of(texture.begin(), texture.end(), [](uint8_t v) { return v == 0; }));
  const int recoveryUploads=regionUploads;
  failUpload=true;
  assert(!images.updateRgbaRegion(*image,0,0,1,1,redPixel.data(),1));
  assert(!images.lookup(*image)->knownAllZero);
  assert(canvases.clear(canvas->handle));
  assert(!canvases.prepareImage(canvas->handle));
  failUpload=false;
  assert(canvases.prepareImage(canvas->handle));
  assert(regionUploads==recoveryUploads+1);
  assert(images.lookup(*image)->knownAllZero);

  const auto initiallyEmpty=canvases.create(3,2); assert(initiallyEmpty);
  assert(canvases.prepareImage(initiallyEmpty->handle));
  const int initiallyEmptyUploads=regionUploads;
  assert(canvases.clear(initiallyEmpty->handle));
  assert(canvases.clearRect(initiallyEmpty->handle,-1,-1,5,4));
  canvases.uploadDirty();
  assert(regionUploads==initiallyEmptyUploads);
  assert(canvases.prepareImage(initiallyEmpty->handle));
  assert(regionUploads==initiallyEmptyUploads);
  assert(canvases.fillRect(initiallyEmpty->handle,0,0,1,1,0xff0000ff));
  assert(canvases.fillRect(initiallyEmpty->handle,2,1,1,1,0x0000ffff));
  assert(canvases.clearRect(initiallyEmpty->handle,0,0,1,1));
  const auto partiallyCleared=canvases.readPixels(initiallyEmpty->handle,0,0,3,2); assert(partiallyCleared);
  assert(partiallyCleared->rgba[5*4+2]==255);
  assert(canvases.clear(initiallyEmpty->handle));
  const auto fullyCleared=canvases.readPixels(initiallyEmpty->handle,0,0,3,2); assert(fullyCleared);
  assert(std::all_of(fullyCleared->rgba.begin(),fullyCleared->rgba.end(),[](uint8_t v){return v==0;}));
  assert(canvases.release(initiallyEmpty->handle));

  const auto queued=canvases.create(3,2); assert(queued);
  assert(canvases.fillRect(queued->handle,0,0,3,2,0xff0000ff));
  assert(canvases.clear(queued->handle));
  assert(canvases.prepareImage(queued->handle));
  assert(std::all_of(texture.begin(),texture.end(),[](uint8_t v){return v==0;}));
  assert(canvases.fillRect(queued->handle,0,0,3,2,0x0000ffff));
  assert(canvases.clear(queued->handle));
  assert(canvases.prepareImage(queued->handle));
  assert(std::all_of(texture.begin(),texture.end(),[](uint8_t v){return v==0;}));
  assert(canvases.release(queued->handle));

  const auto textCanvas=canvases.create(32,24); assert(textCanvas);
  assert(canvases.prepareImage(textCanvas->handle));
  assert(canvases.clear(textCanvas->handle));
  const auto font=std::filesystem::path(__FILE__).parent_path()/"assets/testfont.ttf";
  assert(canvases.drawText(textCanvas->handle,font,"A",1,19,18,0xffffffff));
  const auto textPixels=canvases.readPixels(textCanvas->handle,0,0,32,24); assert(textPixels);
  assert(std::any_of(textPixels->rgba.begin(),textPixels->rgba.end(),[](uint8_t v){return v!=0;}));
  assert(canvases.clear(textCanvas->handle));
  const auto clearedText=canvases.readPixels(textCanvas->handle,0,0,32,24); assert(clearedText);
  assert(std::all_of(clearedText->rgba.begin(),clearedText->rgba.end(),[](uint8_t v){return v==0;}));
  assert(canvases.prepareImage(textCanvas->handle));
  assert(std::all_of(texture.begin(),texture.end(),[](uint8_t v){return v==0;}));
  assert(canvases.release(textCanvas->handle));

  const std::vector<uint8_t> zeros(2*2*4,0);
  const auto empty=images.createRgba(2,2,zeros.data(),true); assert(empty);
  assert(images.lookup(empty->handle)->knownAllZero);
  const std::vector<uint8_t> strided={0,0,0,0, 255,255,255,255,
                                     0,0,0,0, 255,255,255,255};
  assert(images.updateRgbaRegion(empty->handle,0,0,1,2,strided.data(),2));
  assert(images.lookup(empty->handle)->knownAllZero);
  const std::vector<uint8_t> hiddenRgb={37,0,0,0};
  assert(images.updateRgbaRegion(empty->handle,0,0,1,1,hiddenRgb.data(),1));
  assert(!images.lookup(empty->handle)->knownAllZero);
  assert(images.updateRgbaRegion(empty->handle,0,0,1,1,zeros.data(),1));
  assert(!images.lookup(empty->handle)->knownAllZero);
  const std::vector<uint8_t> fullStrided={0,0,0,0, 0,0,0,0, 255,255,255,255,
                                         0,0,0,0, 0,0,0,0, 255,255,255,255};
  assert(images.updateRgbaRegion(empty->handle,0,0,2,2,fullStrided.data(),3));
  assert(images.lookup(empty->handle)->knownAllZero);
  failUpload=true;
  assert(!images.updateRgbaRegion(empty->handle,0,0,1,1,hiddenRgb.data(),1));
  assert(!images.lookup(empty->handle)->knownAllZero);
  failUpload=false;
  assert(images.updateRgba(empty->handle,zeros.data()));
  assert(images.lookup(empty->handle)->knownAllZero);
  failUpload=true;
  assert(!images.updateRgba(empty->handle,zeros.data()));
  assert(!images.lookup(empty->handle)->knownAllZero);
  failUpload=false;
  assert(images.updateRgba(empty->handle,zeros.data()));
  assert(images.release(empty->handle));
  assert(!images.lookup(empty->handle));

  const auto reused=images.createRgba(1,1,hiddenRgb.data(),true); assert(reused);
  assert((reused->handle & 0xffffU)==(empty->handle & 0xffffU));
  assert(!images.lookup(reused->handle)->knownAllZero);
  assert(!images.lookup(empty->handle));
  assert(images.release(reused->handle));
  for(const bool target : {false,true}) {
    const auto gpu=target ? images.createRenderTarget(2,2,true) : images.createRgba(2,2,nullptr,true);
    assert(gpu && !images.lookup(gpu->handle)->knownAllZero);
    assert(images.updateRgba(gpu->handle,zeros.data()));
    assert(!images.lookup(gpu->handle)->knownAllZero);
    assert(images.updateRgbaRegion(gpu->handle,0,0,2,2,zeros.data(),2));
    assert(!images.lookup(gpu->handle)->knownAllZero);
    assert(images.release(gpu->handle));
  }
  for (const bool target : {false, true}) {
    const auto gpu = target ? images.createRenderTarget(5,3,true) : images.createRgba(5,3,nullptr,true);
    assert(gpu);
    std::vector<uint8_t> pattern(5*3*4);
    for (int i=0;i<15;++i) {
      pattern[i*4]=static_cast<uint8_t>(i*11);
      pattern[i*4+1]=static_cast<uint8_t>(i*7);
      pattern[i*4+2]=static_cast<uint8_t>(i*3);
      pattern[i*4+3]=255;
    }
    assert(images.updateRgba(gpu->handle,pattern.data()));
    const auto region = images.readPixelsRegion(gpu->handle,2,1,2,2);
    assert(region && region->width==2 && region->height==2);
    assert((readRectangle==std::array<int,4>{2,1,2,2}));
    std::vector<uint8_t> expected;
    for (int y=1;y<3;++y) expected.insert(expected.end(),pattern.begin()+(y*5+2)*4,pattern.begin()+(y*5+4)*4);
    assert(region->rgba==expected);
    const std::array<uint8_t,4> changed{19,37,53,255};
    assert(images.updateRgbaRegion(gpu->handle,4,2,1,1,changed.data(),1));
    const auto edge = images.readPixelsRegion(gpu->handle,4,2,1,1);
    assert(edge && edge->rgba==std::vector<uint8_t>(changed.begin(),changed.end()));
    assert((readRectangle==std::array<int,4>{4,2,1,1}));
    assert(!images.readPixelsRegion(gpu->handle,4,2,2,1));
    assert(images.release(gpu->handle));
  }
  for (const bool gpu : {false,true}) for (const bool immediate : {false,true}) for (const bool region : {false,true}) {
    const std::vector<uint8_t> blue={0,0,255,128};
    const std::vector<uint8_t> original={128,0,0,128};
    const auto source=images.createRgba(1,1,gpu?nullptr:original.data(),true); assert(source);
    if(gpu) assert(images.updateRgba(source->handle,original.data()));
    const auto destination=canvases.create(1,1); assert(destination);
    if(immediate) assert(canvases.readPixels(destination->handle,0,0,1,1));
    assert(canvases.drawImage(destination->handle,source->handle,0,0,1,1,0,0,1,1,1,false));
    assert(region ? images.updateRgbaRegion(source->handle,0,0,1,1,blue.data(),1) : images.updateRgba(source->handle,blue.data()));
    assert(images.release(source->handle));
    const auto captured=canvases.readPixels(destination->handle,0,0,1,1); assert(captured);
    assert((captured->rgba==std::vector<uint8_t>{255,0,0,128}));
    assert(canvases.release(destination->handle));
  }
  const auto unreadable=images.createRenderTarget(1,1,true); assert(unreadable);
  failRead=true;
  assert(!images.readPixelsRegion(unreadable->handle,0,0,1,1));
  const auto retry=canvases.create(1,1); assert(retry);
  assert(canvases.drawImage(retry->handle,unreadable->handle,0,0,1,1,0,0,1,1,1,false));
  const std::vector<uint8_t> opaqueRed={255,0,0,255};
  assert(!images.updateRgba(unreadable->handle,opaqueRed.data()));
  failRead=false;
  assert(images.updateRgba(unreadable->handle,opaqueRed.data()));
  assert((canvases.readPixels(retry->handle,0,0,1,1)->rgba==std::vector<uint8_t>(4,0)));
  assert(canvases.release(retry->handle)); assert(images.release(unreadable->handle));

  // Cropping an unchanged image view agrees with first realizing the complete
  // source, including clipped destinations and captured pre-mutation pixels.
  for (const bool premultiplied : {false,true}) for (const bool mutate : {false,true}) for (int dx : {-1,0}) {
    std::vector<uint8_t> pixels(16*12*4);
    for (size_t i=0;i<16*12;i++) {
      pixels[i*4]=37; pixels[i*4+1]=67; pixels[i*4+2]=103;
      pixels[i*4+3]=static_cast<uint8_t>(i*23);
      if (premultiplied) for (int c=0;c<3;c++) pixels[i*4+c]=pixels[i*4+c]*pixels[i*4+3]/255;
    }
    const auto asset=images.createRgba(16,12,pixels.data(),premultiplied); assert(asset);
    const auto view=canvases.create(16,12), reference=canvases.create(16,12);
    assert(view && reference);
    for (auto handle : {view->handle,reference->handle})
      assert(canvases.drawImage(handle,asset->handle,0,0,16,12,0,0,16,12,1,true));
    assert(canvases.readPixels(reference->handle,0,0,16,12));
    if (mutate) {
      const std::vector<uint8_t> replacement(16*12*4,255);
      assert(images.updateRgba(asset->handle,replacement.data()));
    }
    assert(images.release(asset->handle));
    const auto crop=canvases.create(3,3), expected=canvases.create(3,3); assert(crop && expected);
    assert(canvases.drawImage(crop->handle,view->handle,1,0,3,3,dx,0,3,3,1,true));
    assert(canvases.drawImage(expected->handle,reference->handle,1,0,3,3,dx,0,3,3,1,true));
    // Mutating the source after capture detaches its new command stream.
    assert(canvases.fillRect(view->handle,0,0,16,12,0xff0000ff));
    const auto beforeCrop=canvases.cpuBytes();
    const auto actual=canvases.readPixels(crop->handle,0,0,3,3); assert(actual);
    assert(canvases.cpuBytes()==beforeCrop+3*3*4);
    assert(actual->rgba==canvases.readPixels(expected->handle,0,0,3,3)->rgba);
    for (auto handle : {view->handle,reference->handle,crop->handle,expected->handle}) assert(canvases.release(handle));
  }
  {
    pmjs::ImageStore accountingImages;
    pmjs::CanvasStore accounting(accountingImages);
    const std::vector<uint8_t> red={255,0,0,255}, blue={0,0,255,255};
    const auto source=accountingImages.createRgba(1,1,red.data(),true); assert(source);
    const auto destination=accounting.create(1,1), retained=accounting.create(1,1);
    assert(destination && retained);
    assert(accounting.drawImage(destination->handle,source->handle,0,0,1,1,0,0,1,1,1,false));
    assert(accounting.drawImage(retained->handle,destination->handle,0,0,1,1,0,0,1,1,1,false));
    // Copy-on-write duplicates the deferred command, sharing its snapshot.
    assert(accounting.fillRect(destination->handle,0,0,1,1,0xffffffff));
    assert(accounting.cpuBytes()==0);
    assert(accountingImages.updateRgba(source->handle,blue.data()));
    assert(accounting.cpuBytes()==4);
    assert(accountingImages.release(source->handle));
    assert(accounting.release(retained->handle));
    assert(accounting.cpuBytes()==4);
    assert(accounting.realize(destination->handle));
    assert(accounting.cpuBytes()==4);
    assert(accounting.release(destination->handle));
    assert(accounting.cpuBytes()==0);

    const auto pixels=accounting.createPixels(1,1,red,pmjs::PixelEncoding::StraightRGBA8); assert(pixels);
    const auto view=accounting.create(1,1); assert(view);
    assert(accounting.cpuBytes()==4);
    assert(accounting.drawImage(view->handle,pixels->handle,0,0,1,1,0,0,1,1,1,false));
    assert(accounting.fillRect(pixels->handle,0,0,1,1,0xffffffff));
    assert(accounting.cpuBytes()==8);
    assert(accounting.replacePixels(pixels->handle,blue,pmjs::PixelEncoding::StraightRGBA8));
    assert(accounting.cpuBytes()==8);
    assert(accounting.release(pixels->handle));
    assert(accounting.cpuBytes()==4);
    assert(accounting.readPixels(view->handle,0,0,1,1)->rgba==red);
    assert(accounting.cpuBytes()==4);
    assert(accounting.release(view->handle));
    assert(accounting.cpuBytes()==0);
  }
  {
    const auto large=canvases.create(8192,2049), source=canvases.create(1,1);
    assert(large && source);
    assert(canvases.writePixels(source->handle,0,0,1,1,{255,0,0,128}));
    for (const int x : {1,8191}) {
      assert(canvases.writePixels(large->handle,x,2048,1,1,{0,0,255,255}));
      assert(canvases.drawImage(large->handle,source->handle,0,0,1,1,x,2048,1,1,1,false));
      const auto pixels=canvases.readPixels(large->handle,x,2048,1,1);
      assert(pixels && (pixels->rgba==std::vector<uint8_t>{128,0,127,255}));
    }
    assert(canvases.release(large->handle));assert(canvases.release(source->handle));
  }
  std::cout << "[canvas-upload] exact RGBA premultiplied transfers, region bounds and failed-upload retry agree\n";
}
