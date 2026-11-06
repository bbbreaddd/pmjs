#include "renderer.hpp"
#include "scene_packet.hpp"
#include <png.h>
#include <dlfcn.h>
#include "renderer_identity_shader.hpp"
#include "platform.hpp"
#include <GLES3/gl3.h>
#include <cassert>
#include <iostream>
#include <set>
#include <string>

namespace {
unsigned compiles = 0, links = 0, loads = 0;
bool reject = false, unsupported = false, driverChange = false;
std::set<GLuint> rejected;
const char* vertex = "attribute vec2 position; void main(){gl_Position=vec4(position,0.,1.);}";
const char* fragment = "precision mediump float; uniform vec4 tint; void main(){gl_FragColor=tint;}";
}
namespace {
template <typename T> T original(const char* name) {
  const auto pointer = reinterpret_cast<T>(dlsym(RTLD_NEXT, name)); assert(pointer); return pointer;
}
const auto actualCompileShader = original<decltype(&glCompileShader)>("glCompileShader");
const auto actualLinkProgram = original<decltype(&glLinkProgram)>("glLinkProgram");
const auto actualProgramBinary = original<decltype(&glProgramBinary)>("glProgramBinary");
const auto actualGetProgramiv = original<decltype(&glGetProgramiv)>("glGetProgramiv");
const auto actualGetIntegerv = original<decltype(&glGetIntegerv)>("glGetIntegerv");
const auto actualGetString = original<decltype(&glGetString)>("glGetString");
const auto actualDeleteProgram = original<decltype(&glDeleteProgram)>("glDeleteProgram");
}
extern "C" {
void glCompileShader(GLuint shader) { ++compiles; actualCompileShader(shader); }
void glLinkProgram(GLuint program) { ++links; actualLinkProgram(program); }
void glProgramBinary(GLuint program, GLenum format, const void* bytes, GLsizei count) {
  ++loads; actualProgramBinary(program, format, bytes, count);
  if (reject) rejected.insert(program);
}
void glGetProgramiv(GLuint program, GLenum property, GLint* value) {
  actualGetProgramiv(program, property, value);
  if (property == GL_LINK_STATUS && rejected.contains(program)) *value = GL_FALSE;
}
void glGetIntegerv(GLenum property, GLint* value) {
  actualGetIntegerv(property, value);
  if (unsupported && property == GL_NUM_PROGRAM_BINARY_FORMATS) *value = 0;
}
const GLubyte* glGetString(GLenum property) {
  if (driverChange && property == GL_VERSION) return reinterpret_cast<const GLubyte*>("changed driver identity");
  return actualGetString(property);
}
void glDeleteProgram(GLuint program) { rejected.erase(program); actualDeleteProgram(program); }
}

