#pragma once

#include <filesystem>
#include <cstdint>
#include <optional>
#include <string>
#include <unordered_map>
#include <vector>

namespace pmjs {

class Vfs {
 public:
  explicit Vfs(std::filesystem::path root);

  std::optional<std::filesystem::path> resolve(const std::string& path) const;
  std::optional<std::string> readText(const std::string& path) const;
  std::optional<std::vector<std::uint8_t>> readBytes(const std::string& path) const;
  std::optional<std::vector<std::string>> readDirectory(const std::string& path) const;
  bool exists(const std::string& path) const;
  bool isDirectory(const std::string& path) const;
  const std::filesystem::path& root() const { return root_; }

 private:
  static std::optional<std::string> normalize(const std::string& path);

  std::filesystem::path root_;
  std::unordered_map<std::string, std::filesystem::path> files_;
  std::unordered_map<std::string, std::filesystem::path> directories_;
};

}  // namespace pmjs
