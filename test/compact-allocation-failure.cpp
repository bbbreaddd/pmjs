#include "assets/asset_processor.hpp"
#include "graphics/resources.hpp"
#include "platform/platform.hpp"

#include <GLES3/gl3.h>
#include <array>
#include <filesystem>
#include <iostream>
#include <stdexcept>
#include <vector>
#include <unistd.h>

namespace {
int textureCountdown = 0;
bool captureUploads = false;
GLenum pendingError = GL_NO_ERROR;
std::vector<GLuint> uploadedTextures;

void require(bool condition, const char* message) {
  if (!condition) throw std::runtime_error(message);
}

struct FixtureDirectory {
  std::filesystem::path path;
  FixtureDirectory() {
    const auto root = std::filesystem::current_path()/".cache/tests";
    std::filesystem::create_directories(root);
    auto name = (root/"compact-allocation-XXXXXX").string();
    require(mkdtemp(name.data()) != nullptr, "fixture directory creation failed");
    path = name;
  }
  ~FixtureDirectory() { std::filesystem::remove_all(path); }
};

auto unpackState() {
  constexpr std::array<GLenum, 6> names{GL_TEXTURE_BINDING_2D, GL_PIXEL_UNPACK_BUFFER_BINDING,
    GL_UNPACK_ALIGNMENT, GL_UNPACK_ROW_LENGTH, GL_UNPACK_SKIP_ROWS, GL_UNPACK_SKIP_PIXELS};
  std::array<GLint, names.size()> values{};
  for (std::size_t i = 0; i < names.size(); ++i) glGetIntegerv(names[i], &values[i]);
  return values;
}
}

extern "C" {
void __real_glTexImage2D(GLenum, GLint, GLint, GLsizei, GLsizei, GLint, GLenum, GLenum, const void*);
GLenum __real_glGetError();
void __wrap_glTexImage2D(GLenum target, GLint level, GLint format, GLsizei width,
    GLsizei height, GLint border, GLenum sourceFormat, GLenum type, const void* pixels) {
  if (captureUploads) {
    GLint texture = 0; glGetIntegerv(GL_TEXTURE_BINDING_2D, &texture);
    uploadedTextures.push_back(static_cast<GLuint>(texture));
  }
  if (textureCountdown && --textureCountdown == 0) { pendingError = GL_OUT_OF_MEMORY; return; }
  __real_glTexImage2D(target, level, format, width, height, border, sourceFormat, type, pixels);
}
GLenum __wrap_glGetError() {
  if (pendingError != GL_NO_ERROR) {
    const auto error = pendingError; pendingError = GL_NO_ERROR; return error;
  }
  return __real_glGetError();
}
}

