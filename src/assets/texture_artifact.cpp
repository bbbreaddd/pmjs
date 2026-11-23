#include "texture_artifact.hpp"
#include "color_hash.hpp"
#include "prepared_page.hpp"
#include <algorithm>
#include <bit>
#include <cstring>
#include <cstdio>
#include <memory>
#include <stdexcept>
#include <unordered_map>
#include <lz4.h>
#if defined(__aarch64__) && defined(__linux__)
#include <arm_neon.h>
#include <asm/hwcap.h>
#include <sys/auxv.h>
#endif
extern "C" {
#include <libavutil/sha.h>
#include <libavutil/mem.h>
}
namespace pmjs {
namespace {
void put(std::span<std::uint8_t> out, std::size_t at, std::uint32_t v) {
  for (int i = 0; i < 4; ++i) out[at+i] = v >> (i*8);
}
std::uint32_t get(std::span<const std::uint8_t> in, std::size_t at) {
  std::uint32_t v = 0;
  for (int i = 0; i < 4; ++i) v |= std::uint32_t(in[at+i]) << (i*8);
  return v;
}
#if defined(__aarch64__) && defined(__linux__)
__attribute__((target("+sha2")))
void sha256BlockArm64(uint32x4_t& state0, uint32x4_t& state1, const std::uint8_t* block) {
  static constexpr std::uint32_t kRoundConstants[64] = {
    0x428a2f98U, 0x71374491U, 0xb5c0fbcfU, 0xe9b5dba5U,
    0x3956c25bU, 0x59f111f1U, 0x923f82a4U, 0xab1c5ed5U,
    0xd807aa98U, 0x12835b01U, 0x243185beU, 0x550c7dc3U,
    0x72be5d74U, 0x80deb1feU, 0x9bdc06a7U, 0xc19bf174U,
    0xe49b69c1U, 0xefbe4786U, 0x0fc19dc6U, 0x240ca1ccU,
    0x2de92c6fU, 0x4a7484aaU, 0x5cb0a9dcU, 0x76f988daU,
    0x983e5152U, 0xa831c66dU, 0xb00327c8U, 0xbf597fc7U,
    0xc6e00bf3U, 0xd5a79147U, 0x06ca6351U, 0x14292967U,
    0x27b70a85U, 0x2e1b2138U, 0x4d2c6dfcU, 0x53380d13U,
    0x650a7354U, 0x766a0abbU, 0x81c2c92eU, 0x92722c85U,
    0xa2bfe8a1U, 0xa81a664bU, 0xc24b8b70U, 0xc76c51a3U,
    0xd192e819U, 0xd6990624U, 0xf40e3585U, 0x106aa070U,
    0x19a4c116U, 0x1e376c08U, 0x2748774cU, 0x34b0bcb5U,
    0x391c0cb3U, 0x4ed8aa4aU, 0x5b9cca4fU, 0x682e6ff3U,
    0x748f82eeU, 0x78a5636fU, 0x84c87814U, 0x8cc70208U,
    0x90befffaU, 0xa4506cebU, 0xbef9a3f7U, 0xc67178f2U
  };
  auto loadWord = [](const std::uint8_t* ptr) {
    const auto raw = vld1q_u8(ptr);
    if constexpr (std::endian::native == std::endian::little) {
      return vreinterpretq_u32_u8(vrev32q_u8(raw));
    }
    return vreinterpretq_u32_u8(raw);
  };
  uint32x4_t w0 = loadWord(block);
  uint32x4_t w1 = loadWord(block + 16);
  uint32x4_t w2 = loadWord(block + 32);
  uint32x4_t w3 = loadWord(block + 48);
  uint32x4_t abef = state0;
  uint32x4_t cdgh = state1;
  for (int round = 0; round < 48; round += 16) {
    {
      const auto tmp = vaddq_u32(w0, vld1q_u32(kRoundConstants + round));
      const auto saved = abef;
      abef = vsha256hq_u32(abef, cdgh, tmp);
      cdgh = vsha256h2q_u32(cdgh, saved, tmp);
    }
    w0 = vsha256su1q_u32(vsha256su0q_u32(w0, w1), w2, w3);
    {
      const auto tmp = vaddq_u32(w1, vld1q_u32(kRoundConstants + round + 4));
      const auto saved = abef;
      abef = vsha256hq_u32(abef, cdgh, tmp);
      cdgh = vsha256h2q_u32(cdgh, saved, tmp);
    }
    w1 = vsha256su1q_u32(vsha256su0q_u32(w1, w2), w3, w0);
    {
      const auto tmp = vaddq_u32(w2, vld1q_u32(kRoundConstants + round + 8));
      const auto saved = abef;
      abef = vsha256hq_u32(abef, cdgh, tmp);
      cdgh = vsha256h2q_u32(cdgh, saved, tmp);
    }
    w2 = vsha256su1q_u32(vsha256su0q_u32(w2, w3), w0, w1);
    {
      const auto tmp = vaddq_u32(w3, vld1q_u32(kRoundConstants + round + 12));
      const auto saved = abef;
      abef = vsha256hq_u32(abef, cdgh, tmp);
      cdgh = vsha256h2q_u32(cdgh, saved, tmp);
    }
    w3 = vsha256su1q_u32(vsha256su0q_u32(w3, w0), w1, w2);
  }
  for (int i = 0; i < 4; ++i) {
    const auto msg = i == 0 ? w0 : i == 1 ? w1 : i == 2 ? w2 : w3;
    const auto tmp = vaddq_u32(msg, vld1q_u32(kRoundConstants + 48 + i * 4));
    const auto saved = abef;
    abef = vsha256hq_u32(abef, cdgh, tmp);
    cdgh = vsha256h2q_u32(cdgh, saved, tmp);
  }
  state0 = vaddq_u32(state0, abef);
  state1 = vaddq_u32(state1, cdgh);
}

__attribute__((target("+sha2")))
std::array<std::uint8_t, 32> sha256Arm64(std::span<const std::uint8_t> bytes) {
  static constexpr std::uint32_t kInitial[8] = {
    0x6a09e667U, 0xbb67ae85U, 0x3c6ef372U, 0xa54ff53aU,
    0x510e527fU, 0x9b05688cU, 0x1f83d9abU, 0x5be0cd19U
  };
  uint32x4_t state0 = vld1q_u32(kInitial);
  uint32x4_t state1 = vld1q_u32(kInitial + 4);
  const std::uint8_t* cursor = bytes.data();
  std::size_t remaining = bytes.size();
  while (remaining >= 64) {
    sha256BlockArm64(state0, state1, cursor);
    cursor += 64;
    remaining -= 64;
  }
  std::array<std::uint8_t, 128> tail{};
  if (remaining > 0) std::memcpy(tail.data(), cursor, remaining);
  tail[remaining] = 0x80;
  const std::size_t totalBlocks = remaining >= 56 ? 2 : 1;
  const std::uint64_t bitCount = static_cast<std::uint64_t>(bytes.size()) * 8ULL;
  for (int i = 0; i < 8; ++i) {
    tail[totalBlocks * 64 - 8 + i] = static_cast<std::uint8_t>(bitCount >> ((7 - i) * 8));
  }
  sha256BlockArm64(state0, state1, tail.data());
  if (totalBlocks == 2) sha256BlockArm64(state0, state1, tail.data() + 64);
  std::array<std::uint8_t, 32> hash{};
  auto storeWord = [](std::uint8_t* ptr, uint32x4_t val) {
    if constexpr (std::endian::native == std::endian::little) {
      vst1q_u8(ptr, vrev32q_u8(vreinterpretq_u8_u32(val)));
    } else {
      vst1q_u8(ptr, vreinterpretq_u8_u32(val));
    }
  };
  storeWord(hash.data(), state0);
  storeWord(hash.data() + 16, state1);
  return hash;
}

bool hasArm64Sha2() {
  static const bool supported = (::getauxval(AT_HWCAP) & HWCAP_SHA2) != 0;
  return supported;
}
#endif

std::array<std::uint8_t, 32> digest(std::span<const std::uint8_t> bytes) {
#if defined(__aarch64__) && defined(__linux__)
  if (hasArm64Sha2()) return sha256Arm64(bytes);
#endif
  auto* sha = av_sha_alloc();
  if (!sha) throw std::bad_alloc();
  std::array<std::uint8_t, 32> hash{};
  av_sha_init(sha, 256); av_sha_update(sha, bytes.data(), bytes.size()); av_sha_final(sha, hash.data()); av_free(sha);
  return hash;
}
void plane(PreparedTexture& out, int width, int height, TextureFormat format, std::vector<std::uint8_t> bytes) {
  bytes.resize(std::size_t(width)*height*textureTexelBytes(format));
  out.layout.planes.push_back({std::uint32_t(width), std::uint32_t(height), format, {}});
  out.bytes.push_back(std::move(bytes));
}
template<std::size_t N> std::vector<std::uint8_t> words(const std::vector<std::array<std::uint32_t, N>>& values) {
  std::vector<std::uint8_t> bytes(values.size()*N*4);
  for (std::size_t i = 0; i < values.size(); ++i)
    for (std::size_t j = 0; j < N; ++j) put(bytes, (i*N+j)*4, values[i][j]);
  return bytes;
}
std::optional<PreparedTexture> dense(const ImagePixels& pixels, const ImageStorageDecision& decision) {
  const auto count = pixels.rgba.size()/4;
  const int channels = decision.channels.channels;
  if (channels == 1 || !decision.paletteBits) return {};
  const auto limit = decision.paletteBits == 8 ? 256 : 65536;
  std::unordered_map<std::uint32_t, std::uint16_t, ColorHash> colors;
  colors.reserve(4096);
  std::vector<std::uint8_t> entries, indices(count*(decision.paletteBits/8));
  for (std::size_t i = 0; i < count; ++i) {
    const auto color = get(pixels.rgba, i*4);
    auto found = colors.find(color);
    if (found == colors.end()) {
      if (colors.size() == std::size_t(limit)) return {};
      found = colors.emplace(color, colors.size()).first;
      entries.insert(entries.end(), pixels.rgba.begin()+i*4, pixels.rgba.begin()+i*4+4);
    }
    indices[i*(decision.paletteBits/8)] = found->second;
    if (decision.paletteBits == 16) indices[i*2+1] = found->second >> 8;
  }
  if (count*(channels-decision.paletteBits/8) <= ((colors.size()+255)/256)*1024) return {};
  PreparedTexture out; out.layout = {pixels.width, pixels.height,
    decision.paletteBits == 8 ? TextureKind::Dense8 : TextureKind::Dense16, {}};
  plane(out, pixels.width, pixels.height, decision.paletteBits == 8 ? TextureFormat::R8 : TextureFormat::RG8, std::move(indices));
  plane(out, 256, (colors.size()+255)/256, TextureFormat::RGBA8, std::move(entries));
  return out;
}
PreparedTexture sparse(SparsePalettePage page) {
  PreparedTexture out; out.layout = {page.width, page.height,
    page.indexBytes == 3 ? TextureKind::Sparse24 : TextureKind::Sparse16, {}};
  plane(out, page.width, page.height, TextureFormat::R8, std::move(page.base));
  const int height = (page.colors.size()/4+255)/256;
  plane(out, 256, height, TextureFormat::RGBA8, std::move(page.colors));
  plane(out, (page.width+7)/8, (page.height+7)/8, TextureFormat::RGB32UI, words(page.blocks));
  const auto count = page.residual.size()/(page.indexBytes == 3 ? 1 : 2);
  const int width = std::min<std::size_t>(page.indexBytes == 3 ? 2048 : 1024, count);
  plane(out, width, (count+width-1)/width, page.indexBytes == 3 ? TextureFormat::R8 : TextureFormat::RG8, std::move(page.residual));
  return out;
}
bool validLayout(const TextureLayout& l) {
  if (l.width <= 0 || l.height <= 0 || l.width > 16384 || l.height > 16384) return false;
  const auto kind = l.kind;
  if (kind < TextureKind::Dense8 || kind > TextureKind::Channels) return false;
  const bool sp = kind == TextureKind::Sparse16 || kind == TextureKind::Sparse24;
  if (l.planes.size() != (sp ? 4U : 2U)) return false;
  for (const auto& p : l.planes)
    if (!p.width || !p.height || p.width > 8192 || p.height > 8192 || !textureTexelBytes(p.format)) return false;
  const auto& a = l.planes[0]; const auto& b = l.planes[1];
  if (kind == TextureKind::Channels)
    return a.width == 2048 && a.format == TextureFormat::RGBA8 && b.width == std::uint32_t((l.width+7)/8) &&
      b.height == std::uint32_t((l.height+7)/8) && b.format == TextureFormat::RGBA32UI;
  if (a.width != std::uint32_t(l.width) || a.height != std::uint32_t(l.height) ||
      a.format != (kind == TextureKind::Dense16 ? TextureFormat::RG8 : TextureFormat::R8) ||
      b.width != 256 || b.height > (kind == TextureKind::Sparse24 ? 1024U : kind == TextureKind::Dense8 ? 1U : 256U) ||
      b.format != TextureFormat::RGBA8) return false;
  if (!sp) return true;
  const auto& c = l.planes[2]; const auto& d = l.planes[3];
  return c.width == std::uint32_t((l.width+7)/8) && c.height == std::uint32_t((l.height+7)/8) &&
    c.format == TextureFormat::RGB32UI && d.width <= (kind == TextureKind::Sparse24 ? 2048U : 1024U) &&
    d.format == (kind == TextureKind::Sparse24 ? TextureFormat::R8 : TextureFormat::RG8);
}
}
std::size_t textureTexelBytes(TextureFormat f) {
  switch(f) { case TextureFormat::R8:return 1; case TextureFormat::RG8:return 2; case TextureFormat::RGBA8:return 4;
    case TextureFormat::RGB32UI:return 12; case TextureFormat::RGBA32UI:return 16; }
  return 0;
}
std::optional<PreparedTexture> makePreparedTexture(const ImagePixels& pixels, const ImageStorageDecision* known,
                                                  std::size_t retainedLimit, bool allowPalettes) {
  const auto classified = known ? *known : classifyImageStorage(pixels);
  if (allowPalettes) {
    if (classified.paletteBits == 16) {
      if (auto page = makeSparsePalettePage(pixels.width, pixels.height, pixels.rgba)) return sparse(std::move(*page));
    }
    if (auto result = dense(pixels, classified); result && validLayout(result->layout)) return result;
    if (auto page = makeSparsePalettePage(pixels.width, pixels.height, pixels.rgba, 262144)) {
      if (page->indexBytes == 3 && page->gpuBytes()+page->colors.size()*3 < pixels.rgba.size()) return sparse(std::move(*page));
    }
  }
  auto channel = makeChannelBlockPage(pixels.width, pixels.height, pixels.rgba, retainedLimit);
  if (!channel) return {};
  PreparedTexture out; out.layout = {pixels.width, pixels.height, TextureKind::Channels, {}};
  const int height = (channel->bytes.size()+8191)/8192;
  plane(out, 2048, height, TextureFormat::RGBA8, std::move(channel->bytes));
  plane(out, (pixels.width+7)/8, (pixels.height+7)/8, TextureFormat::RGBA32UI, words(channel->blocks));
  return out;
}
void writeTextureArtifact(const std::filesystem::path& path, const PreparedTexture& texture) {
  auto l = texture.layout;
  if (!validLayout(l) || texture.bytes.size() != l.planes.size()) throw std::invalid_argument("invalid texture artifact");
  std::size_t chunks = 0;
  for (auto& p : l.planes) chunks += (p.height+(textureChunkLimit/(p.width*textureTexelBytes(p.format)))-1)/(textureChunkLimit/(p.width*textureTexelBytes(p.format)));
  std::vector<std::uint8_t> header(32+l.planes.size()*16+chunks*64);
  std::memcpy(header.data(), "PMTX", 4); put(header, 4, 1); put(header, 8, std::uint32_t(l.kind));
  put(header, 12, l.width); put(header, 16, l.height); put(header, 20, l.planes.size()); put(header, 24, chunks);
  std::unique_ptr<FILE, int(*)(FILE*)> file(std::fopen(path.c_str(), "wb"), &std::fclose);
  if (!file || std::fseek(file.get(), static_cast<long>(header.size()), SEEK_SET) != 0)
    throw std::runtime_error("texture artifact write failed");
  std::size_t record = 32+l.planes.size()*16, offset = header.size();
  for (std::size_t i = 0; i < l.planes.size(); ++i) {
    const auto& p = l.planes[i]; const auto stride = p.width*textureTexelBytes(p.format);
    if (texture.bytes[i].size() != stride*p.height) throw std::invalid_argument("invalid texture plane");
    put(header, 32+i*16, p.width); put(header, 36+i*16, p.height); put(header, 40+i*16, std::uint32_t(p.format));
    const auto rows = textureChunkLimit/stride; put(header, 44+i*16, (p.height+rows-1)/rows);
    for (std::size_t y = 0; y < p.height; y += rows) {
      const auto n = std::min<std::size_t>(rows, p.height-y);
      const auto raw = std::span(texture.bytes[i]).subspan(y*stride, n*stride);
      std::vector<std::uint8_t> encoded(LZ4_compressBound(raw.size()));
      const int size = LZ4_compress_default(reinterpret_cast<const char*>(raw.data()), reinterpret_cast<char*>(encoded.data()), raw.size(), encoded.size());
      if (!size) throw std::runtime_error("texture compression failed");
      put(header, record, y); put(header, record+4, n); put(header, record+8, offset);
      put(header, record+12, size); put(header, record+16, raw.size());
      const auto hash = digest(raw); std::copy(hash.begin(), hash.end(), header.begin()+record+20);
      if (std::fwrite(encoded.data(), 1, size, file.get()) != static_cast<std::size_t>(size))
        throw std::runtime_error("texture artifact write failed");
      offset += size; record += 64;
    }
  }
  if (std::fseek(file.get(), 0, SEEK_SET) != 0 ||
      std::fwrite(header.data(), 1, header.size(), file.get()) != header.size())
    throw std::runtime_error("texture artifact write failed");
  if (std::fclose(file.release()) != 0) throw std::runtime_error("texture artifact write failed");
}
std::optional<TextureLayout> readTextureLayout(const TextureReader& read, std::size_t fileBytes) {
  std::array<std::uint8_t, 32> h{};
  if (fileBytes < h.size() || fileBytes > 256U*1024U*1024U || !read(0,h) || std::memcmp(h.data(),"PMTX",4) || get(h,4)!=1) return {};
  const auto planes = get(h,20), chunks = get(h,24);
  if (planes < 2 || planes > 4 || !chunks || chunks > 4096) return {};
  std::vector<std::uint8_t> meta(planes*16+chunks*64);
  if (32+meta.size() > fileBytes || !read(32,meta)) return {};
  TextureLayout l{int(get(h,12)), int(get(h,16)), TextureKind(get(h,8)), {}};
  std::size_t records = 0, at = planes*16, offset = 32+meta.size();
  for (std::size_t i = 0; i < planes; ++i) {
    TexturePlane p{get(meta,i*16), get(meta,i*16+4), TextureFormat(get(meta,i*16+8)), {}};
    const auto count = get(meta,i*16+12); std::size_t y = 0;
    const auto stride = std::uint64_t(p.width)*textureTexelBytes(p.format);
    if (!stride || stride > textureChunkLimit || !p.height || count > chunks-records) return {};
    for (std::size_t j = 0; j < count; ++j, at += 64) {
      TextureChunk c{get(meta,at),get(meta,at+4),get(meta,at+8),get(meta,at+12),get(meta,at+16),{}};
      std::copy_n(meta.begin()+at+20, 32, c.hash.begin());
      if (c.y != y || !c.rows || c.rows > p.height-y || c.decoded != c.rows*stride || c.decoded > textureChunkLimit ||
          !c.encoded || c.encoded > std::uint32_t(LZ4_compressBound(c.decoded)) || c.offset != offset ||
          c.encoded > fileBytes-offset) return {};
      y += c.rows; offset += c.encoded; p.chunks.push_back(c);
    }
    if (y != p.height) return {};
    records += count; l.planes.push_back(std::move(p));
  }
  if (records != chunks || offset != fileBytes || !validLayout(l)) return {};
  return l;
}
bool readTextureChunks(const TextureReader& read, const TextureLayout& layout, const TextureUpload& upload,
                       std::size_t& peakDecoded) {
  for (std::size_t i = 0; i < layout.planes.size(); ++i) for (const auto& c : layout.planes[i].chunks) {
    std::vector<std::uint8_t> encoded(c.encoded), decoded(c.decoded);
    peakDecoded = std::max(peakDecoded, decoded.size());
    if (!read(c.offset,encoded) || LZ4_decompress_safe(reinterpret_cast<const char*>(encoded.data()),
        reinterpret_cast<char*>(decoded.data()), encoded.size(), decoded.size()) != int(decoded.size()) ||
        digest(decoded) != c.hash) return false;
    if constexpr (std::endian::native == std::endian::big) {
      if (textureTexelBytes(layout.planes[i].format) >= 12)
        for (std::size_t j = 0; j < decoded.size(); j += 4) std::reverse(decoded.begin()+j,decoded.begin()+j+4);
    }
    if (!upload(i,c,decoded)) return false;
  }
  return true;
}
}
