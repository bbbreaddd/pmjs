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
  texture.assign(bytes,bytes+static_cast<size_t>(width)*height*4);
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
  std::cout << "[canvas-upload] exact RGBA premultiplied transfers, region bounds and failed-upload retry agree\n";
}
