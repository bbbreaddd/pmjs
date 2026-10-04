#include "canvas.hpp"
#include <GLES3/gl3.h>
#include <algorithm>
#include <cassert>
#include <iostream>
#include <vector>

namespace {
std::vector<uint8_t> texture;
int textureWidth, textureHeight, rowLength, fullUploads, regionUploads;
GLenum pendingError = GL_NO_ERROR;
bool failUpload = false;
}
// Capture the actual GLES transfer boundary without a window or driver.
extern "C" {
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
void glGenFramebuffers(GLsizei, GLuint*) { assert(false); }
void glBindFramebuffer(GLenum, GLuint) { assert(false); }
void glFramebufferTexture2D(GLenum, GLenum, GLenum, GLuint, GLint) { assert(false); }
GLenum glCheckFramebufferStatus(GLenum) { assert(false); return 0; }
void glBindBuffer(GLenum, GLuint) { assert(false); }
void glReadPixels(GLint, GLint, GLsizei, GLsizei, GLenum, GLenum, void*) { assert(false); }
void glDeleteFramebuffers(GLsizei, const GLuint*) { assert(false); }
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
  std::cout << "[canvas-upload] exact RGBA premultiplied transfers, region bounds and failed-upload retry agree\n";
}
