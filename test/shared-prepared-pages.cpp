#include "platform.hpp"
#include "prepared_page.hpp"
#include "resources.hpp"

#include <algorithm>
#include <array>
#include <filesystem>
#include <iostream>
#include <stdexcept>
#include <thread>
#include <vector>
#include <unistd.h>
#include <png.h>
#include <GLES3/gl3.h>

namespace {
void require(bool value, const char* message) {
  if (!value) throw std::runtime_error(message);
}
void write(const std::filesystem::path& path, int width, int height,
           const std::vector<std::uint8_t>& pixels) {
  png_image image{}; image.version = PNG_IMAGE_VERSION;
  image.width = width; image.height = height; image.format = PNG_FORMAT_RGBA;
  require(png_image_write_to_file(&image, path.c_str(), 0, pixels.data(), 0, nullptr), "fixture PNG write failed");
}
struct Fixture {
  std::filesystem::path source, directory;
  pmjs::PreparedImageDescriptor descriptor;
  std::vector<std::uint8_t> pixels;
};
Fixture fixture(const std::filesystem::path& root, const char* name, int cropX = 9, int fill = 241,
                int width = 49, int height = 37, int pageFill = 241, int pageWidth = 29, int pageHeight = 27) {
  Fixture result;
  result.source = root / (std::string(name) + ".png");
  result.directory = root / name;
  std::filesystem::create_directory(result.directory);
  auto& d = result.descriptor;
  d.width = width; d.height = height; d.halo = 3;
  d.pages = {{"page-0.png",pageWidth,pageHeight}};
  d.cells = {{{0,0,width,height},{cropX,7,23,21},{3,3,23,21},
    {static_cast<std::uint8_t>(fill),static_cast<std::uint8_t>(fill),static_cast<std::uint8_t>(fill),0},0}};
  result.pixels.resize(width * height * 4);
  std::vector<std::uint8_t> page(pageWidth * pageHeight * 4);
  for (std::size_t i = 0; i < result.pixels.size(); i += 4) {
    result.pixels[i] = result.pixels[i+1] = result.pixels[i+2] = static_cast<std::uint8_t>(fill);
  }
  // Page payloads remain identical even when logical placement or fill differs.
  for (std::size_t i = 0; i < page.size(); i += 4)
    page[i] = page[i+1] = page[i+2] = static_cast<std::uint8_t>(pageFill);
  for (int y = 0; y < 21; ++y) for (int x = 0; x < 23; ++x) {
    const auto gray = static_cast<std::uint8_t>((x * 13 + y * 17) % 256);
    const auto alpha = static_cast<std::uint8_t>((x * 19 + y * 7) % 256);
    const std::array<std::uint8_t,4> color{gray,gray,gray,alpha};
    std::copy(color.begin(),color.end(),page.begin() + ((y+3)*pageWidth+x+3)*4);
    std::copy(color.begin(),color.end(),result.pixels.begin() + ((y+7)*width+x+cropX)*4);
  }
  write(result.source,width,height,result.pixels);
  write(result.directory / "page-0.png",pageWidth,pageHeight,page);
  return result;
}
void install(pmjs::ImageStore& images, const Fixture& value) {
  require(images.installPrepared(value.source,value.directory,value.descriptor), "prepared fixture installation failed");
}
void pixels(pmjs::ImageStore& images, pmjs::ImageHandle image, const std::vector<std::uint8_t>& expected) {
  const auto info = images.inspect(image);
  require(info.has_value(),"logical image unavailable");
  const auto actual = images.readPixelsRegion(image,0,0,info->width,info->height);
  require(actual && actual->rgba == expected, "logical RGBA changed, including hidden RGB");
}
}

