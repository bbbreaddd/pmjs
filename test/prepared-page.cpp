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
extern "C" {
#include <libavutil/sha.h>
#include <libavutil/mem.h>
}

namespace {
void require(bool value, const std::source_location& location = std::source_location::current()) {
  if (!value) throw std::runtime_error("LZ4 page fixture failed at " + std::to_string(location.line()));
}
void put(std::vector<std::uint8_t>& bytes, std::size_t offset, std::uint32_t value) {
  for (int i = 0; i < 4; ++i) bytes[offset + i] = static_cast<std::uint8_t>(value >> (8 * i));
}
void headerChecksum(std::vector<std::uint8_t>& bytes) { put(bytes, 28, crc32(0, bytes.data(), 28)); }
std::array<std::uint8_t, 32> referenceDigest(std::span<const std::uint8_t> bytes) {
  auto* sha = av_sha_alloc();
  require(sha != nullptr);
  require(av_sha_init(sha, 256) == 0);
  av_sha_update(sha, bytes.data(), bytes.size());
  std::array<std::uint8_t, 32> digest{};
  av_sha_final(sha, digest.data());
  av_free(sha);
  return digest;
}
std::string hexDigest(const std::array<std::uint8_t, 32>& digest) {
  constexpr char digits[] = "0123456789abcdef";
  std::string result;
  for (auto byte : digest) { result += digits[byte >> 4]; result += digits[byte & 15]; }
  return result;
}
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
      require(!withoutPalettes || withoutPalettes->layout.kind == pmjs::TextureKind::FilteredTiles);
      if (variant >= 4) {
        if (!texture) continue;
        require(texture->layout.kind == pmjs::TextureKind::FilteredTiles);
      } else {
        require(texture.has_value());
        require(int(texture->layout.kind) == variant + 1);
      }
      auto unsupported = *texture; unsupported.layout.height = 16385;
      bool unsupportedRejected = false;
      try { pmjs::writeTextureArtifact(root / "unsupported.pmtx",unsupported); }
      catch(const std::invalid_argument&) { unsupportedRejected = true; }
      require(unsupportedRejected);
      const auto file = root / "texture.pmtx";
      pmjs::writeTextureArtifact(file,*texture);
      if (variant == 0 && std::filesystem::exists("/dev/full")) {
        bool writeFailed = false;
        try { pmjs::writeTextureArtifact("/dev/full", *texture); }
        catch (const std::runtime_error&) { writeFailed = true; }
        require(writeFailed);
      }
      std::ifstream in(file,std::ios::binary);
      std::vector<std::uint8_t> bytes((std::istreambuf_iterator<char>(in)),{});
      const pmjs::TextureReader read = [&](std::size_t at, std::span<std::uint8_t> out) {
        if (at > bytes.size() || out.size() > bytes.size()-at) return false;
        std::copy_n(bytes.begin()+at,out.size(),out.begin()); return true;
      };
      auto layout = pmjs::readTextureLayout(read,bytes.size()); require(layout.has_value());
      for (std::size_t i = 0; i < layout->planes.size(); ++i) {
        const auto& plane = layout->planes[i];
        const auto stride = plane.width * pmjs::textureTexelBytes(plane.format);
        for (const auto& chunk : plane.chunks) {
          const auto raw = std::span(texture->bytes[i]).subspan(chunk.y * stride, chunk.decoded);
          require(chunk.hash == referenceDigest(raw));
        }
      }
      std::vector<std::vector<std::uint8_t>> decoded(texture->bytes.size());
      std::size_t peak = 0;
      require(pmjs::readTextureChunks(read,*layout,[&](auto i,const auto&,auto data) {
        decoded[i].insert(decoded[i].end(),data.begin(),data.end()); return true;
      },peak));
      require(decoded == texture->bytes && peak <= pmjs::textureChunkLimit);
      if (variant < 4) {
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
    // Fixed SHA-256 answers check padding boundaries independently of the native reader.
    for (const auto& [length, expected] : std::vector<std::pair<int, std::string>>{
      {1, "4a64a107f0cb32536e5bce6c98c393db21cca7f4ea187ba8c4dca8b51d4ea80a"},
      {3, "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad"},
      {55, "59aaae80b8e7958f5757b4ac9274f1fd57ec0dc7aa8349319102316781b92006"},
      {56, "dca902d31487ffab357ce36cc5abc6947fbb69127ec04c468ba5687268c4bf7c"},
      {63, "b8e655e9e7ad413b96f0a371eb1d6db71dcca27f4eee35892517cbe4bfaa6f9a"},
      {64, "e5146be62accc56709594cb45c651b361df94f622cbb09b91ea3ca7a2060bd53"},
      {65, "4b6c6774f0cbcd776a90e187b9494e04ca880c0afe3ea1c5cad51c8bbcb41f74"},
      {127, "b4f5398bf618d741f2ab0f6e2fcde06f4949c20d476b5f6e1d4bf8618bc8973a"},
      {128, "ed045c7c319e0c9286e1dea21c80bfd4a08eca43e02e13ee8a7a2c8b4b2baec9"},
      {129, "d6f2fca0407b3f98c9ce29ae92a6cdf489506450fdbb29172f6b18987bc685db"},
    }) {
      pmjs::PreparedTexture texture;
      texture.layout = {length, 1, pmjs::TextureKind::Dense8,
        {{static_cast<std::uint32_t>(length), 1, pmjs::TextureFormat::R8, {}},
         {256, 1, pmjs::TextureFormat::RGBA8, {}}}};
      texture.bytes = {std::vector<std::uint8_t>(length), std::vector<std::uint8_t>(1024)};
      for (int i = 0; i < length; ++i) texture.bytes[0][i] = (i * 131 + 17) & 255;
      if (length == 3) texture.bytes[0] = {'a', 'b', 'c'};
      const auto file = root / "known-digest.pmtx";
      pmjs::writeTextureArtifact(file, texture);
      std::ifstream input(file, std::ios::binary);
      const std::vector<std::uint8_t> encoded{std::istreambuf_iterator<char>(input), {}};
      const auto layout = pmjs::readTextureLayout([&](std::size_t offset, std::span<std::uint8_t> bytes) {
        if (offset > encoded.size() || bytes.size() > encoded.size() - offset) return false;
        std::copy_n(encoded.begin() + offset, bytes.size(), bytes.begin());
        return true;
      }, encoded.size());
      require(layout.has_value());
      require(hexDigest(layout->planes[0].chunks[0].hash) == expected);
    }
    bool refused = false;
    try { pmjs::writeLz4Page(root / "invalid", 2049, 1, {}); }
    catch (const std::runtime_error&) { refused = true; }
    require(refused);
    refused = false;
    try { pmjs::writeLz4Page(root / "missing" / "page", 1, 1, std::vector<std::uint8_t>(4)); }
    catch (const std::runtime_error&) { refused = true; }
    require(refused);
    if (std::filesystem::exists("/dev/full")) {
      refused = false;
      try { pmjs::writeLz4Page("/dev/full", 1, 1, std::vector<std::uint8_t>(4)); }
      catch (const std::runtime_error&) { refused = true; }
      require(refused);
    }
    std::filesystem::remove_all(root);
  } catch (const std::exception& error) {
    std::filesystem::remove_all(root); std::cerr << error.what() << '\n'; return 1;
  }
}
