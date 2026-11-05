#include "renderer.hpp"
#include <SDL.h>
#include <GLES3/gl3.h>
#include <array>
#include <cassert>
#include <stdexcept>

namespace {
unsigned links = 0;
}

extern "C" {
void __real_glLinkProgram(GLuint program);
void __wrap_glLinkProgram(GLuint program) {
  ++links;
  __real_glLinkProgram(program);
}
}

int main() {
  SDL_SetHint(SDL_HINT_VIDEO_X11_FORCE_EGL, "1");
  assert(SDL_Init(SDL_INIT_VIDEO) == 0);
  SDL_GL_SetAttribute(SDL_GL_CONTEXT_PROFILE_MASK, SDL_GL_CONTEXT_PROFILE_ES);
  SDL_GL_SetAttribute(SDL_GL_CONTEXT_MAJOR_VERSION, 3);
  auto* window = SDL_CreateWindow("Renderer precision", 0, 0, 8, 8,
                                  SDL_WINDOW_OPENGL | SDL_WINDOW_HIDDEN);
  assert(window);
  const auto context = SDL_GL_CreateContext(window);
  assert(context);
  unsigned familyLinks = 0;
  for (const auto* precision : {"mediump", "highp", "lowp", "default"}) {
    pmjs::ImageStore images;
    pmjs::Renderer renderer(8, 8, images);
    const auto constructed = links;
    const std::array<std::uint8_t, 4> red{255, 0, 0, 255};
    const auto image = images.createRgba(1, 1, red.data());
    assert(image);
    renderer.beginFrame();
    assert(renderer.queueImage(image->handle, {8, 0, 0, 8, 0, 0},
                                {0, 0, 1, 1}, 1, 0xffffff,
                                pmjs::BlendMode::normal));
    renderer.renderScene();
    assert(links == constructed);
    const auto earlyPixels = renderer.captureSceneRgba();
    for (std::size_t i = 0; i < earlyPixels.size(); ++i) assert(earlyPixels[i] == red[i % 4]);
    const auto mesh = renderer.createMesh(image->handle,
      {0, 0, 8, 0, 8, 8, 0, 8}, {0, 0, 1, 0, 1, 1, 0, 1},
      {0, 1, 2, 0, 2, 3}, false);
    assert(mesh);
    const bool configured = std::string(precision) != "default";
    if (configured) {
      bool rejected = false;
      try { renderer.configurePixiFragmentPrecision("invalid"); }
      catch (const std::invalid_argument&) { rejected = true; }
      assert(rejected && links == constructed);
      renderer.configurePixiFragmentPrecision(precision);
      assert(links > constructed);
      if (!familyLinks) familyLinks = links - constructed;
      assert(links - constructed == familyLinks);
      renderer.configurePixiFragmentPrecision(precision);
      assert(links - constructed == familyLinks);
    }
    for (int frame = 0; frame < 2; ++frame) {
      renderer.beginFrame();
      const std::array<std::uint32_t, pmjs::scene_packet::metadataStride> metadata{
        8, 0xffffffffU, mesh, 0xffffff, 0, 8, 0};
      std::array<float, pmjs::scene_packet::valueStride> values{};
      values[0] = values[3] = values[6] = 1;
      assert(renderer.queueScene(pmjs::scene_packet::version, metadata.data(), metadata.size(),
                                 values.data(), values.size(), 1));
      renderer.renderScene();
      assert(links - constructed == familyLinks);
      const auto pixels = renderer.captureSceneRgba();
      assert(pixels.size() == 8 * 8 * 4);
      for (std::size_t i = 0; i < pixels.size(); ++i) assert(pixels[i] == red[i % 4]);
      assert(glGetError() == GL_NO_ERROR);
    }
    if (configured) {
      bool rejected = false;
      try { renderer.configurePixiFragmentPrecision(std::string(precision) == "highp" ? "lowp" : "highp"); }
      catch (const std::runtime_error&) { rejected = true; }
      assert(rejected && links - constructed == familyLinks);
    }
    glUseProgram(0);
  }
  SDL_GL_DeleteContext(context);
  SDL_DestroyWindow(window);
  SDL_Quit();
}
