#include "asset_processor.hpp"
#include "png_color.hpp"
#include "astc_encoder.hpp"
#include "checked_bounds.hpp"
#include "prepared_page.hpp"
#include "texture_artifact.hpp"

#include <algorithm>
#include <cerrno>
#include <chrono>
#include <fcntl.h>
#include <mutex>
#include <span>
#include <unistd.h>
#include <cstdio>
#include <cstring>
#include <deque>
#include <exception>
#include <fstream>
#include <limits>
#include <memory>
#include <map>
#include <new>
#include <stdexcept>
#include <string>
#include <unordered_map>
#include <zlib.h>
#include <utility>
#include <png.h>

namespace pmjs {
namespace {
constexpr int pageLimit = 2048;
constexpr std::size_t rowLimit = 1U * 1024U * 1024U;
constexpr std::uint64_t replaySourceLimit = 128U * 1024U * 1024U;
constexpr std::uint64_t replayMemoryLimit = 192U * 1024U * 1024U;

class PreparationOutputError : public std::runtime_error {
 public:
  using std::runtime_error::runtime_error;
};

template <typename Work>
bool optionalPreparation(Work&& work) {
  try { work(); return true; }
  // Source decoding and pixel-integrity failures must still abort preparation.
  catch (const PreparationOutputError&) {}
  catch (const std::filesystem::filesystem_error&) {}
  catch (const std::bad_alloc&) {}
  return false;
}

class PngRows {
 public:
  explicit PngRows(const std::filesystem::path& path) {
    file_ = std::fopen(path.c_str(), "rb");
    if (!file_) throw std::runtime_error("cannot open preparation source");
    png_ = png_create_read_struct(PNG_LIBPNG_VER_STRING, nullptr, nullptr, nullptr);
    info_ = png_ ? png_create_info_struct(png_) : nullptr;
    if (!info_) { close(); throw std::runtime_error("cannot create PNG reader"); }
    if (setjmp(png_jmpbuf(png_))) { close(); throw AssetPreparationDecodeError("invalid preparation PNG"); }
    png_set_chunk_malloc_max(png_, 1024U * 1024U);
    png_init_io(png_, file_);
    png_read_info(png_, info_);
    const auto w = png_get_image_width(png_, info_);
    const auto h = png_get_image_height(png_, info_);
    if (!w || !h || w > rowLimit / 4 || h > static_cast<unsigned>(std::numeric_limits<int>::max()) ||
        png_get_interlace_type(png_, info_) != PNG_INTERLACE_NONE) {
      close(); throw AssetPreparationUnsupported("preparation requires a bounded noninterlaced PNG");
    }
    width = static_cast<int>(w); height = static_cast<int>(h);
    configurePng(png_, info_, transform_);
    png_read_update_info(png_, info_);
    if (png_get_rowbytes(png_, info_) != static_cast<std::size_t>(width) * 4) {
      close(); throw std::runtime_error("unexpected preparation PNG format");
    }
    row.resize(static_cast<std::size_t>(width) * 4);
  }
  ~PngRows() { close(); }
  PngRows(const PngRows&) = delete;
  PngRows& operator=(const PngRows&) = delete;
  void read() {
    if (setjmp(png_jmpbuf(png_))) throw AssetPreparationDecodeError("cannot decode preparation PNG row");
    png_read_row(png_, row.data(), nullptr);
    transform_.apply(row.data(), width);
  }
  void finish() {
    if (setjmp(png_jmpbuf(png_))) throw AssetPreparationDecodeError("cannot finish preparation PNG");
    png_read_end(png_, info_);
  }
  int width = 0, height = 0;
  std::vector<std::uint8_t> row;
 private:
  void close() {
    if (png_) png_destroy_read_struct(&png_, info_ ? &info_ : nullptr, nullptr);
    if (file_) std::fclose(file_);
    png_ = nullptr; info_ = nullptr; file_ = nullptr;
  }
  ImageColorTransform transform_;
  FILE* file_ = nullptr;
  png_structp png_ = nullptr;
  png_infop info_ = nullptr;
};

std::optional<std::uint64_t> memoryHeadroom() {
  std::ifstream memory("/proc/meminfo");
  std::optional<std::uint64_t> available;
  for (std::string key, line; memory >> key;) {
    if (key == "MemAvailable:") {
      std::uint64_t kib;
      if (memory >> kib && kib <= UINT64_MAX / 1024) available = kib * 1024;
      break;
    }
    std::getline(memory, line);
  }
  if (!available) return std::nullopt;
  const auto limitAt = [&](std::filesystem::path directory, const std::filesystem::path& root,
                           const char* limitFile, const char* usageFile) {
    for (;;) {
      std::ifstream limits(directory / limitFile), usage(directory / usageFile);
      std::uint64_t limit, used;
      if (limits >> limit && usage >> used)
        *available = std::min(*available, used < limit ? limit - used : 0);
      if (directory == root) break;
      directory = directory.parent_path();
    }
  };
  // Walk ancestors too: a parent cgroup can impose the effective hard limit.
  std::ifstream groups("/proc/self/cgroup");
  for (std::string line; std::getline(groups, line);) {
    const auto first = line.find(':'), second = line.find(':', first + 1);
    if (first == std::string::npos || second == std::string::npos) continue;
    const auto controllers = ',' + line.substr(first + 1, second - first - 1) + ',';
    const auto relative = std::filesystem::path(line.substr(second + 1)).relative_path();
    const bool safe = std::none_of(relative.begin(), relative.end(), [](const auto& part) { return part == ".."; });
    const auto root = std::filesystem::path(controllers == ",," ? "/sys/fs/cgroup" : "/sys/fs/cgroup/memory");
    if (controllers != ",," && controllers.find(",memory,") == std::string::npos) continue;
    const auto directory = safe ? (root / relative).lexically_normal() : root;
    limitAt(directory, root, controllers == ",," ? "memory.max" : "memory.limit_in_bytes",
      controllers == ",," ? "memory.current" : "memory.usage_in_bytes");
  }
  return available;
}

class Workspace {
 public:
  struct Buffer {
    Workspace* owner = nullptr;
    std::unique_ptr<std::uint8_t[]> bytes;
    std::size_t size = 0;
    ~Buffer() {
      if (!owner) return;
      std::lock_guard lock(mutex_);
      bytes.reset(); processBytes_ -= size; owner->bytes_ -= size;
      owner->stats.liveWorkspaceBytes = owner->bytes_;
    }
  };
  Workspace(std::size_t limit, AssetPreparationStats& stats) : stats(stats) {
    allowance_ = limit ? availableAllowance() : 0;
    limit_ = std::min({limit, std::size_t{256U * 1024U * 1024U}, allowance_});
    stats.workspaceLimitBytes = limit_;
  }
  std::shared_ptr<Buffer> retain(std::size_t size, bool allocate = true) {
    if (!size) return {};
    if (size > limit_) { stats.workspaceConstrained = true; return {}; }
    const auto now = std::chrono::steady_clock::now();
    if (size >= 8U * 1024U * 1024U || now - checked_ >= std::chrono::milliseconds(250)) {
      allowance_ = availableAllowance(); checked_ = now;
    }
    std::shared_ptr<Buffer> buffer;
    try { buffer = std::make_shared<Buffer>(); }
    catch (const std::bad_alloc&) { stats.workspaceConstrained = true; return {}; }
    std::lock_guard lock(mutex_);
    // The cap covers simultaneous preparation jobs, not just each worker.
    if (processBytes_ > limit_ || size > limit_ - processBytes_ || size > allowance_) {
      stats.workspaceConstrained = true; return {};
    }
    std::unique_ptr<std::uint8_t[]> bytes(allocate ? new (std::nothrow) std::uint8_t[size] : nullptr);
    if (allocate && !bytes) { stats.workspaceConstrained = true; return {}; }
    buffer->owner = this; buffer->bytes = std::move(bytes); buffer->size = size;
    processBytes_ += size; bytes_ += size;
    stats.liveWorkspaceBytes = bytes_;
    stats.peakWorkspaceBytes = std::max(stats.peakWorkspaceBytes, bytes_);
    return buffer;
  }
  AssetPreparationStats& stats;
 private:
  static std::size_t availableAllowance() try {
    constexpr std::uint64_t reserve = 200U * 1024U * 1024U;
    const auto available = memoryHeadroom();
    return available && *available > reserve ? std::min<std::uint64_t>(*available - reserve, SIZE_MAX) : 0;
  } catch (const std::bad_alloc&) { return 0; }
  inline static std::mutex mutex_;
  inline static std::size_t processBytes_ = 0;
  std::size_t bytes_ = 0, limit_ = 0, allowance_ = 0;
  std::chrono::steady_clock::time_point checked_ = std::chrono::steady_clock::now();
};

class PreparationSource {
 public:
  class Rows {
   public:
    explicit Rows(PreparationSource& source) : width(source.width), height(source.height), source_(source) {
      if (source.ready_) { cache_ = source.cache_; ++source.workspace.stats.sourceCacheHits; }
      else {
        png_ = source.initial_ ? std::move(source.initial_) : source.open();
        if (png_->width != width || png_->height != height) throw std::runtime_error("preparation source dimensions changed");
        filling_ = !!source.cache_;
      }
    }
    ~Rows() { if (filling_) source_.cache_.reset(); }
    Rows(const Rows&) = delete;
    Rows& operator=(const Rows&) = delete;
    void read() {
      if (next_ >= height) throw std::runtime_error("preparation row exceeds source");
      if (cache_) row = {cache_->bytes.get() + static_cast<std::size_t>(next_) * width * 4, static_cast<std::size_t>(width) * 4};
      else {
        png_->read(); row = png_->row;
        if (filling_) std::memcpy(source_.cache_->bytes.get() + static_cast<std::size_t>(next_) * width * 4, row.data(), row.size());
      }
      ++next_;
    }
    void finish() {
      if (next_ != height) throw std::runtime_error("incomplete preparation source");
      if (png_) png_->finish();
      if (filling_) { source_.ready_ = true; filling_ = false; }
    }
    int width, height;
    std::span<const std::uint8_t> row;
   private:
    PreparationSource& source_;
    std::unique_ptr<PngRows> png_;
    std::shared_ptr<Workspace::Buffer> cache_;
    int next_ = 0;
    bool filling_ = false;
  };
  PreparationSource(const std::filesystem::path& path, Workspace& workspace) : workspace(workspace), path_(path) {
    initial_ = open(); width = initial_->width; height = initial_->height;
    if (!checkedImageExtent(width, height, 16384)) throw AssetPreparationUnsupported("preparation image exceeds logical limits");
    const auto size = static_cast<std::uint64_t>(width) * height * 4;
    if (size <= SIZE_MAX) cache_ = workspace.retain(static_cast<std::size_t>(size));
  }
  Rows rows() { return Rows(*this); }
  void releaseCache() { cache_.reset(); ready_ = false; }
  Workspace& workspace;
  int width = 0, height = 0;
 private:
  std::unique_ptr<PngRows> open() {
    ++workspace.stats.sourceDecodes;
    return std::make_unique<PngRows>(path_);
  }
  std::filesystem::path path_;
  std::unique_ptr<PngRows> initial_;
  std::shared_ptr<Workspace::Buffer> cache_;
  bool ready_ = false;
};

class TileStore {
 public:
  TileStore(Workspace& workspace, std::filesystem::path directory) : workspace_(workspace), directory_(std::move(directory)) {}
  ~TileStore() {
    if (fd_ >= 0) ::close(fd_);
    if (!file_.empty()) { std::error_code ignored; std::filesystem::remove(file_, ignored); }
  }
  std::size_t create(std::size_t size) {
    auto buffer = workspace_.retain(size);
    const auto offset = extent_;
    if (!buffer) extent_ += size;
    records_.push_back({std::move(buffer), offset, size});
    return records_.size() - 1;
  }
  void append(std::size_t index, std::span<const std::uint8_t> bytes) {
    auto& record = records_.at(index);
    if (bytes.size() > record.size - record.written) throw std::runtime_error("preparation tile exceeds extent");
    if (record.buffer) std::memcpy(record.buffer->bytes.get() + record.written, bytes.data(), bytes.size());
    else {
      ensureSpill();
      std::size_t done = 0;
      while (done < bytes.size()) {
        const auto count = ::pwrite(fd_, bytes.data() + done, bytes.size() - done, record.offset + record.written + done);
        if (count < 0 && errno == EINTR) continue;
        if (count <= 0) throw PreparationOutputError("cannot write preparation spill");
        done += count;
      }
      workspace_.stats.spillBytesWritten += bytes.size();
    }
    record.hash = crc32(record.hash, bytes.data(), static_cast<uInt>(bytes.size()));
    record.written += bytes.size();
  }
  void read(std::size_t index, std::size_t offset, std::span<std::uint8_t> bytes) const {
    const auto& record = records_.at(index);
    if (offset > record.written || bytes.size() > record.written - offset) throw PreparationOutputError("incomplete preparation tile");
    if (record.buffer) std::memcpy(bytes.data(), record.buffer->bytes.get() + offset, bytes.size());
    else {
      std::size_t done = 0;
      while (done < bytes.size()) {
        const auto count = ::pread(fd_, bytes.data() + done, bytes.size() - done, record.offset + offset + done);
        if (count < 0 && errno == EINTR) continue;
        if (count <= 0) throw PreparationOutputError("cannot read preparation spill");
        done += count;
      }
      workspace_.stats.spillBytesRead += bytes.size();
    }
  }
  std::uint64_t hash(std::size_t index) const {
    const auto& record = records_.at(index);
    if (record.written != record.size) throw PreparationOutputError("incomplete preparation tile");
    return record.hash;
  }
  bool same(std::size_t a, std::size_t b) const {
    const auto& left = records_.at(a); const auto& right = records_.at(b);
    if (left.size != right.size) return false;
    if (left.buffer && right.buffer)
      return !std::memcmp(left.buffer->bytes.get(), right.buffer->bytes.get(), left.size);
    std::array<std::uint8_t, 16384> l{}, r{};
    for (std::size_t offset = 0; offset < left.size;) {
      const auto count = std::min(l.size(), left.size - offset);
      read(a, offset, std::span(l).first(count)); read(b, offset, std::span(r).first(count));
      if (std::memcmp(l.data(), r.data(), count)) return false;
      offset += count;
    }
    return true;
  }
  bool matches(std::size_t index, std::span<const std::uint8_t> bytes) const {
    const auto& record = records_.at(index);
    if (record.size != bytes.size()) return false;
    if (record.buffer) return !std::memcmp(record.buffer->bytes.get(), bytes.data(), bytes.size());
    std::array<std::uint8_t, 16384> buffer{};
    for (std::size_t offset = 0; offset < bytes.size();) {
      const auto count = std::min(buffer.size(), bytes.size() - offset);
      read(index, offset, std::span(buffer).first(count));
      if (std::memcmp(buffer.data(), bytes.data() + offset, count)) return false;
      offset += count;
    }
    return true;
  }
  void discard(std::size_t index) { records_.at(index).buffer.reset(); }
 private:
  void ensureSpill() {
    if (fd_ >= 0) return;
    std::filesystem::create_directories(directory_);
    auto name = (directory_ / ".tiles-XXXXXX").string();
    fd_ = ::mkostemp(name.data(), O_CLOEXEC);
    if (fd_ < 0) throw PreparationOutputError("cannot create preparation spill");
    file_ = name;
    ++workspace_.stats.temporaryFiles;
  }
  struct Record {
    std::shared_ptr<Workspace::Buffer> buffer;
    std::uint64_t offset;
    std::size_t size, written = 0;
    std::uint64_t hash = 0;
  };
  Workspace& workspace_;
  std::filesystem::path directory_, file_;
  std::vector<Record> records_;
  std::uint64_t extent_ = 0;
  int fd_ = -1;
};

AssetColor pixel(const std::uint8_t* bytes) { return {bytes[0], bytes[1], bytes[2], bytes[3]}; }
bool inside(int x, int y, const AssetRect& rect) {
  return x >= rect[0] && y >= rect[1] && x - rect[0] < rect[2] && y - rect[1] < rect[3];
}
void writePng(const std::filesystem::path& path, int width, int height,
              const std::vector<std::uint8_t>& bytes) {
  std::unordered_map<std::uint32_t, std::uint8_t> colors;
  colors.reserve(256);
  std::array<std::uint8_t, 1024> palette{};
  auto colorKey = [](const std::uint8_t* rgba) {
    return static_cast<std::uint32_t>(rgba[0]) |
      (static_cast<std::uint32_t>(rgba[1]) << 8) |
      (static_cast<std::uint32_t>(rgba[2]) << 16) |
      (static_cast<std::uint32_t>(rgba[3]) << 24);
  };
  bool indexed = true;
  for (std::size_t offset = 0; offset < bytes.size(); offset += 4) {
    const auto key = colorKey(bytes.data() + offset);
    if (colors.contains(key)) continue;
    if (colors.size() == 256) { indexed = false; break; }
    const auto index = static_cast<std::uint8_t>(colors.size());
    colors.emplace(key, index);
    std::copy_n(bytes.data() + offset, 4, palette.data() + index * 4);
  }
  std::vector<std::uint8_t> indices;
  if (indexed) {
    indices.resize(bytes.size() / 4);
    for (std::size_t index = 0; index < indices.size(); ++index)
      indices[index] = colors.at(colorKey(bytes.data() + index * 4));
  }
  png_image image{};
  image.version = PNG_IMAGE_VERSION;
  image.width = static_cast<png_uint_32>(width);
  image.height = static_cast<png_uint_32>(height);
  image.format = indexed ? PNG_FORMAT_RGBA_COLORMAP : PNG_FORMAT_RGBA;
  image.colormap_entries = indexed ? static_cast<png_uint_32>(colors.size()) : 0;
  if (!png_image_write_to_file(&image, path.c_str(), 0,
      indexed ? indices.data() : bytes.data(), 0, indexed ? palette.data() : nullptr)) {
    const std::string error = image.message;
    png_image_free(&image);
    throw PreparationOutputError("cannot write prepared PNG: " + error);
  }
  png_image_free(&image);
}
std::uint64_t digest(std::span<const std::uint8_t> bytes) {
  return crc32(0, bytes.data(), static_cast<uInt>(bytes.size()));
}
struct Tile {
  int width = 0, height = 0;
  int page = -1, x = 0, y = 0;
  std::size_t size() const { return static_cast<std::size_t>(width) * height * 4; }
};
std::vector<PreparedAssetPage> packTiles(std::vector<Tile>& tiles,
                                         const std::vector<std::size_t>& unique) {
  auto pack = [&](int width, bool assign, int* nextDifferentWidth = nullptr) {
    std::vector<PreparedAssetPage> pages;
    int page = 0, shelfX = 0, shelfY = 0, shelfHeight = 0, usedWidth = 0, usedHeight = 0;
    for (const auto index : unique) {
      auto& tile = tiles[index];
      if (shelfX + tile.width > width) {
        // Until this exact threshold, every shelf decision (and thus every
        // resulting page extent) stays identical. No candidate widths are lost.
        if (nextDifferentWidth)
          *nextDifferentWidth = std::min(*nextDifferentWidth, shelfX + tile.width);
        shelfX = 0; shelfY += shelfHeight; shelfHeight = 0;
      }
      if (shelfY + tile.height > pageLimit) {
        pages.push_back({"page-" + std::to_string(page) + ".png", usedWidth, usedHeight});
        ++page; shelfX = shelfY = shelfHeight = usedWidth = usedHeight = 0;
      }
      if (assign) { tile.page = page; tile.x = shelfX; tile.y = shelfY; }
      shelfX += tile.width; shelfHeight = std::max(shelfHeight, tile.height);
      usedWidth = std::max(usedWidth, shelfX); usedHeight = std::max(usedHeight, shelfY + tile.height);
    }
    if (!unique.empty()) pages.push_back({"page-" + std::to_string(page) + ".png", usedWidth, usedHeight});
    return pages;
  };
  auto score = [](const std::vector<PreparedAssetPage>& pages) {
    std::uint64_t area = 0;
    int longest = 0;
    for (const auto& page : pages) {
      area += static_cast<std::uint64_t>(page.width) * page.height;
      longest = std::max({longest, page.width, page.height});
    }
    return std::pair{area, longest};
  };
  int minimumWidth = 1;
  for (const auto index : unique) minimumWidth = std::max(minimumWidth, tiles[index].width);
  int bestWidth = pageLimit;
  const auto originalPages = pack(bestWidth, false);
  auto bestScore = score(originalPages);
  for (int width = minimumWidth; width < pageLimit;) {
    int nextDifferentWidth = pageLimit;
    const auto pages = pack(width, false, &nextDifferentWidth);
    if (pages.size() <= originalPages.size()) {
      const auto candidate = score(pages);
      if (candidate < bestScore) { bestWidth = width; bestScore = candidate; }
    }
    width = std::max(width + 1, nextDifferentWidth);
  }
  return pack(bestWidth, true);
}
std::vector<AssetColor> modalFills(PreparationSource& source, const AssetRecipe& recipe) {
  auto input = source.rows();
  if (recipe.columns <= 0 || recipe.rows <= 0 || recipe.columns > 4096 ||
      recipe.rows > 4096 / recipe.columns || input.width % recipe.columns || input.height % recipe.rows)
    throw AssetPreparationUnsupported("preparation grid must divide the source exactly");
  const int cellWidth = input.width / recipe.columns, cellHeight = input.height / recipe.rows;
  std::vector<AssetColor> fills(static_cast<std::size_t>(recipe.columns) * recipe.rows);
  using ColorCounts = std::unordered_map<std::uint32_t, std::uint64_t>;
  std::vector<ColorCounts> histograms(recipe.columns);
  std::vector<bool> overflow(recipe.columns);
  std::size_t distinctColors = 0;
  for (int y = 0; y < input.height; ++y) {
    input.read();
    const bool perimeterRow = y % cellHeight == 0 || y % cellHeight == cellHeight - 1;
    for (int column = 0; column < recipe.columns; ++column) {
      if (overflow[column]) continue;
      auto& histogram = histograms[column];
      const auto* row = input.row.data() + static_cast<std::size_t>(column) * cellWidth * 4;
      // Interior colors must not exhaust the background probe's bounded histogram.
      for (int x = 0; x < cellWidth;) {
        std::uint32_t word;
        std::memcpy(&word, row + static_cast<std::size_t>(x) * 4, 4);
        int end = x + 1;
        for (; perimeterRow && end < cellWidth; ++end) {
          std::uint32_t next;
          std::memcpy(&next, row + static_cast<std::size_t>(end) * 4, 4);
          if (next != word) break;
        }
        const auto count = static_cast<std::uint64_t>(end - x);
        x = perimeterRow ? end : (x == 0 && cellWidth > 1 ? cellWidth - 1 : cellWidth);
        const auto found = histogram.find(word);
        if (found != histogram.end()) { found->second += count; continue; }
        // High-color cells keep the ordinary fill; bound the entire active grid row.
        if (histogram.size() == 4096 || distinctColors == 65536) {
          distinctColors -= histogram.size();
          ColorCounts{}.swap(histogram); overflow[column] = true; break;
        }
        histogram.emplace(word, count); ++distinctColors;
      }
    }
    if ((y + 1) % cellHeight) continue;
    for (int column = 0; column < recipe.columns; ++column) {
      if (!overflow[column]) {
        auto& fill = fills[static_cast<std::size_t>(y / cellHeight) * recipe.columns + column];
        std::uint64_t largest = 0;
        for (const auto& [word, count] : histograms[column]) {
          AssetColor rgba;
          std::memcpy(rgba.data(), &word, 4);
          if (count > largest || (count == largest && rgba < fill)) { fill = rgba; largest = count; }
        }
      }
      ColorCounts{}.swap(histograms[column]); overflow[column] = false;
    }
    distinctColors = 0;
  }
  input.finish();
  return fills;
}
std::vector<std::uint8_t> renderPage(PreparationSource& source, const PreparedAsset& asset,
                                    int pageIndex, bool verifyFills, const AssetRecipe* recipe = nullptr) {
  const int width = pageIndex >= 0 ? asset.pages[pageIndex].width : 0;
  const int height = pageIndex >= 0 ? asset.pages[pageIndex].height : 0;
  std::vector<std::uint8_t> bytes(static_cast<std::size_t>(width) * height * 4);
  std::vector<std::uint8_t> written(static_cast<std::size_t>(width) * height);
  auto rows = source.rows();
  for (int y = 0; y < source.height; ++y) {
    rows.read();
    for (const auto& cell : asset.cells) {
      const int localY = y - cell.rect[1];
      if (verifyFills && localY >= 0 && localY < cell.rect[3]) {
        for (int x = 0; x < cell.rect[2]; ++x) {
          const auto color = pixel(rows.row.data() + static_cast<std::size_t>(cell.rect[0] + x) * 4);
          if ((!inside(x, localY, cell.crop) && color != cell.fill) ||
              (recipe && recipe->crop && !inside(x, localY, *recipe->crop) && color != recipe->backdrop))
            throw AssetPreparationUnsupported("prepared fill discards source pixels");
        }
      }
      if (verifyFills && asset.blockGrid && !cell.crop[2] &&
          y >= std::max(0, cell.rect[1] - asset.halo) &&
          y <= std::min(source.height - 1, cell.rect[1] + cell.rect[3] + asset.halo - 1)) {
        for (int x = cell.rect[0] - asset.halo; x < cell.rect[0] + cell.rect[2] + asset.halo; ++x)
          if (pixel(rows.row.data() + static_cast<std::size_t>(std::clamp(x, 0, source.width - 1)) * 4) != cell.fill)
            throw AssetPreparationUnsupported("indexed uniform block border differs");
      }
      if (!cell.crop[2] || cell.page != pageIndex) continue;
      const int top = cell.rect[1] + cell.crop[1] - asset.halo;
      const int paddedHeight = cell.crop[3] + asset.halo * 2;
      if (y < std::max(0, top) || y > std::min(source.height - 1, top + paddedHeight - 1)) continue;
      const int firstRow = y == 0 ? 0 : y - top;
      const int lastRow = y == source.height - 1 ? paddedHeight - 1 : y - top;
      const int left = cell.rect[0] + cell.crop[0] - asset.halo;
      const int paddedWidth = cell.crop[2] + asset.halo * 2;
      for (int py = firstRow; py <= lastRow; ++py) {
        const auto offset = (static_cast<std::size_t>(cell.atlas[1] - asset.halo + py) * width + cell.atlas[0] - asset.halo);
        if (left >= 0 && paddedWidth <= source.width - left) {
          const auto* from = rows.row.data() + static_cast<std::size_t>(left) * 4;
          const auto begin = written.begin() + offset, end = begin + paddedWidth;
          if (std::find(begin, end, 1) == end) {
            std::memcpy(bytes.data() + offset * 4, from, static_cast<std::size_t>(paddedWidth) * 4);
            std::fill(begin, end, 1);
            continue;
          }
          if (std::find(begin, end, 0) == end) {
            if (std::memcmp(bytes.data() + offset * 4, from, static_cast<std::size_t>(paddedWidth) * 4))
              throw AssetPreparationUnsupported("prepared shared tile differs");
            continue;
          }
        }
        for (int x = 0; x < paddedWidth; ++x) {
          const auto* color = rows.row.data() + static_cast<std::size_t>(std::clamp(left + x, 0, source.width - 1)) * 4;
          auto* target = bytes.data() + (offset + x) * 4;
          if (written[offset + x] && std::memcmp(target, color, 4))
            throw AssetPreparationUnsupported("prepared shared tile differs");
          std::memcpy(target, color, 4); written[offset + x] = 1;
        }
      }
    }
  }
  rows.finish();
  return bytes;
}

void emitLayout(PreparationSource& source, const std::filesystem::path& staging, PreparedAsset& asset,
                const AssetRecipe& recipe, bool lz4Pages) {
  if (asset.uniform) {
    auto rows = source.rows();
    for (int y = 0; y < source.height; ++y) {
      rows.read();
      for (int x = 0; x < source.width; ++x)
        if (pixel(rows.row.data() + static_cast<std::size_t>(x) * 4) != *asset.uniform)
          throw AssetPreparationUnsupported("indexed uniform color differs");
    }
    rows.finish();
  } else if (asset.pages.empty()) renderPage(source, asset, -1, true, &recipe);
  const bool classifyCompact = !asset.compactEligible.has_value();
  const bool classifyBlocks = !asset.blockChannels.has_value();
  if (classifyCompact && !asset.uniform && !asset.cells.empty()) {
    const auto fill = asset.cells.front().fill;
    const int inset = std::max(2, asset.halo);
    asset.compactEligible = fill[0] == fill[1] && fill[0] == fill[2] && fill[3] == 255 &&
      std::all_of(asset.cells.begin(), asset.cells.end(), [&](const auto& cell) {
        return cell.fill == fill && (!cell.crop[2] ||
          (cell.crop[0] >= inset && cell.crop[1] >= inset &&
           cell.crop[0]+cell.crop[2]+inset <= cell.rect[2] &&
           cell.crop[1]+cell.crop[3]+inset <= cell.rect[3]));
      });
  }
  if (!asset.pages.empty()) std::filesystem::create_directories(staging);
  asset.ordinaryRetainedBytes = 0;
  for (std::size_t index = 0; index < asset.pages.size(); ++index) {
    auto& page = asset.pages[index];
    auto bytes = renderPage(source, asset, static_cast<int>(index), index == 0, &recipe);
    // No more source rows are needed for this emission. Keep encoding scratch
    // from overlapping the cached decode; a failed replay can reopen the source.
    if (index + 1 == asset.pages.size()) source.releaseCache();
    if (classifyCompact && asset.compactEligible.value_or(false)) {
      for (const auto& cell : asset.cells) {
        if (cell.page != static_cast<int>(index) || !cell.crop[2]) continue;
        for (int y = 0; y < cell.crop[3]; ++y) for (int x = 0; x < cell.crop[2]; ++x) {
          const auto offset = (static_cast<std::size_t>(cell.atlas[1]+y)*page.width+cell.atlas[0]+x)*4;
          if (bytes[offset] != bytes[offset+1] || bytes[offset] != bytes[offset+2] || bytes[offset+3] != 255)
            asset.compactEligible = false;
        }
      }
    }
    if (classifyBlocks && asset.blockGrid) {
      int channels = asset.pages.size() == 1 ? 1 : 0;
      for (std::size_t i = 0; channels && i < bytes.size(); i += 4) {
        if (bytes[i] != bytes[i+1] || bytes[i] != bytes[i+2]) channels = 0;
        else if (bytes[i+3] != 255) channels = 2;
      }
      for (const auto& cell : asset.cells)
        if (cell.fill[0] != cell.fill[1] || cell.fill[0] != cell.fill[2]) channels = 0;
      asset.blockChannels = channels;
    }
    page.path.replace_extension(lz4Pages ? ".pml4" : ".png");
    if (lz4Pages) {
      std::uint64_t retained = 0;
      writeLz4Page(staging / page.path, page.width, page.height, bytes, true, &retained);
      asset.ordinaryRetainedBytes += retained;
      ++source.workspace.stats.lz4Encodes;
    } else {
      writePng(staging / page.path, page.width, page.height, bytes);
      asset.ordinaryRetainedBytes += std::uint64_t(page.width)*page.height*5;
      ++source.workspace.stats.pngEncodes;
    }
    source.workspace.stats.encodedPixels += static_cast<std::uint64_t>(page.width) * page.height;
  }
}

std::optional<PreparedAsset> sharedInteriorLayout(PreparationSource& source, const PreparedAsset& asset) {
  const auto powerOfTwo = [](int n) { return n > 0 && (n & (n - 1)) == 0; };
  // Keep single-cell resolution available to textures eligible for direct sampling.
  if (asset.uniform || asset.cells.size() < 2 ||
      (powerOfTwo(asset.width) && powerOfTwo(asset.height))) return std::nullopt;
  std::map<std::array<int, 2>, std::array<int, 3>> firstPhysicalCrop;
  bool comparableCrops = false;
  for (const auto& cell : asset.cells) {
    if (cell.crop[2] <= 2 * asset.halo || cell.crop[3] <= 2 * asset.halo) continue;
    const std::array<int, 2> dimensions{cell.crop[2], cell.crop[3]};
    const std::array<int, 3> physical{cell.page, cell.atlas[0], cell.atlas[1]};
    const auto [found, inserted] = firstPhysicalCrop.emplace(dimensions, physical);
    if (!inserted && found->second != physical) { comparableCrops = true; break; }
  }
  if (!comparableCrops) return std::nullopt;
  constexpr std::size_t pixelBudget = 32U * 1024U * 1024U;
  std::size_t pageBytes = 0;
  for (const auto& page : asset.pages) pageBytes += static_cast<std::size_t>(page.width) * page.height * 4;
  if (pageBytes > pixelBudget) return std::nullopt;
  std::vector<std::vector<std::uint8_t>> pages;
  for (std::size_t index = 0; index < asset.pages.size(); ++index)
    pages.push_back(renderPage(source, asset, static_cast<int>(index), false));
  struct Region { int page; AssetRect rect; };
  const auto regionRow = [&](const Region& region, int y) {
    return pages[region.page].data() + (static_cast<std::size_t>(region.rect[1] + y) *
      asset.pages[region.page].width + region.rect[0]) * 4;
  };
  const auto regionHash = [&](const Region& region) {
    std::uint64_t hash = 0;
    for (int y = 0; y < region.rect[3]; ++y) {
      const auto* row = regionRow(region, y);
      hash = crc32(hash, row, static_cast<uInt>(region.rect[2]) * 4);
    }
    return hash;
  };
  const auto sameRegion = [&](const Region& a, const Region& b) {
    if (a.rect[2] != b.rect[2] || a.rect[3] != b.rect[3]) return false;
    for (int y = 0; y < a.rect[3]; ++y)
      if (std::memcmp(regionRow(a, y), regionRow(b, y), static_cast<std::size_t>(a.rect[2]) * 4)) return false;
    return true;
  };
  struct Crop { Region region; bool repeated = false; };
  std::vector<Crop> crops;
  std::map<std::array<int, 5>, std::size_t> physical;
  std::vector<int> cropForCell(asset.cells.size(), -1);
  std::unordered_map<std::uint64_t, std::vector<std::size_t>> hashes;
  const int halo = asset.halo;
  for (std::size_t index = 0; index < asset.cells.size(); ++index) {
    const auto& cell = asset.cells[index];
    if (cell.crop[2] <= 2 * halo || cell.crop[3] <= 2 * halo) continue;
    const auto& a = cell.atlas;
    const std::array<int, 5> key{cell.page, a[0], a[1], a[2], a[3]};
    if (const auto found = physical.find(key); found != physical.end()) {
      cropForCell[index] = static_cast<int>(found->second); continue;
    }
    Crop crop{{cell.page, a}};
    auto& candidates = hashes[regionHash(crop.region)];
    for (const auto other : candidates) {
      auto& previous = crops[other];
      if (sameRegion(previous.region, crop.region))
        previous.repeated = crop.repeated = true;
    }
    cropForCell[index] = static_cast<int>(crops.size());
    physical.emplace(key, crops.size());
    candidates.push_back(crops.size()); crops.push_back(std::move(crop));
  }
  if (std::none_of(crops.begin(), crops.end(), [](const auto& crop) { return crop.repeated; }))
    return std::nullopt;

  PreparedAsset result = asset;
  result.cells.clear(); result.pages.clear();
  std::vector<Tile> tiles;
  std::vector<Region> contents;
  std::vector<int> canonical;
  hashes.clear();
  std::size_t retainedBytes = 0;
  const auto addPiece = [&](const PreparedAssetCell& original, const AssetRect& rect) {
    if (result.cells.size() == 4096) return false;
    PreparedAssetCell piece;
    piece.rect = rect; piece.fill = original.fill;
    const int cropX = original.rect[0] + original.crop[0], cropY = original.rect[1] + original.crop[1];
    const int left = std::max(rect[0], cropX), top = std::max(rect[1], cropY);
    const int right = std::min(rect[0] + rect[2], cropX + original.crop[2]);
    const int bottom = std::min(rect[1] + rect[3], cropY + original.crop[3]);
    int x0 = rect[0] + rect[2], y0 = rect[1] + rect[3], x1 = 0, y1 = 0;
    if (original.crop[2]) {
      const auto& bytes = pages[original.page];
      const int pageWidth = asset.pages[original.page].width;
      for (int y = top; y < bottom; ++y) for (int x = left; x < right; ++x) {
        const auto offset = (static_cast<std::size_t>(original.atlas[1] + y - cropY) * pageWidth +
          original.atlas[0] + x - cropX) * 4;
        if (pixel(bytes.data() + offset) == piece.fill) continue;
        x0 = std::min(x0, x); y0 = std::min(y0, y); x1 = std::max(x1, x + 1); y1 = std::max(y1, y + 1);
      }
    }
    int selected = -1;
    if (x1 > x0 && y1 > y0) {
      piece.crop = {x0 - rect[0], y0 - rect[1], x1 - x0, y1 - y0};
      const int w = x1 - x0 + 2 * halo, h = y1 - y0 + 2 * halo;
      const int px = original.atlas[0] + x0 - cropX - halo;
      const int py = original.atlas[1] + y0 - cropY - halo;
      const Region region{original.page, {px, py, w, h}};
      auto& candidates = hashes[regionHash(region)];
      for (const auto other : candidates)
        if (sameRegion(contents[other], region)) {
          selected = static_cast<int>(other); break;
        }
      if (selected < 0) {
        const auto size = static_cast<std::size_t>(w) * h * 4;
        if (size > pixelBudget - retainedBytes) return false;
        selected = static_cast<int>(tiles.size());
        Tile tile; tile.width = w; tile.height = h;
        tiles.push_back(tile); candidates.push_back(contents.size());
        retainedBytes += size; contents.push_back(region);
      }
    }
    result.cells.push_back(piece); canonical.push_back(selected);
    return true;
  };
  for (std::size_t index = 0; index < asset.cells.size(); ++index) {
    const auto& cell = asset.cells[index];
    if (cropForCell[index] < 0 || !crops[cropForCell[index]].repeated) {
      if (!addPiece(cell, cell.rect)) return std::nullopt;
      continue;
    }
    const auto& r = cell.rect;
    const AssetRect core{r[0] + cell.crop[0] + halo, r[1] + cell.crop[1] + halo,
      cell.crop[2] - 2 * halo, cell.crop[3] - 2 * halo};
    const std::array<AssetRect, 5> pieces{core,
      AssetRect{r[0], r[1], r[2], core[1] - r[1]},
      AssetRect{r[0], core[1] + core[3], r[2], r[1] + r[3] - core[1] - core[3]},
      AssetRect{r[0], core[1], core[0] - r[0], core[3]},
      AssetRect{core[0] + core[2], core[1], r[0] + r[2] - core[0] - core[2], core[3]}};
    for (const auto& piece : pieces) if (!addPiece(cell, piece)) return std::nullopt;
  }
  std::vector<std::size_t> unique;
  for (std::size_t index = 0; index < tiles.size(); ++index) unique.push_back(index);
  std::stable_sort(unique.begin(), unique.end(), [&](std::size_t a, std::size_t b) {
    if (tiles[a].height != tiles[b].height) return tiles[a].height > tiles[b].height;
    return tiles[a].width > tiles[b].width;
  });
  result.pages = packTiles(tiles, unique);
  for (std::size_t index = 0; index < result.cells.size(); ++index) if (canonical[index] >= 0) {
    auto& cell = result.cells[index]; const auto& tile = tiles[canonical[index]];
    cell.page = tile.page; cell.atlas = {tile.x + halo, tile.y + halo, cell.crop[2], cell.crop[3]};
  }
  return result;
}
std::optional<PreparedAsset> blockLayout(PreparationSource& source,
                                       const std::filesystem::path& staging,
                                       const AssetRecipe& recipe, const PreparedAsset& original) {
  constexpr int blockSize = 64;
  constexpr std::size_t tileBudget = 32U * 1024U * 1024U;
  constexpr std::size_t bandBudget = 16U * 1024U * 1024U;
  constexpr std::uint64_t minimumSaving = 64U * 1024U;
  if (recipe.crop || original.uniform || recipe.columns * recipe.rows <= 1) return std::nullopt;
  const int frameWidth = original.width / recipe.columns, frameHeight = original.height / recipe.rows;
  if (frameWidth <= blockSize && frameHeight <= blockSize) return std::nullopt;
  const auto blocksX = (static_cast<std::uint64_t>(frameWidth) + blockSize - 1) / blockSize;
  const auto blocksY = (static_cast<std::uint64_t>(frameHeight) + blockSize - 1) / blockSize;
  const auto references = blocksX * blocksY * recipe.columns * recipe.rows;
  const auto sourceBytes = static_cast<std::uint64_t>(original.width) * original.height * 4;
  const int halo = original.halo;
  const auto bandBytes = static_cast<std::uint64_t>(original.width) * (std::min(blockSize, frameHeight) + 2 * halo) * 4;
  std::uint64_t originalArea = 0;
  for (const auto& page : original.pages) originalArea += static_cast<std::uint64_t>(page.width) * page.height;
  if (references > 65536 || sourceBytes > replaySourceLimit || bandBytes > bandBudget ||
      blockSize + 2 * halo > pageLimit || originalArea <= minimumSaving) return std::nullopt;

  PreparedAsset result;
  result.width = original.width; result.height = original.height; result.halo = halo;
  result.blockGrid = std::array<int, 3>{blockSize, frameWidth, frameHeight};
  auto input = source.rows();
  if (input.width != original.width || input.height != original.height)
    throw std::runtime_error("preparation source dimensions changed");
  std::deque<std::vector<std::uint8_t>> band;
  int firstRow = 0, nextRow = 0;
  std::vector<Tile> tiles;
  TileStore storage(source.workspace, staging);
  std::vector<std::size_t> contents;
  std::unordered_map<std::uint64_t, std::vector<std::size_t>> hashes;
  std::vector<int> canonical;
  std::size_t retainedBytes = 0;
  using FillRun = std::array<int, 6>;
  for (int frameRow = 0; frameRow < recipe.rows; ++frameRow) {
    std::vector<std::map<FillRun, std::size_t>> active(recipe.columns);
    for (int localY = 0; localY < frameHeight; localY += blockSize) {
      const int y = frameRow * frameHeight + localY, height = std::min(blockSize, frameHeight - localY);
      const int top = std::max(0, y - halo), bottom = std::min(original.height - 1, y + height + halo - 1);
      while (firstRow < top && !band.empty()) { band.pop_front(); ++firstRow; }
      while (nextRow <= bottom) { input.read(); band.emplace_back(input.row.begin(), input.row.end()); ++nextRow; }
      for (int frameColumn = 0; frameColumn < recipe.columns; ++frameColumn) {
        std::vector<PreparedAssetCell> row;
        std::vector<int> rowTiles;
        for (int localX = 0; localX < frameWidth; localX += blockSize) {
          const int x = frameColumn * frameWidth + localX, width = std::min(blockSize, frameWidth - localX);
          const int paddedWidth = width + 2 * halo, paddedHeight = height + 2 * halo;
          std::vector<std::uint8_t> padded(static_cast<std::size_t>(paddedWidth) * paddedHeight * 4);
          bool uniform = true;
          AssetColor fill{};
          for (int py = 0; py < paddedHeight; ++py) {
            const auto& sourceRow = band[std::clamp(y + py - halo, 0, original.height - 1) - firstRow];
            for (int px = 0; px < paddedWidth; ++px) {
              const auto* sourcePixel = sourceRow.data() + static_cast<std::size_t>(std::clamp(x + px - halo, 0, original.width - 1)) * 4;
              auto* target = padded.data() + (static_cast<std::size_t>(py) * paddedWidth + px) * 4;
              std::copy_n(sourcePixel, 4, target);
              if (!px && !py) fill = pixel(sourcePixel);
              else uniform = uniform && pixel(sourcePixel) == fill;
            }
          }
          PreparedAssetCell cell;
          cell.rect = {x, y, width, height};
          int selected = -1;
          if (uniform) cell.fill = fill;
          else {
            cell.crop = {0, 0, width, height};
            auto& candidates = hashes[digest(padded)];
            for (const auto candidate : candidates)
              if (tiles[candidate].width == paddedWidth && tiles[candidate].height == paddedHeight &&
                  storage.matches(contents[candidate], padded)) {
                selected = static_cast<int>(candidate); break;
              }
            if (selected < 0) {
              if (padded.size() > tileBudget - retainedBytes) return std::nullopt;
              selected = static_cast<int>(tiles.size());
              Tile tile; tile.width = paddedWidth; tile.height = paddedHeight;
              tiles.push_back(tile); candidates.push_back(contents.size());
              retainedBytes += padded.size();
              contents.push_back(storage.create(padded.size()));
              storage.append(contents.back(), padded);
            }
          }
          row.push_back(cell); rowTiles.push_back(selected);
        }
        std::map<FillRun, std::size_t> current;
        for (std::size_t column = 0; column < row.size();) {
          auto cell = row[column];
          const int selected = rowTiles[column++];
          if (selected >= 0) { result.cells.push_back(cell); canonical.push_back(selected); }
          else {
            while (column < row.size() && rowTiles[column] < 0 && row[column].fill == cell.fill)
              cell.rect[2] += row[column++].rect[2];
            const FillRun key{cell.rect[0], cell.rect[2], cell.fill[0], cell.fill[1], cell.fill[2], cell.fill[3]};
            if (const auto found = active[frameColumn].find(key); found != active[frameColumn].end()) {
              result.cells[found->second].rect[3] += height; current.emplace(key, found->second);
            } else {
              current.emplace(key, result.cells.size()); result.cells.push_back(cell); canonical.push_back(-1);
            }
          }
          if (result.cells.size() > 4096) return std::nullopt;
        }
        active[frameColumn] = std::move(current);
      }
    }
  }
  input.finish();
  std::vector<std::size_t> unique;
  for (std::size_t index = 0; index < tiles.size(); ++index) unique.push_back(index);
  std::stable_sort(unique.begin(), unique.end(), [&](std::size_t a, std::size_t b) {
    if (tiles[a].height != tiles[b].height) return tiles[a].height > tiles[b].height;
    return tiles[a].width > tiles[b].width;
  });
  result.pages = packTiles(tiles, unique);
  std::uint64_t candidateArea = 0;
  for (const auto& page : result.pages) candidateArea += static_cast<std::uint64_t>(page.width) * page.height;
  // Compare even the cheapest one-channel page payload, plus cell fields and
  // an eight-byte lookup per logical block. Small pixel wins cannot hide table costs.
  const auto originalCost = originalArea + original.cells.size() * sizeof(PreparedAssetCell);
  const auto candidateCost = candidateArea + result.cells.size() * sizeof(PreparedAssetCell) + references * 8;
  if (candidateArea >= originalArea || candidateCost >= originalCost ||
      originalCost - candidateCost < minimumSaving || candidateCost * 100 >= originalCost * 95 ||
      sourceBytes + candidateArea * 5 > replayMemoryLimit) return std::nullopt;
  for (std::size_t index = 0; index < result.cells.size(); ++index) if (canonical[index] >= 0) {
    auto& cell = result.cells[index]; const auto& tile = tiles[canonical[index]];
    cell.page = tile.page; cell.atlas = {tile.x + halo, tile.y + halo, cell.crop[2], cell.crop[3]};
  }
  return result;
}
void validateLayout(PreparationSource& source, const AssetRecipe& recipe, const PreparedAsset& layout) {
  const int width = source.width, height = source.height;
  if (layout.width != width || layout.height != height || layout.halo !=
      (std::max(width, height) + 1023) / 1024 + 2 ||
      recipe.columns <= 0 || recipe.rows <= 0 || recipe.columns > 4096 ||
      recipe.rows > 4096 / recipe.columns || width % recipe.columns || height % recipe.rows)
    throw AssetPreparationUnsupported("indexed image layout is incompatible");
  if (layout.blockGrid) {
    const auto& grid = *layout.blockGrid;
    if (layout.uniform || recipe.crop || grid[0] != 64 || grid[1] <= 0 || grid[2] <= 0 ||
        width % grid[1] || height % grid[2] ||
        ((recipe.columns != 1 || recipe.rows != 1) && (grid[1] != width / recipe.columns || grid[2] != height / recipe.rows)) ||
        ((static_cast<std::uint64_t>(grid[1]) + 63) / 64) * ((static_cast<std::uint64_t>(grid[2]) + 63) / 64) *
          (width / grid[1]) * (height / grid[2]) > 65536)
      throw AssetPreparationUnsupported("indexed block grid is incompatible");
  }
  const auto sourceBytes = static_cast<std::uint64_t>(width) * height * 4;
  if (sourceBytes > replaySourceLimit)
    throw AssetPreparationUnsupported("indexed image exceeds replay memory limit");
  if (layout.uniform) {
    if (!layout.cells.empty() || !layout.pages.empty())
      throw AssetPreparationUnsupported("invalid indexed uniform image");
    return;
  }
  const int cellWidth = layout.blockGrid ? (*layout.blockGrid)[1] : width / recipe.columns;
  const int cellHeight = layout.blockGrid ? (*layout.blockGrid)[2] : height / recipe.rows;
  if (layout.cells.empty() || layout.cells.size() > 4096 || layout.pages.size() > 4096 ||
      (recipe.crop && layout.cells.size() != static_cast<std::size_t>(recipe.columns * recipe.rows)))
    throw AssetPreparationUnsupported("indexed cells do not match the recipe");
  std::uint64_t covered = 0;
  for (std::size_t index = 0; index < layout.cells.size(); ++index) {
    const auto& r = layout.cells[index].rect;
    if (r[0] < 0 || r[1] < 0 || r[2] <= 0 || r[3] <= 0 ||
        r[0] > width - r[2] || r[1] > height - r[3] ||
        r[0] % cellWidth > cellWidth - r[2] || r[1] % cellHeight > cellHeight - r[3])
      throw AssetPreparationUnsupported("indexed piece crosses a source cell");
    if (layout.blockGrid) {
      const auto& grid = *layout.blockGrid;
      const int localX = r[0] % grid[1], localY = r[1] % grid[2];
      if (localX % 64 || localY % 64 ||
          ((localX + r[2]) % 64 && localX + r[2] != grid[1]) ||
          ((localY + r[3]) % 64 && localY + r[3] != grid[2]) ||
          (layout.cells[index].crop[2] &&
            (r[2] != std::min(64, grid[1] - localX) || r[3] != std::min(64, grid[2] - localY) ||
             layout.cells[index].crop != AssetRect{0, 0, r[2], r[3]})))
        throw AssetPreparationUnsupported("invalid indexed block cell");
    }
    for (std::size_t previous = 0; previous < index; ++previous) {
      const auto& other = layout.cells[previous].rect;
      if (r[0] < other[0] + other[2] && other[0] < r[0] + r[2] &&
          r[1] < other[1] + other[3] && other[1] < r[1] + r[3])
        throw AssetPreparationUnsupported("indexed pieces overlap");
    }
    covered += static_cast<std::uint64_t>(r[2]) * r[3];
  }
  if (covered != static_cast<std::uint64_t>(width) * height)
    throw AssetPreparationUnsupported("indexed pieces do not cover the source");
  std::uint64_t totalBytes = sourceBytes;
  for (std::size_t index = 0; index < layout.pages.size(); ++index) {
    const auto& page = layout.pages[index];
    if ((page.path != "page-" + std::to_string(index) + ".png" &&
         page.path != "page-" + std::to_string(index) + ".pml4") ||
        page.width <= 0 || page.height <= 0 || page.width > pageLimit || page.height > pageLimit)
      throw AssetPreparationUnsupported("invalid indexed page");
    const auto area = static_cast<std::uint64_t>(page.width) * page.height;
    totalBytes += area * 5;
    if (totalBytes > replayMemoryLimit)
      throw AssetPreparationUnsupported("indexed pages exceed replay memory limit");
  }
  for (std::size_t index = 0; index < layout.cells.size(); ++index) {
    const auto& cell = layout.cells[index];
    if (recipe.crop) {
      const AssetRect expected{static_cast<int>(index % recipe.columns) * cellWidth,
        static_cast<int>(index / recipe.columns) * cellHeight, cellWidth, cellHeight};
      if (cell.rect != expected) throw AssetPreparationUnsupported("indexed cells do not match the recipe");
    }
    if (cell.crop[0] < 0 || cell.crop[1] < 0 ||
        cell.crop[2] < 0 || cell.crop[3] < 0 ||
        cell.crop[0] > cell.rect[2] - cell.crop[2] ||
        cell.crop[1] > cell.rect[3] - cell.crop[3] ||
        (cell.crop[2] == 0) != (cell.crop[3] == 0) ||
        (recipe.crop && cell.fill != recipe.backdrop))
      throw AssetPreparationUnsupported("invalid indexed crop");
    if (!cell.crop[2]) continue;
    if (cell.page < 0 || static_cast<std::size_t>(cell.page) >= layout.pages.size() ||
        cell.atlas[2] != cell.crop[2] || cell.atlas[3] != cell.crop[3])
      throw AssetPreparationUnsupported("invalid indexed atlas");
    const auto& page = layout.pages[cell.page];
    const int paddedX = cell.atlas[0] - layout.halo, paddedY = cell.atlas[1] - layout.halo;
    const int paddedWidth = cell.crop[2] + layout.halo * 2;
    const int paddedHeight = cell.crop[3] + layout.halo * 2;
    if (paddedX < 0 || paddedY < 0 || paddedX > page.width - paddedWidth ||
        paddedY > page.height - paddedHeight)
      throw AssetPreparationUnsupported("indexed atlas exceeds its page");
  }

}


}

void writePreparedPng(const std::filesystem::path& path, int width, int height,
                      const std::vector<std::uint8_t>& bytes) {
  if (width <= 0 || height <= 0 || bytes.size() != static_cast<std::size_t>(width)*height*4)
    throw std::runtime_error("invalid prepared PNG extent");
  writePng(path, width, height, bytes);
}

static PreparedAsset prepareAssetCells(PreparationSource& source,
                                      const std::filesystem::path& staging,
                                      const AssetRecipe& recipe,
                                      const std::vector<AssetColor>& fills = {}) {
  auto input = source.rows();
  PreparedAsset result;
  result.width = input.width; result.height = input.height;
  result.halo = (std::max(input.width, input.height) + 1023) / 1024 + 2;
  if (recipe.columns <= 0 || recipe.rows <= 0 || recipe.columns > 4096 ||
      recipe.rows > 4096 / recipe.columns || input.width % recipe.columns || input.height % recipe.rows)
    throw AssetPreparationUnsupported("preparation grid must divide the source exactly");
  const int cellWidth = input.width / recipe.columns, cellHeight = input.height / recipe.rows;
  if (recipe.crop && ((*recipe.crop)[0] < 0 || (*recipe.crop)[1] < 0 ||
      (*recipe.crop)[2] <= 0 || (*recipe.crop)[3] <= 0 ||
      (*recipe.crop)[0] > cellWidth - (*recipe.crop)[2] ||
      (*recipe.crop)[1] > cellHeight - (*recipe.crop)[3]))
    throw AssetPreparationUnsupported("preparation crop is outside a cell");
  const auto count = static_cast<std::size_t>(recipe.columns * recipe.rows);
  result.cells.resize(count);
  for (std::size_t index = 0; index < count; ++index) {
    auto& cell = result.cells[index];
    cell.rect = {static_cast<int>(index % recipe.columns) * cellWidth,
                 static_cast<int>(index / recipe.columns) * cellHeight, cellWidth, cellHeight};
    cell.fill = recipe.crop ? recipe.backdrop : fills.empty() ? AssetColor{} : fills[index];
    cell.crop = {cellWidth, cellHeight, 0, 0};
  }
  bool allUniform = true;
  AssetColor first{};
  for (int y = 0; y < input.height; ++y) {
    input.read();
    if (y == 0) first = pixel(input.row.data());
    const auto rowIndex = static_cast<std::size_t>(y / cellHeight) * recipe.columns;
    const int localY = y % cellHeight;
    for (int column = 0; column < recipe.columns; ++column) {
      auto& cell = result.cells[rowIndex + column];
      const auto* row = input.row.data() + static_cast<std::size_t>(cell.rect[0]) * 4;
      int left = 0, right = cellWidth;
      while (left < right && pixel(row + static_cast<std::size_t>(left) * 4) == cell.fill) ++left;
      while (right > left && pixel(row + static_cast<std::size_t>(right - 1) * 4) == cell.fill) --right;
      if (allUniform) {
        if (left == cellWidth) allUniform = cell.fill == first;
        else if (cell.fill == first || left > 0 || right < cellWidth) allUniform = false;
        else {
          // Non-fill endpoints alone cannot disprove a uniform non-fill row.
          for (int x = left; allUniform && x < right; ++x)
            allUniform = pixel(row + static_cast<std::size_t>(x) * 4) == first;
        }
      }
      if (left == cellWidth) continue;
      // A rectangular recipe contains every non-fill pixel iff it contains both row endpoints.
      if (recipe.crop && (!inside(left, localY, *recipe.crop) || !inside(right - 1, localY, *recipe.crop)))
        throw AssetPreparationUnsupported("preparation recipe discards nonconstant pixels");
      if (!cell.crop[2]) cell.crop = {left, localY, right - left, 1};
      else {
        const int end = std::max(cell.crop[0] + cell.crop[2], right);
        cell.crop[0] = std::min(cell.crop[0], left);
        cell.crop[2] = end - cell.crop[0];
        cell.crop[3] = localY - cell.crop[1] + 1;
      }
    }
  }
  input.finish();
  if (allUniform) { result.uniform = first; result.cells.clear(); return result; }
  if (recipe.columns == 1 && recipe.rows == 1 && !recipe.crop &&
      result.cells[0].crop == AssetRect{0, 0, result.width, result.height})
    throw AssetPreparationUnsupported("image has no eligible compact representation");
  std::filesystem::create_directories(staging);
  std::vector<Tile> tiles(count);
  TileStore storage(source.workspace, staging);
  std::vector<std::size_t> records(count, SIZE_MAX);
  for (std::size_t index = 0; index < count; ++index) {
    auto& cell = result.cells[index];
    if (!cell.crop[2]) { cell.crop = {0, 0, 0, 0}; continue; }
    auto& tile = tiles[index];
    tile.width = cell.crop[2] + result.halo * 2; tile.height = cell.crop[3] + result.halo * 2;
    if (tile.width > pageLimit || tile.height > pageLimit)
      throw AssetPreparationUnsupported("prepared crop exceeds the page limit");
    records[index] = storage.create(tile.size());
  }
  auto extraction = source.rows();
  std::vector<std::uint8_t> haloRow(static_cast<std::size_t>(pageLimit) * 4);
  for (int y = 0; y < result.height; ++y) {
    extraction.read();
    for (std::size_t index = 0; index < count; ++index) {
      const auto& cell = result.cells[index];
      const auto& tile = tiles[index];
      if (!tile.width) continue;
      const int startY = cell.rect[1] + cell.crop[1] - result.halo;
      const int firstY = std::max(0, startY), lastY = std::min(result.height - 1, startY + tile.height - 1);
      if (y < firstY || y > lastY) continue;
      const int repetitions = 1 + (y == 0 ? std::max(0, -startY) : 0) +
        (y == result.height - 1 ? std::max(0, startY + tile.height - result.height) : 0);
      const int startX = cell.rect[0] + cell.crop[0] - result.halo;
      if (startX >= 0 && tile.width <= result.width - startX)
        std::memcpy(haloRow.data(), extraction.row.data() + static_cast<std::size_t>(startX) * 4,
          static_cast<std::size_t>(tile.width) * 4);
      else for (int x = 0; x < tile.width; ++x) {
        const int sourceX = std::clamp(startX + x, 0, result.width - 1);
        std::memcpy(haloRow.data() + static_cast<std::size_t>(x) * 4,
          extraction.row.data() + static_cast<std::size_t>(sourceX) * 4, 4);
      }
      for (int repeat = 0; repeat < repetitions; ++repeat)
        storage.append(records[index], std::span(haloRow).first(static_cast<std::size_t>(tile.width) * 4));
    }
  }
  extraction.finish();
  std::unordered_map<std::uint64_t, std::vector<std::size_t>> hashes;
  std::vector<std::size_t> canonical(count);
  std::vector<std::size_t> unique;
  for (std::size_t index = 0; index < count; ++index) {
    const auto& tile = tiles[index];
    if (!tile.width) continue;
    auto& candidates = hashes[storage.hash(records[index])];
    canonical[index] = index;
    for (const auto other : candidates) {
      if (tiles[other].width == tile.width && tiles[other].height == tile.height &&
          storage.same(records[other], records[index])) {
        canonical[index] = other; break;
      }
    }
    if (canonical[index] == index) { candidates.push_back(index); unique.push_back(index); }
    else storage.discard(records[index]);
  }
  auto check = source.rows();
  std::vector<std::uint8_t> tileRow(static_cast<std::size_t>(pageLimit) * 4);
  for (int y = 0; y < result.height; ++y) {
    check.read();
    for (int column = 0; column < recipe.columns; ++column) {
      const auto index = static_cast<std::size_t>(y / cellHeight) * recipe.columns + column;
      const auto& cell = result.cells[index];
      const int localY = y - cell.rect[1];
      const auto* sourceRow = check.row.data() + static_cast<std::size_t>(cell.rect[0]) * 4;
      const auto verifyFill = [&](int first, int last) {
        for (int x = first; x < last; ++x)
          if (pixel(sourceRow + static_cast<std::size_t>(x) * 4) != cell.fill)
            throw std::runtime_error("prepared image reconstruction differs");
      };
      if (cell.crop[2] && localY >= cell.crop[1] && localY < cell.crop[1] + cell.crop[3]) {
        const auto offset = static_cast<std::size_t>(localY - cell.crop[1] + result.halo) * tiles[index].width * 4;
        storage.read(records[canonical[index]], offset,
          std::span(tileRow).first(static_cast<std::size_t>(tiles[index].width) * 4));
        if (std::memcmp(tileRow.data() + static_cast<std::size_t>(result.halo) * 4,
            sourceRow + static_cast<std::size_t>(cell.crop[0]) * 4, static_cast<std::size_t>(cell.crop[2]) * 4))
          throw std::runtime_error("prepared image reconstruction differs");
        verifyFill(0, cell.crop[0]);
        verifyFill(cell.crop[0] + cell.crop[2], cellWidth);
      } else verifyFill(0, cellWidth);
    }
  }
  check.finish();
  result.pages = packTiles(tiles, unique);
  std::uint64_t packedArea = 0;
  for (const auto& page : result.pages) packedArea += static_cast<std::uint64_t>(page.width) * page.height;
  // A multi-frame layout also enables bounded frame residency, even when its
  // sampling borders make the stored pages larger than the original sheet.
  if (count == 1 && packedArea >= static_cast<std::uint64_t>(result.width) * result.height) {
    throw AssetPreparationUnsupported("prepared pages do not reduce decoded storage");
  }
  for (std::size_t index = 0; index < count; ++index) if (tiles[index].width) {
    const auto& tile = tiles[canonical[index]];
    auto& cell = result.cells[index];
    cell.page = tile.page; cell.atlas = {tile.x + result.halo, tile.y + result.halo, cell.crop[2], cell.crop[3]};
  }
  return result;
}

namespace {
void emitTexture(PreparationSource& source, const std::filesystem::path& staging,
                 PreparedAsset& asset, const AssetRecipe& recipe) {
  asset.textureArtifact.clear();
  const bool automatic = !recipe.framePages;
  if ((automatic && (std::max(asset.ordinaryRetainedBytes, std::uint64_t(source.width)*source.height*4) < 4U*1024U*1024U ||
      (asset.blockGrid && asset.blockChannels.value_or(0) > 0) || asset.compactEligible.value_or(false))) ||
      asset.uniform || recipe.crop || recipe.backdrop != AssetColor{} ||
      asset.width != source.width || asset.height != source.height || source.width > 16384 || source.height > 16384) return;
  source.releaseCache();
  const auto size = std::size_t(source.width)*source.height*4;
  // Reserve input, output, dictionary overhead and chunk encoding scratch together.
  auto reservation = source.workspace.retain(size + 8U*1024U*1024U, false);
  if (!reservation) return;
  try {
    ImagePixels pixels{source.width, source.height, std::vector<std::uint8_t>(size)};
    auto rows = source.rows();
    for (int y = 0; y < source.height; ++y) {
      rows.read();
      std::memcpy(pixels.rgba.data()+std::size_t(y)*source.width*4, rows.row.data(), rows.row.size());
    }
    rows.finish();
    const auto classified = classifyImageStorage(pixels);
    const bool boundedPalette = classified.paletteBits && source.width <= 8192 && source.height <= 8192;
    auto encoding = source.workspace.retain(size*(boundedPalette ? 2 : 3) + 24U*1024U*1024U, false);
    if (!encoding) return;
    // Nonzero fills may require reconstructed cells or a full-source texture.
    // Keep mixed layouts conservative: a zero-fill first draw can use only its atlas.
    if (automatic && !asset.cells.empty() && std::all_of(asset.cells.begin(), asset.cells.end(),
        [](const auto& cell) { return cell.fill != AssetColor{}; }))
      asset.ordinaryRetainedBytes += std::uint64_t(source.width)*source.height*imageChannelStorage(pixels).channels;
    auto texture = makePreparedTexture(pixels, &classified, automatic ? asset.ordinaryRetainedBytes : 0);
    if (!texture) return;
    std::uint64_t retained = 0;
    for (const auto& plane : texture->layout.planes)
      retained += std::uint64_t(plane.width)*plane.height*textureTexelBytes(plane.format);
    if (texture->layout.kind != TextureKind::Channels) retained += texture->bytes[1].size()*2;
    asset.textureRetainedBytes = retained;
    // Fill-only layouts already realize the same dense palette without recovery pages.
    if (automatic && asset.pages.empty() &&
        (texture->layout.kind == TextureKind::Dense8 || texture->layout.kind == TextureKind::Dense16))
      asset.ordinaryRetainedBytes = retained;
    if (automatic && retained >= asset.ordinaryRetainedBytes) return;
    writeTextureArtifact(staging / "texture.pmtx", *texture);
    asset.framePages = true;
    asset.textureArtifact = "texture.pmtx";
  } catch (const std::invalid_argument&) {
    std::filesystem::remove(staging / "texture.pmtx");
  } catch (const std::bad_alloc&) {
    source.workspace.stats.workspaceConstrained = true;
    std::filesystem::remove(staging / "texture.pmtx");
  }
}

std::optional<PreparedAsset> prepareAstc(PreparationSource& source,
    const std::filesystem::path& staging, const AssetRecipe& recipe,
    const AssetPreparationOptions& options) {
  if (!options.allowAstc || recipe.crop || recipe.backdrop != AssetColor{}) return std::nullopt;
  const auto extent = checkedImageExtent(source.width, source.height);
  if (!extent) return std::nullopt;
  const auto count = std::uint64_t(source.width) * source.height;
  if (recipe.columns <= 0 || recipe.rows <= 0 || recipe.columns > 4096 ||
      recipe.rows > 4096 / recipe.columns || source.width % recipe.columns || source.height % recipe.rows)
    return std::nullopt;
  auto buffer = source.workspace.retain(static_cast<std::size_t>(count) * 4);
  if (!buffer) return std::nullopt;
  auto rows = source.rows();
  bool opaque = true;
  for (int y = 0; y < source.height; ++y) {
    rows.read();
    std::memcpy(buffer->bytes.get() + std::size_t(y) * source.width * 4, rows.row.data(), rows.row.size());
    for (std::size_t i = 0; i < rows.row.size(); i += 4) {
      opaque &= rows.row[i+3] == 255;
    }
  }
  rows.finish();
  std::filesystem::create_directories(staging);
  PreparedAsset result;
  result.width = source.width; result.height = source.height; result.halo = 1;
  result.compression = "astc-4x4";
  const std::span<std::uint8_t> pixels(buffer->bytes.get(), static_cast<std::size_t>(count) * 4);
  encodeAstc4x4(staging / "page-0.astc", source.width, source.height, pixels, options.astcQuality);
  result.pages.push_back({"page-0.astc", source.width, source.height});
  if (!opaque) {
    for (std::size_t i = 0; i < pixels.size(); i += 4)
      for (int channel = 0; channel < 3; ++channel)
        pixels[i+channel] = static_cast<std::uint8_t>((pixels[i+channel] * pixels[i+3] + 127) / 255);
    encodeAstc4x4(staging / "page-1.astc", source.width, source.height, pixels, options.astcQuality);
    result.pages.push_back({"page-1.astc", source.width, source.height});
  }
  return result;
}
}

PreparedAsset prepareAssetImage(const std::filesystem::path& path,
                               const std::filesystem::path& staging,
                               const AssetRecipe& recipe, const PreparedAsset* layout,
                               const AssetPreparationOptions& options) {
  AssetPreparationStats localStats;
  auto& stats = options.statistics ? *options.statistics : localStats;
  stats = {};
  Workspace workspace(options.workspaceBytes, stats);
  PreparationSource source(path, workspace);
  if (!recipe.framePages) if (auto astc = prepareAstc(source, staging, recipe, options)) return *astc;
  if (layout && layout->compression.empty() && layout->framePages == recipe.framePages) {
    try {
      validateLayout(source, recipe, *layout);
      auto result = *layout;
      emitLayout(source, staging, result, recipe, options.lz4Pages);
      emitTexture(source, staging, result, recipe);
      return result;
    }
    catch (const AssetPreparationUnsupported&) {}
    catch (const std::exception&) {}
    for (const auto& page : layout->pages)
      if (page.path.filename() == page.path) {
        std::filesystem::remove(staging / page.path);
        auto converted = page.path;
        converted.replace_extension(options.lz4Pages ? ".pml4" : ".png");
        std::filesystem::remove(staging / converted);
      }
  }
  const auto area = [](const PreparedAsset& asset) {
    std::uint64_t pixels = 0;
    for (const auto& page : asset.pages) pixels += static_cast<std::uint64_t>(page.width) * page.height;
    return pixels;
  };
  const auto optimize = [&](PreparedAsset asset) {
    optionalPreparation([&] {
      const auto candidate = sharedInteriorLayout(source, asset);
      if (!candidate || area(*candidate) >= area(asset)) return;
      const auto sourceBytes = static_cast<std::uint64_t>(asset.width) * asset.height * 4;
      if (sourceBytes > replaySourceLimit || sourceBytes + area(*candidate) * 5 > replayMemoryLimit) return;
      validateLayout(source, recipe, *candidate);
      asset = *candidate;
    });
    optionalPreparation([&] {
      const auto candidate = blockLayout(source, staging, recipe, asset);
      if (candidate) { validateLayout(source, recipe, *candidate); asset = *candidate; }
    });
    return asset;
  };
  std::optional<PreparedAsset> selected;
  try {
    if (recipe.crop) selected = prepareAssetCells(source, staging, recipe);
    else {
      std::exception_ptr unsupported;
      try { selected = prepareAssetCells(source, staging, recipe); }
      catch (const AssetPreparationUnsupported&) { unsupported = std::current_exception(); }
      if (selected && selected->uniform) return *selected;
      std::vector<AssetColor> fills;
      if (selected) optionalPreparation([&] { fills = modalFills(source, recipe); });
      else fills = modalFills(source, recipe);
      if (std::any_of(fills.begin(), fills.end(), [](const auto& fill) { return fill != AssetColor{}; })) {
        const auto tryModal = [&] {
          std::optional<PreparedAsset> candidate;
          try { candidate = prepareAssetCells(source, staging, recipe, fills); }
          catch (const AssetPreparationUnsupported&) { return; }
          if (candidate && (!selected || area(*candidate) < area(*selected))) selected = std::move(candidate);
        };
        if (selected) optionalPreparation(tryModal);
        else tryModal();
      }
      if (!selected) std::rethrow_exception(unsupported);
      if (!recipe.framePages) selected = optimize(std::move(*selected));
    }
  } catch (const AssetPreparationUnsupported&) {
    if ((!options.lz4Pages && source.width <= 8192 && source.height <= 8192) || recipe.crop || recipe.columns <= 0 || recipe.rows <= 0 ||
        recipe.columns > 4096 || recipe.rows > 4096 / recipe.columns ||
        source.width % recipe.columns || source.height % recipe.rows) throw;
    PreparedAsset flat;
    flat.width = source.width; flat.height = source.height;
    flat.halo = (std::max(flat.width, flat.height) + 1023) / 1024 + 2;
    const int extent = pageLimit - 2 * flat.halo;
    for (int y = 0; y < flat.height; y += extent) for (int x = 0; x < flat.width; x += extent) {
      const int width = std::min(extent, flat.width - x), height = std::min(extent, flat.height - y);
      PreparedAssetCell cell;
      cell.rect = {x, y, width, height}; cell.crop = {0, 0, width, height};
      cell.page = static_cast<int>(flat.pages.size());
      cell.atlas = {flat.halo, flat.halo, width, height};
      flat.pages.push_back({"page-" + std::to_string(cell.page) + ".pml4",
        width + 2 * flat.halo, height + 2 * flat.halo});
      flat.cells.push_back(cell);
    }
    selected = std::move(flat);
  }
  if (recipe.framePages && !selected->uniform) {
    selected->framePages = true;
    selected->pages.clear();
    for (auto& cell : selected->cells) {
      if (!cell.crop[2] || !cell.crop[3]) continue;
      cell.page = static_cast<int>(selected->pages.size());
      cell.atlas = {selected->halo, selected->halo, cell.crop[2], cell.crop[3]};
      selected->pages.push_back({"page-" + std::to_string(cell.page) + ".png",
        cell.crop[2] + 2 * selected->halo, cell.crop[3] + 2 * selected->halo});
    }
  }
  if (!selected->uniform) emitLayout(source, staging, *selected, recipe, options.lz4Pages);
  emitTexture(source, staging, *selected, recipe);
  return std::move(*selected);
}
}
