#include "effects.hpp"
#include "media_service.hpp"
#include <Effekseer.h>
#include <SDL.h>
#include <GLES3/gl3.h>
#include <array>
#include <cstdint>
#include <cstdlib>
#include <cstring>
#include <stdexcept>
#include <string>
#include <utility>
#include <vector>

namespace {
struct Context {
  SDL_Window* window;
  SDL_GLContext gl;
  explicit Context(int version) {
    if (SDL_Init(SDL_INIT_VIDEO | SDL_INIT_AUDIO) != 0) throw std::runtime_error(SDL_GetError());
    SDL_GL_SetAttribute(SDL_GL_CONTEXT_PROFILE_MASK, SDL_GL_CONTEXT_PROFILE_ES);
    SDL_GL_SetAttribute(SDL_GL_CONTEXT_MAJOR_VERSION, version);
    SDL_GL_SetAttribute(SDL_GL_CONTEXT_MINOR_VERSION, 0);
    window = SDL_CreateWindow("Effect GL state", 0, 0, 32, 32, SDL_WINDOW_OPENGL | SDL_WINDOW_HIDDEN);
    if (!window) { SDL_Quit(); throw std::runtime_error(SDL_GetError()); }
    gl = SDL_GL_CreateContext(window);
    if (!gl) { SDL_DestroyWindow(window); SDL_Quit(); throw std::runtime_error(SDL_GetError()); }
    const char* actual = reinterpret_cast<const char*>(glGetString(GL_VERSION));
    if (!actual || std::strncmp(actual, version == 3 ? "OpenGL ES 3" : "OpenGL ES 2", 11) != 0)
      throw std::runtime_error("GL-state test did not obtain the requested ES version");
  }
  ~Context() { SDL_GL_DeleteContext(gl); SDL_DestroyWindow(window); SDL_Quit(); }
};

GLuint makeProgram() {
  const char* vertex = "attribute vec4 position; void main() { gl_Position = position; }";
  const char* fragment = "precision mediump float; void main() { gl_FragColor = vec4(1.0); }";
  const GLuint program = glCreateProgram();
  for (auto [type, source] : {std::pair{GL_VERTEX_SHADER, vertex}, std::pair{GL_FRAGMENT_SHADER, fragment}}) {
    GLuint shader = glCreateShader(type);
    glShaderSource(shader, 1, &source, nullptr);
    glCompileShader(shader);
    GLint compiled;
    glGetShaderiv(shader, GL_COMPILE_STATUS, &compiled);
    if (!compiled) throw std::runtime_error("GL-state test shader did not compile");
    glAttachShader(program, shader);
    glDeleteShader(shader);
  }
  glBindAttribLocation(program, 0, "position");
  glLinkProgram(program);
  GLint linked;
  glGetProgramiv(program, GL_LINK_STATUS, &linked);
  if (!linked) throw std::runtime_error("GL-state test program did not link");
  return program;
}

struct Attribute {
  std::array<GLint, 6> values{};
  void* pointer = nullptr;
  bool operator==(const Attribute&) const = default;
};
std::vector<Attribute> attributes() {
  constexpr GLenum queries[] = {GL_VERTEX_ATTRIB_ARRAY_ENABLED, GL_VERTEX_ATTRIB_ARRAY_BUFFER_BINDING,
    GL_VERTEX_ATTRIB_ARRAY_SIZE, GL_VERTEX_ATTRIB_ARRAY_STRIDE, GL_VERTEX_ATTRIB_ARRAY_TYPE,
    GL_VERTEX_ATTRIB_ARRAY_NORMALIZED};
  GLint count;
  glGetIntegerv(GL_MAX_VERTEX_ATTRIBS, &count);
  std::vector<Attribute> result(count);
  for (GLint i = 0; i < count; ++i) {
    for (std::size_t j = 0; j < std::size(queries); ++j)
      glGetVertexAttribiv(i, queries[j], &result[i].values[j]);
    glGetVertexAttribPointerv(i, GL_VERTEX_ATTRIB_ARRAY_POINTER, &result[i].pointer);
  }
  return result;
}
}

