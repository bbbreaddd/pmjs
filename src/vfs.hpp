#pragma once

#include <filesystem>
#include <cstdint>
#include <optional>
#include <memory>
#include <unordered_set>
#include <string>
#include <unordered_map>
#include <vector>

namespace pmjs {

class Vfs {
 public:
  explicit Vfs(std::filesystem::path root);

  void mountWritableOverlay(const std::filesystem::path& root);
  void updateWritableOverlay(const std::vector<std::string>& paths,
                             const std::vector<std::string>& deletionMarkers);

  std::optional<std::filesystem::path> resolve(const std::string& path) const;
  std::optional<std::string> readText(const std::string& path) const;
  std::optional<std::vector<std::uint8_t>> readBytes(const std::string& path) const;
  std::optional<std::vector<std::string>> readDirectory(const std::string& path) const;
  bool exists(const std::string& path) const;
  bool isDirectory(const std::string& path) const;
  const std::filesystem::path& root() const { return root_; }

 private:
  static std::optional<std::string> normalize(const std::string& path);
  void indexPath(const std::filesystem::path& path);

  struct Overlay {
    std::shared_ptr<const Vfs> files;
    std::unordered_set<std::string> deleted;
    bool hides(const std::string& key) const;
  };
  std::shared_ptr<const Overlay> overlay_;
  std::filesystem::path root_;
  std::unordered_map<std::string, std::filesystem::path> files_;
  std::unordered_map<std::string, std::filesystem::path> directories_;
};

}  // namespace pmjs
