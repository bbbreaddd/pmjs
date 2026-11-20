#include "graphics/renderer.hpp"
#include "graphics/resources.hpp"
#include <SDL.h>
#include <GLES3/gl3.h>
#include <array>
#include <cassert>
#include <functional>
#include <vector>

namespace {
using namespace pmjs;
bool failReadback = false;
unsigned readbacks = 0;
struct Result { std::vector<std::uint8_t> pixels; std::uint64_t skipped; };

void sprite(Renderer& renderer, ImageHandle image, float alpha = 1,
            std::uint32_t flags = scene_packet::nearestSampling, int blend = 0, float x = 0, float scale = 4) {
  std::array<std::uint32_t, scene_packet::metadataStride> metadata{
    1, scene_packet::noParent, image, 0xffffff, static_cast<std::uint32_t>(blend), flags, 0};
  std::array<float, scene_packet::valueStride> values{};
  values[0] = values[3] = scale;
  values[4] = x;
  values[6] = alpha;
  values[11] = values[12] = values[13] = values[14] = 2;
  assert(renderer.queueScene(scene_packet::version, metadata.data(), metadata.size(),
    values.data(), values.size(), 1));
}

Result render(Renderer& renderer, bool enabled, const std::function<void()>& queue) {
  renderer.setDuplicateSpriteCulling(enabled);
  renderer.beginFrame();
  const auto before = renderer.stats().duplicateSpriteDrawsSkipped;
  queue();
  renderer.renderScene();
  return {renderer.captureSceneRgba(), renderer.stats().duplicateSpriteDrawsSkipped - before};
}

void compare(Renderer& renderer, const std::function<void()>& queue, std::uint64_t skipped) {
  const auto control = render(renderer, false, queue);
  const auto candidate = render(renderer, true, queue);
  assert(control.pixels == candidate.pixels);
  assert(candidate.skipped == skipped);
  assert(glGetError() == GL_NO_ERROR);
}
}

extern "C" {
void __real_glReadPixels(GLint, GLint, GLsizei, GLsizei, GLenum, GLenum, void*);
void __wrap_glReadPixels(GLint x, GLint y, GLsizei width, GLsizei height, GLenum format, GLenum type, void* data) {
  ++readbacks;
  __real_glReadPixels(x, y, width, height, format, failReadback ? 0 : type, data);
}
}

