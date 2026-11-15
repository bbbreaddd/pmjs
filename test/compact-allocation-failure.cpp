#include "platform/platform.hpp"
#include "graphics/resources.hpp"
#include "assets/asset_processor.hpp"
#include "assets/texture_artifact.hpp"

#include <GLES3/gl3.h>
#include <algorithm>
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
    const auto pattern = (root/"compact-allocation-XXXXXX").string();
    std::vector<char> buffer(pattern.begin(), pattern.end()); buffer.push_back('\0');
    const auto* directory = mkdtemp(buffer.data());
    require(directory, "fixture directory creation failed");
    path = directory;
  }
  ~FixtureDirectory() { std::filesystem::remove_all(path); }
};

struct UnpackState {
  static constexpr std::array<GLenum, 6> names{GL_TEXTURE_BINDING_2D,
    GL_PIXEL_UNPACK_BUFFER_BINDING, GL_UNPACK_ALIGNMENT, GL_UNPACK_ROW_LENGTH,
    GL_UNPACK_SKIP_ROWS, GL_UNPACK_SKIP_PIXELS};
  std::array<GLint, names.size()> values{};
  UnpackState() {
    for (std::size_t i = 0; i < names.size(); ++i) glGetIntegerv(names[i], &values[i]);
  }
};

