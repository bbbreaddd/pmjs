#include "platform.hpp"
#include "renderer.hpp"
#include "resources.hpp"

#include <GLES3/gl3.h>
#include <dlfcn.h>
#include <algorithm>
#include <array>
#include <cassert>
#include <cstdlib>
#include <memory>
#include <new>
#include <stdexcept>
#include <vector>

namespace {
bool failFramebuffer = false;
bool failTextureAllocation = false;
bool failFramebufferAllocation = false;
bool recordAllocations = false;
std::vector<GLuint> textures, framebuffers, renderbuffers;
}

// Keep real driver rendering while controlling allocation failure and teardown checks.
extern "C" {
GLenum glCheckFramebufferStatus(GLenum target) {
  if (failFramebuffer) {
    failFramebuffer = false;
    return GL_FRAMEBUFFER_INCOMPLETE_ATTACHMENT;
  }
  static const auto real = reinterpret_cast<GLenum (*)(GLenum)>(dlsym(RTLD_NEXT, "glCheckFramebufferStatus"));
  assert(real);
  return real(target);
}
void glGenTextures(GLsizei count, GLuint* names) {
  if (failTextureAllocation) {
    failTextureAllocation = false;
    std::fill_n(names, count, 0);
    return;
  }
  static const auto real = reinterpret_cast<void (*)(GLsizei, GLuint*)>(dlsym(RTLD_NEXT, "glGenTextures"));
  assert(real);
  real(count, names);
  if (recordAllocations) textures.insert(textures.end(), names, names + count);
}
void glGenRenderbuffers(GLsizei count, GLuint* names) {
  static const auto real = reinterpret_cast<void (*)(GLsizei, GLuint*)>(dlsym(RTLD_NEXT, "glGenRenderbuffers"));
  assert(real);
  real(count, names);
  if (recordAllocations) renderbuffers.insert(renderbuffers.end(), names, names + count);
}
void glGenFramebuffers(GLsizei count, GLuint* names) {
  if (failFramebufferAllocation) {
    failFramebufferAllocation = false;
    std::fill_n(names, count, 0);
    return;
  }
  static const auto real = reinterpret_cast<void (*)(GLsizei, GLuint*)>(dlsym(RTLD_NEXT, "glGenFramebuffers"));
  assert(real);
  real(count, names);
  if (recordAllocations) framebuffers.insert(framebuffers.end(), names, names + count);
}
}

int main() {
  setenv("PMJS_GRAPHICS_DIAGNOSTICS", "1", 1);
  pmjs::Platform platform(32, 32, "Filter allocation lifetime");
  pmjs::ImageStore images;
  std::vector<std::uint8_t> pixels(32 * 32 * 4, 255);
  const auto image = images.createRgba(32, 32, pixels.data(), true);
  assert(image);
  recordAllocations = true;
  {
    pmjs::Renderer renderer(32, 32, images);
    const auto program = renderer.createFilterProgram(
      "varying vec2 vTextureCoord; uniform sampler2D uSampler; void main(){gl_FragColor=texture2D(uSampler,vTextureCoord);}",
      "attribute vec2 aVertexPosition; attribute vec2 aTextureCoord; uniform mat3 projectionMatrix; varying vec2 vTextureCoord; void main(){gl_Position=vec4((projectionMatrix*vec3(aVertexPosition,1.0)).xy,0,1);vTextureCoord=aTextureCoord;}");
    const auto plan = [&](int width, int height) {
      auto value = std::make_shared<pmjs::CustomFilterPlan>();
      value->frame = {0, 0, float(width), float(height)};
      value->resolutions = {1, 1, 1};
      pmjs::CustomFilterPass first, last;
      first.program = last.program = program;
      first.input = 0; first.output = 2; first.clear = true;
      last.input = 2; last.output = 1;
      value->passes = {first, last};
      return std::pair{value, renderer.registerFilterPlan(value)};
    };
    const auto large = plan(32, 24), small = plan(16, 12), other = plan(8, 6);
    const auto render = [&](std::uint32_t handle) {
      const std::array<std::uint32_t, 21> metadata{
        6, pmjs::scene_packet::noParent, handle, 0xffffff, 31, 0, 0,
        1, 0, image->handle, 0xffffff, 0, 0, 0,
        7, 0, 0, 0xffffff, 0, 0, 0};
      std::array<float, 3 * pmjs::scene_packet::valueStride> values{};
      for (std::size_t i = 0; i < 3; ++i) {
        auto* v = values.data() + i * pmjs::scene_packet::valueStride;
        v[0] = v[3] = v[6] = 1;
      }
      auto* sprite = values.data() + pmjs::scene_packet::valueStride;
      sprite[11] = sprite[12] = sprite[13] = sprite[14] = 32;
      renderer.beginFrame();
      assert(renderer.queueScene(pmjs::scene_packet::version, metadata.data(), metadata.size(),
        values.data(), values.size(), 3));
      renderer.renderScene();
      return renderer.captureSceneRawPremultiplied();
    };
    const auto largePixels = render(large.second);
    const auto smallPixels = render(small.second);
    const auto beforeFailure = renderer.stats();
    for (auto* failure : {&failFramebuffer, &failTextureAllocation, &failFramebufferAllocation}) {
      *failure = true;
      bool failed = false;
      try { render(other.second); }
      catch (const std::runtime_error&) { failed = true; }
      catch (const std::bad_alloc&) { failed = true; }
      assert(failed && !*failure);
      assert(renderer.stats().rendererTargetBytes == beforeFailure.rendererTargetBytes);
      assert(renderer.stats().rendererTargetCacheBytes == beforeFailure.rendererTargetCacheBytes);
      assert(glGetError() == GL_NO_ERROR);
    }
    assert(render(small.second) == smallPixels);
    assert(render(large.second) == largePixels);
    assert(renderer.stats().rendererTargetCreates == beforeFailure.rendererTargetCreates);
    assert(renderer.stats().rendererTargetDestroys == beforeFailure.rendererTargetDestroys);
    assert(renderer.stats().rendererTargetCacheHits >= 3);
    const auto pressure = plan(2048, 2048);
    assert(render(pressure.second) == pixels);
    assert(render(small.second) == smallPixels);
    assert(renderer.stats().rendererTargetCacheBytes <= 32U * 1024U * 1024U);
    assert(renderer.stats().rendererTargetCacheEvictions > 0);
    assert(glGetError() == GL_NO_ERROR);
  }
  recordAllocations = false;
  assert(!textures.empty() && !framebuffers.empty());
  for (auto name : textures) assert(!glIsTexture(name));
  for (auto name : framebuffers) assert(!glIsFramebuffer(name));
  for (auto name : renderbuffers) assert(!glIsRenderbuffer(name));
  assert(glGetError() == GL_NO_ERROR);
}
