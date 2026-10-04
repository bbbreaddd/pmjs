#include "renderer.hpp"
#include <SDL.h>
#include <GLES3/gl3.h>
#include <array>
#include <cassert>
#include <iostream>

int main() {
  assert(SDL_Init(SDL_INIT_VIDEO) == 0);
  SDL_GL_SetAttribute(SDL_GL_CONTEXT_PROFILE_MASK, SDL_GL_CONTEXT_PROFILE_ES);
  SDL_GL_SetAttribute(SDL_GL_CONTEXT_MAJOR_VERSION, 3);
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
  SDL_DestroyWindow(window);
  SDL_Quit();
  std::cout << "Immediate clearing preserves framebuffer, scissor, viewport and color state\n";
}
