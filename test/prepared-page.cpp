#include "assets/prepared_page.hpp"
#include "assets/texture_artifact.hpp"
#include <bit>

#include <algorithm>
#include <filesystem>
#include <fstream>
#include <iostream>
#include <source_location>
#include <stdexcept>
#include <unistd.h>
#include <zlib.h>
#include <lz4.h>

namespace {
void require(bool value, const std::source_location& location = std::source_location::current()) {
  if (!value) throw std::runtime_error("LZ4 page fixture failed at " + std::to_string(location.line()));
}
void put(std::vector<std::uint8_t>& bytes, std::size_t offset, std::uint32_t value) {
  for (int i = 0; i < 4; ++i) bytes[offset + i] = static_cast<std::uint8_t>(value >> (8 * i));
}
void headerChecksum(std::vector<std::uint8_t>& bytes) { put(bytes, 28, crc32(0, bytes.data(), 28)); }
void checkRows(const pmjs::SparsePalettePage& page, const std::vector<std::uint8_t>& rgba) {
  for (int y : {0, 7, 8, page.height - 1}) for (int x : {0, 7, 31, page.width - 17}) {
    const int count = std::min(17, page.width - x);
    std::vector<std::uint8_t> row(count * 4 + 16, 199);
    page.copyRow(x, y, std::span(row).subspan(8, count * 4));
    require(std::equal(row.begin() + 8, row.end() - 8,
      rgba.begin() + (static_cast<std::size_t>(y) * page.width + x) * 4));
    require(std::all_of(row.begin(), row.begin() + 8, [](auto value) { return value == 199; }));
    require(std::all_of(row.end() - 8, row.end(), [](auto value) { return value == 199; }));
  }
}
}
int main() {
  const auto root = std::filesystem::temp_directory_path() / ("pmjs-lz4-test-" + std::to_string(getpid()));
  std::filesystem::create_directories(root);
  try {
    for (const int count : {256, 257, 65536, 65537}) {
      pmjs::ImagePixels pixels{2048, 256, std::vector<std::uint8_t>(2048 * 256 * 4)};
      for (std::size_t i = 0; i < pixels.rgba.size() / 4; ++i) {
        const auto color = i * count / (pixels.rgba.size() / 4);
        pixels.rgba[i * 4] = color;
        pixels.rgba[i * 4 + 1] = (color >> 8) ^ (color * 31);
        pixels.rgba[i * 4 + 2] = (color >> 16) ^ (color * 17);
        pixels.rgba[i * 4 + 3] = 255;
      }
      const auto opaque = pmjs::classifyImageStorage(pixels);
      require(opaque.hasPixelFacts && opaque.opaque && !opaque.allZero);
      require(opaque.paletteBits == (count == 256 ? 8 : count <= 65536 ? 16 : 0));
      pixels.rgba.back() = 0;
      const auto transparentTail = pmjs::classifyImageStorage(pixels);
      require(!transparentTail.opaque && !transparentTail.allZero);
      require(transparentTail.paletteBits == (count < 256 ? 8 : count < 65536 ? 16 : 0));
    }
    pmjs::ImagePixels emptyPixels{128, 128, std::vector<std::uint8_t>(128 * 128 * 4)};
    const auto emptyStorage = pmjs::classifyImageStorage(emptyPixels);
    require(emptyStorage.hasPixelFacts && emptyStorage.allZero && !emptyStorage.opaque);
    const std::vector<std::uint8_t> artifact{'P','M','C','O','L','1',0,0,1,2,3,4,5,6,7,8};
    auto packedArtifact = pmjs::compressLz4Artifact(artifact);
    require(pmjs::decompressLz4Artifact(packedArtifact, artifact.size()) == artifact);
    require(!pmjs::decompressLz4Artifact(packedArtifact, artifact.size() - 1));
    auto brokenArtifact = packedArtifact; brokenArtifact.back() ^= 0x80;
    require(!pmjs::decompressLz4Artifact(brokenArtifact, artifact.size()));
    brokenArtifact = packedArtifact; brokenArtifact.push_back(0);
    require(!pmjs::decompressLz4Artifact(brokenArtifact, artifact.size()));
    bool refusedArtifact = false;
    try { pmjs::compressLz4Artifact({}); }
    catch (const std::runtime_error&) { refusedArtifact = true; }
    require(refusedArtifact);
    for (const auto [width, height] : {std::pair{1,1}, {37,19}, {2048,3}, {2048,2048}}) {
      std::vector<std::uint8_t> rgba(static_cast<std::size_t>(width) * height * 4);
      std::uint32_t state = 0x12345678;
      for (auto& byte : rgba) { state = state * 1664525U + 1013904223U; byte = state >> 24; }
      // Keep colored transparent pixels in the lossless contract.
      for (std::size_t i = 3; i < rgba.size(); i += 28) rgba[i] = 0;
      const auto file = root / "page.pml4";
      pmjs::writeLz4Page(file, width, height, rgba);
      std::ifstream input(file, std::ios::binary);
      const std::vector<std::uint8_t> encoded(std::istreambuf_iterator<char>(input), {});
      const auto decoded = pmjs::readLz4Page(encoded, rgba.size());
      require(decoded && decoded->width == width && decoded->height == height && decoded->rgba == rgba);
      require(!pmjs::makeChannelBlockPage(width, height, rgba));
      if (rgba.size() >= 256U*1024U) {
        const auto retained = pmjs::makeChannelBlockPage(width, height, rgba, rgba.size()*2);
        require(retained && retained->pixels().rgba == rgba);
        require(!pmjs::makeChannelBlockPage(width, height, rgba, retained->gpuBytes()));
      }
      require(!pmjs::readLz4Page(encoded, rgba.size() - 1));
      for (const auto offset : {0U,4U,8U,12U,16U,20U,24U,28U}) {
        auto damaged = encoded; damaged[offset] ^= 1;
        require(!pmjs::readLz4Page(damaged, rgba.size()));
      }
      for (const auto [offset, value] : {std::pair{4U,2U}, {8U,0U}, {8U,2049U}, {12U,0xffffffffU},
             {16U,0xffffffffU}, {20U,0U}, {20U,0xffffffffU}, {24U,0U}}) {
        auto damaged = encoded; put(damaged, offset, value); headerChecksum(damaged);
        require(!pmjs::readLz4Page(damaged, rgba.size()));
      }
      auto extra = encoded; extra.push_back(0); require(!pmjs::readLz4Page(extra, rgba.size()));
      if (width == 37) {
        for (std::size_t length = 0; length < encoded.size(); ++length)
          require(!pmjs::readLz4Page(std::span(encoded).first(length), rgba.size()));
        for (std::size_t i = 32; i < encoded.size(); i += 11) {
          auto damaged = encoded; damaged[i] ^= 0x80;
          const auto checked = pmjs::readLz4Page(damaged, rgba.size());
          require(!checked || checked->rgba == rgba);
        }
      }
    }
    {
      const int width = 1051, height = 1027;
      std::vector<std::uint8_t> rgba(std::size_t(width) * height * 4);
      for (int y = 0; y < height; ++y) for (int x = 0; x < width; ++x) {
        const auto at = (std::size_t(y) * width + x) * 4;
        rgba[at] = x % 251; rgba[at + 1] = y % 251;
        rgba[at + 2] = (x + y) % 251; rgba[at + 3] = (x / 8 + y / 8) % 2 ? 0 : 255;
      }
      const auto channel = pmjs::makeChannelBlockPage(width, height, rgba);
      require(channel && channel->pixels().rgba == rgba && channel->gpuBytes() < rgba.size());
      require(channel->bytes.size() < std::size_t(width) * height);
    }
    {
      const int width = 1051, height = 1027;
      std::vector<std::uint8_t> rgba(std::size_t(width) * height * 4);
      for (std::size_t i = 0; i < rgba.size() / 4; i += 11) {
        const unsigned color = i / 11 + 1;
        rgba[i * 4] = color; rgba[i * 4 + 1] = color >> 8;
        rgba[i * 4 + 2] = color >> 16; rgba[i * 4 + 3] = color % 256;
      }
      require(!pmjs::makeSparsePalettePage(width, height, rgba));
      const auto sparse = pmjs::makeSparsePalettePage(width, height, rgba, 262144);
      require(sparse && sparse->indexBytes == 3 && sparse->pixels().rgba == rgba);
      require(sparse->gpuBytes() < rgba.size());
      checkRows(*sparse, rgba);
      const auto dense = sparse->denseIndices();
      require(dense.size() == std::size_t(width) * height * 3);
      for (std::size_t i = 0; i < dense.size(); i += 3) {
        const unsigned color = dense[i] | (unsigned(dense[i + 1]) << 8) | (unsigned(dense[i + 2]) << 16);
        require(std::equal(rgba.begin() + i / 3 * 4, rgba.begin() + i / 3 * 4 + 4,
          sparse->colors.begin() + color * 4));
      }
    }
    for (const auto [width, height] : {std::pair{257,259}, {512,512}}) {
      std::vector<std::uint8_t> rgba(std::size_t(width) * height * 4);
      std::size_t rarePixels = 0;
      for (std::size_t i = 0; i < rgba.size() / 4; ++i) {
        const bool rare = i % 31 == 0;
        rgba[i * 4] = i & 255; rgba[i * 4 + 1] = rare ? (i >> 8) & 255 : 97;
        rgba[i * 4 + 2] = rare ? 137 : 51; rgba[i * 4 + 3] = rare ? i % 255 : 255;
        rarePixels += rare;
      }
      const auto sparse = pmjs::makeSparsePalettePage(width, height, rgba);
      require(sparse && sparse->pixels().rgba == rgba && sparse->residual.size() / 2 > rarePixels);
      checkRows(*sparse, rgba);
      const auto denseBytes = rgba.size() / 2 + ((sparse->colors.size() + 1023) / 1024) * 1024;
      require(sparse->gpuBytes() * 100 <= denseBytes * 85);
      const auto file = root / "sparse.pml4";
      pmjs::writeLz4Page(file, width, height, rgba, true);
      std::ifstream input(file, std::ios::binary);
      const std::vector<std::uint8_t> encoded(std::istreambuf_iterator<char>(input), {});
      require(encoded[4] == 2);
      const auto parsed = pmjs::readSparsePalettePage(encoded, rgba.size());
      require(parsed && parsed->pixels().rgba == rgba && parsed->gpuBytes() == sparse->gpuBytes());
      const auto ordinary = pmjs::readLz4Page(encoded, rgba.size());
      require(ordinary && ordinary->rgba == rgba);
      require(!pmjs::readSparsePalettePage(encoded, rgba.size() - 1));
      for (const auto at : {0U, 4U, 16U, 24U, 28U, unsigned(encoded.size() - 1)}) {
        auto broken = encoded; broken[at] ^= 128;
        require(!pmjs::readSparsePalettePage(broken, rgba.size()));
      }
      std::vector<std::uint8_t> packed(encoded[16] | (unsigned(encoded[17]) << 8) | (unsigned(encoded[18]) << 16));
      require(LZ4_decompress_safe(reinterpret_cast<const char*>(encoded.data() + 32),
        reinterpret_cast<char*>(packed.data()), encoded.size() - 32, packed.size()) == int(packed.size()));
      const auto badPacked = [&](std::size_t at, std::uint32_t value) {
        auto bytes = packed; put(bytes, at, value);
        std::vector<std::uint8_t> broken(32 + LZ4_compressBound(bytes.size()));
        std::copy_n(encoded.begin(), 32, broken.begin());
        const auto length = LZ4_compress_default(reinterpret_cast<const char*>(bytes.data()),
          reinterpret_cast<char*>(broken.data() + 32), bytes.size(), broken.size() - 32);
        require(length > 0); broken.resize(32 + length);
        put(broken, 20, length); put(broken, 24, crc32(0, bytes.data(), bytes.size())); headerChecksum(broken);
        require(!pmjs::readSparsePalettePage(broken, rgba.size()));
      };
      const auto base = 8 + sparse->colors.size(), blocks = base + sparse->base.size();
      badPacked(0, 65537); badPacked(4, rgba.size());
      badPacked(base, 0); // The first source pixel is exceptional.
      badPacked(blocks + 8, 1); // The first block must start at residual zero.
      badPacked(blocks + sparse->blocks.size() * 12, 0xffffffffU);
      std::cout << "sparse palette " << width << 'x' << height << ": dense=" << denseBytes
        << " sparse=" << sparse->gpuBytes() << " exceptions=" << sparse->residual.size() / 2 << '\n';
    }
    for (const unsigned count : {200U, 256U}) for (const unsigned run : {1U, 511U}) {
      std::vector<std::uint8_t> rgba(512 * 512 * 4);
      for (std::size_t i = 0; i < rgba.size() / 4; ++i) {
        const auto color = (i / run) % count;
        rgba[i * 4] = color & 255; rgba[i * 4 + 1] = (color >> 8) & 255;
        rgba[i * 4 + 2] = color >> 16; rgba[i * 4 + 3] = 255;
      }
      const auto indexed = pmjs::makeIndexedPalettePage(512, 512, rgba);
      require(indexed && indexed->packed && indexed->colors.size() == count * 4 &&
        indexed->blocks.empty() && indexed->residual.empty());
      require(indexed->pixels().rgba == rgba);
      checkRows(*indexed, rgba);
      require(indexed->gpuBytes() == rgba.size() / 4 + 1024);
      const auto file = root / "indexed.pml4";
      pmjs::writeLz4Page(file, 512, 512, rgba, true);
      std::ifstream input(file, std::ios::binary);
      const std::vector<std::uint8_t> encoded(std::istreambuf_iterator<char>(input), {});
      require(encoded[4] == 3);
      const auto decodedBytes = 4U + indexed->colors.size() + indexed->base.size();
      const auto parsed = pmjs::readIndexedPalettePage(encoded, decodedBytes);
      require(parsed && parsed->packed && parsed->pixels().rgba == rgba &&
        parsed->gpuBytes() == indexed->gpuBytes());
      const auto ordinary = pmjs::readLz4Page(encoded, rgba.size());
      require(ordinary && ordinary->rgba == rgba);
      require(!pmjs::readIndexedPalettePage(encoded, decodedBytes - 1));
      require(!pmjs::readSparsePalettePage(encoded, rgba.size()));
      for (const auto at : {0U, 4U, 8U, 16U, 24U, 28U, unsigned(encoded.size() - 1)}) {
        auto broken = encoded; broken[at] ^= 128;
        require(!pmjs::readIndexedPalettePage(broken, rgba.size()));
      }
    }
    for (const unsigned count : {256U, 512U, 65537U}) {
      std::vector<std::uint8_t> rgba(512 * 512 * 4);
      for (std::size_t i = 0; i < rgba.size() / 4; ++i) {
        const auto color = i % count;
        rgba[i * 4] = color & 255; rgba[i * 4 + 1] = (color >> 8) & 255;
        rgba[i * 4 + 2] = color >> 16; rgba[i * 4 + 3] = 255;
      }
      require(!pmjs::makeSparsePalettePage(512, 512, rgba));
      require(!pmjs::makeIndexedPalettePage(512, 512, rgba) || count == 256);
    }
    require(!pmjs::makeIndexedPalettePage(32, 32, std::vector<std::uint8_t>(32 * 32 * 4)));
    for (int variant = 0; variant < 7; ++variant) {
      pmjs::ImagePixels pixels{variant == 5 ? 63 : variant == 3 ? 2055 : 1031,
        variant == 5 ? 16384 : variant == 3 ? 1025 : 513, {}};
      pixels.rgba.resize(std::size_t(pixels.width)*pixels.height*4);
      std::uint32_t noise = 0x98765432;
      for (int y = 0; y < pixels.height; ++y) for (int x = 0; x < pixels.width; ++x) {
        const auto i = std::size_t(y)*pixels.width+x;
        const auto color = variant == 0 ? i%127 : variant == 1 ? i%1024 : variant == 2 ? (i%31 ? 0 : (i/31)%1023+1) :
          variant == 3 ? (i%23 ? 0 : i/23+1) : 0;
        auto* p = pixels.rgba.data()+i*4;
        if (variant == 6) { for (int c=0;c<4;++c) { noise=noise*1664525U+1013904223U; p[c]=noise>>24; } }
        else if (variant == 5) { p[0]=x; p[1]=y%251; p[2]=37; p[3]=x%2 ? 0 : 255; }
        else if (variant == 4) { p[0]=x%251; p[1]=y%251; p[2]=(x+y)%251; p[3]=(x/8+y/8)%3 ? 96+x%8*19 : 0; }
        else { p[0]=color; p[1]=color>>8; p[2]=color>>16; p[3]=color%255; }
      }
      auto texture = pmjs::makePreparedTexture(pixels, nullptr, variant == 6 ? pixels.rgba.size()*2 : 0, true);
      auto withoutPalettes = pmjs::makePreparedTexture(pixels);
      require(!withoutPalettes || withoutPalettes->layout.kind == pmjs::TextureKind::Channels);
      require(texture.has_value());
      auto unsupported = *texture; unsupported.layout.height = 16385;
      bool unsupportedRejected = false;
      try { pmjs::writeTextureArtifact(root / "unsupported.pmtx",unsupported); }
      catch(const std::invalid_argument&) { unsupportedRejected = true; }
      require(unsupportedRejected);
      require(int(texture->layout.kind) == std::min(variant+1,5));
      const auto file = root / "texture.pmtx";
      pmjs::writeTextureArtifact(file,*texture);
      std::ifstream in(file,std::ios::binary);
      std::vector<std::uint8_t> bytes((std::istreambuf_iterator<char>(in)),{});
      const pmjs::TextureReader read = [&](std::size_t at, std::span<std::uint8_t> out) {
        if (at > bytes.size() || out.size() > bytes.size()-at) return false;
        std::copy_n(bytes.begin()+at,out.size(),out.begin()); return true;
      };
      auto layout = pmjs::readTextureLayout(read,bytes.size()); require(layout.has_value());
      std::vector<std::vector<std::uint8_t>> decoded(texture->bytes.size());
      std::size_t peak = 0;
      require(pmjs::readTextureChunks(read,*layout,[&](auto i,const auto&,auto data) {
        decoded[i].insert(decoded[i].end(),data.begin(),data.end()); return true;
      },peak));
      require(decoded == texture->bytes && peak <= pmjs::textureChunkLimit);
      if (variant >= 4) {
        pmjs::ChannelBlockPage p; p.width=pixels.width; p.height=pixels.height;
        p.bytes=decoded[0]; p.blocks.resize(decoded[1].size()/16);
        for (std::size_t i=0;i<p.blocks.size();++i) for(int j=0;j<4;++j) {
          unsigned v=0;for(int k=0;k<4;++k)v|=unsigned(decoded[1][i*16+j*4+k])<<(8*k);
          p.blocks[i][j]=v;
        }
        require(p.pixels().rgba == pixels.rgba);
      } else {
        for (std::size_t i=0;i<pixels.rgba.size()/4;++i) {
          unsigned index=decoded[0][i];
          if(variant==1) index=unsigned(decoded[0][i*2])|(unsigned(decoded[0][i*2+1])<<8);
          if(variant>=2 && index==255) {
            const auto x=i%pixels.width,y=i/pixels.width, bit=(y%8)*8+x%8;
            const auto at=((y/8)*((pixels.width+7)/8)+x/8)*12;
            auto word=[&](auto n){unsigned v=0;for(int k=0;k<4;++k)v|=unsigned(decoded[2][at+n*4+k])<<(k*8);return v;};
            const auto rank=std::popcount(word(bit/32)&((1U<<(bit%32))-1))+(bit>=32?std::popcount(word(0)):0);
            const auto offset=(word(2)+rank)*(variant==3?3:2);
            index=decoded[3][offset]|unsigned(decoded[3][offset+1])<<8;
            if(variant==3)index|=unsigned(decoded[3][offset+2])<<16;
          }
          require(std::equal(pixels.rgba.begin()+i*4,pixels.rgba.begin()+i*4+4,decoded[1].begin()+index*4));
        }
      }
      auto corrupt=bytes; bytes.back()^=1;
      require(!pmjs::readTextureChunks(read,*layout,[](auto,const auto&,auto){return true;},peak));
      bytes=corrupt;
      require(!pmjs::readTextureChunks(read,*layout,[](auto,const auto&,auto){return false;},peak));
      require(!pmjs::readTextureLayout(read,bytes.size()-1));
      for (const auto field : {std::size_t(4),std::size_t(32+layout->planes.size()*16),std::size_t(32+layout->planes.size()*16+16)}) {
        bytes=corrupt; put(bytes,field,0xffffffff);
        require(!pmjs::readTextureLayout(read,bytes.size()));
      }
      bytes=corrupt;
      put(bytes,32+layout->planes.size()*16+8,0);
      require(!pmjs::readTextureLayout(read,bytes.size()));
    }
    bool refused = false;
    try { pmjs::writeLz4Page(root / "invalid", 2049, 1, {}); }
    catch (const std::runtime_error&) { refused = true; }
    require(refused);
    refused = false;
    try { pmjs::writeLz4Page(root / "missing" / "page", 1, 1, std::vector<std::uint8_t>(4)); }
    catch (const std::runtime_error&) { refused = true; }
    require(refused);
    std::filesystem::remove_all(root);
  } catch (const std::exception& error) {
    std::filesystem::remove_all(root); std::cerr << error.what() << '\n'; return 1;
  }
}