int main(int argc, char** argv) {
  assert(argc == 4);
  const std::string mode = argv[2];
  reject = mode == "reject"; unsupported = mode == "unsupported";
  pmjs::Platform platform(8, 8, "Program binary cache");
  driverChange = mode == "driver";
  GLint formats = 0; actualGetIntegerv(GL_NUM_PROGRAM_BINARY_FORMATS, &formats); assert(formats > 0);
  {
    pmjs::ImageStore images(argv[1]);
    pmjs::Renderer renderer(8, 8, images);
    renderer.configurePixiFragmentPrecision("highp");
    const auto source = std::string(fragment) + (mode == "changed" ? "\n// changed source" : mode == "budget" ? "\n// budget source" : "");
    const auto handle = renderer.createFilterProgram(source, vertex);
    const auto& custom = renderer.filterProgram(handle);
    glUseProgram(custom.program);
    const auto tint = glGetUniformLocation(custom.program, "tint"); assert(tint >= 0);
    std::array<float, 4> value{1, 1, 1, 1}; glGetUniformfv(custom.program, tint, value.data());
    assert((value == std::array<float, 4>{0, 0, 0, 0}));
    glUniform4f(tint, 0, 1, 0, 1);
    const std::array<std::uint8_t, 4> red{255, 0, 0, 255};
    const auto image = images.createRgba(1, 1, red.data()); assert(image);
    renderer.beginFrame();
    assert(renderer.queueImage(image->handle, {8,0,0,8,0,0}, {0,0,1,1}, 1, 0xffffff, pmjs::BlendMode::normal));
    renderer.renderScene();
    const auto pixels = renderer.captureSceneRgba();
    assert(pixels.size() == 256);
    for (std::size_t i = 0; i < pixels.size(); ++i) assert(pixels[i] == red[i % 4]);
    // A cache hit must not capture the mutable program's uniform state.
    constexpr std::array<pmjs::ProgramAttributeBinding, 4> bindings{{
      {0, "position"}, {1, "uv"}, {0, "aVertexPosition"}, {1, "aTextureCoord"}}};
    if (mode == "populate")
      images.programCache().store(images.programCache().key(vertex, source, bindings), custom.program);
    assert(glGetAttribLocation(custom.program, "position") == 0);
    const auto color = renderer.createFilterProgram(pmjs::shaders::colorMatrixFragment, pmjs::shaders::colorMatrixVertex);
    auto plan = std::make_shared<pmjs::CustomFilterPlan>();
    plan->frame = {0,0,8,8}; plan->resolutions = {1,1};
    pmjs::CustomFilterPass pass; pass.program = color;
    for (const auto& uniform : renderer.filterProgram(color).uniforms) {
      if (uniform.name == "m" || uniform.name == "m[0]")
        pass.uniforms.insert(pass.uniforms.end(), {1,0,0,0,0,0,1,0,0,0,0,0,1,0,0,0,0,0,1,0});
      else { assert(uniform.name == "uAlpha"); pass.uniforms.push_back(1); }
    }
    plan->passes.push_back(pass);
    const auto planHandle = renderer.registerFilterPlan(plan);
    const std::array<std::uint32_t, 21> metadata{
      6,0xffffffffU,planHandle,0xffffff,31,0,0,
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
    renderer.renderScene();
    assert(renderer.captureSceneRgba() == pixels);
    renderer.releaseFilterPlan(planHandle); images.release(image->handle);
    const std::filesystem::path fixture(argv[3]);
    std::vector<std::uint8_t> page(34 * 18 * 4);
    for (std::size_t i = 0; i < page.size(); ++i) page[i] = red[i % 4];
    png_image png{}; png.version = PNG_IMAGE_VERSION; png.width = 34; png.height = 18; png.format = PNG_FORMAT_RGBA;
    const auto file = fixture / "page.png";
    assert(png_image_write_to_file(&png, file.c_str(), 0, page.data(), 0, nullptr));
    pmjs::PreparedImageDescriptor descriptor;
    descriptor.width = 32; descriptor.height = 16; descriptor.halo = 1;
    descriptor.pages = {{"page.png", 34, 18}};
    descriptor.cells = {{{0,0,32,16}, {0,0,32,16}, {1,1,32,16}, {0,0,0,0}, 0}};
    const auto sourceFile = fixture / "source.png";
    png.width = 32; png.height = 16;
    assert(png_image_write_to_file(&png, sourceFile.c_str(), 0, page.data(), 0, nullptr));
    assert(images.installPrepared(sourceFile, fixture, descriptor));
    const auto prepared = images.loadPng(sourceFile); assert(prepared);
    const auto before = links, beforeLoads = loads;
    const auto frame = images.resolvePreparedFrameRegion(prepared->handle, 4,4,8,8, false, true);
    assert(frame);
    const auto framePixels = images.readPixelsRegion(frame->image.handle, 0,0,10,10); assert(framePixels);
    for (std::size_t i = 0; i < framePixels->rgba.size(); ++i) assert(framePixels->rgba[i] == red[i % 4]);
    if (mode == "hit") assert(links == before && loads == beforeLoads + 1);
    images.release(prepared->handle);
    const auto key = images.programCache().key(vertex, fragment);
    const std::array<pmjs::ProgramAttributeBinding, 1> binding{{{1, "position"}}};
    if (!unsupported) assert(key != images.programCache().key(vertex, fragment, binding));
    if (mode == "hit") assert(compiles == 0 && links == 0 && loads > 0);
    else if (mode == "changed" || mode == "budget") assert(links == 1 && compiles > 0 && loads > 0);
    else if (mode != "recover") assert(compiles > 0 && links > 0);
    if (reject) assert(loads > 0);
    if (unsupported) assert(loads == 0);
    assert(glGetError() == GL_NO_ERROR);
    std::cout << "{\"compiles\":" << compiles << ",\"links\":" << links << ",\"loads\":" << loads << "}\n";
  }
}