void requireGpuPixels(const pmjs::ImageInfo& image, const std::vector<std::uint8_t>& expected) {
  GLuint framebuffer = 0;
  glGenFramebuffers(1, &framebuffer); glBindFramebuffer(GL_FRAMEBUFFER, framebuffer);
  glFramebufferTexture2D(GL_FRAMEBUFFER, GL_COLOR_ATTACHMENT0, GL_TEXTURE_2D, image.texture, 0);
  require(glCheckFramebufferStatus(GL_FRAMEBUFFER) == GL_FRAMEBUFFER_COMPLETE,
    "fallback framebuffer is incomplete");
  std::vector<std::uint8_t> actual(expected.size());
  glReadPixels(0, 0, image.width, image.height, GL_RGBA, GL_UNSIGNED_BYTE, actual.data());
  glBindFramebuffer(GL_FRAMEBUFFER, 0); glDeleteFramebuffers(1, &framebuffer);
  // Framebuffer reads expose channel storage before the grayscale texture swizzle.
  glBindTexture(GL_TEXTURE_2D, image.texture);
  constexpr std::array<GLenum, 4> names{GL_TEXTURE_SWIZZLE_R, GL_TEXTURE_SWIZZLE_G,
    GL_TEXTURE_SWIZZLE_B, GL_TEXTURE_SWIZZLE_A};
  std::array<GLint, 4> swizzles{};
  for (std::size_t c = 0; c < names.size(); ++c) glGetTexParameteriv(GL_TEXTURE_2D, names[c], &swizzles[c]);
  for (std::size_t i = 0; i < actual.size(); i += 4) {
    const std::array<std::uint8_t, 4> stored{actual[i], actual[i+1], actual[i+2], actual[i+3]};
    for (std::size_t c = 0; c < names.size(); ++c)
      actual[i+c] = swizzles[c] == GL_ONE ? 255 : swizzles[c] == GL_ZERO ? 0 :
        stored[swizzles[c] == GL_RED ? 0 : swizzles[c] == GL_GREEN ? 1 : swizzles[c] == GL_BLUE ? 2 : 3];
  }
  require(actual == expected, "ordinary GPU fallback changed image pixels");
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
  pmjs::Platform platform(32, 32, "Compact allocation failure");
  FixtureDirectory directory;
  const auto& root = directory.path;
  {
    pmjs::ImagePixels pixels{512,256,std::vector<std::uint8_t>(512*256*4)};
    for (std::size_t i=0;i<pixels.rgba.size();i+=4) {
      pixels.rgba[i]=(i/4)%127; pixels.rgba[i+1]=31; pixels.rgba[i+2]=47; pixels.rgba[i+3]=93;
    }
    pmjs::writePreparedPng(root/"artifact-source.png",pixels.width,pixels.height,pixels.rgba);
    pmjs::AssetRecipe recipe; recipe.columns=2; recipe.rows=1; recipe.framePages=true;
    const auto prepared=pmjs::prepareAssetImage(root/"artifact-source.png",root/"artifact",recipe);
    require(prepared.textureArtifact=="texture.pmtx","texture artifact was not prepared");
    pmjs::PreparedImageDescriptor descriptor;
    descriptor.width=prepared.width; descriptor.height=prepared.height; descriptor.halo=prepared.halo;
    descriptor.framePages=true; descriptor.textureArtifact=prepared.textureArtifact;
    for(const auto& page:prepared.pages)descriptor.pages.push_back({page.path,page.width,page.height});
    for(const auto& cell:prepared.cells)descriptor.cells.push_back({cell.rect,cell.crop,cell.atlas,cell.fill,cell.page});
    for(const int failAt:{0,1,2}) {
      pmjs::ImageStore images; images.setWarmBudgetBytes(0);
      require(images.installPrepared(root/"artifact-source.png",root/"artifact",descriptor),"artifact install failed");
      auto image=images.loadPng(root/"artifact-source.png");require(image.has_value(),"artifact load failed");
      GLuint texture=0,buffer=0;glGenTextures(1,&texture);glBindTexture(GL_TEXTURE_2D,texture);
      glGenBuffers(1,&buffer);glBindBuffer(GL_PIXEL_UNPACK_BUFFER,buffer);glBufferData(GL_PIXEL_UNPACK_BUFFER,256,nullptr,GL_STATIC_DRAW);
      glPixelStorei(GL_UNPACK_ALIGNMENT,8);glPixelStorei(GL_UNPACK_ROW_LENGTH,17);
      glPixelStorei(GL_UNPACK_SKIP_ROWS,2);glPixelStorei(GL_UNPACK_SKIP_PIXELS,3);
      const UnpackState before;
      uploadedTextures.clear();captureUploads=true;textureCountdown=failAt;
      const auto palette=images.resolvePaletteImage(image->handle,false);
      captureUploads=false;textureCountdown=0;
      require(palette.has_value(),"artifact failure did not recover through the source representation");
      require(UnpackState().values==before.values,"artifact upload changed caller unpack state");
      require(images.textureArtifactLoads()==(failAt?0U:1U),"artifact activation differs");
      require(images.sourceTextureBuilds()==(failAt?1U:0U),"artifact fallback differs");
      glBindBuffer(GL_PIXEL_UNPACK_BUFFER,0);glBindTexture(GL_TEXTURE_2D,0);
      glPixelStorei(GL_UNPACK_ALIGNMENT,1);glPixelStorei(GL_UNPACK_ROW_LENGTH,0);
      glPixelStorei(GL_UNPACK_SKIP_ROWS,0);glPixelStorei(GL_UNPACK_SKIP_PIXELS,0);
      images.release(image->handle);images.update();
      require(images.gpuBytes()==0,"artifact allocation failure leaked texture bytes");
      for(auto id:uploadedTextures)require(!glIsTexture(id),"artifact allocation failure leaked a texture");
      glDeleteTextures(1,&texture);glDeleteBuffers(1,&buffer);
    }
  }
  pmjs::PreparedImageDescriptor descriptor;
  descriptor.width = 48; descriptor.height = 12;
  descriptor.pages = {{"page.png", 6, 6}};
  descriptor.cells = {
    {{0, 0, 16, 12}, {4, 4, 2, 2}, {2, 2, 2, 2}, {37, 37, 37, 255}, 0},
    {{16, 0, 16, 12}, {0, 0, 0, 0}, {}, {37, 37, 37, 255}, -1},
    {{32, 0, 16, 12}, {0, 0, 0, 0}, {}, {37, 37, 37, 255}, -1}};
  std::vector<std::uint8_t> source(48*12*4), page(6*6*4);
  for (auto* pixels : {&source, &page}) for (std::size_t i = 0; i < pixels->size(); i += 4) {
    (*pixels)[i] = (*pixels)[i+1] = (*pixels)[i+2] = 37; (*pixels)[i+3] = 255;
  }
  for (int y = 0; y < 2; ++y) for (int x = 0; x < 2; ++x) {
    const auto gray = static_cast<std::uint8_t>(81 + x*25 + y*31);
    for (int channel = 0; channel < 3; ++channel) {
      source[((y+4)*48+x+4)*4+channel] = gray;
      page[((y+2)*6+x+2)*4+channel] = gray;
    }
  }
  pmjs::writePreparedPng(root/"source.png", 48, 12, source);
  pmjs::writePreparedPng(root/"page.png", 6, 6, page);
  for (const int failurePosition : {1, 2, 3, 4, 5}) {
    pmjs::ImageStore images;
    images.setWarmBudgetBytes(0);
    require(images.installPrepared(root/"source.png", root, descriptor), "prepared catalog installation failed");
    auto image = images.loadPng(root/"source.png");
    require(image && images.hasPreparedBacking(image->handle), "prepared source load failed");
    images.setCompactSamplingEnabled(false);
    uploadedTextures.clear(); captureUploads = true;
    require(!images.resolveCompactRegion(image->handle, 0, 0, 16, 12),
      "disabled compact sampling selected a compact texture");
    captureUploads = false;
    require(uploadedTextures.empty(), "disabled compact sampling attempted GL allocation");
    images.setCompactSamplingEnabled(true);
    GLuint sentinelTexture = 0, sentinelBuffer = 0;
    glGenTextures(1, &sentinelTexture); glBindTexture(GL_TEXTURE_2D, sentinelTexture);
    glGenBuffers(1, &sentinelBuffer); glBindBuffer(GL_PIXEL_UNPACK_BUFFER, sentinelBuffer);
    glBufferData(GL_PIXEL_UNPACK_BUFFER, 256, nullptr, GL_STATIC_DRAW);
    glPixelStorei(GL_UNPACK_ALIGNMENT, 8); glPixelStorei(GL_UNPACK_ROW_LENGTH, 17);
    glPixelStorei(GL_UNPACK_SKIP_ROWS, 2); glPixelStorei(GL_UNPACK_SKIP_PIXELS, 3);
    const UnpackState beforeState;
    const auto beforeBytes = images.gpuBytes();
    const auto beforeUploads = images.textureCreates();
    const auto beforeCompactUploads = images.compactTextureUploads();
    const auto beforeFailures = images.compactUploadFailures();
    textureCountdown = failurePosition;
    uploadedTextures.clear(); captureUploads = true;
    const auto failed = images.resolveCompactRegion(image->handle, 0, 0, 16, 12);
    captureUploads = false;
    require(!failed && textureCountdown == 0, "compact allocation fault did not select fallback");
    require(UnpackState().values == beforeState.values, "compact failure changed unpack bindings or state");
    require(images.gpuBytes() == beforeBytes && images.textureCreates() == beforeUploads,
      "failed compact realization published GPU allocation accounting");
    require(images.compactUploadFailures() == beforeFailures+1, "compact failure diagnostic missing");
    require(images.compactTextureUploads() == beforeCompactUploads,
      "failed compact realization reported a successful upload");
    require(!uploadedTextures.empty(), "compact upload fault did not exercise GL allocation");
    for (const auto texture : uploadedTextures)
      require(!glIsTexture(texture), "partial compact realization leaked a texture");
    uploadedTextures.clear(); captureUploads = true;
    for (int attempt = 0; attempt < 3; ++attempt)
      require(!images.resolveCompactRegion(image->handle, 0, 0, 16, 12), "failed backing retried compact realization");
    captureUploads = false;
    require(uploadedTextures.empty() && images.compactUploadFailures() == beforeFailures+1,
      "failed backing repeated GL allocations or failure diagnostics");
    require(UnpackState().values == beforeState.values, "latched compact failure changed GL state");
    glBindBuffer(GL_PIXEL_UNPACK_BUFFER, 0);
    glPixelStorei(GL_UNPACK_ALIGNMENT, 1); glPixelStorei(GL_UNPACK_ROW_LENGTH, 0);
    glPixelStorei(GL_UNPACK_SKIP_ROWS, 0); glPixelStorei(GL_UNPACK_SKIP_PIXELS, 0);
    glBindTexture(GL_TEXTURE_2D, 0);
    glDeleteBuffers(1, &sentinelBuffer); glDeleteTextures(1, &sentinelTexture);
    images.setPreparedCropUploadsEnabled(false);
    const auto beforeCropUploads = images.preparedCropUploads();
    const auto fallback = images.lookup(image->handle);
    require(fallback.has_value(), "ordinary fallback allocation failed");
    require(images.preparedCropUploads() == beforeCropUploads,
      "disabled prepared crop uploads used the optimized realization path");
    requireGpuPixels(*fallback, source);
    images.release(image->handle); images.update();
    require(images.gpuBytes() == 0, "failed backing teardown retained GPU allocations");
    image = images.loadPng(root/"source.png");
    require(image.has_value(), "crop upload backing recreation failed");
    images.setPreparedCropUploadsEnabled(true);
    const auto cropFallback = images.lookup(image->handle);
    require(cropFallback && images.preparedCropUploads() == beforeCropUploads+1,
      "enabled prepared crop uploads did not realize a fresh backing");
    requireGpuPixels(*cropFallback, source);
    images.release(image->handle); images.update();
    require(images.gpuBytes() == 0, "crop upload control retained GPU allocations");
    image = images.loadPng(root/"source.png");
    require(image.has_value(), "backing recreation failed");
    const auto recovered = images.resolveCompactRegion(image->handle, 0, 0, 16, 12);
    require(recovered.has_value(), "backing recreation retained an allocation failure latch");
    require(images.compactTextureUploads() == beforeCompactUploads+1,
      "compact recovery did not report its successful upload");
    require(images.compactUploadFailures() == beforeFailures+1, "successful recovery reported another failure");
    images.release(image->handle); images.update();
    require(images.gpuBytes() == 0 && images.liveCount() == 0, "recovered compact backing leaked allocations");
    require(glGetError() == GL_NO_ERROR, "compact failure left a GL error");
  }
  for (int variant = 0; variant < 4; ++variant) {
    pmjs::PreparedImageDescriptor whole;
    whole.width = 32; whole.height = 16;
    whole.pages = {{"whole-page.png", 36, 18}};
    whole.cells = {
      {{0, 0, 16, 16}, {0, 0, 16, 16}, {1, 1, 16, 16}, {255, 0, 255, 23}, 0},
      {{16, 0, 16, 16}, {0, 0, 16, 16}, {19, 1, 16, 16}, {0, 0, 0, 0}, 0}};
    std::vector<std::uint8_t> wholeSource(32*16*4), wholePage(36*18*4);
    for (int y = 0; y < 16; ++y) for (int x = 0; x < 32; ++x) {
      const auto offset = (y*32+x)*4;
      const auto gray = static_cast<std::uint8_t>((x*7+y*11)%256);
      wholeSource[offset] = wholeSource[offset+1] = wholeSource[offset+2] = gray;
      wholeSource[offset+3] = 255;
    }
    if (variant == 1) wholeSource[1] = wholeSource[0]+1;
    if (variant == 2) wholeSource[3] = 128;
    if (variant == 3) {
      whole.cells[1].crop[2] = whole.cells[1].atlas[2] = 15;
      for (int y = 0; y < 16; ++y) std::fill_n(wholeSource.data()+(y*32+31)*4, 4, 0);
    }
    for (const auto& cell : whole.cells) for (int y = 0; y < cell.crop[3]; ++y)
      std::copy_n(wholeSource.data()+((y+cell.rect[1])*32+cell.rect[0])*4,
        cell.crop[2]*4, wholePage.data()+((y+cell.atlas[1])*36+cell.atlas[0])*4);
    pmjs::writePreparedPng(root/"whole-source.png", 32, 16, wholeSource);
    pmjs::writePreparedPng(root/"whole-page.png", 36, 18, wholePage);
    pmjs::ImageStore images;
    images.setWarmBudgetBytes(0);
    require(images.installPrepared(root/"whole-source.png", root, whole), "whole crop fixture install failed");
    const auto image = images.loadPng(root/"whole-source.png");
    require(image.has_value(), "whole crop source load failed");
    const auto realized = images.lookup(image->handle);
    require(realized.has_value(), "whole crop realization failed");
    require(images.preparedCropUploads() == (variant == 0 ? 1 : 0),
      "unused fills or non-grayscale/translucent pixels selected the wrong upload path");
    requireGpuPixels(*realized, wholeSource);
    images.release(image->handle); images.update();
    require(images.gpuBytes() == 0 && images.liveCount() == 0, "whole crop release retained allocations");
  }
  pmjs::PreparedImageDescriptor blocks;
  blocks.width = 128; blocks.height = 64;
  blocks.blockGrid = std::array<int, 3>{64, 64, 64};
  blocks.pages = {{"block-page.png", 66, 66}};
  blocks.cells = {
    {{0, 0, 64, 64}, {0, 0, 64, 64}, {1, 1, 64, 64}, {255, 255, 255, 0}, 0},
    {{64, 0, 64, 64}, {}, {}, {255, 255, 255, 0}, -1}};
  std::vector<std::uint8_t> blockSource(128*64*4, 255), blockPage(66*66*4);
  for (std::size_t i = 3; i < blockSource.size(); i += 4) blockSource[i] = 0;
  for (int y = 12; y < 52; ++y) for (int x = 12; x < 52; ++x) {
    const auto offset = (y*128+x)*4;
    blockSource[offset] = blockSource[offset+1] = blockSource[offset+2] = static_cast<std::uint8_t>(40+x+y);
    blockSource[offset+3] = static_cast<std::uint8_t>((x+y)%3 ? 128 : 255);
  }
  const auto writeBlocks = [&]() {
    for (int y = 0; y < 66; ++y) for (int x = 0; x < 66; ++x)
      std::copy_n(blockSource.data()+(std::clamp(y-1, 0, 63)*128+std::clamp(x-1, 0, 127))*4,
        4, blockPage.data()+(y*66+x)*4);
    pmjs::writePreparedPng(root/"block-source.png", 128, 64, blockSource);
    pmjs::writePreparedPng(root/"block-page.png", 66, 66, blockPage);
  };
  writeBlocks();
  for (const int failurePosition : {1, 2}) {
    pmjs::ImageStore images;
    images.setWarmBudgetBytes(0);
    auto malformed = blocks;
    malformed.blockGrid = std::array<int, 3>{64, 63, 64};
    require(!images.installPrepared(root/"block-source.png", root, malformed), "invalid block grid was accepted");
    malformed = blocks; malformed.cells[0].crop = {1, 0, 63, 64};
    malformed.cells[0].atlas = {1, 1, 63, 64};
    require(!images.installPrepared(root/"block-source.png", root, malformed), "partial block crop was accepted");
    require(images.installPrepared(root/"block-source.png", root, blocks), "block catalog installation failed");
    auto image = images.loadPng(root/"block-source.png");
    require(image.has_value(), "block source load failed");
    images.setCompactSamplingEnabled(false);
    uploadedTextures.clear(); captureUploads = true;
    require(!images.resolveBlockRegion(image->handle), "disabled compact control selected block backing");
    captureUploads = false;
    require(uploadedTextures.empty(), "disabled block lookup allocated textures");
    images.setCompactSamplingEnabled(true);
    GLuint sentinelTexture = 0, sentinelBuffer = 0;
    glGenTextures(1, &sentinelTexture); glBindTexture(GL_TEXTURE_2D, sentinelTexture);
    glGenBuffers(1, &sentinelBuffer); glBindBuffer(GL_PIXEL_UNPACK_BUFFER, sentinelBuffer);
    glBufferData(GL_PIXEL_UNPACK_BUFFER, 256, nullptr, GL_STATIC_DRAW);
    glPixelStorei(GL_UNPACK_ALIGNMENT, 8); glPixelStorei(GL_UNPACK_ROW_LENGTH, 17);
    glPixelStorei(GL_UNPACK_SKIP_ROWS, 2); glPixelStorei(GL_UNPACK_SKIP_PIXELS, 3);
    const UnpackState beforeState;
    textureCountdown = failurePosition;
    uploadedTextures.clear(); captureUploads = true;
    require(!images.resolveBlockRegion(image->handle), "failed block upload did not select fallback");
    captureUploads = false;
    require(textureCountdown == 0 && uploadedTextures.size() == 2, "block fault missed atlas or table upload");
    require(UnpackState().values == beforeState.values, "block failure changed unpack state");
    require(images.gpuBytes() == 0 && images.blockTextureUploads() == 0 && images.blockUploadFailures() == 1,
      "failed block upload changed GPU accounting or diagnostics");
    for (const auto texture : uploadedTextures)
      require(!glIsTexture(texture), "failed block upload retained a partial texture");
    uploadedTextures.clear(); captureUploads = true;
    require(!images.resolveBlockRegion(image->handle) && !images.resolveBlockRegion(image->handle, false),
      "failed block backing retried a representation");
    captureUploads = false;
    require(uploadedTextures.empty() && images.blockUploadFailures() == 1, "block failure latch retried GL allocation");
    glBindBuffer(GL_PIXEL_UNPACK_BUFFER, 0);
    glPixelStorei(GL_UNPACK_ALIGNMENT, 1); glPixelStorei(GL_UNPACK_ROW_LENGTH, 0);
    glPixelStorei(GL_UNPACK_SKIP_ROWS, 0); glPixelStorei(GL_UNPACK_SKIP_PIXELS, 0);
    glBindTexture(GL_TEXTURE_2D, 0);
    glDeleteBuffers(1, &sentinelBuffer); glDeleteTextures(1, &sentinelTexture);
    const auto fallback = images.lookup(image->handle);
    require(fallback.has_value(), "ordinary block fallback failed");
    requireGpuPixels(*fallback, blockSource);
    images.release(image->handle); images.update();
    require(images.gpuBytes() == 0, "failed block backing leaked allocations");
    image = images.loadPng(root/"block-source.png");
    require(image.has_value(), "block backing recreation failed");
    const auto premultiplied = images.resolveBlockRegion(image->handle);
    const auto straight = images.resolveBlockRegion(image->handle, false);
    require(premultiplied && straight && premultiplied->image.premultiplied && !straight->image.premultiplied,
      "block recovery did not separate source representations");
    const std::size_t representationBytes = 66U*66U*2U+2U*4U;
    require(images.gpuBytes() == representationBytes*2 && images.blockTextureUploads() == 2,
      "block residency omitted a representation or lookup texture");
    const auto uploads = images.textureUploadBytes();
    require(images.resolveBlockRegion(image->handle).has_value() && images.textureUploadBytes() == uploads,
      "cached block backing uploaded again");
    require(images.beginUse(image->handle), "block queued ownership failed");
    images.release(image->handle); images.update();
    require(glIsTexture(premultiplied->image.texture) && glIsTexture(premultiplied->table) &&
      glIsTexture(straight->image.texture) && glIsTexture(straight->table), "queued block textures died with source owner");
    images.endUse(image->handle); images.update();
    require(images.gpuBytes() == 0 && images.liveCount() == 0, "block backing destruction leaked residency");
    image = images.loadPng(root/"block-source.png");
    const auto previous = images.resolveBlockRegion(image->handle);
    require(previous.has_value(), "block mutation fixture failed");
    require(images.updateRgba(image->handle, blockSource.data()) && !images.hasPreparedBacking(image->handle) &&
      !images.resolveBlockRegion(image->handle) && !glIsTexture(previous->image.texture) && !glIsTexture(previous->table),
      "source mutation retained block textures or lookup metadata");
    images.release(image->handle); images.update();
    require(images.gpuBytes() == 0, "mutated block backing leaked allocations");
  }
  blockSource[(20*128+63)*4] = blockSource[(20*128+63)*4+1] = blockSource[(20*128+63)*4+2] = 111;
  blockSource[(20*128+63)*4+3] = 128;
  writeBlocks();
  {
    pmjs::ImageStore images;
    images.setWarmBudgetBytes(0);
    require(images.installPrepared(root/"block-source.png", root, blocks), "unsafe padding fixture install failed");
    const auto image = images.loadPng(root/"block-source.png");
    require(image && !images.resolveBlockRegion(image->handle) && images.blockTextureUploads() == 0,
      "literal block ignored a nonuniform neighboring halo");
    require(images.readPixelsRegion(image->handle, 0, 0, 128, 64)->rgba == blockSource,
      "block rejection changed lossless CPU pixels");
    images.release(image->handle); images.update();
  }
  std::cout << "compact allocation failures preserve GL state, fallback pixels and backing recovery\n";
  return 0;
} catch (const std::exception& error) { std::cerr << error.what() << '\n'; return 1; }