int main(int argc, char** argv) {
  if (argc != 3) return 2;
  const bool es3 = std::string(argv[2]) == "3";
  setenv("SDL_AUDIODRIVER", "dummy", 1);
  Context context(es3 ? 3 : 2);
  pmjs::Vfs vfs(argv[1]);
  pmjs::MediaService media(argv[1]);
  pmjs::Effects effects(vfs, media);
  std::array<GLuint, 2> framebuffers{};
  std::array<GLuint, Effekseer::TextureSlotMax + 1> textures{}, samplers{};
  std::array<GLuint, 3> buffers{};
  GLuint vao = 0;
  const GLuint program = makeProgram();
  glUseProgram(program);
  if (es3) { glGenVertexArrays(1, &vao); glBindVertexArray(vao); }
  glGenBuffers(buffers.size(), buffers.data());
  for (std::size_t i = 0; i < buffers.size(); ++i) {
    glBindBuffer(i == 2 ? GL_ELEMENT_ARRAY_BUFFER : GL_ARRAY_BUFFER, buffers[i]);
    glBufferData(i == 2 ? GL_ELEMENT_ARRAY_BUFFER : GL_ARRAY_BUFFER, 512, nullptr, GL_STATIC_DRAW);
  }
  GLint attributeCount;
  glGetIntegerv(GL_MAX_VERTEX_ATTRIBS, &attributeCount);
  for (GLint i = 0; i < attributeCount; ++i) {
    glBindBuffer(GL_ARRAY_BUFFER, buffers[i % 2]);
    glVertexAttribPointer(i, 1 + i % 4, GL_FLOAT, i % 2, 32,
      reinterpret_cast<void*>(static_cast<std::uintptr_t>(i % 4 * sizeof(float))));
    if (i % 2) glEnableVertexAttribArray(i);
    else glDisableVertexAttribArray(i);
  }
  glBindBuffer(GL_ARRAY_BUFFER, buffers[1]);
  const auto savedAttributes = attributes();
  glGenFramebuffers(framebuffers.size(), framebuffers.data());
  glGenTextures(textures.size(), textures.data());
  if (es3) glGenSamplers(samplers.size(), samplers.data());
  for (std::size_t i = 0; i < textures.size(); ++i) {
    glActiveTexture(GL_TEXTURE0 + i);
    glBindTexture(GL_TEXTURE_2D, textures[i]);
    glTexImage2D(GL_TEXTURE_2D, 0, GL_RGBA, 32, 32, 0, GL_RGBA, GL_UNSIGNED_BYTE, nullptr);
    if (es3) glBindSampler(i, samplers[i]);
    if (i < framebuffers.size()) {
      glBindFramebuffer(GL_FRAMEBUFFER, framebuffers[i]);
      glFramebufferTexture2D(GL_FRAMEBUFFER, GL_COLOR_ATTACHMENT0, GL_TEXTURE_2D, textures[i], 0);
      if (glCheckFramebufferStatus(GL_FRAMEBUFFER) != GL_FRAMEBUFFER_COMPLETE)
        throw std::runtime_error("GL-state test framebuffer is incomplete");
    }
  }
  if (es3) {
    glBindFramebuffer(GL_READ_FRAMEBUFFER, framebuffers[0]);
    glBindFramebuffer(GL_DRAW_FRAMEBUFFER, framebuffers[1]);
  } else glBindFramebuffer(GL_FRAMEBUFFER, framebuffers[1]);
  glActiveTexture(GL_TEXTURE0 + textures.size() - 1);
  glViewport(3, 4, 25, 24);

  // Upstream restores render state; PMJS protects bindings around every operation.
  glEnable(GL_BLEND); glEnable(GL_DEPTH_TEST); glEnable(GL_CULL_FACE); glEnable(GL_SCISSOR_TEST);
  glBlendFuncSeparate(GL_DST_COLOR, GL_ONE_MINUS_DST_COLOR, GL_DST_ALPHA, GL_ONE_MINUS_DST_ALPHA);
  glBlendEquationSeparate(GL_FUNC_REVERSE_SUBTRACT, GL_FUNC_SUBTRACT);
  glDepthFunc(GL_GREATER); glDepthMask(GL_FALSE); glCullFace(GL_FRONT); glFrontFace(GL_CW);
  glScissor(2, 3, 20, 18); glColorMask(GL_FALSE, GL_TRUE, GL_FALSE, GL_TRUE);
  constexpr GLenum renderQueries[] = {GL_BLEND, GL_DEPTH_TEST, GL_CULL_FACE, GL_SCISSOR_TEST,
    GL_BLEND_SRC_RGB, GL_BLEND_DST_RGB, GL_BLEND_SRC_ALPHA, GL_BLEND_DST_ALPHA,
    GL_BLEND_EQUATION_RGB, GL_BLEND_EQUATION_ALPHA, GL_DEPTH_FUNC, GL_DEPTH_WRITEMASK,
    GL_CULL_FACE_MODE, GL_FRONT_FACE};
  std::array<GLint, std::size(renderQueries)> savedRender{};
  for (std::size_t i = 0; i < savedRender.size(); ++i) glGetIntegerv(renderQueries[i], &savedRender[i]);
  auto verify = [&] {
    for (auto [query, expected] : {std::pair{GL_CURRENT_PROGRAM, program},
        std::pair{GL_ARRAY_BUFFER_BINDING, buffers[1]}, std::pair{GL_ELEMENT_ARRAY_BUFFER_BINDING, buffers[2]},
        std::pair{es3 ? GL_DRAW_FRAMEBUFFER_BINDING : GL_FRAMEBUFFER_BINDING, framebuffers[1]},
        std::pair{GL_ACTIVE_TEXTURE, static_cast<GLuint>(GL_TEXTURE0 + textures.size() - 1)}}) {
      GLint actual; glGetIntegerv(query, &actual);
      if (actual != static_cast<GLint>(expected)) throw std::runtime_error("effect changed binding " + std::to_string(query));
    }
    if (es3) {
      GLint read, boundVao;
      glGetIntegerv(GL_READ_FRAMEBUFFER_BINDING, &read); glGetIntegerv(GL_VERTEX_ARRAY_BINDING, &boundVao);
      if (read != static_cast<GLint>(framebuffers[0]) || boundVao != static_cast<GLint>(vao))
        throw std::runtime_error("effect changed read framebuffer or VAO");
    }
    if (attributes() != savedAttributes) throw std::runtime_error("effect changed vertex attributes");
    for (std::size_t i = 0; i < savedRender.size(); ++i) {
      GLint actual; glGetIntegerv(renderQueries[i], &actual);
      if (actual != savedRender[i]) throw std::runtime_error("effect changed render state " + std::to_string(renderQueries[i]));
    }
    std::array<GLint, 4> viewport{}, scissor{}, mask{};
    glGetIntegerv(GL_VIEWPORT, viewport.data()); glGetIntegerv(GL_SCISSOR_BOX, scissor.data());
    glGetIntegerv(GL_COLOR_WRITEMASK, mask.data());
    if (viewport != std::array<GLint, 4>{3, 4, 25, 24} || scissor != std::array<GLint, 4>{2, 3, 20, 18} ||
        mask != std::array<GLint, 4>{0, 1, 0, 1}) throw std::runtime_error("effect changed viewport, scissor or color mask");
    for (std::size_t i = 0; i < textures.size(); ++i) {
      GLint texture, sampler = 0;
      glActiveTexture(GL_TEXTURE0 + i);
      glGetIntegerv(GL_TEXTURE_BINDING_2D, &texture);
      if (es3) glGetIntegerv(GL_SAMPLER_BINDING, &sampler);
      if (texture != static_cast<GLint>(textures[i]) || sampler != static_cast<GLint>(samplers[i]))
        throw std::runtime_error("effect changed texture or sampler binding");
    }
    glActiveTexture(GL_TEXTURE0 + textures.size() - 1);
    if (glGetError() != GL_NO_ERROR) throw std::runtime_error("effect operation produced a GL error");
  };
  verify();
  const auto effectContext = effects.createContext(); verify();
  const auto effect = effects.load(effectContext, "effects/TextureResource.efkefc", 1); verify();
  const auto handle = effects.play(effectContext, effect, {0, 0, 0}); verify();
  effects.update(effectContext, 1); verify();
  pmjs::EffectDraw draw;
  draw.handle = handle;
  draw.viewport = {0, 0, 32, 32};
  draw.resetViewport = {32, 32};
  draw.projection = draw.camera = {1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1};
  if (effects.draw(draw) == 0) throw std::runtime_error("effect fixture did not draw");
  verify();
  glDisable(GL_BLEND); glDisable(GL_DEPTH_TEST); glDisable(GL_CULL_FACE); glDisable(GL_SCISSOR_TEST);
  savedRender[0] = savedRender[1] = savedRender[2] = savedRender[3] = GL_FALSE;
  if (effects.draw(draw) == 0) throw std::runtime_error("effect fixture did not draw twice");
  verify();
  effects.release(effectContext, effect); verify();
  effects.releaseContext(effectContext); verify();
  glUseProgram(0); glDeleteProgram(program);
  if (es3) { glBindVertexArray(0); glDeleteVertexArrays(1, &vao); }
  glDeleteBuffers(buffers.size(), buffers.data());
  glBindFramebuffer(GL_FRAMEBUFFER, 0);
  glDeleteFramebuffers(framebuffers.size(), framebuffers.data());
  if (es3) glDeleteSamplers(samplers.size(), samplers.data());
  glDeleteTextures(textures.size(), textures.data());
}
