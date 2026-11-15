#include "texture_artifact.hpp"
#include "prepared_page.hpp"
#include <algorithm>
#include <bit>
#include <cstring>
#include <fstream>
#include <stdexcept>
#include <unordered_map>
#include <lz4.h>
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
std::array<std::uint8_t, 32> digest(std::span<const std::uint8_t> bytes) {
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
  std::unordered_map<std::uint32_t, std::uint16_t> colors;
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
                                                  std::size_t retainedLimit) {
  const auto classified = known ? *known : classifyImageStorage(pixels);
  if (classified.paletteBits == 16) {
    if (auto page = makeSparsePalettePage(pixels.width, pixels.height, pixels.rgba)) return sparse(std::move(*page));
  }
  if (auto result = dense(pixels, classified); result && validLayout(result->layout)) return result;
  if (auto page = makeSparsePalettePage(pixels.width, pixels.height, pixels.rgba, 262144)) {
    if (page->indexBytes == 3 && page->gpuBytes()+page->colors.size()*3 < pixels.rgba.size()) return sparse(std::move(*page));
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
  std::ofstream file(path, std::ios::binary | std::ios::trunc);
  file.seekp(header.size());
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
      file.write(reinterpret_cast<const char*>(encoded.data()), size); offset += size; record += 64;
    }
  }
  file.seekp(0); file.write(reinterpret_cast<const char*>(header.data()), header.size()); file.close();
  if (!file) throw std::runtime_error("texture artifact write failed");
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