int main() {
  pmjs::Platform platform(16,16,"Shared prepared resources");
  const auto temporaryRoot = std::filesystem::current_path() / ".cache/tests";
  std::filesystem::create_directories(temporaryRoot);
  const auto pattern = (temporaryRoot / "shared-prepared-XXXXXX").string();
  std::vector<char> temporary(pattern.begin(),pattern.end()); temporary.push_back('\0');
  const auto* directory = mkdtemp(temporary.data()); require(directory,"temporary fixture failed");
  const std::filesystem::path root(directory);
  try {
    const auto a = fixture(root,"first"), b = fixture(root,"second");
    {
      const auto source = root / "block-grid.png", directory = root / "block-grid";
      std::filesystem::create_directory(directory);
      std::vector<std::uint8_t> pixels(128 * 64 * 4);
      write(source,128,64,pixels);
      pmjs::PreparedImageDescriptor descriptor;
      descriptor.width=128; descriptor.height=64; descriptor.blockGrid=std::array<int,3>{64,128,64};
      descriptor.cells={
        {{0,0,64,64},{0,0,0,0},{0,0,0,0},{0,0,0,0},-1},
        {{64,0,64,64},{0,0,0,0},{0,0,0,0},{0,0,0,0},-1}
      };
      pmjs::ImageStore images;
      require(images.installPrepared(source,directory,descriptor),"native fixed-grid descriptor rejected");
      auto overlapping=descriptor;
      overlapping.cells[1].rect=overlapping.cells[0].rect;
      pmjs::ImageStore rejects;
      require(!rejects.installPrepared(source,directory,overlapping),"native fixed-grid overlap accepted");
    }
    const auto shifted = fixture(root,"shifted",10), hidden = fixture(root,"hidden",9,242);
    const auto potA = fixture(root,"pot-first",9,241,64,64), potB = fixture(root,"pot-second",9,241,64,64);
    const auto spriteA = fixture(root,"sprite-first",9,0,64,64,0), spriteB = fixture(root,"sprite-second",9,0,64,64,0);
    {
      pmjs::ImageStore images;
      images.setWarmBudgetBytes(0);
      images.setPreparedFrameCacheBudget(0);
      install(images,a); install(images,b);
      auto sourceA = pmjs::ImageStore::openFile(a.source), sourceB = pmjs::ImageStore::openFile(b.source);
      require(sourceA && sourceB && sourceA->key() != sourceB->key(),"distinct sources must retain independent identities");
      auto pendingA = images.capturePrepared(*sourceA), pendingB = images.capturePrepared(*sourceB);
      require(pendingA && pendingB,"worker snapshots unavailable");
      bool validA = false, validB = false;
      std::thread left([&] { validA = images.validatePrepared(*pendingA); });
      std::thread right([&] { validB = images.validatePrepared(*pendingB); });
      left.join(); right.join();
      require(validA && validB,"concurrent page validation failed");
      require(images.cpuBytes() == 0,"private worker pages entered resident accounting before publication");
      auto first = images.installPreparedLoad(*sourceA,std::move(pendingA),false);
      require(images.cpuBytes() == 29U * 27 * 4,"first publication did not charge its shared page");
      auto second = images.installPreparedLoad(*sourceB,std::move(pendingB),false);
      require(first && second && first->handle != second->handle,"sharing must preserve independent logical handles");
      constexpr std::size_t pageBytes = 29 * 27 * 4;
      require(images.preparedPageDecodes() == 1,"concurrent identical pages decoded more than once");
      require(images.cpuBytes() == pageBytes,"shared CPU page counted or stored twice");
      for (int tick = 0; tick < 40; ++tick) images.update();
      require(images.cpuBytes() == pageBytes,"shared page accounting changed while idle");
      for (int tick = 40; tick < 61; ++tick) images.update();
      require(images.cpuBytes() == pageBytes,"idle shared page was discarded below its byte budget");
      const auto decodes = images.preparedPageDecodes();
      pixels(images,first->handle,a.pixels); pixels(images,second->handle,b.pixels);
      require(images.preparedPageDecodes() == decodes,"retained shared page was decoded again for an owner");
      const auto firstStraight = images.lookup(first->handle);
      const auto creates = images.textureCreates(), uploads = images.textureUploadBytes();
      const auto secondStraight = images.lookup(second->handle);
      require(firstStraight && secondStraight && firstStraight->texture == secondStraight->texture,
        "identical NPOT full materializations did not share a texture");
      require(images.textureCreates() == creates && images.textureUploadBytes() == uploads,
        "second full materialization uploaded identical pixels again");
      const auto firstPremultiplied = images.lookupPremultiplied(first->handle);
      const auto premultipliedUploads = images.textureUploadBytes();
      const auto secondPremultiplied = images.lookupPremultiplied(second->handle);
      require(firstPremultiplied && secondPremultiplied && firstPremultiplied->texture == secondPremultiplied->texture &&
        images.textureUploadBytes() == premultipliedUploads,"premultiplied materializations did not share");
      const auto deferred = images.deferPixelRead(first->handle,0,0,49,37);
      auto changed = a.pixels;
      const std::array<std::uint8_t,4> patch{31,67,149,255};
      std::copy(patch.begin(),patch.end(),changed.begin()+(8*49+10)*4);
      require(images.updateRgbaRegion(first->handle,10,8,1,1,patch.data(),1),"shared region mutation failed");
      require(deferred && deferred->pixels && deferred->pixels->rgba == a.pixels,"mutation lost the deferred original snapshot");
      pixels(images,first->handle,changed); pixels(images,second->handle,b.pixels);
      require(images.lookup(second->handle)->texture == secondStraight->texture &&
        images.lookup(first->handle)->texture != secondStraight->texture,"region mutation did not detach its texture");
      require(images.lookupPremultiplied(second->handle)->texture == secondPremultiplied->texture,
        "mutation invalidated another owner's premultiplied texture");
      require(images.release(first->handle),"first owner release failed"); images.update();
      require(glIsTexture(secondStraight->texture) && glIsTexture(secondPremultiplied->texture),
        "releasing one owner deleted another owner's textures");
      pixels(images,second->handle,b.pixels);
      require(images.release(second->handle),"last owner release failed"); images.update();
      require(images.gpuBytes() == 0 && images.cpuBytes() == 0,"shared pools retained resources after the last owner left");
    }
    {
      pmjs::ImageStore images; images.setWarmBudgetBytes(1024*1024);
      install(images,a); install(images,b);
      const auto first = images.loadPng(a.source), second = images.loadPng(b.source);
      require(first && second,"warm alias fixtures failed to load");
      require(images.lookup(first->handle) && images.lookup(second->handle) &&
        images.lookupPremultiplied(first->handle) && images.lookupPremultiplied(second->handle),
        "warm alias textures unavailable");
      const auto physicalBytes = images.cpuBytes()+images.gpuBytes();
      require(images.release(first->handle) && images.release(second->handle),"warm alias release failed");
      images.update();
      require(images.warmCount() == 2 && images.warmBytes() == physicalBytes,
        "two warm aliases counted shared physical CPU or GPU storage twice");
      images.setWarmBudgetBytes(0); images.update();
      require(images.warmBytes() == 0 && images.warmCount() == 0 &&
        images.cpuBytes() == 0 && images.gpuBytes() == 0,"zero budget failed to reclaim both warm aliases");
    }
    {
      pmjs::ImageStore images;
      images.setWarmBudgetBytes(0); images.setPreparedFrameCacheBudget(0);
      install(images,a); install(images,b); install(images,shifted); install(images,hidden);
      install(images,potA); install(images,potB);
      const auto first = images.loadPng(a.source), second = images.loadPng(b.source);
      const auto placement = images.loadPng(shifted.source), invisible = images.loadPng(hidden.source);
      const auto mipmapFirst = images.loadPng(potA.source), mipmapSecond = images.loadPng(potB.source);
      require(first && second && placement && invisible && mipmapFirst && mipmapSecond,"negative-control loads failed");
      require(images.preparedPageDecodes() == 1 && images.cpuBytes() == 29*27*4,
        "identical encoded pages failed to share across different logical descriptors");
      pixels(images,placement->handle,shifted.pixels); pixels(images,invisible->handle,hidden.pixels);
      const auto firstTexture = images.lookup(first->handle)->texture;
      require(images.lookup(placement->handle)->texture != firstTexture,"different logical placement reused the wrong full texture");
      require(images.lookup(invisible->handle)->texture != firstTexture,"different hidden fill RGB reused the wrong full texture");
      require(images.lookup(second->handle)->texture == firstTexture,"exact source copy failed to share in negative-control batch");
      const auto potTexture = images.lookup(mipmapFirst->handle)->texture;
      require(potTexture != firstTexture,"different logical dimensions reused the wrong full texture");
      require(images.lookup(mipmapSecond->handle)->texture == potTexture,"identical POT full textures failed to share");
      require(images.ensureMipmaps(mipmapFirst->handle,false),"shared POT mipmaps unavailable");
      const auto mipmapBytes = images.gpuBytes();
      require(images.ensureMipmaps(mipmapSecond->handle,false) && images.gpuBytes() == mipmapBytes,
        "second owner duplicated shared mipmap accounting");
      auto changed = a.pixels; changed[0] = 17; changed[1] = 29; changed[2] = 41; changed[3] = 255;
      require(images.updateRgba(first->handle,changed.data()),"full shared-image mutation failed");
      pixels(images,first->handle,changed); pixels(images,second->handle,b.pixels);
      for (const auto image : {*first,*second,*placement,*invisible,*mipmapFirst,*mipmapSecond})
        require(images.release(image.handle),"fixture release failed");
      images.update();
      require(images.gpuBytes() == 0 && images.cpuBytes() == 0,"negative-control resources survived last release");
    }
    {
      pmjs::ImageStore images; images.setWarmBudgetBytes(0);
      install(images,spriteA); install(images,spriteB);
      const auto first = images.loadPng(spriteA.source), second = images.loadPng(spriteB.source);
      require(first && second,"prepared-page sharing fixtures failed to load");
      for (const bool premultiplied : {false,true}) {
        const auto region = images.resolveSpriteRegion(first->handle,0,0,64,64,premultiplied);
        const auto uploads = images.textureUploadBytes();
        const auto alias = images.resolveSpriteRegion(second->handle,0,0,64,64,premultiplied);
        require(region && alias && region->image.texture == alias->image.texture &&
          images.textureUploadBytes() == uploads,"identical sprite pages did not share physical storage");
      }
      require(images.gpuBytes() == 2U*29*27*2,"sprite-page GPU accounting duplicated shared alpha representations");
      pixels(images,first->handle,spriteA.pixels); pixels(images,second->handle,spriteB.pixels);
      const auto surviving = images.resolveSpriteRegion(second->handle,0,0,64,64,false)->image.texture;
      require(images.release(first->handle),"sprite-page owner release failed"); images.update();
      require(glIsTexture(surviving),"one owner release deleted the shared sprite page");
      require(images.release(second->handle),"last sprite-page owner release failed"); images.update();
      require(images.gpuBytes() == 0 && images.cpuBytes() == 0,"sprite-page resources survived their last owner");
    }
    for (const bool grayscale : {false, true}) {
      constexpr int width = 64, height = 64, pageWidth = 70, pageHeight = 70;
      Fixture indexed;
      indexed.source = root / (grayscale ? "indexed-gray.png" : "indexed.png");
      indexed.directory = root / (grayscale ? "indexed-gray" : "indexed");
      std::filesystem::create_directory(indexed.directory);
      auto& d = indexed.descriptor;
      d.width = width; d.height = height; d.halo = 3;
      d.pages = {{"page-0.pml4", pageWidth, pageHeight}};
      d.cells = {{{0, 0, width, height}, {0, 0, width, height}, {3, 3, width, height}, {0, 0, 0, 0}, 0}};
      indexed.pixels.resize(width * height * 4);
      std::vector<std::uint8_t> page(pageWidth * pageHeight * 4);
      const auto color = [grayscale](int x, int y) {
        const auto index = (x * 7 + y * 11) % 256;
        return std::array<std::uint8_t, 4>{std::uint8_t(index), std::uint8_t(grayscale ? index : 255-index),
          std::uint8_t(index), 255};
      };
      for (int y = 0; y < height; ++y) for (int x = 0; x < width; ++x) {
        const auto rgba = color(x, y);
        std::copy(rgba.begin(), rgba.end(), indexed.pixels.begin() + (y * width + x) * 4);
      }
      for (int y = 0; y < pageHeight; ++y) for (int x = 0; x < pageWidth; ++x) {
        const auto rgba = color(std::clamp(x - 3, 0, width - 1), std::clamp(y - 3, 0, height - 1));
        std::copy(rgba.begin(), rgba.end(), page.begin() + (y * pageWidth + x) * 4);
      }
      write(indexed.source, width, height, indexed.pixels);
      pmjs::writeLz4Page(indexed.directory / "page-0.pml4", pageWidth, pageHeight, page, true);
      if (grayscale) {
        auto descriptor = d;
        descriptor.blockGrid = std::array<int, 3>{64, width, height};
        descriptor.blockChannels = 1;
        pmjs::ImageStore blocks;
        blocks.setWarmBudgetBytes(0);
        require(blocks.installPrepared(indexed.source, indexed.directory, descriptor), "block fixture install failed");
        const auto image = blocks.loadPng(indexed.source);
        require(image && blocks.resolveBlockRegion(image->handle, false), "indexed block upload failed");
        require(blocks.cpuBytes() < std::size_t(pageWidth) * pageHeight * 4,
          "block upload retained expanded indexed pixels");
        const auto decodes = blocks.preparedPageDecodes();
        const auto uploads = blocks.textureUploadBytes();
        require(blocks.readPixelsRegion(image->handle, 0, 0, width, height)->rgba == indexed.pixels,
          "block upload lost reconstructible CPU pixels");
        require(blocks.resolveBlockRegion(image->handle, false) && blocks.preparedPageDecodes() == decodes &&
          blocks.textureUploadBytes() == uploads, "repeated block use decoded or uploaded pixels");
        blocks.release(image->handle); blocks.update();
        require(blocks.cpuBytes() == 0 && blocks.gpuBytes() == 0, "block storage outlived its owner");
      }
      pmjs::ImageStore images;
      images.setWarmBudgetBytes(0); images.setPreparedFrameCacheBudget(0);
      install(images, indexed);
      const auto loaded = images.loadPng(indexed.source);
      require(loaded.has_value(), "indexed prepared page failed to load");
      const auto region = images.resolveSpriteRegion(loaded->handle, 0, 0, width, height, false, true, true);
      if (grayscale) {
        require(!region, "opaque grayscale page selected palette sampling");
        const auto ordinary = images.lookup(loaded->handle);
        require(ordinary && images.gpuBytes() == std::size_t(width) * height,
          "opaque grayscale fallback did not retain single-channel storage");
        require(images.cpuBytes() < std::size_t(pageWidth) * pageHeight * 4,
          "grayscale upload retained expanded indexed pages");
      } else {
        require(region && region->paletteTable != 0, "indexed palette region unavailable");
        require(images.gpuBytes() == std::size_t(pageWidth) * pageHeight + 1024,
          "indexed palette GPU accounting is incorrect");
      }
      const auto decodes = images.preparedPageDecodes();
      const auto uploads = images.textureUploadBytes();
      for (int frame = 0; frame < 8; ++frame) {
        const auto repeated = images.resolveSpriteRegion(loaded->handle, 0, 0, width, height, false, true, true);
        require(grayscale ? !repeated : repeated && repeated->image.texture == region->image.texture &&
          repeated->paletteTable == region->paletteTable,
          "repeated indexed palette view changed its backing");
      }
      require(images.preparedPageDecodes() == decodes,
        "repeated indexed palette view decoded an already resident page");
      require(images.textureUploadBytes() == uploads,
        "repeated indexed palette view uploaded an already resident page");
      const auto restored = images.readPixelsRegion(loaded->handle, 0, 0, width, height);
      require(restored && restored->rgba == indexed.pixels, "indexed palette pixels changed");
      require(images.release(loaded->handle), "indexed palette release failed");
      images.update();
      require(images.gpuBytes() == 0 && images.cpuBytes() == 0,
        "indexed palette resources survived their last owner");
    }
    {
      constexpr int side = 2048, width = 64, height = 64;
      std::vector<std::uint8_t> page(side * side * 4), source(width * height * 4);
      for (int y = 0; y < side; ++y) for (int x = 0; x < side; ++x) {
        const auto gray = static_cast<std::uint8_t>((x * 7 + y * 11) % 256);
        const auto offset = (y * side + x) * 4;
        page[offset] = page[offset+1] = page[offset+2] = gray; page[offset+3] = 255;
      }
      for (int y = 0; y < height; ++y)
        std::copy_n(page.data() + ((y+1) * side + 1) * 4, width * 4,
          source.data() + y * width * 4);
      pmjs::ImageStore images;
      images.setWarmBudgetBytes(0);
      std::vector<pmjs::ImageHandle> handles;
      for (int index = 0; index < 9; ++index) {
        const auto name = "packed-budget-" + std::to_string(index);
        const auto directory = root / name, file = root / (name + ".png");
        std::filesystem::create_directory(directory);
        const auto offset = (128 + index) * 4;
        page[offset] = page[offset+1] = page[offset+2] = std::uint8_t(page[offset] + 1);
        write(file, width, height, source);
        pmjs::writeLz4Page(directory / "page.pml4", side, side, page, true);
        pmjs::PreparedImageDescriptor descriptor;
        descriptor.width = width; descriptor.height = height; descriptor.halo = 1;
        descriptor.pages = {{"page.pml4", side, side}};
        descriptor.cells = {{{0,0,width,height}, {0,0,width,height}, {1,1,width,height}, {}, 0}};
        require(images.installPrepared(file, directory, descriptor), "packed cache fixture installation failed");
        const auto image = images.loadPng(file);
        require(image.has_value(), "packed cache fixture load failed");
        handles.push_back(image->handle);
      }
      require(images.cpuBytes() <= 32U * 1024U * 1024U,
        "packed page payloads exceeded the shared CPU page budget");
      const auto decodes = images.preparedPageDecodes();
      pixels(images, handles.front(), source);
      require(images.preparedPageDecodes() > decodes,
        "evicted packed page was not reconstructed from its retained source");
      require(images.cpuBytes() <= 32U * 1024U * 1024U,
        "reconstructed packed page exceeded the shared CPU page budget");
      for (const auto handle : handles) require(images.release(handle), "packed cache owner release failed");
      images.update();
      require(images.cpuBytes() == 0 && images.gpuBytes() == 0, "packed cache resources survived their last owner");
    }
    {
      const auto blockFixture = [&](const char* name) {
        Fixture value; value.source = root/(std::string(name)+".png"); value.directory = root/name;
        std::filesystem::create_directory(value.directory);
        auto& d = value.descriptor; d.width = 128; d.height = 64; d.halo = 3;
        d.blockGrid = std::array<int,3>{64,64,64}; d.pages = {{"page-0.png",70,70}};
        d.cells = {{{0,0,64,64},{0,0,64,64},{3,3,64,64},{0,0,0,0},0},
          {{64,0,64,64},{0,0,64,64},{3,3,64,64},{0,0,0,0},0}};
        value.pixels.resize(128*64*4); std::vector<std::uint8_t> page(70*70*4);
        for (int y = 4; y < 60; ++y) for (int x = 4; x < 60; ++x) {
          const auto gray = static_cast<std::uint8_t>((x*13+y*17)%256);
          const std::array<std::uint8_t,4> color{gray,gray,gray,static_cast<std::uint8_t>((x*19+y*7)%256)};
          std::copy(color.begin(),color.end(),page.begin()+((y+3)*70+x+3)*4);
          for (const int frame : {0,1}) std::copy(color.begin(),color.end(),value.pixels.begin()+(y*128+x+frame*64)*4);
        }
        write(value.source,128,64,value.pixels); write(value.directory/"page-0.png",70,70,page);
        return value;
      };
      const auto blockA = blockFixture("block-first"), blockB = blockFixture("block-second");
      pmjs::ImageStore images; images.setWarmBudgetBytes(0);
      install(images,blockA); install(images,blockB);
      const auto first = images.loadPng(blockA.source), second = images.loadPng(blockB.source);
      require(first && second,"block sharing fixtures failed to load");
      const auto region = images.resolveBlockRegion(first->handle,false);
      const auto creates = images.textureCreates(), uploads = images.textureUploadBytes();
      const auto alias = images.resolveBlockRegion(second->handle,false);
      require(region && alias && region->image.texture == alias->image.texture && region->table != alias->table,
        "block owners must share the atlas and retain separate lookup tables");
      require(images.textureCreates() == creates+1 && images.textureUploadBytes() == uploads+8,
        "second block owner uploaded more than its private two-entry table");
      require(images.gpuBytes() == 70U*70*2+2*8,"shared block atlas GPU accounting is incorrect");
      const auto spriteRegion = images.resolveSpriteRegion(first->handle,0,0,64,64,false);
      require(spriteRegion && spriteRegion->image.texture == region->image.texture,
        "block and sprite consumers did not reuse the same physical page");
      const auto entries = images.memoryEntries();
      const auto owner = std::find_if(entries.begin(),entries.end(),[&](const auto& entry) { return entry.handle == first->handle; });
      require(owner != entries.end() && owner->gpuBytes == 70U*70*2+8,
        "one logical owner counted its shared page and block atlas twice");
      pixels(images,first->handle,blockA.pixels); pixels(images,second->handle,blockB.pixels);
      require(images.release(first->handle),"first block owner release failed"); images.update();
      require(glIsTexture(alias->image.texture) && glIsTexture(alias->table),"first release invalidated the surviving block owner");
      require(images.gpuBytes() == 70U*70*2+8,"first block release did not reclaim only its private table");
      require(images.release(second->handle),"last block owner release failed"); images.update();
      require(images.gpuBytes() == 0 && images.cpuBytes() == 0,"block resources survived their last owner");
    }
    {
      const auto largeA=fixture(root,"budget-a",9,241,49,37,31,1536,1536);
      const auto largeB=fixture(root,"budget-b",9,241,49,37,63,1536,1536);
      const auto largeC=fixture(root,"budget-c",9,241,49,37,95,1536,1536);
      const auto largeD=fixture(root,"budget-d",9,241,49,37,127,1536,1536);
      const auto aliasB=fixture(root,"budget-b-alias",9,241,49,37,63,1536,1536);
      pmjs::ImageStore images; images.setWarmBudgetBytes(0);
      for(const auto* value : {&largeA,&largeB,&largeC,&largeD,&aliasB}) install(images,*value);
      const auto first=images.loadPng(largeA.source), second=images.loadPng(largeB.source), third=images.loadPng(largeC.source);
      require(first && second && third,"budget fixtures did not load");
      constexpr std::size_t retainedBytes=3U*1536U*1536U*4U;
      require(images.cpuBytes()==retainedBytes,"independent CPU pages were not accounted globally");
      const auto alias=images.loadPng(aliasB.source); require(alias.has_value(),"budget alias did not load");
      require(images.preparedPageDecodes()==3 && images.cpuBytes()==retainedBytes,"alias duplicated physical CPU page storage");
      const auto fourth=images.loadPng(largeD.source); require(fourth.has_value(),"pressure fixture did not load");
      require(images.cpuBytes()==retainedBytes,"page installation exceeded the global byte budget");
      pixels(images,alias->handle,aliasB.pixels);
      const auto before=images.preparedPageDecodes();
      pixels(images,first->handle,largeA.pixels);
      require(images.preparedPageDecodes()==before+1 && images.cpuBytes()==retainedBytes,
        "evicted page reconstruction did not restore the global byte limit");
      for(const auto [handle,value] : {
          std::pair{second->handle,&largeB}, {alias->handle,&aliasB},
          {fourth->handle,&largeD}, {first->handle,&largeA}}) pixels(images,handle,value->pixels);
      require(images.preparedPageDecodes()==before+1,"global eviction discarded a more recently read physical page");
      pixels(images,third->handle,largeC.pixels);
      require(images.preparedPageDecodes()==before+2 && images.cpuBytes()==retainedBytes,
        "least recently read page did not reconstruct within the global byte limit");
      for(const auto handle : {first->handle,second->handle,third->handle,fourth->handle,alias->handle})
        require(images.release(handle),"budget fixture release failed");
      images.update();
      require(images.cpuBytes()==0 && images.gpuBytes()==0,"budgeted pages survived their final owners");

      Fixture localAliases;
      localAliases.directory=root/"local-aliases";
      std::filesystem::create_directory(localAliases.directory);
      localAliases.source=root/"local-aliases.png";
      auto& descriptor=localAliases.descriptor;
      descriptor.width=196; descriptor.height=37; descriptor.halo=3;
      localAliases.pixels.resize(196*37*4);
      int page=0;
      for(const auto* value : {&largeA,&largeB,&largeB,&largeC}) {
        const auto name="page-"+std::to_string(page)+".png";
        std::filesystem::create_hard_link(value->directory/"page-0.png",localAliases.directory/name);
        descriptor.pages.push_back({name,1536,1536});
        descriptor.cells.push_back({{page*49,0,49,37},{9,7,23,21},{3,3,23,21},{241,241,241,0},page});
        for(int y=0;y<37;++y) std::copy_n(value->pixels.data()+y*49*4,49*4,
          localAliases.pixels.data()+(y*196+page*49)*4);
        ++page;
      }
      write(localAliases.source,196,37,localAliases.pixels);
      pmjs::ImageStore aliases; aliases.setWarmBudgetBytes(0);
      install(aliases,localAliases);
      const auto logical=aliases.loadPng(localAliases.source); require(logical.has_value(),"local aliases failed to load");
      require(aliases.preparedPageDecodes()==3 && aliases.cpuBytes()==retainedBytes,
        "within-image aliases were counted as separate physical allocations");
      pixels(aliases,logical->handle,localAliases.pixels);
      require(aliases.preparedPageDecodes()==3 && aliases.cpuBytes()==retainedBytes,
        "local alias counting evicted a page below the physical byte limit");
      require(aliases.release(logical->handle),"local alias release failed"); aliases.update();
      require(aliases.cpuBytes()==0 && aliases.gpuBytes()==0,"local page aliases survived their final owner");
    }
    std::filesystem::remove_all(root);
    std::cout << "shared prepared pages: concurrent decoding, physical accounting, global LRU budget and mutation isolation passed\n";
  } catch (...) { std::filesystem::remove_all(root); throw; }
}
