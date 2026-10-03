#include "platform.hpp"
#include "resources.hpp"

#include <array>
#include <cstdio>
#include <cstdlib>
#include <stdexcept>
#include <utility>
#include <unistd.h>

#include <GLES3/gl3.h>
#include <png.h>

int main() {
  pmjs::Platform platform(16, 16, "Image capability test");
  pmjs::ImageStore images;
  const auto sampled = images.createRgba(4, 4, nullptr);
  const auto target = images.createRenderTarget(4, 4);
  if (!sampled || !target) throw std::runtime_error("image allocation failed");
  if (images.isRenderTarget(sampled->handle)) {
    throw std::runtime_error("GPU-only sampled storage acquired render-target capability");
  }
  if (!images.isRenderTarget(target->handle)) {
    throw std::runtime_error("render target lost its mutation capability");
  }
  images.release(sampled->handle);
  images.release(target->handle);
  if (images.isRenderTarget(target->handle)) {
    throw std::runtime_error("released image retained render-target capability");
  }

  const std::array<std::uint8_t, 16> rgba = {
    255, 0, 0, 255, 0, 255, 0, 128,
    0, 0, 255, 64, 127, 63, 31, 0
  };
  char path[] = "/tmp/pmjs-image-readback-XXXXXX";
  const int descriptor = mkstemp(path);
  if (descriptor < 0) throw std::runtime_error("temporary image allocation failed");
  close(descriptor);
  png_image png{};
  png.version = PNG_IMAGE_VERSION;
  png.width = 2;
  png.height = 2;
  png.format = PNG_FORMAT_RGBA;
  if (!png_image_write_to_file(&png, path, 0, rgba.data(), 0, nullptr)) {
    std::remove(path);
    throw std::runtime_error("temporary image encoding failed");
  }
  const auto image = images.loadPng(path);
  std::remove(path);
  if (!image) throw std::runtime_error("temporary image loading failed");

  GLuint readFramebuffer = 0, drawFramebuffer = 0, packBuffer = 0;
  glGenFramebuffers(1, &readFramebuffer);
  glGenFramebuffers(1, &drawFramebuffer);
  glGenBuffers(1, &packBuffer);
  glBindFramebuffer(GL_READ_FRAMEBUFFER, readFramebuffer);
  glBindFramebuffer(GL_DRAW_FRAMEBUFFER, drawFramebuffer);
  glBindBuffer(GL_PIXEL_PACK_BUFFER, packBuffer);
  glPixelStorei(GL_PACK_ALIGNMENT, 8);
  glPixelStorei(GL_PACK_ROW_LENGTH, 7);
  glPixelStorei(GL_PACK_SKIP_PIXELS, 2);
  glPixelStorei(GL_PACK_SKIP_ROWS, 3);
  const auto pixels = images.readPixels(image->handle);
  if (!pixels || pixels->rgba != std::vector<std::uint8_t>(rgba.begin(), rgba.end())) {
    throw std::runtime_error("lazy image pixels changed row order or straight alpha");
  }
  const std::array<std::pair<GLenum, GLint>, 7> expected = {{
    {GL_READ_FRAMEBUFFER_BINDING, static_cast<GLint>(readFramebuffer)},
    {GL_DRAW_FRAMEBUFFER_BINDING, static_cast<GLint>(drawFramebuffer)},
    {GL_PIXEL_PACK_BUFFER_BINDING, static_cast<GLint>(packBuffer)},
    {GL_PACK_ALIGNMENT, 8}, {GL_PACK_ROW_LENGTH, 7},
    {GL_PACK_SKIP_PIXELS, 2}, {GL_PACK_SKIP_ROWS, 3}
  }};
  for (const auto& [parameter, value] : expected) {
    GLint actual = 0;
    glGetIntegerv(parameter, &actual);
    if (actual != value) throw std::runtime_error("lazy image readback changed GL state");
  }
  images.release(image->handle);
  glBindBuffer(GL_PIXEL_PACK_BUFFER, 0);
  glBindFramebuffer(GL_READ_FRAMEBUFFER, 0);
  glBindFramebuffer(GL_DRAW_FRAMEBUFFER, 0);
  glDeleteBuffers(1, &packBuffer);
  glDeleteFramebuffers(1, &readFramebuffer);
  glDeleteFramebuffers(1, &drawFramebuffer);
}
