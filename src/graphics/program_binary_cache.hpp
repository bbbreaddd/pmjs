#pragma once

#include <cstdint>
#include <filesystem>
#include <span>
#include <string>
#include <string_view>
#include <vector>

namespace pmjs {

struct ProgramAttributeBinding {
  std::uint32_t location;
  const char* name;
};

class ProgramBinaryCache {
 public:
  explicit ProgramBinaryCache(std::filesystem::path root = {});
  std::string key(std::string_view vertex, std::string_view fragment,
                  std::span<const ProgramAttributeBinding> attributes = {}) noexcept;
  std::uint32_t load(const std::string& key) noexcept;
  void prepare(std::uint32_t program, const std::string& key) const;
  void store(const std::string& key, std::uint32_t program) noexcept;

 private:
  void prune();
  std::filesystem::path root_;
  bool inspected_ = false;
  std::string identity_;
  std::vector<int> formats_;
};

}  // namespace pmjs
