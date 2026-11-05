#include "renderer.hpp"
#include "renderer_identity_shader.hpp"
#include <SDL.h>
#include <GLES3/gl3.h>
#include <array>
#include <cassert>
#include <iostream>
#include <map>
#include <set>

namespace {
unsigned compiles = 0, links = 0;
unsigned failCompileAt = 0;
GLuint failedShader = 0;
bool failLinks = false;
std::map<std::pair<GLenum, std::string>, unsigned> sources;
std::set<GLuint> shaders, programs, failedPrograms;
constexpr const char* vertex = "attribute vec2 position; void main(){gl_Position=vec4(position,0.0,1.0);}";
constexpr const char* fragment = "precision mediump float; void main(){gl_FragColor=vec4(1.0);}";

void expectFailure(const auto& operation) {
  bool failed = false;
  try { operation(); }
  catch (const std::runtime_error&) { failed = true; }
  assert(failed);
}
}

extern "C" {
GLuint __real_glCreateShader(GLenum type);
void __real_glDeleteShader(GLuint shader);
void __real_glCompileShader(GLuint shader);
void __real_glLinkProgram(GLuint program);
void __real_glGetShaderiv(GLuint shader, GLenum name, GLint* value);
void __real_glGetProgramiv(GLuint program, GLenum name, GLint* value);
GLuint __real_glCreateProgram();
void __real_glDeleteProgram(GLuint program);
GLuint __wrap_glCreateShader(GLenum type) {
  const auto shader = __real_glCreateShader(type);
  shaders.insert(shader);
  return shader;
}
void __wrap_glDeleteShader(GLuint shader) {
  assert(shaders.erase(shader) == 1);
  if (failedShader == shader) failedShader = 0;
  __real_glDeleteShader(shader);
}
void __wrap_glCompileShader(GLuint shader) {
  GLint type = 0, length = 0;
  glGetShaderiv(shader, GL_SHADER_TYPE, &type);
  glGetShaderiv(shader, GL_SHADER_SOURCE_LENGTH, &length);
  std::string source(length, '\0');
  GLsizei written = 0;
  glGetShaderSource(shader, length, &written, source.data());
  source.resize(written);
  ++sources[{static_cast<GLenum>(type), source}];
  ++compiles;
  if (compiles == failCompileAt) failedShader = shader;
  __real_glCompileShader(shader);
}
void __wrap_glLinkProgram(GLuint program) {
  ++links;
  if (failLinks) failedPrograms.insert(program);
  __real_glLinkProgram(program);
}
void __wrap_glGetShaderiv(GLuint shader, GLenum name, GLint* value) {
  if (name == GL_COMPILE_STATUS && shader == failedShader) *value = GL_FALSE;
  else __real_glGetShaderiv(shader, name, value);
}
void __wrap_glGetProgramiv(GLuint program, GLenum name, GLint* value) {
  if (name == GL_LINK_STATUS && failedPrograms.contains(program)) *value = GL_FALSE;
  else __real_glGetProgramiv(program, name, value);
}
GLuint __wrap_glCreateProgram() {
  const auto program = __real_glCreateProgram();
  programs.insert(program);
  return program;
}
void __wrap_glDeleteProgram(GLuint program) {
  assert(programs.erase(program) == 1);
  failedPrograms.erase(program);
  __real_glDeleteProgram(program);
}
}

