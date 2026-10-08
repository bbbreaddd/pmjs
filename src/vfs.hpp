#pragma once

#include <filesystem>
#include <atomic>
#include <cstdint>
#include <optional>
#include <memory>
#include <unordered_set>
#include <string>
#include <unordered_map>
#include <vector>

namespace pmjs {

class FileReader {
 public:
  FileReader(int descriptor, std::uint64_t position) : descriptor_(descriptor), position_(position) {}
  ~FileReader();
  FileReader(const FileReader&) = delete;
  FileReader& operator=(const FileReader&) = delete;
  std::vector<std::uint8_t> read(std::size_t maxBytes);
  void close();
 private:
  int descriptor_;
  std::uint64_t position_;
};

class Vfs {
 public:
  struct DerivedFile {
    std::string logical, source, settings;
    std::filesystem::path file;
    std::string sourceIdentity, settingsIdentity, fileIdentity;
  };
  explicit Vfs(std::filesystem::path root);

  static std::string fileIdentity(const std::filesystem::path& path);
  void installDerivedFiles(const std::vector<DerivedFile>& files, bool catalog = false);
  std::string derivedIdentity(const std::string& path) const;
  std::optional<std::filesystem::path> resolveDerived(const std::string& path) const;

  bool consumeDerivedInvalidation() { return derivedInvalidated_->exchange(false, std::memory_order_relaxed); }

  void mountWritableOverlay(const std::filesystem::path& root);
  void updateWritableOverlay(const std::vector<std::string>& paths,
                             const std::vector<std::string>& deletionMarkers);

  std::optional<std::filesystem::path> resolve(const std::string& path) const;
  std::optional<std::string> readText(const std::string& path) const;
  std::optional<std::vector<std::uint8_t>> readBytes(const std::string& path) const;
  std::unique_ptr<FileReader> openRead(const std::string& path, std::uint64_t start = 0) const;
  std::optional<std::vector<std::string>> readDirectory(const std::string& path) const;
  bool exists(const std::string& path) const;
  bool isDirectory(const std::string& path) const;
  const std::filesystem::path& root() const { return root_; }

 private:
  static std::optional<std::string> normalize(const std::string& path);
  std::optional<std::filesystem::path> resolveOriginal(const std::string& path) const;
  void indexPath(const std::filesystem::path& path);

  struct Overlay {
    std::shared_ptr<const Vfs> files;
    std::unordered_set<std::string> deleted;
    bool hides(const std::string& key) const;
  };
  std::shared_ptr<std::atomic<bool>> derivedInvalidated_ = std::make_shared<std::atomic<bool>>(false);
  std::shared_ptr<const Overlay> overlay_;
  std::shared_ptr<const std::unordered_map<std::string, DerivedFile>> derived_;
  std::filesystem::path root_;
  std::unordered_map<std::string, std::filesystem::path> files_;
  std::unordered_map<std::string, std::filesystem::path> directories_;
};

}  // namespace pmjs
