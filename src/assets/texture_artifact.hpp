#pragma once
#include "image_storage.hpp"
#include <array>
#include <filesystem>
#include <functional>
#include <optional>
#include <span>

namespace pmjs {
constexpr std::size_t textureChunkLimit = 1024U * 1024U;
enum class TextureFormat : std::uint32_t { R8 = 1, RG8, RGBA8, RGB32UI, RGBA32UI, R32UI };
enum class TextureKind : std::uint32_t { Dense8 = 1, Dense16, Sparse16, Sparse24, Channels, FilteredTiles };
struct TextureChunk {
  std::uint32_t y = 0, rows = 0, offset = 0, encoded = 0, decoded = 0;
  std::array<std::uint8_t, 32> hash{};
};
struct TexturePlane {
  std::uint32_t width = 0, height = 0;
  TextureFormat format = TextureFormat::R8;
  std::vector<TextureChunk> chunks;
};
struct TextureLayout {
  int width = 0, height = 0;
  TextureKind kind = TextureKind::Dense8;
  std::vector<TexturePlane> planes;
};
struct PreparedTexture {
  TextureLayout layout;
  std::vector<std::vector<std::uint8_t>> bytes;
};
using TextureReader = std::function<bool(std::size_t, std::span<std::uint8_t>)>;
using TextureUpload = std::function<bool(std::size_t, const TextureChunk&, std::span<const std::uint8_t>)>;
std::optional<PreparedTexture> makePreparedTexture(const ImagePixels& pixels, const ImageStorageDecision* decision = nullptr,
                                                 std::size_t retainedLimit = 0, bool allowPalettes = false);
void writeTextureArtifact(const std::filesystem::path& path, const PreparedTexture& texture);
std::optional<TextureLayout> readTextureLayout(const TextureReader& read, std::size_t fileBytes);
bool readTextureChunks(const TextureReader& read, const TextureLayout& layout, const TextureUpload& upload,
                       std::size_t& peakDecoded);
std::size_t textureTexelBytes(TextureFormat format);
}