int main() {
  SDL_SetHint(SDL_HINT_VIDEO_X11_FORCE_EGL, "1");
  assert(SDL_Init(SDL_INIT_VIDEO) == 0);
  SDL_GL_SetAttribute(SDL_GL_CONTEXT_PROFILE_MASK, SDL_GL_CONTEXT_PROFILE_ES);
  SDL_GL_SetAttribute(SDL_GL_CONTEXT_MAJOR_VERSION, 3);
  auto* window = SDL_CreateWindow("Shader stage cache", 0, 0, 8, 8,
                                  SDL_WINDOW_OPENGL | SDL_WINDOW_HIDDEN);
  assert(window);
  const auto context = SDL_GL_CreateContext(window);
  assert(context);
  {
    pmjs::ImageStore images;
    pmjs::Renderer renderer(8, 8, images);
    std::cout << "construction: " << compiles << " compiles, " << links << " links\n";
    renderer.configurePixiFragmentPrecision("highp");
    std::cout << "configured: " << compiles << " compiles, " << links << " links\n";
    for (const auto& [key, count] : sources) assert(count == 1);
    assert(compiles < links * 2);
    const auto readyCompiles = compiles, readyLinks = links;
    const std::array<std::uint8_t, 4> red{255, 0, 0, 255};
    const auto image = images.createRgba(1, 1, red.data());
    assert(image);
    for (int frame = 0; frame < 2; ++frame) {
      renderer.beginFrame();
      assert(renderer.queueImage(image->handle, {8, 0, 0, 8, 0, 0}, {0, 0, 1, 1},
                                 1, 0xffffff, pmjs::BlendMode::normal));
      renderer.renderScene();
      const auto pixels = renderer.captureSceneRgba();
      assert(pixels.size() == 8 * 8 * 4);
      for (std::size_t i = 0; i < pixels.size(); ++i) assert(pixels[i] == red[i % 4]);
      std::cout << "frame " << frame << ": " << compiles << " compiles, " << links << " links\n";
      assert(compiles == readyCompiles && links == readyLinks);
    }
    const auto custom = renderer.createFilterProgram(fragment, vertex);
    const auto afterCustom = compiles, afterLinks = links;
    assert(renderer.createFilterProgram(fragment, vertex) == custom);
    assert(compiles == afterCustom && links == afterLinks);
    renderer.createFilterProgram(std::string(fragment) + "\n", vertex);
    assert(compiles == afterCustom + 1 && links == afterLinks + 1);
    renderer.createFilterProgram(fragment, std::string(vertex) + "\n");
    assert(compiles == afterCustom + 2 && links == afterLinks + 2);
    renderer.createFilterProgram("precision highp float; void main(){gl_FragColor=vec4(1.0);}", vertex);
    assert(compiles == afterCustom + 3 && links == afterLinks + 3);
    const std::string shared = "precision mediump float; void main(){}";
    const auto sharedSource = "precision highp sampler2D;\n" + shared;
    renderer.createFilterProgram(shared, sharedSource);
    assert(sources.at({GL_VERTEX_SHADER, sharedSource}) == 1);
    assert(sources.at({GL_FRAGMENT_SHADER, sharedSource}) == 1);
    const auto goodPrograms = programs.size();
    for (int retry = 0; retry < 2; ++retry) {
      const auto before = compiles;
      expectFailure([&] { renderer.createFilterProgram("invalid shader", vertex); });
      assert(compiles == before + 1 && programs.size() == goodPrograms);
    }
    failLinks = true;
    const auto beforeFailure = compiles;
    expectFailure([&] { renderer.createFilterProgram(std::string(fragment) + "//link failure", vertex); });
    failLinks = false;
    renderer.createFilterProgram(std::string(fragment) + "//link failure", vertex);
    assert(compiles == beforeFailure + 1);
    const auto beforeColor = links;
    const auto color = renderer.createFilterProgram(pmjs::shaders::colorMatrixFragment,
                                                     pmjs::shaders::colorMatrixVertex);
    assert(links == beforeColor + 1);
    assert(renderer.filterProgram(color).identityProgram == 0);
    const auto drawColor = [&](bool identity) {
      auto plan = std::make_shared<pmjs::CustomFilterPlan>();
      plan->frame = {0, 0, 8, 8}; plan->resolutions = {1, 1};
      pmjs::CustomFilterPass pass;
      pass.program = color;
      const std::array<double, 20> matrix{1,0,0,0,identity ? 0 : 0.1,0,1,0,0,0,0,0,1,0,0,0,0,0,1,0};
      for (const auto& uniform : renderer.filterProgram(color).uniforms) {
        if (uniform.name == "m" || uniform.name == "m[0]")
          pass.uniforms.insert(pass.uniforms.end(), matrix.begin(), matrix.end());
        else { assert(uniform.name == "uAlpha"); pass.uniforms.push_back(1); }
      }
      plan->passes.push_back(pass);
      const auto handle = renderer.registerFilterPlan(plan);
      const std::array<std::uint32_t, 21> metadata{
        6,0xffffffffU,handle,0xffffff,31,0,0,
        1,0,image->handle,0xffffff,0,8,0,
        7,0,0,0xffffff,0,0,0};
      std::array<float, 3 * pmjs::scene_packet::valueStride> values{};
      for (int row = 0; row < 3; ++row) {
        const auto offset = row * pmjs::scene_packet::valueStride;
        values[offset] = values[offset+3] = values[offset+6] = 1;
      }
      const auto sprite = pmjs::scene_packet::valueStride;
      values[sprite] = values[sprite+3] = 8;
      for (int column = 11; column <= 14; ++column) values[sprite+column] = 1;
      renderer.beginFrame();
      assert(renderer.queueScene(pmjs::scene_packet::version, metadata.data(), metadata.size(),
                                 values.data(), values.size(), 3));
      try { renderer.renderScene(); }
      catch (...) { renderer.releaseFilterPlan(handle); throw; }
      renderer.releaseFilterPlan(handle);
      const auto pixels = renderer.captureSceneRgba();
      for (std::size_t pixel = 0; pixel < pixels.size(); ++pixel) assert(pixels[pixel] == red[pixel % 4]);
    };
    drawColor(false);
    assert(links == beforeColor + 1 && renderer.filterProgram(color).identityProgram == 0);
    failCompileAt = compiles + 1;
    expectFailure([&] { drawColor(true); });
    failCompileAt = 0;
    assert(links == beforeColor + 1 && renderer.filterProgram(color).identityProgram == 0);
    drawColor(false);
    failLinks = true;
    expectFailure([&] { drawColor(true); });
    failLinks = false;
    assert(renderer.filterProgram(color).identityProgram == 0);
    drawColor(false);
    drawColor(true);
    assert(links == beforeColor + 3 && renderer.filterProgram(color).identityProgram != 0);
    drawColor(true);
    drawColor(false);
    assert(links == beforeColor + 3);
    glUseProgram(0);
  }
  assert(shaders.empty() && programs.empty());
  {
    sources.clear();
    pmjs::ImageStore images;
    pmjs::Renderer renderer(8, 8, images);
    for (const auto& [key, count] : sources) assert(count == 1);
    glUseProgram(0);
  }
  assert(shaders.empty() && programs.empty());
  failCompileAt = compiles + 4;
  {
    pmjs::ImageStore images;
    expectFailure([&] { pmjs::Renderer renderer(8, 8, images); });
  }
  failCompileAt = 0;
  assert(shaders.empty() && programs.empty());
  for (const auto sourceSize : {std::size_t(128), std::size_t(65000)}) {
    pmjs::ImageStore images;
    pmjs::Renderer renderer(8, 8, images);
    failLinks = true;
    bool saturated = false;
    for (unsigned index = 0; index < 270; ++index) {
      auto source = std::string(fragment) + "\n//" + std::to_string(index);
      source.resize(sourceSize, ' ');
      const auto retained = shaders.size();
      const auto before = compiles;
      expectFailure([&] { renderer.createFilterProgram(source, vertex); });
      if (shaders.size() != retained) continue;
      expectFailure([&] { renderer.createFilterProgram(source, vertex); });
      assert(compiles == before + 2);
      assert(shaders.size() <= 256);
      if (sourceSize == 128) assert(shaders.size() == 256);
      else assert(shaders.size() < 256);
      saturated = true;
      break;
    }
    assert(saturated);
    failLinks = false;
    renderer.createFilterProgram(fragment, vertex);
    assert(glGetError() == GL_NO_ERROR);
    glUseProgram(0);
  }
  assert(shaders.empty() && programs.empty());
  SDL_GL_DeleteContext(context);
  SDL_DestroyWindow(window);
  SDL_Quit();
}
