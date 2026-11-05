#include "renderer.hpp"
#include "resources.hpp"

#include <SDL.h>
#include <GLES3/gl3.h>
#include <algorithm>
#include <array>
#include <cstdint>
#include <functional>
#include <iostream>
#include <stdexcept>
#include <vector>

namespace {
std::vector<bool> blendStates;
bool recordBlendStates = false;

void require(bool value, const char* message) {
  if (!value) throw std::runtime_error(message);
}

struct Context {
  SDL_Window* window = nullptr;
  SDL_GLContext gl = nullptr;
  Context() {
    SDL_SetHint(SDL_HINT_VIDEO_X11_FORCE_EGL, "1");
    require(SDL_Init(SDL_INIT_VIDEO) == 0, SDL_GetError());
    SDL_GL_SetAttribute(SDL_GL_CONTEXT_PROFILE_MASK, SDL_GL_CONTEXT_PROFILE_ES);
    SDL_GL_SetAttribute(SDL_GL_CONTEXT_MAJOR_VERSION, 3);
    window = SDL_CreateWindow("Renderer opaque blend", 0, 0, 16, 16,
                              SDL_WINDOW_OPENGL | SDL_WINDOW_HIDDEN);
    require(window != nullptr, SDL_GetError());
    gl = SDL_GL_CreateContext(window);
    require(gl != nullptr, SDL_GetError());
  }
  ~Context() {
    SDL_GL_DeleteContext(gl);
    SDL_DestroyWindow(window);
    SDL_Quit();
  }
};

struct DrawResult {
  std::vector<bool> blend;
  std::array<std::uint8_t, 4> pixel{};
};

DrawResult renderDraw(pmjs::Renderer& renderer,
                      const std::function<void()>& queue) {
  renderer.beginFrame();
  queue();
  blendStates.clear();
  recordBlendStates = true;
  renderer.renderScene();
  recordBlendStates = false;
  const auto pixels = renderer.captureSceneRgba();
  const std::size_t offset = static_cast<std::size_t>((5 * 16 + 5) * 4);
  return {blendStates, {pixels[offset], pixels[offset + 1],
                        pixels[offset + 2], pixels[offset + 3]}};
}
}  // namespace

extern "C" {
void __real_glDrawArrays(GLenum mode, GLint first, GLsizei count);
void __wrap_glDrawArrays(GLenum mode, GLint first, GLsizei count) {
  if (recordBlendStates) blendStates.push_back(glIsEnabled(GL_BLEND));
  __real_glDrawArrays(mode, first, count);
}
}

int main() {
  Context context;
  pmjs::ImageStore images;
  pmjs::Renderer renderer(16, 16, images);
  renderer.setClearColor(0, 0, 1, 1);

  const std::vector<std::uint8_t> opaquePixels{
    255, 0, 0, 255, 255, 0, 0, 255,
    255, 0, 0, 255, 255, 0, 0, 255};
  const std::vector<std::uint8_t> translucentPixels{
    255, 0, 0, 128, 255, 0, 0, 128,
    255, 0, 0, 128, 255, 0, 0, 128};
  const auto opaque = images.createRgba(2, 2, opaquePixels.data());
  const auto translucent = images.createRgba(2, 2, translucentPixels.data());
  require(opaque.has_value(), "opaque image creation failed");
  require(translucent.has_value(), "translucent image creation failed");
  require(images.isOpaque(opaque->handle) == std::optional<bool>(true),
          "opaque image classification failed");
  require(images.isOpaque(translucent->handle) == std::optional<bool>(false),
          "translucent image classification failed");
  require(images.isOpaque(opaque->handle) == std::optional<bool>(true), "opaque classification was not retained");
  require(images.isOpaque(translucent->handle) == std::optional<bool>(false),
          "translucent classification was not retained");

  const auto draw = [&](pmjs::ImageHandle image, float alpha) {
    return renderDraw(renderer, [&] {
      require(renderer.queueImage(image, {16, 0, 0, 16, 0, 0},
                                  {0, 0, 2, 2}, alpha, 0xffffff,
                                  pmjs::BlendMode::normal),
              "image submission failed");
    });
  };

  const auto opaqueDraw = draw(opaque->handle, 1);
  require((opaqueDraw.pixel == std::array<std::uint8_t, 4>{255, 0, 0, 255}),
          "opaque image draw changed pixels");
  require(glIsEnabled(GL_BLEND), "opaque draw did not restore blending");

  const auto translucentDraw = draw(translucent->handle, 1);
  require(!translucentDraw.blend.empty() &&
          std::all_of(translucentDraw.blend.begin(), translucentDraw.blend.end(),
                      [](bool enabled) { return enabled; }),
          "translucent image draw disabled blending");
  require(translucentDraw.pixel[0] > 120 && translucentDraw.pixel[0] < 136 &&
          translucentDraw.pixel[2] > 120 && translucentDraw.pixel[2] < 136,
          "translucent image draw lost its blend");

  const auto fadedDraw = draw(opaque->handle, 0.5F);
  require(!fadedDraw.blend.empty() &&
          std::all_of(fadedDraw.blend.begin(), fadedDraw.blend.end(),
                      [](bool enabled) { return enabled; }),
          "faded opaque image draw disabled blending");
  require(fadedDraw.pixel[0] > 120 && fadedDraw.pixel[0] < 136 &&
          fadedDraw.pixel[2] > 120 && fadedDraw.pixel[2] < 136,
          "faded opaque image draw lost its blend");

  const auto fill = renderDraw(renderer, [&] {
    renderer.queueQuad(0, 0, 16, 16, {0, 1, 0, 1});
  });
  require((fill.pixel == std::array<std::uint8_t, 4>{0, 255, 0, 255}),
          "opaque screen fill changed pixels");
  require(glIsEnabled(GL_BLEND), "screen fill did not restore blending");

  std::cout << "Opaque, translucent and faded draws preserve rendered pixels and blend state\n";
}
