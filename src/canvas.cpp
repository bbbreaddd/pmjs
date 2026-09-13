#include "canvas.hpp"
#include "checked_bounds.hpp"

#include <ft2build.h>
#include FT_FREETYPE_H
#include <png.h>

#include <algorithm>
#include <cmath>
#include <cstring>
#include <list>
#include <unordered_map>
#include <utility>

namespace pmjs {
namespace {
constexpr std::uint32_t indexMask = 0xffffU;
constexpr std::uint16_t generationMask = 0x7fffU;

std::vector<std::uint32_t> decodeUtf8(const std::string& text) {
  std::vector<std::uint32_t> result;
  for (std::size_t offset = 0; offset < text.size();) {
    const auto first = static_cast<std::uint8_t>(text[offset++]);
    std::uint32_t codepoint = 0xfffdU;
    std::size_t continuationCount = 0;
    if (first < 0x80U) {
      codepoint = first;
    } else if ((first & 0xe0U) == 0xc0U) {
      codepoint = first & 0x1fU;
      continuationCount = 1;
    } else if ((first & 0xf0U) == 0xe0U) {
      codepoint = first & 0x0fU;
      continuationCount = 2;
    } else if ((first & 0xf8U) == 0xf0U) {
      codepoint = first & 0x07U;
      continuationCount = 3;
    }
    if (continuationCount > 0) {
      if (offset + continuationCount > text.size()) {
        offset = text.size();
        codepoint = 0xfffdU;
      } else {
        bool valid = true;
        for (std::size_t index = 0; index < continuationCount; ++index) {
          const auto byte = static_cast<std::uint8_t>(text[offset++]);
          if ((byte & 0xc0U) != 0x80U) valid = false;
          codepoint = (codepoint << 6U) | (byte & 0x3fU);
        }
        if (!valid) codepoint = 0xfffdU;
      }
    }
    result.push_back(codepoint);
  }
  return result;
}
}

struct GlyphKey {
  std::string fontKey;
  char32_t codepoint = 0;
  int strokeWidth = 0;

  bool operator==(const GlyphKey& o) const noexcept {
    return codepoint == o.codepoint &&
           strokeWidth == o.strokeWidth &&
           fontKey == o.fontKey;
  }
};

struct GlyphKeyHash {
  std::size_t operator()(const GlyphKey& k) const noexcept {
    std::size_t h1 = std::hash<std::string>{}(k.fontKey);
    std::size_t h2 = std::hash<std::uint32_t>{}(static_cast<std::uint32_t>(k.codepoint));
    std::size_t h3 = std::hash<int>{}(k.strokeWidth);
    return h1 ^ (h2 << 1) ^ (h3 << 2);
  }
};

struct CachedGlyph {
  int bitmapLeft = 0;
  int bitmapTop = 0;
  int advanceX = 0;
  int width = 0;
  int height = 0;
  int bearingX = 0;
  int bearingY = 0;
  int metricWidth = 0;
  int metricHeight = 0;
  std::vector<std::uint8_t> coverage;
};

struct CanvasStore::FontState {
  static constexpr std::size_t kMaxCachedGlyphs = 2048;

  FT_Library library = nullptr;
  std::unordered_map<std::string, FT_Face> faces;
  std::list<GlyphKey> lruOrder;
  std::unordered_map<GlyphKey, std::pair<CachedGlyph, std::list<GlyphKey>::iterator>, GlyphKeyHash> glyphCache;

  FontState() { FT_Init_FreeType(&library); }
  ~FontState() {
    glyphCache.clear();
    lruOrder.clear();
    for (auto& [key, face] : faces) {
      (void)key;
      FT_Done_Face(face);
    }
    if (library) FT_Done_FreeType(library);
  }

  FT_Face face(const std::filesystem::path& path, int pixelSize) {
    if (!library || pixelSize <= 0 || pixelSize > 256) return nullptr;
    const std::string key = path.string() + '\n' + std::to_string(pixelSize);
    if (const auto found = faces.find(key); found != faces.end()) return found->second;
    FT_Face created = nullptr;
    if (FT_New_Face(library, path.c_str(), 0, &created) != 0) return nullptr;
    if (FT_Set_Pixel_Sizes(created, 0, static_cast<FT_UInt>(pixelSize)) != 0) {
      FT_Done_Face(created);
      return nullptr;
    }
    faces.emplace(key, created);
    return created;
  }

