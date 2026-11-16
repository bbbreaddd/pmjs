#include "graphics/renderer.hpp"
#include <SDL.h>
#include <GLES3/gl3.h>
#include <array>
#include <cassert>
#include <iostream>

int main() {
  SDL_SetHint(SDL_HINT_VIDEO_X11_FORCE_EGL, "1");
  assert(SDL_Init(SDL_INIT_VIDEO) == 0);
  SDL_GL_SetAttribute(SDL_GL_CONTEXT_PROFILE_MASK, SDL_GL_CONTEXT_PROFILE_ES);
  SDL_GL_SetAttribute(SDL_GL_CONTEXT_MAJOR_VERSION, 3);
  SDL_GL_SetAttribute(SDL_GL_ALPHA_SIZE, 8);
  auto* window = SDL_CreateWindow("Renderer clearing", 0, 0, 16, 12,
                                 SDL_WINDOW_OPENGL | SDL_WINDOW_HIDDEN);
  assert(window);
  const auto context = SDL_GL_CreateContext(window);
  assert(context);
  {
    pmjs::ImageStore images;
    pmjs::Renderer renderer(16, 12, images);
    renderer.clearScene(0, 0, 1, 1);
    std::array<GLuint, 2> framebuffers{};
    glGenFramebuffers(2, framebuffers.data());
    glBindFramebuffer(GL_READ_FRAMEBUFFER, framebuffers[0]);
    glBindFramebuffer(GL_DRAW_FRAMEBUFFER, framebuffers[1]);
    glEnable(GL_SCISSOR_TEST);
    glScissor(1, 2, 3, 4);
    glViewport(2, 3, 4, 5);
    glColorMask(GL_FALSE, GL_TRUE, GL_FALSE, GL_TRUE);
    glClearColor(0.25F, 0.5F, 0.75F, 1);
    const auto verifyState = [&] {
      GLint read = 0, draw = 0;
      std::array<GLint, 4> viewport{}, scissor{};
      std::array<GLboolean, 4> mask{};
      std::array<GLfloat, 4> color{};
      glGetIntegerv(GL_READ_FRAMEBUFFER_BINDING, &read);
      glGetIntegerv(GL_DRAW_FRAMEBUFFER_BINDING, &draw);
      glGetIntegerv(GL_VIEWPORT, viewport.data());
      glGetIntegerv(GL_SCISSOR_BOX, scissor.data());
      glGetBooleanv(GL_COLOR_WRITEMASK, mask.data());
      glGetFloatv(GL_COLOR_CLEAR_VALUE, color.data());
      assert(read == static_cast<GLint>(framebuffers[0]));
      assert(draw == static_cast<GLint>(framebuffers[1]));
      assert(glIsEnabled(GL_SCISSOR_TEST));
      assert((viewport == std::array<GLint, 4>{2, 3, 4, 5}));
      assert((scissor == std::array<GLint, 4>{1, 2, 3, 4}));
      assert((mask == std::array<GLboolean, 4>{GL_FALSE, GL_TRUE, GL_FALSE, GL_TRUE}));
      assert((color == std::array<GLfloat, 4>{0.25F, 0.5F, 0.75F, 1}));
      assert(glGetError() == GL_NO_ERROR);
    };
    renderer.clearScene(1, 0, 0, 1);
    verifyState();
    renderer.clearScene(0, 1, 0, 1, std::array<int, 4>{2, 3, 4, 5});
    verifyState();
    const auto pixels = renderer.captureSceneRgba();
    const auto pixel = [&](int x, int y) {
      const auto offset = static_cast<std::size_t>(y * 16 + x) * 4;
      return std::array<std::uint8_t, 4>{pixels[offset], pixels[offset + 1],
        pixels[offset + 2], pixels[offset + 3]};
    };
    assert((pixel(0, 0) == std::array<std::uint8_t, 4>{255, 0, 0, 255}));
    assert((pixel(3, 5) == std::array<std::uint8_t, 4>{0, 255, 0, 255}));
    glBindFramebuffer(GL_FRAMEBUFFER, 0);
    glDeleteFramebuffers(2, framebuffers.data());
  }
  SDL_GL_DeleteContext(context);
  const auto resizeContext = SDL_GL_CreateContext(window);
  assert(resizeContext);
  {
    pmjs::ImageStore images;
    pmjs::Renderer renderer(8,6,images);
    renderer.setDrawableSize(16,12);
    assert(renderer.setScreenRenderSize(16,12));
    renderer.clearScene(0,1,0,1);
    renderer.presentToDrawable();
    glBindFramebuffer(GL_FRAMEBUFFER,0);
    std::array<std::uint8_t,4> corner{};
    glReadPixels(15,11,1,1,GL_RGBA,GL_UNSIGNED_BYTE,corner.data());
    assert((corner==std::array<std::uint8_t,4>{0,255,0,255}));
    assert(glGetError()==GL_NO_ERROR);
  }
  SDL_GL_DeleteContext(resizeContext);
  const auto captureContext = SDL_GL_CreateContext(window);
  assert(captureContext);
  {
    pmjs::ImageStore images;
    pmjs::Renderer renderer(1, 3, images);
    const std::vector<std::uint8_t> premultiplied{
      128, 0, 0, 128, 0, 255, 0, 255, 0, 0, 255, 255};
    const std::vector<std::uint8_t> straight{
      255, 0, 0, 128, 0, 255, 0, 255, 0, 0, 255, 255};
    renderer.clearScene(0, 0, 1, 1);
    renderer.clearScene(0.5F, 0, 0, 0.5F, std::array<int, 4>{0, 2, 1, 1});
    renderer.clearScene(0, 1, 0, 1, std::array<int, 4>{0, 1, 1, 1});
    assert(renderer.captureSceneRawPremultiplied() == premultiplied);
    assert(renderer.captureSceneRgba(pmjs::AlphaMode::straight) == straight);
    assert(renderer.captureSceneRgba(pmjs::AlphaMode::premultiplied) == premultiplied);

    const auto image = images.createRgba(1, 3, premultiplied.data(), true);
    assert(image);
    assert(renderer.renderToRgba(1, 3, image->handle, pmjs::AlphaMode::premultiplied) == premultiplied);
    assert(renderer.renderToRgba(1, 3, image->handle, pmjs::AlphaMode::straight) == straight);

    renderer.setDrawableSize(1, 3);
    glBindFramebuffer(GL_DRAW_FRAMEBUFFER, 0);
    glColorMask(GL_TRUE, GL_TRUE, GL_TRUE, GL_TRUE);
    glEnable(GL_SCISSOR_TEST);
    for (int y = 0; y < 3; ++y) {
      const auto offset = static_cast<std::size_t>(2 - y) * 4;
      glScissor(0, y, 1, 1);
      glClearColor(premultiplied[offset] / 255.0F, premultiplied[offset + 1] / 255.0F,
                   premultiplied[offset + 2] / 255.0F, premultiplied[offset + 3] / 255.0F);
      glClear(GL_COLOR_BUFFER_BIT);
    }
    glDisable(GL_SCISSOR_TEST);
    assert(renderer.captureDrawableRgba(pmjs::AlphaMode::premultiplied) == premultiplied);
    assert(renderer.captureDrawableRgba(pmjs::AlphaMode::straight) == straight);
  }
  SDL_GL_DeleteContext(captureContext);
  SDL_DestroyWindow(window);
  SDL_Quit();
  std::cout << "Immediate clearing preserves framebuffer, scissor, viewport and color state\n";
}
