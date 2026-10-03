#include "effects.hpp"
#include "media_service.hpp"
#include "platform.hpp"
#include <Effekseer.h>
#include <GLES3/gl3.h>
#include <array>
#include <cstdlib>
#include <stdexcept>

int main(int argc, char** argv) {
  if (argc != 2) return 2;
  setenv("SDL_AUDIODRIVER", "dummy", 1);
  pmjs::Platform platform(32, 32, "Effect GL state");
  pmjs::Vfs vfs(argv[1]);
  pmjs::MediaService media(argv[1]);
  pmjs::Effects effects(vfs, media);
  std::array<GLuint, 2> framebuffers{};
  std::array<GLuint, Effekseer::TextureSlotMax + 1> textures{}, samplers{};
  glGenFramebuffers(framebuffers.size(), framebuffers.data());
  glGenTextures(textures.size(), textures.data());
  glGenSamplers(samplers.size(), samplers.data());
  for (std::size_t i = 0; i < textures.size(); ++i) {
    glActiveTexture(GL_TEXTURE0 + i);
    glBindTexture(GL_TEXTURE_2D, textures[i]);
    glTexImage2D(GL_TEXTURE_2D, 0, GL_RGBA8, 32, 32, 0, GL_RGBA, GL_UNSIGNED_BYTE, nullptr);
    glBindSampler(i, samplers[i]);
    if (i < framebuffers.size()) {
      glBindFramebuffer(GL_FRAMEBUFFER, framebuffers[i]);
      glFramebufferTexture2D(GL_FRAMEBUFFER, GL_COLOR_ATTACHMENT0, GL_TEXTURE_2D, textures[i], 0);
    }
  }
  glBindFramebuffer(GL_READ_FRAMEBUFFER, framebuffers[0]);
  glBindFramebuffer(GL_DRAW_FRAMEBUFFER, framebuffers[1]);
  glActiveTexture(GL_TEXTURE0 + textures.size() - 1);
  glViewport(3, 4, 25, 24);
  auto verify = [&] {
    GLint read, draw, active;
    glGetIntegerv(GL_READ_FRAMEBUFFER_BINDING, &read);
    glGetIntegerv(GL_DRAW_FRAMEBUFFER_BINDING, &draw);
    glGetIntegerv(GL_ACTIVE_TEXTURE, &active);
    if (read != static_cast<GLint>(framebuffers[0]) || draw != static_cast<GLint>(framebuffers[1]) ||
        active != static_cast<GLint>(GL_TEXTURE0 + textures.size() - 1))
      throw std::runtime_error("effect operation changed framebuffer or active texture state");
    std::array<GLint, 4> viewport{};
    glGetIntegerv(GL_VIEWPORT, viewport.data());
    if (viewport != std::array<GLint, 4>{3, 4, 25, 24}) throw std::runtime_error("effect changed viewport");
    for (std::size_t i = 0; i < textures.size(); ++i) {
      GLint texture, sampler;
      glActiveTexture(GL_TEXTURE0 + i);
      glGetIntegerv(GL_TEXTURE_BINDING_2D, &texture);
      glGetIntegerv(GL_SAMPLER_BINDING, &sampler);
      if (texture != static_cast<GLint>(textures[i]) || sampler != static_cast<GLint>(samplers[i]))
        throw std::runtime_error("effect operation changed a texture or sampler binding");
    }
    glActiveTexture(active);
    if (glGetError() != GL_NO_ERROR) throw std::runtime_error("effect operation produced a GL error");
  };
  const auto context = effects.createContext(); verify();
  const auto effect = effects.load(context, "effects/TextureResource.efkefc", 1); verify();
  const auto handle = effects.play(context, effect, {0, 0, 0});
  effects.update(context, 1); verify();
  pmjs::EffectDraw draw;
  draw.handle = handle;
  draw.viewport = {0, 0, 32, 32};
  draw.resetViewport = {32, 32};
  draw.projection = draw.camera = {1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1};
  if (effects.draw(draw) == 0) throw std::runtime_error("effect fixture did not draw");
  verify();
  effects.release(context, effect); verify();
  effects.releaseContext(context); verify();
  glBindFramebuffer(GL_FRAMEBUFFER, 0);
  glDeleteFramebuffers(framebuffers.size(), framebuffers.data());
  glDeleteSamplers(samplers.size(), samplers.data());
  glDeleteTextures(textures.size(), textures.data());
}