int main() try {
  pmjs::Platform platform(32, 32, "Prepared artifact allocation failure");
  FixtureDirectory fixture;
  const auto source = fixture.path / "source.png", staging = fixture.path / "prepared";
  constexpr int width = 512, height = 256;
  std::vector<std::uint8_t> pixels(width * height * 4);
  for (std::size_t i = 0; i < pixels.size(); i += 4) {
    const auto color = static_cast<std::uint8_t>((i / 4) % 127);
    pixels[i] = color; pixels[i + 1] = 2 * color; pixels[i + 2] = 255 - color; pixels[i + 3] = color + 20;
  }
  pmjs::writePreparedPng(source, width, height, pixels);
  pmjs::AssetRecipe recipe; recipe.columns = 2; recipe.rows = 1; recipe.framePages = true;
  pmjs::AssetPreparationOptions options; options.allowPalettes = true;
  const auto prepared = pmjs::prepareAssetImage(source, staging, recipe, nullptr, options);
  require(prepared.textureArtifact == "texture.pmtx", "texture artifact was not prepared");
  pmjs::PreparedImageDescriptor descriptor;
  descriptor.width = width; descriptor.height = height; descriptor.halo = prepared.halo;
  descriptor.framePages = prepared.framePages; descriptor.textureArtifact = prepared.textureArtifact;
  for (const auto& page : prepared.pages) descriptor.pages.push_back({page.path, page.width, page.height});
  for (const auto& cell : prepared.cells) descriptor.cells.push_back({cell.rect, cell.crop, cell.atlas, cell.fill, cell.page});
  for (const int failAt : {0, 1, 2}) {
    pmjs::ImageStore images;
    images.setWarmBudgetBytes(0);
    images.setPalettizationEnabled(true);
    require(images.installPrepared(source, staging, descriptor), "artifact install failed");
    const auto image = images.loadPng(source);
    require(image && images.hasPreparedBacking(image->handle), "artifact load failed");
    GLuint texture = 0, buffer = 0;
    glGenTextures(1, &texture); glBindTexture(GL_TEXTURE_2D, texture);
    glGenBuffers(1, &buffer); glBindBuffer(GL_PIXEL_UNPACK_BUFFER, buffer);
    glBufferData(GL_PIXEL_UNPACK_BUFFER, 256, nullptr, GL_STATIC_DRAW);
    glPixelStorei(GL_UNPACK_ALIGNMENT, 8); glPixelStorei(GL_UNPACK_ROW_LENGTH, 17);
    glPixelStorei(GL_UNPACK_SKIP_ROWS, 2); glPixelStorei(GL_UNPACK_SKIP_PIXELS, 3);
    const auto before = unpackState();
    uploadedTextures.clear(); captureUploads = true; textureCountdown = failAt;
    const auto palette = images.resolvePaletteImage(image->handle, false);
    captureUploads = false;
    require(textureCountdown == 0 && palette.has_value() == !failAt, "artifact allocation path changed");
    require(unpackState() == before, "artifact upload changed caller unpack state");
    require(images.textureArtifactLoads() == (failAt ? 0U : 1U), "artifact activation differs");
    if (failAt) {
      require(images.gpuBytes() == 0 && images.textureArtifactFailures() == 1, "failed artifact published storage");
      for (auto id : uploadedTextures) require(!glIsTexture(id), "partial artifact texture leaked");
      require(!images.resolvePaletteImage(image->handle, false) && images.textureArtifactFailures() == 1,
        "failed artifact was retried");
      const auto fallback = images.lookup(image->handle);
      require(fallback && unpackState() == before, "ordinary fallback failed or changed unpack state");
      GLuint framebuffer = 0;
      glGenFramebuffers(1, &framebuffer); glBindFramebuffer(GL_FRAMEBUFFER, framebuffer);
      glFramebufferTexture2D(GL_FRAMEBUFFER, GL_COLOR_ATTACHMENT0, GL_TEXTURE_2D, fallback->texture, 0);
      std::vector<std::uint8_t> actual(pixels.size());
      glReadPixels(0, 0, width, height, GL_RGBA, GL_UNSIGNED_BYTE, actual.data());
      require(actual == pixels, "ordinary fallback changed source pixels");
      glBindFramebuffer(GL_FRAMEBUFFER, 0); glDeleteFramebuffers(1, &framebuffer);
    }
    images.release(image->handle); images.update();
    require(images.gpuBytes() == 0 && images.liveCount() == 0, "artifact resources outlived owner");
    for (auto id : uploadedTextures) require(!glIsTexture(id), "artifact texture leaked");
    glBindBuffer(GL_PIXEL_UNPACK_BUFFER, 0); glDeleteBuffers(1, &buffer);
    glBindTexture(GL_TEXTURE_2D, 0); glDeleteTextures(1, &texture);
    glPixelStorei(GL_UNPACK_ALIGNMENT, 1); glPixelStorei(GL_UNPACK_ROW_LENGTH, 0);
    glPixelStorei(GL_UNPACK_SKIP_ROWS, 0); glPixelStorei(GL_UNPACK_SKIP_PIXELS, 0);
    require(glGetError() == GL_NO_ERROR, "artifact test left a GL error");
  }
  return 0;
} catch (const std::exception& error) {
  std::cerr << error.what() << '\n';
  return 1;
}
