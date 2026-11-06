#include "program_binary_cache.hpp"

#include <GLES3/gl3.h>
extern "C" {
#include <libavutil/mem.h>
#include <libavutil/sha.h>
}
#include <algorithm>
#include <array>
#include <cstdio>
#include <fstream>
#include <memory>
#include <unistd.h>

namespace pmjs {
namespace {
constexpr std::size_t headerBytes = 48, maxBinaryBytes = 4 * 1024 * 1024;
constexpr std::size_t maxCacheBytes = 16 * 1024 * 1024, maxEntries = 64;
constexpr std::array<std::uint8_t, 8> magic{'P', 'M', 'J', 'S', 'P', 'B', 1, 0};

std::array<std::uint8_t, 32> digest(std::span<const std::uint8_t> bytes, std::string_view prefix = {}) {
  std::unique_ptr<AVSHA, decltype(&av_free)> sha(av_sha_alloc(), av_free);
  if (!sha) throw std::bad_alloc();
  std::array<std::uint8_t, 32> result{};
  av_sha_init(sha.get(), 256);
  if (!prefix.empty()) av_sha_update(sha.get(), reinterpret_cast<const std::uint8_t*>(prefix.data()), prefix.size());
  av_sha_update(sha.get(), bytes.data(), bytes.size());
  av_sha_final(sha.get(), result.data());
  return result;
}
void put32(std::uint8_t* target, std::uint32_t value) {
  for (int i = 0; i < 4; ++i) target[i] = static_cast<std::uint8_t>(value >> (8 * i));
}
std::uint32_t get32(const std::uint8_t* source) {
  std::uint32_t value = 0;
  for (int i = 0; i < 4; ++i) value |= std::uint32_t(source[i]) << (8 * i);
  return value;
}
}

ProgramBinaryCache::ProgramBinaryCache(std::filesystem::path root) : root_(std::move(root)) {}

std::string ProgramBinaryCache::key(std::string_view vertex, std::string_view fragment,
    std::span<const ProgramAttributeBinding> attributes) noexcept {
  if (root_.empty()) return {};
  try {
    if (!inspected_) {
      GLint count = 0;
      glGetIntegerv(GL_NUM_PROGRAM_BINARY_FORMATS, &count);
      if (count > 0 && count <= 256) {
        formats_.resize(count);
        glGetIntegerv(GL_PROGRAM_BINARY_FORMATS, formats_.data());
        for (GLenum property : {GL_VENDOR, GL_RENDERER, GL_VERSION, GL_SHADING_LANGUAGE_VERSION}) {
          const auto* value = glGetString(property);
          if (!value) { formats_.clear(); break; }
          identity_.append(reinterpret_cast<const char*>(value)); identity_ += '\0';
        }
      }
      inspected_ = true;
    }
    if (formats_.empty()) return {};
    auto source = std::string("pmjs-program-binary-v1\0", 23) + identity_;
    source.append(vertex); source += '\0'; source.append(fragment); source += '\0';
    for (const auto& attribute : attributes) {
      source += std::to_string(attribute.location); source += ':';
      source += attribute.name; source += '\0';
    }
    const auto hash = digest({reinterpret_cast<const std::uint8_t*>(source.data()), source.size()});
    std::string result;
    for (auto byte : hash) { result += "0123456789abcdef"[byte >> 4]; result += "0123456789abcdef"[byte & 15]; }
    return result;
  } catch (...) { return {}; }
}

std::uint32_t ProgramBinaryCache::load(const std::string& cacheKey) noexcept {
  if (cacheKey.empty()) return 0;
  GLuint program = 0;
  try {
    const auto file = root_ / (cacheKey + ".bin");
    const auto size = std::filesystem::file_size(file);
    if (size <= headerBytes || size > headerBytes + maxBinaryBytes) return 0;
    std::ifstream input(file, std::ios::binary);
    std::array<std::uint8_t, headerBytes> header{};
    if (!input.read(reinterpret_cast<char*>(header.data()), header.size()) ||
        !std::equal(magic.begin(), magic.end(), header.begin()) ||
        get32(header.data() + 12) != size - headerBytes) return 0;
    const auto format = get32(header.data() + 8);
    if (std::find(formats_.begin(), formats_.end(), static_cast<int>(format)) == formats_.end()) return 0;
    std::vector<std::uint8_t> bytes(size - headerBytes);
    if (!input.read(reinterpret_cast<char*>(bytes.data()), bytes.size())) return 0;
    const auto hash = digest(bytes, cacheKey);
    if (!std::equal(hash.begin(), hash.end(), header.begin() + 16)) return 0;
    program = glCreateProgram();
    glProgramBinary(program, format, bytes.data(), static_cast<GLsizei>(bytes.size()));
    GLint linked = GL_FALSE;
    glGetProgramiv(program, GL_LINK_STATUS, &linked);
    if (linked == GL_TRUE) return program;
  } catch (...) {}
  if (program) glDeleteProgram(program);
  return 0;
}

void ProgramBinaryCache::prepare(std::uint32_t program, const std::string& cacheKey) const {
  if (!cacheKey.empty()) glProgramParameteri(program, GL_PROGRAM_BINARY_RETRIEVABLE_HINT, GL_TRUE);
}

void ProgramBinaryCache::store(const std::string& cacheKey, std::uint32_t program) noexcept {
  if (cacheKey.empty()) return;
  std::filesystem::path temporary;
  try {
    GLint size = 0;
    glGetProgramiv(program, GL_PROGRAM_BINARY_LENGTH, &size);
    if (size <= 0 || static_cast<std::size_t>(size) > maxBinaryBytes) return;
    std::vector<std::uint8_t> bytes(size);
    GLenum format = 0;
    GLsizei written = 0;
    glGetProgramBinary(program, size, &written, &format, bytes.data());
    if (written <= 0 || written > size) return;
    bytes.resize(written);
    std::array<std::uint8_t, headerBytes> header{};
    std::copy(magic.begin(), magic.end(), header.begin());
    put32(header.data() + 8, format); put32(header.data() + 12, written);
    const auto hash = digest(bytes, cacheKey); std::copy(hash.begin(), hash.end(), header.begin() + 16);
    std::filesystem::create_directories(root_);
    auto name = (root_ / ".pending-XXXXXX").string();
    const int descriptor = mkstemp(name.data());
    if (descriptor < 0) return;
    temporary = name;
    const auto closeFile = [](std::FILE* file) { std::fclose(file); };
    std::unique_ptr<std::FILE, decltype(closeFile)> output(fdopen(descriptor, "wb"), closeFile);
    if (!output) { close(descriptor); std::filesystem::remove(temporary); return; }
    const bool writtenAll = std::fwrite(header.data(), 1, header.size(), output.get()) == header.size() &&
      std::fwrite(bytes.data(), 1, bytes.size(), output.get()) == bytes.size();
    const bool closed = std::fclose(output.release()) == 0;
    if (!writtenAll || !closed) { std::filesystem::remove(temporary); return; }
    std::filesystem::rename(temporary, root_ / (cacheKey + ".bin"));
    temporary.clear();
    prune();
  } catch (...) {
    if (!temporary.empty()) { std::error_code error; std::filesystem::remove(temporary, error); }
  }
}

void ProgramBinaryCache::prune() {
  struct Entry { std::filesystem::path path; std::filesystem::file_time_type time; std::uintmax_t bytes; };
  std::vector<Entry> entries;
  std::uintmax_t total = 0;
  for (const auto& file : std::filesystem::directory_iterator(root_)) {
    if (!file.is_regular_file()) continue;
    const auto time = file.last_write_time();
    if (file.path().filename().string().starts_with(".pending-")) {
      if (std::filesystem::file_time_type::clock::now() - time > std::chrono::hours(24))
        std::filesystem::remove(file.path());
      continue;
    }
    if (file.path().extension() != ".bin") continue;
    const auto bytes = file.file_size();
    entries.push_back({file.path(), time, bytes}); total += bytes;
  }
  std::sort(entries.begin(), entries.end(), [](const auto& a, const auto& b) { return a.time < b.time; });
  auto count = entries.size();
  for (const auto& entry : entries) {
    if (count <= maxEntries && total <= maxCacheBytes) break;
    if (std::filesystem::remove(entry.path)) { total -= entry.bytes; --count; }
  }
}

}  // namespace pmjs