  const CachedGlyph* getOrLoadGlyph(const std::filesystem::path& path,
                                    int pixelSize,
                                    char32_t codepoint,
                                    int strokeWidth) {
    if (pixelSize <= 0 || pixelSize > 256 || strokeWidth < 0 || strokeWidth > 32) return nullptr;
    const std::string fontKey = path.string() + '\n' + std::to_string(pixelSize);
    GlyphKey key{fontKey, codepoint, strokeWidth};

    auto it = glyphCache.find(key);
    if (it != glyphCache.end()) {
      lruOrder.splice(lruOrder.begin(), lruOrder, it->second.second);
      return &it->second.first;
    }

    FT_Face f = face(path, pixelSize);
    if (!f) return nullptr;
    if (FT_Load_Char(f, codepoint, FT_LOAD_RENDER) != 0) return nullptr;

    const FT_GlyphSlot slot = f->glyph;
    CachedGlyph cached;
    cached.advanceX = static_cast<int>(slot->advance.x >> 6);
    cached.bearingX = static_cast<int>(slot->metrics.horiBearingX >> 6);
    cached.bearingY = static_cast<int>(slot->metrics.horiBearingY >> 6);
    cached.metricWidth = static_cast<int>(slot->metrics.width >> 6);
    cached.metricHeight = static_cast<int>(slot->metrics.height >> 6);

    const int radius = (strokeWidth + 1) / 2;
    if (slot->bitmap.width > 0 && slot->bitmap.rows > 0) {
      if (radius == 0) {
        cached.width = slot->bitmap.width;
        cached.height = slot->bitmap.rows;
        cached.bitmapLeft = slot->bitmap_left;
        cached.bitmapTop = slot->bitmap_top;
        cached.coverage.resize(static_cast<std::size_t>(cached.width) * cached.height);
        for (unsigned int r = 0; r < slot->bitmap.rows; ++r) {
          const auto* srcRow = slot->bitmap.buffer + r * slot->bitmap.pitch;
          auto* dstRow = cached.coverage.data() + static_cast<std::size_t>(r) * cached.width;
          std::memcpy(dstRow, srcRow, slot->bitmap.width);
        }
      } else {
        cached.width = static_cast<int>(slot->bitmap.width) + 2 * radius;
        cached.height = static_cast<int>(slot->bitmap.rows) + 2 * radius;
        cached.bitmapLeft = slot->bitmap_left - radius;
        cached.bitmapTop = slot->bitmap_top + radius;
        cached.coverage.assign(static_cast<std::size_t>(cached.width) * cached.height, 0);

        for (unsigned int r = 0; r < slot->bitmap.rows; ++r) {
          for (unsigned int c = 0; c < slot->bitmap.width; ++c) {
            const auto cov = slot->bitmap.buffer[r * slot->bitmap.pitch + c];
            if (cov == 0) continue;
            for (int dy = -radius; dy <= radius; ++dy) {
              for (int dx = -radius; dx <= radius; ++dx) {
                if (dx * dx + dy * dy > radius * radius) continue;
                const int outR = static_cast<int>(r) + radius + dy;
                const int outC = static_cast<int>(c) + radius + dx;
                const std::size_t outIdx = static_cast<std::size_t>(outR) * cached.width + outC;
                const std::uint32_t cur = cached.coverage[outIdx];
                const std::uint32_t add = static_cast<std::uint32_t>(cov);
                cached.coverage[outIdx] = static_cast<std::uint8_t>(cur + add * (255U - cur) / 255U);
              }
            }
          }
        }
      }
    }

    if (glyphCache.size() >= kMaxCachedGlyphs && !lruOrder.empty()) {
      const auto& oldestKey = lruOrder.back();
      glyphCache.erase(oldestKey);
      lruOrder.pop_back();
    }

    lruOrder.push_front(key);
    auto [insIt, _] = glyphCache.emplace(std::move(key), std::make_pair(std::move(cached), lruOrder.begin()));
    return &insIt->second.first;
  }
};

CanvasStore::CanvasStore(ImageStore& images)
    : images_(images), fonts_(std::make_unique<FontState>()) {}

CanvasStore::~CanvasStore() = default;

void CanvasStore::releaseCommandDependencies(CanvasCommand& cmd) {
  std::visit([this](auto& c) {
    using T = std::decay_t<decltype(c)>;
    if constexpr (std::is_same_v<T, DrawImageCmd>) {
      if (c.source != 0) {
        images_.release(c.source);
        c.source = 0;
      }
    }
  }, cmd);
}

void CanvasStore::discardCommands(Surface& surface) {
  for (auto& cmd : surface.commands) {
    releaseCommandDependencies(cmd);
  }
  surface.commands.clear();
  surface.queuedCommandBytes = 0;
}

void CanvasStore::fillRectNow(Surface& surface, int x, int y, int width, int height,
                              std::uint32_t rgba) {
  const int x0 = std::clamp(x, 0, surface.width);
  const int y0 = std::clamp(y, 0, surface.height);
  const int x1 = static_cast<int>(std::clamp<std::int64_t>(
    static_cast<std::int64_t>(x) + width, 0, surface.width));
  const int y1 = static_cast<int>(std::clamp<std::int64_t>(
    static_cast<std::int64_t>(y) + height, 0, surface.height));
  for (int py = y0; py < y1; ++py) {
    for (int px = x0; px < x1; ++px) {
      blendPixel(surface, px, py, rgba, 255);
    }
  }
  markDirty(surface, x0, y0, x1 - x0, y1 - y0);
}

void CanvasStore::clearNow(Surface& surface) {
  std::fill(surface.pixels.begin(), surface.pixels.end(), 0);
  markDirty(surface, 0, 0, surface.width, surface.height);
}

void CanvasStore::clearRectNow(Surface& surface, int x, int y, int width, int height) {
  const int x0 = std::clamp(x, 0, surface.width);
  const int y0 = std::clamp(y, 0, surface.height);
  const int x1 = static_cast<int>(std::clamp<std::int64_t>(
    static_cast<std::int64_t>(x) + width, 0, surface.width));
  const int y1 = static_cast<int>(std::clamp<std::int64_t>(
    static_cast<std::int64_t>(y) + height, 0, surface.height));
  for (int py = y0; py < y1; ++py) {
    for (int px = x0; px < x1; ++px) {
      const std::size_t offset =
        (static_cast<std::size_t>(py) * surface.width + px) * 4U;
      std::fill_n(surface.pixels.data() + offset, 4, 0);
    }
  }
  markDirty(surface, x0, y0, x1 - x0, y1 - y0);
}

bool CanvasStore::drawImageNow(Surface& destinationSurface, std::uint32_t source,
                               int sourceX, int sourceY,
                               int sourceWidth, int sourceHeight,
                               int destinationX, int destinationY,
                               int destinationWidth, int destinationHeight,
                               float alpha) {
  struct PixelView {
    int width;
    int height;
    const std::uint8_t* rgba;
  } sourcePixels{};
  std::vector<std::uint8_t> sourceSnapshot;
  if (auto* sourceSurface = lookup(source)) {
    if (sourceSurface->state == SurfaceState::Deferred) {
      realizeSurface(*sourceSurface);
    }
    if (sourceSurface == &destinationSurface) {
      sourceSnapshot = sourceSurface->pixels;
      sourcePixels = {sourceSurface->width, sourceSurface->height,
                      sourceSnapshot.data()};
    } else {
      sourcePixels = {sourceSurface->width, sourceSurface->height,
                      sourceSurface->pixels.data()};
    }
  } else {
    const auto* decoded = images_.readPixels(source);
    if (!decoded) return false;
    sourcePixels = {decoded->width, decoded->height, decoded->rgba.data()};
  }
  if (sourceX >= sourcePixels.width || sourceY >= sourcePixels.height) return true;

  const auto coverage = static_cast<std::uint8_t>(std::clamp(
      static_cast<int>(alpha * 255.0F + 0.5F), 0, 255));
  for (int y = 0; y < destinationHeight; ++y) {
    const int targetY = destinationY + y;
    if (targetY < 0 || targetY >= destinationSurface.height) continue;
    const int sampleY = sourceY + y * sourceHeight / destinationHeight;
    if (sampleY < 0 || sampleY >= sourcePixels.height) continue;
    for (int x = 0; x < destinationWidth; ++x) {
      const int targetX = destinationX + x;
      if (targetX < 0 || targetX >= destinationSurface.width) continue;
      const int sampleX = sourceX + x * sourceWidth / destinationWidth;
      if (sampleX < 0 || sampleX >= sourcePixels.width) continue;
      const std::size_t offset =
        (static_cast<std::size_t>(sampleY) * sourcePixels.width + sampleX) * 4U;
      const std::uint32_t rgba =
        (static_cast<std::uint32_t>(sourcePixels.rgba[offset]) << 24U) |
        (static_cast<std::uint32_t>(sourcePixels.rgba[offset + 1]) << 16U) |
        (static_cast<std::uint32_t>(sourcePixels.rgba[offset + 2]) << 8U) |
        sourcePixels.rgba[offset + 3];
      blendPixel(destinationSurface, targetX, targetY, rgba, coverage);
    }
  }
  markDirty(destinationSurface, destinationX, destinationY,
            destinationWidth, destinationHeight);
  return true;
}

bool CanvasStore::drawTextNow(Surface& surface, const std::filesystem::path& fontPath,
                              const std::string& text, int x, int y, int pixelSize,
                              std::uint32_t rgba, int strokeWidth) {
  int penX = x;
  const int baseline = y;
  for (const auto codepoint : decodeUtf8(text)) {
    const auto* glyph = fonts_->getOrLoadGlyph(fontPath, pixelSize, codepoint, strokeWidth);
    if (!glyph) continue;

    if (glyph->width > 0 && glyph->height > 0 && !glyph->coverage.empty()) {
      const int originX = penX + glyph->bitmapLeft;
      const int originY = baseline - glyph->bitmapTop;
      for (int row = 0; row < glyph->height; ++row) {
        const int destY = originY + row;
        if (destY < 0 || destY >= surface.height) continue;
        const std::size_t rowOffset = static_cast<std::size_t>(row) * glyph->width;
        for (int col = 0; col < glyph->width; ++col) {
          const auto cov = glyph->coverage[rowOffset + col];
          if (cov == 0) continue;
          blendPixel(surface, originX + col, destY, rgba, cov);
        }
      }
    }
    penX += glyph->advanceX;
  }
  const int radius = (strokeWidth + 1) / 2;
  markDirty(surface, x - radius, y - pixelSize - radius,
            penX - x + radius * 2, pixelSize * 2 + radius * 2);
  return true;
}

bool CanvasStore::blurNow(Surface& surface) {
  const int width = surface.width;
  const int height = surface.height;
  std::vector<std::uint8_t> scratch(surface.pixels.size());
  constexpr int weights[5] = {1, 4, 6, 4, 1};
  for (int pass = 0; pass < 2; ++pass) {
    const auto& source = pass == 0 ? surface.pixels : scratch;
    auto& destination = pass == 0 ? scratch : surface.pixels;
    for (int y = 0; y < height; ++y) {
      for (int x = 0; x < width; ++x) {
        for (int channel = 0; channel < 4; ++channel) {
          int sum = 0;
          for (int offset = -2; offset <= 2; ++offset) {
            const int sampleX = pass == 0 ? std::clamp(x + offset, 0, width - 1) : x;
            const int sampleY = pass == 0 ? y : std::clamp(y + offset, 0, height - 1);
            const std::size_t index =
              (static_cast<std::size_t>(sampleY) * width + sampleX) * 4U + channel;
            sum += source[index] * weights[offset + 2];
          }
          destination[(static_cast<std::size_t>(y) * width + x) * 4U + channel] =
            static_cast<std::uint8_t>((sum + 8) / 16);
        }
      }
    }
  }
  markDirty(surface, 0, 0, width, height);
  return true;
}

bool CanvasStore::realizeSurface(Surface& surface) {
  if (surface.state == SurfaceState::Realized) return true;
  if (surface.state == SurfaceState::Realizing) return false;
  surface.state = SurfaceState::Realizing;

  const std::size_t expected = static_cast<std::size_t>(surface.width) *
                               static_cast<std::size_t>(surface.height) * 4U;
  surface.pixels.assign(expected, 0);

  auto pendingCommands = std::move(surface.commands);
  surface.commands.clear();
  surface.queuedCommandBytes = 0;

  for (auto& cmd : pendingCommands) {
    std::visit([this, &surface](auto& c) {
      using T = std::decay_t<decltype(c)>;
      if constexpr (std::is_same_v<T, FillRectCmd>) {
        fillRectNow(surface, c.x, c.y, c.width, c.height, c.rgba);
      } else if constexpr (std::is_same_v<T, ClearRectCmd>) {
        clearRectNow(surface, c.x, c.y, c.width, c.height);
      } else if constexpr (std::is_same_v<T, DrawImageCmd>) {
        drawImageNow(surface, c.source, c.sourceX, c.sourceY,
                     c.sourceWidth, c.sourceHeight,
                     c.destinationX, c.destinationY,
                     c.destinationWidth, c.destinationHeight, c.alpha);
        images_.release(c.source);
      } else if constexpr (std::is_same_v<T, DrawTextCmd>) {
        drawTextNow(surface, c.fontPath, c.text, c.x, c.y,
                    c.pixelSize, c.rgba, c.strokeWidth);
      } else if constexpr (std::is_same_v<T, BlurCmd>) {
        blurNow(surface);
      }
    }, cmd);
  }

  const auto image = images_.createRgba(surface.width, surface.height,
                                        surface.pixels.data());
  if (!image) {
    std::vector<std::uint8_t>().swap(surface.pixels);
    surface.state = SurfaceState::Deferred;
    return false;
  }
  surface.image = image->handle;
  surface.state = SurfaceState::Realized;
  surface.dirtyX0 = surface.dirtyY0 = 0;
  surface.dirtyX1 = surface.dirtyY1 = 0;

  peakCpuBytes_ = std::max(peakCpuBytes_, cpuBytes());
  return true;
}

bool CanvasStore::realize(CanvasHandle handle) {
  auto* surface = lookup(handle);
  return surface && realizeSurface(*surface);
}

std::optional<ImageHandle> CanvasStore::prepareImage(CanvasHandle handle) {
  auto* surface = lookup(handle);
  if (!surface) return std::nullopt;
  if (surface->state == SurfaceState::Deferred) {
    if (!realizeSurface(*surface)) return std::nullopt;
  }
  return surface->image;
}

std::optional<std::vector<std::uint8_t>> CanvasStore::encodePng(
    CanvasHandle handle) {
  auto* surface = lookup(handle);
  if (!surface) return std::nullopt;
  if (surface->state == SurfaceState::Deferred && !realizeSurface(*surface)) {
    return std::nullopt;
  }
  png_image image{};
  image.version = PNG_IMAGE_VERSION;
  image.width = static_cast<png_uint_32>(surface->width);
  image.height = static_cast<png_uint_32>(surface->height);
  image.format = PNG_FORMAT_RGBA;
  png_alloc_size_t size = 0;
  if (!png_image_write_to_memory(&image, nullptr, &size, 0,
                                 surface->pixels.data(), 0, nullptr)) {
    png_image_free(&image);
    return std::nullopt;
  }
  std::vector<std::uint8_t> encoded(static_cast<std::size_t>(size));
  if (!png_image_write_to_memory(&image, encoded.data(), &size, 0,
                                 surface->pixels.data(), 0, nullptr)) {
    png_image_free(&image);
    return std::nullopt;
  }
  png_image_free(&image);
  encoded.resize(static_cast<std::size_t>(size));
  return encoded;
}

CanvasHandle CanvasStore::makeHandle(std::size_t index, std::uint16_t generation) {
  return canvasHandleTag |
         (static_cast<std::uint32_t>(generation & generationMask) << 16U) |
         static_cast<std::uint32_t>(index + 1U);
}

CanvasStore::Surface* CanvasStore::lookup(CanvasHandle handle) {
  return const_cast<Surface*>(std::as_const(*this).lookup(handle));
}

const CanvasStore::Surface* CanvasStore::lookup(CanvasHandle handle) const {
  if ((handle & canvasHandleTag) == 0) return nullptr;
  const std::uint32_t encodedIndex = handle & indexMask;
  if (encodedIndex == 0) return nullptr;
  const std::size_t index = encodedIndex - 1U;
  const auto generation = static_cast<std::uint16_t>((handle >> 16U) & generationMask);
  if (index >= surfaces_.size()) return nullptr;
  const auto& surface = surfaces_[index];
  return surface.live && surface.generation == generation ? &surface : nullptr;
}

std::optional<CanvasInfo> CanvasStore::create(int width, int height) {
  const auto extent = checkedImageExtent(width, height);
  if (!extent) return std::nullopt;
  std::size_t index = 0;
  while (index < surfaces_.size() && surfaces_[index].live) ++index;
  if (index >= indexMask) return std::nullopt;
  if (index == surfaces_.size()) surfaces_.emplace_back();
  auto& surface = surfaces_[index];
  surface.image = 0;
  surface.width = width;
  surface.height = height;
  surface.state = SurfaceState::Deferred;
  surface.pixels.clear();
  surface.commands.clear();
  surface.dirtyX0 = surface.dirtyY0 = 0;
  surface.dirtyX1 = surface.dirtyY1 = 0;
  surface.live = true;
  ++liveCount_;
  peakLiveCount_ = std::max(peakLiveCount_, liveCount_);
  return CanvasInfo{makeHandle(index, surface.generation), width, height};
}

std::optional<CanvasInfo> CanvasStore::createRgba(
    int width, int height, std::vector<std::uint8_t> pixels) {
  const auto extent = checkedImageExtent(width, height);
  if (!extent || pixels.size() != extent->rgbaBytes) return std::nullopt;
  const auto image = images_.createRgba(width, height, pixels.data());
  if (!image) return std::nullopt;
  std::size_t index = 0;
  while (index < surfaces_.size() && surfaces_[index].live) ++index;
  if (index >= indexMask) {
    images_.release(image->handle);
    return std::nullopt;
  }
  if (index == surfaces_.size()) surfaces_.emplace_back();
  auto& surface = surfaces_[index];
  surface.image = image->handle;
  surface.width = width;
  surface.height = height;
  surface.state = SurfaceState::Realized;
  surface.pixels = std::move(pixels);
  surface.commands.clear();
  surface.dirtyX0 = surface.dirtyY0 = 0;
  surface.dirtyX1 = surface.dirtyY1 = 0;
  surface.live = true;
  ++liveCount_;
  peakLiveCount_ = std::max(peakLiveCount_, liveCount_);
  peakCpuBytes_ = std::max(peakCpuBytes_, cpuBytes());
  return CanvasInfo{makeHandle(index, surface.generation), width, height};
}

bool CanvasStore::fillRect(CanvasHandle handle, int x, int y, int width, int height,
                           std::uint32_t rgba) {
  auto* surfacePointer = lookup(handle);
  if (!surfacePointer) return false;
  auto& surface = *surfacePointer;
  if (surface.state == SurfaceState::Deferred) {
    if (surface.commands.size() >= 256 || surface.queuedCommandBytes >= 64 * 1024) {
      if (!realizeSurface(surface)) return false;
    } else {
      surface.commands.emplace_back(FillRectCmd{x, y, width, height, rgba});
      surface.queuedCommandBytes += sizeof(FillRectCmd);
      return true;
    }
  }
  fillRectNow(surface, x, y, width, height, rgba);
  return true;
}

bool CanvasStore::clear(CanvasHandle handle) {
  auto* surface = lookup(handle);
  if (!surface) return false;
  if (surface->state == SurfaceState::Deferred) {
    discardCommands(*surface);
    return true;
  }
  clearNow(*surface);
  return true;
}

bool CanvasStore::clearRect(CanvasHandle handle, int x, int y, int width, int height) {
  auto* surface = lookup(handle);
  if (!surface) return false;
  if (surface->state == SurfaceState::Deferred) {
    if (x <= 0 && y <= 0 && width >= surface->width && height >= surface->height) {
      discardCommands(*surface);
      return true;
    }
    if (surface->commands.size() >= 256 || surface->queuedCommandBytes >= 64 * 1024) {
      if (!realizeSurface(*surface)) return false;
    } else {
      surface->commands.emplace_back(ClearRectCmd{x, y, width, height});
      surface->queuedCommandBytes += sizeof(ClearRectCmd);
      return true;
    }
  }
  clearRectNow(*surface, x, y, width, height);
  return true;
}

bool CanvasStore::drawImage(CanvasHandle destination, std::uint32_t source,
                            int sourceX, int sourceY,
                            int sourceWidth, int sourceHeight,
                            int destinationX, int destinationY,
                            int destinationWidth, int destinationHeight,
                            float alpha) {
  auto* destinationSurface = lookup(destination);
  if (!destinationSurface || sourceWidth <= 0 || sourceHeight <= 0 ||
      destinationWidth <= 0 || destinationHeight <= 0 || alpha < 0.0F ||
      alpha > 1.0F) return false;

  // Fallback rule: Canvas -> Canvas drawImage forces realization of destination
  // and executes immediately to guarantee draw-time snapshot semantics.
  if ((source & canvasHandleTag) != 0) {
    if (destinationSurface->state == SurfaceState::Deferred) {
      if (!realizeSurface(*destinationSurface)) return false;
    }
    return drawImageNow(*destinationSurface, source, sourceX, sourceY,
                        sourceWidth, sourceHeight, destinationX, destinationY,
                        destinationWidth, destinationHeight, alpha);
  }

  // Source is an ImageHandle: safe to defer if destination is deferred.
  if (destinationSurface->state == SurfaceState::Deferred) {
    if (destinationSurface->commands.size() >= 256 ||
        destinationSurface->queuedCommandBytes >= 64 * 1024) {
      if (!realizeSurface(*destinationSurface)) return false;
    } else {
      if (!images_.retain(source)) return false;
      destinationSurface->commands.emplace_back(DrawImageCmd{
        source, sourceX, sourceY, sourceWidth, sourceHeight,
        destinationX, destinationY, destinationWidth, destinationHeight, alpha
      });
      destinationSurface->queuedCommandBytes += sizeof(DrawImageCmd);
      return true;
    }
  }

  return drawImageNow(*destinationSurface, source, sourceX, sourceY,
                      sourceWidth, sourceHeight, destinationX, destinationY,
                      destinationWidth, destinationHeight, alpha);
}

void CanvasStore::markDirty(Surface& surface, int x, int y, int width,
                            int height) {
  const int x0 = std::clamp(x, 0, surface.width);
  const int y0 = std::clamp(y, 0, surface.height);
  const int x1 = static_cast<int>(std::clamp<std::int64_t>(
    static_cast<std::int64_t>(x) + width, 0, surface.width));
  const int y1 = static_cast<int>(std::clamp<std::int64_t>(
    static_cast<std::int64_t>(y) + height, 0, surface.height));
  if (x1 <= x0 || y1 <= y0) return;
  if (surface.dirtyX1 <= surface.dirtyX0 || surface.dirtyY1 <= surface.dirtyY0) {
    surface.dirtyX0 = x0;
    surface.dirtyY0 = y0;
    surface.dirtyX1 = x1;
    surface.dirtyY1 = y1;
    return;
  }
  surface.dirtyX0 = std::min(surface.dirtyX0, x0);
  surface.dirtyY0 = std::min(surface.dirtyY0, y0);
  surface.dirtyX1 = std::max(surface.dirtyX1, x1);
  surface.dirtyY1 = std::max(surface.dirtyY1, y1);
}

void CanvasStore::blendPixel(Surface& surface, int x, int y, std::uint32_t rgba,
                             std::uint8_t coverage) {
  if (x < 0 || y < 0 || x >= surface.width || y >= surface.height) return;
  const std::uint32_t colorAlpha = rgba & 0xffU;
  const std::uint32_t sourceAlpha = colorAlpha * coverage / 255U;
  const std::size_t offset =
    (static_cast<std::size_t>(y) * surface.width + x) * 4U;
  const std::uint32_t destinationAlpha = surface.pixels[offset + 3];
  const std::uint32_t inverse = 255U - sourceAlpha;
  const std::uint32_t outputAlpha = sourceAlpha + destinationAlpha * inverse / 255U;
  const std::uint8_t colors[3] = {
    static_cast<std::uint8_t>((rgba >> 24U) & 0xffU),
    static_cast<std::uint8_t>((rgba >> 16U) & 0xffU),
    static_cast<std::uint8_t>((rgba >> 8U) & 0xffU),
  };
  for (int channel = 0; channel < 3; ++channel) {
    const std::uint32_t premultiplied = colors[channel] * sourceAlpha +
      surface.pixels[offset + channel] * destinationAlpha * inverse / 255U;
    surface.pixels[offset + channel] = outputAlpha == 0 ? 0 :
      static_cast<std::uint8_t>(premultiplied / outputAlpha);
  }
  surface.pixels[offset + 3] = static_cast<std::uint8_t>(outputAlpha);
}

bool CanvasStore::drawText(CanvasHandle handle,
                           const std::filesystem::path& fontPath,
                           const std::string& text, int x, int y, int pixelSize,
                           std::uint32_t rgba, int strokeWidth) {
  auto* surface = lookup(handle);
  if (!surface || pixelSize <= 0 || strokeWidth < 0 || strokeWidth > 32) return false;
  if (surface->state == SurfaceState::Deferred) {
    const std::size_t estimatedBytes = sizeof(DrawTextCmd) + text.capacity();
    if (surface->commands.size() >= 256 ||
        surface->queuedCommandBytes + estimatedBytes >= 64 * 1024) {
      if (!realizeSurface(*surface)) return false;
    } else {
      surface->commands.emplace_back(DrawTextCmd{
        fontPath, text, x, y, pixelSize, rgba, strokeWidth
      });
      surface->queuedCommandBytes += estimatedBytes;
      return true;
    }
  }
  return drawTextNow(*surface, fontPath, text, x, y, pixelSize, rgba, strokeWidth);
}

std::optional<int> CanvasStore::measureText(
    const std::filesystem::path& fontPath, const std::string& text,
    int pixelSize) const {
  if (pixelSize <= 0) return std::nullopt;
  int width = 0;
  for (const auto codepoint : decodeUtf8(text)) {
    const auto* glyph = fonts_->getOrLoadGlyph(fontPath, pixelSize, codepoint, 0);
    if (!glyph) continue;
    width += glyph->advanceX;
  }
  return width;
}

std::optional<CanvasTextMetrics> CanvasStore::measureTextMetrics(
    const std::filesystem::path& fontPath, const std::string& text,
    int pixelSize) const {
  if (pixelSize <= 0) return std::nullopt;
  FT_Face face = fonts_->face(fontPath, pixelSize);
  if (!face) return std::nullopt;
  CanvasTextMetrics result;
  int penX = 0;
  int minimumX = 0;
  int maximumX = 0;
  for (const auto codepoint : decodeUtf8(text)) {
    const auto* glyph = fonts_->getOrLoadGlyph(fontPath, pixelSize, codepoint, 0);
    if (!glyph) continue;
    const int left = penX + glyph->bearingX;
    const int top = glyph->bearingY;
    const int right = left + glyph->metricWidth;
    const int bottom = top - glyph->metricHeight;
    minimumX = std::min(minimumX, left);
    maximumX = std::max(maximumX, right);
    result.actualAscent = std::max(result.actualAscent, top);
    result.actualDescent = std::max(result.actualDescent, -bottom);
    penX += glyph->advanceX;
  }
  result.width = penX;
  result.actualLeft = -minimumX;
  result.actualRight = maximumX;
  result.fontAscent = static_cast<int>(face->size->metrics.ascender >> 6);
  result.fontDescent = -static_cast<int>(face->size->metrics.descender >> 6);
  return result;
}

std::optional<std::uint32_t> CanvasStore::pixel(CanvasHandle handle,
                                                int x, int y) {
  auto* surface = lookup(handle);
  if (!surface) return std::nullopt;
  if (surface->state == SurfaceState::Deferred && !realizeSurface(*surface)) {
    return std::nullopt;
  }
  if (x < 0 || y < 0 || x >= surface->width || y >= surface->height) {
    return std::nullopt;
  }
  const std::size_t offset =
    (static_cast<std::size_t>(y) * surface->width + x) * 4U;
  return (static_cast<std::uint32_t>(surface->pixels[offset]) << 24U) |
    (static_cast<std::uint32_t>(surface->pixels[offset + 1]) << 16U) |
    (static_cast<std::uint32_t>(surface->pixels[offset + 2]) << 8U) |
    surface->pixels[offset + 3];
}

bool CanvasStore::blur(CanvasHandle handle) {
  auto* surface = lookup(handle);
  if (!surface) return false;
  if (surface->state == SurfaceState::Deferred) {
    if (surface->commands.size() >= 256 || surface->queuedCommandBytes >= 64 * 1024) {
      if (!realizeSurface(*surface)) return false;
    } else {
      surface->commands.emplace_back(BlurCmd{});
      surface->queuedCommandBytes += sizeof(BlurCmd);
      return true;
    }
  }
  return blurNow(*surface);
}

std::optional<ImagePixels> CanvasStore::readPixels(CanvasHandle handle, int x,
                                                   int y, int width,
                                                   int height) {
  auto* surface = lookup(handle);
  const auto extent = checkedImageExtent(width, height);
  if (!surface || !extent) {
    return std::nullopt;
  }
  if (surface->state == SurfaceState::Deferred && !realizeSurface(*surface)) {
    return std::nullopt;
  }
  ImagePixels result;
  result.width = extent->width;
  result.height = extent->height;
  result.rgba.resize(extent->rgbaBytes);
  for (int row = 0; row < height; ++row) {
    const int sourceY = y + row;
    if (sourceY < 0 || sourceY >= surface->height) continue;
    for (int column = 0; column < width; ++column) {
      const int sourceX = x + column;
      if (sourceX < 0 || sourceX >= surface->width) continue;
      const std::size_t sourceOffset =
        (static_cast<std::size_t>(sourceY) * surface->width + sourceX) * 4U;
      const std::size_t destinationOffset =
        (static_cast<std::size_t>(row) * width + column) * 4U;
      std::copy_n(surface->pixels.data() + sourceOffset, 4,
                  result.rgba.data() + destinationOffset);
    }
  }
  return result;
}

bool CanvasStore::writePixels(CanvasHandle handle, int x, int y, int width,
                              int height,
                              const std::vector<std::uint8_t>& pixels) {
  auto* surface = lookup(handle);
  const std::size_t expected = width > 0 && height > 0
    ? static_cast<std::size_t>(width) * height * 4U : 0;
  if (!surface || expected == 0 || pixels.size() != expected) return false;
  // writePixels forces realization immediately to avoid queuing megabytes of pixels
  if (surface->state == SurfaceState::Deferred && !realizeSurface(*surface)) {
    return false;
  }
  for (int row = 0; row < height; ++row) {
    const int destinationY = y + row;
    if (destinationY < 0 || destinationY >= surface->height) continue;
    const int sourceX = std::max(0, -x);
    const int destinationX = std::max(0, x);
    const int count = std::min(width - sourceX, surface->width - destinationX);
    if (count <= 0) continue;
    const std::size_t sourceOffset =
      (static_cast<std::size_t>(row) * width + sourceX) * 4U;
    const std::size_t destinationOffset =
      (static_cast<std::size_t>(destinationY) * surface->width +
       destinationX) * 4U;
    std::copy_n(pixels.data() + sourceOffset, static_cast<std::size_t>(count) * 4U,
                surface->pixels.data() + destinationOffset);
  }
  markDirty(*surface, x, y, width, height);
  return true;
}

bool CanvasStore::release(CanvasHandle handle) {
  auto* surface = lookup(handle);
  if (!surface) return false;
  discardCommands(*surface);
  if (surface->image != 0) {
    images_.release(surface->image);
    surface->image = 0;
  }
  surface->width = 0;
  surface->height = 0;
  surface->state = SurfaceState::Deferred;
  std::vector<std::uint8_t>().swap(surface->pixels);
  surface->dirtyX0 = surface->dirtyY0 = 0;
  surface->dirtyX1 = surface->dirtyY1 = 0;
  surface->live = false;
  surface->generation = static_cast<std::uint16_t>(
    (surface->generation + 1U) & generationMask);
  if (surface->generation == 0) surface->generation = 1;
  --liveCount_;
  return true;
}

std::optional<CanvasInfo> CanvasStore::info(CanvasHandle handle) const {
  const auto* surface = lookup(handle);
  if (!surface) return std::nullopt;
  return CanvasInfo{handle, surface->width, surface->height};
}

std::optional<ImageHandle> CanvasStore::imageHandle(CanvasHandle handle) const {
  const auto* surface = lookup(handle);
  return surface ? std::optional<ImageHandle>{surface->image} : std::nullopt;
}

void CanvasStore::uploadDirty() {
  for (auto& surface : surfaces_) {
    if (!surface.live || surface.state != SurfaceState::Realized ||
        surface.dirtyX1 <= surface.dirtyX0 ||
        surface.dirtyY1 <= surface.dirtyY0) continue;
    const std::size_t offset =
      (static_cast<std::size_t>(surface.dirtyY0) * surface.width +
       surface.dirtyX0) * 4U;
    if (images_.updateRgbaRegion(surface.image, surface.dirtyX0,
        surface.dirtyY0, surface.dirtyX1 - surface.dirtyX0,
        surface.dirtyY1 - surface.dirtyY0, surface.pixels.data() + offset,
        surface.width)) {
      surface.dirtyX0 = surface.dirtyY0 = 0;
      surface.dirtyX1 = surface.dirtyY1 = 0;
    }
  }
}

std::size_t CanvasStore::cpuBytes() const {
  std::size_t result = 0;
  for (const auto& surface : surfaces_) {
    if (surface.live) result += surface.pixels.size();
  }
  return result;
}

std::size_t CanvasStore::capacityBytes() const {
  std::size_t result = 0;
  for (const auto& surface : surfaces_) result += surface.pixels.capacity();
  return result;
}

std::size_t CanvasStore::deferredCanvasCount() const {
  std::size_t count = 0;
  for (const auto& surface : surfaces_) {
    if (surface.live && surface.state == SurfaceState::Deferred) ++count;
  }
  return count;
}

std::size_t CanvasStore::realizedCanvasCount() const {
  std::size_t count = 0;
  for (const auto& surface : surfaces_) {
    if (surface.live && surface.state == SurfaceState::Realized) ++count;
  }
  return count;
}

std::size_t CanvasStore::deferredCommandCount() const {
  std::size_t count = 0;
  for (const auto& surface : surfaces_) {
    if (surface.live && surface.state == SurfaceState::Deferred) {
      count += surface.commands.size();
    }
  }
  return count;
}

std::size_t CanvasStore::deferredCommandBytes() const {
  std::size_t bytes = 0;
  for (const auto& surface : surfaces_) {
    if (surface.live && surface.state == SurfaceState::Deferred) {
      bytes += surface.queuedCommandBytes;
    }
  }
  return bytes;
}

}  // namespace pmjs