int main() {
  SDL_SetHint(SDL_HINT_VIDEO_X11_FORCE_EGL, "1");
  assert(SDL_Init(SDL_INIT_VIDEO) == 0);
  SDL_GL_SetAttribute(SDL_GL_CONTEXT_PROFILE_MASK, SDL_GL_CONTEXT_PROFILE_ES);
  SDL_GL_SetAttribute(SDL_GL_CONTEXT_MAJOR_VERSION, 3);
  auto* window = SDL_CreateWindow("Duplicate sprites", 0, 0, 16, 16, SDL_WINDOW_OPENGL | SDL_WINDOW_HIDDEN);
  assert(window);
  auto context = SDL_GL_CreateContext(window);
  assert(context);
  {
    ImageStore images;
    Renderer renderer(16, 16, images);
    renderer.setClearColor(0.2F, 0.4F, 0.8F, 1);
    std::array<std::uint8_t, 16> pixels{255, 0, 0, 255, 0, 0, 0, 0,
                                     0, 0, 0, 0, 0, 255, 0, 255};
    const auto image = images.createRgba(2, 2, pixels.data());
    assert(image);
    assert(images.hasBinaryAlpha(image->handle) == true);
    compare(renderer, [&] { for (int i = 0; i < 89; ++i) sprite(renderer, image->handle); }, 88);
    compare(renderer, [&] {
      for (int i = 0; i < 8; ++i) sprite(renderer, image->handle);
      sprite(renderer, image->handle, 0.5F);
    }, 7);
    compare(renderer, [&] {
      sprite(renderer, image->handle);
      sprite(renderer, image->handle, 1, scene_packet::nearestSampling, 0, 1);
      sprite(renderer, image->handle);
    }, 0);
    for (const int blend : {1, 2, 3}) compare(renderer, [&] {
      for (int i = 0; i < 4; ++i) sprite(renderer, image->handle, 1, scene_packet::nearestSampling, blend);
    }, 0);
    compare(renderer, [&] { for (int i = 0; i < 4; ++i) sprite(renderer, image->handle, 0.8F); }, 0);
    compare(renderer, [&] { for (int i = 0; i < 4; ++i) sprite(renderer, image->handle, 1, 0); }, 0);
    compare(renderer, [&] {
      for (int i = 0; i < 8; ++i) sprite(renderer, image->handle, 1,
        scene_packet::nearestSampling | scene_packet::mipmapSampling);
    }, 7);
    compare(renderer, [&] {
      for (int i = 0; i < 8; ++i) sprite(renderer, image->handle, 1,
        scene_packet::nearestSampling | scene_packet::mipmapSampling, 0, 0, 0.5F);
    }, 0);
    compare(renderer, [&] {
      sprite(renderer, image->handle);
      renderer.queueQuad(0, 0, 16, 16, {0, 0, 1, 1});
      sprite(renderer, image->handle);
    }, 0);
    pixels[7] = 128;
    assert(images.updateRgba(image->handle, pixels.data()));
    assert(images.hasBinaryAlpha(image->handle) == false);
    compare(renderer, [&] { for (int i = 0; i < 8; ++i) sprite(renderer, image->handle); }, 0);
    pixels[7] = 0;
    assert(images.updateRgba(image->handle, pixels.data()));
    assert(images.hasBinaryAlpha(image->handle) == true);
    compare(renderer, [&] { for (int i = 0; i < 8; ++i) sprite(renderer, image->handle); }, 7);
    const auto overAlpha = images.createRgba(2, 2, pixels.data(), true);
    assert(overAlpha);
    pixels[4] = 64;
    assert(images.updateRgba(overAlpha->handle, pixels.data()));
    assert(images.hasBinaryAlpha(overAlpha->handle) == false);
    compare(renderer, [&] { for (int i = 0; i < 4; ++i) sprite(renderer, overAlpha->handle); }, 0);
    const auto target = images.createRenderTarget(2, 2, true);
    assert(target && !images.hasBinaryAlpha(target->handle).value_or(false));
    const auto unreadable = images.createRgba(2, 2, pixels.data());
    assert(unreadable);
    failReadback = true;
    const auto beforeRead = readbacks;
    assert(!images.hasBinaryAlpha(unreadable->handle).has_value());
    assert(readbacks > beforeRead);
    const auto afterRead = readbacks;
    assert(!images.hasBinaryAlpha(unreadable->handle).has_value());
    assert(readbacks == afterRead);
    failReadback = false;
    std::vector<std::uint8_t> largePixels(1025 * 1024 * 4, 255);
    const auto large = images.createRgba(1025, 1024, largePixels.data());
    assert(large && !images.hasBinaryAlpha(large->handle).has_value());
    compare(renderer, [&] { for (int i = 0; i < 8; ++i) sprite(renderer, large->handle); }, 0);
    compare(renderer, [&] {
      constexpr std::size_t count = 6;
      std::array<std::uint32_t, count * scene_packet::metadataStride> metadata{};
      std::array<float, count * scene_packet::valueStride> values{};
      const std::array<std::uint32_t, count> kinds{6, 1, 1, 7, 1, 1};
      for (std::size_t i = 0; i < count; ++i) {
        const auto m = i * scene_packet::metadataStride, v = i * scene_packet::valueStride;
        metadata[m] = kinds[i]; metadata[m+1] = scene_packet::noParent;
        values[v] = values[v+3] = 4; values[v+6] = 1;
        if (kinds[i] == 1) {
          metadata[m+2] = image->handle; metadata[m+3] = 0xffffff;
          metadata[m+5] = scene_packet::nearestSampling;
          values[v+11] = values[v+12] = values[v+13] = values[v+14] = 2;
        } else if (kinds[i] == 6) {
          metadata[m+4] = static_cast<std::uint32_t>(scene_packet::FilterKind::alpha);
          values[v+7] = 0.5F;
        }
      }
      assert(renderer.queueScene(scene_packet::version, metadata.data(), metadata.size(), values.data(), values.size(), count));
    }, 1);
    compare(renderer, [&] {
      auto original = pixels; original[4] = 0;
      assert(images.updateRgba(image->handle, original.data()));
      for (int i = 0; i < 8; ++i) sprite(renderer, image->handle);
      auto changed = original; changed[7] = 128;
      assert(images.updateRgba(image->handle, changed.data()));
    }, 0);
    assert(images.updateRgba(image->handle, pixels.data()));
    const auto stale = image->handle;
    assert(images.release(stale));
    assert(!images.hasBinaryAlpha(stale).has_value());
    const auto replacement = images.createRgba(2, 2, pixels.data());
    assert(replacement && images.hasBinaryAlpha(replacement->handle) == false);
    std::vector<std::uint8_t> retainedPixels;
    pixels[4] = 0;
    for (const bool enabled : {false, true}) {
      const auto transient = images.createRgba(2, 2, pixels.data());
      assert(transient);
      const auto result = render(renderer, enabled, [&] {
        for (int i = 0; i < 8; ++i) sprite(renderer, transient->handle);
        assert(images.release(transient->handle));
      });
      if (!enabled) retainedPixels = result.pixels;
      else { assert(result.pixels == retainedPixels); assert(result.skipped == 7); }
      renderer.beginFrame();
      assert(!images.inspect(transient->handle));
    }
  }
  SDL_GL_DeleteContext(context);
  SDL_DestroyWindow(window);
  SDL_Quit();
}
