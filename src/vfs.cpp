#include "vfs.hpp"

#include <algorithm>
#include <cctype>
#include <fstream>
#include <sstream>
#include <stdexcept>
#include <sys/stat.h>
#include <fcntl.h>
#include <unistd.h>
#include <cerrno>
#include <system_error>
#include <limits>

namespace pmjs {

namespace {

bool isContainedBy(const std::filesystem::path& root,
                   const std::filesystem::path& target) {
  const auto relative = target.lexically_relative(root);
  if (relative.empty()) return target == root;
  for (const auto& component : relative) {
    if (component == "..") return false;
  }
  return !relative.is_absolute();
}

}  // namespace

FileReader::~FileReader() { close(); }

void FileReader::close() {
  if (descriptor_ >= 0) { ::close(descriptor_); descriptor_ = -1; }
}

std::vector<std::uint8_t> FileReader::read(std::size_t maxBytes) {
  if (descriptor_ < 0) throw std::system_error(EBADF, std::generic_category(), "read");
  if (maxBytes > static_cast<std::size_t>(std::numeric_limits<ssize_t>::max()) ||
      position_ > static_cast<std::uint64_t>(std::numeric_limits<off_t>::max()))
    throw std::system_error(EINVAL, std::generic_category(), "read range");
  std::vector<std::uint8_t> bytes(maxBytes);
  ssize_t count;
  do { count = ::pread(descriptor_, bytes.data(), maxBytes, static_cast<off_t>(position_)); }
  while (count < 0 && errno == EINTR);
  if (count < 0) throw std::system_error(errno, std::generic_category(), "read");
  position_ += static_cast<std::uint64_t>(count);
  bytes.resize(static_cast<std::size_t>(count));
  return bytes;
}

std::unique_ptr<FileReader> Vfs::openRead(const std::string& path, std::uint64_t start) const {
  const auto resolved = resolve(path);
  if (!resolved) {
    if (isDirectory(path)) throw std::system_error(EISDIR, std::generic_category(), "open");
    return nullptr;
  }
  const int descriptor = ::open(resolved->c_str(), O_RDONLY | O_CLOEXEC);
  if (descriptor < 0) {
    if (errno == ENOENT) return nullptr;
    throw std::system_error(errno, std::generic_category(), "open");
  }
  try { return std::make_unique<FileReader>(descriptor, start); }
  catch (...) { ::close(descriptor); throw; }
}

Vfs::Vfs(std::filesystem::path root) : root_(std::filesystem::canonical(root)) {
  const auto options = std::filesystem::directory_options::skip_permission_denied;
  for (const auto& entry :
       std::filesystem::recursive_directory_iterator(root_, options)) {
    indexPath(entry.path());
  }
}

void Vfs::indexPath(const std::filesystem::path& path) {
  const auto relative = path.lexically_relative(root_).generic_string();
  const auto key = normalize(relative);
  if (!key) return;

  std::error_code error;
  const auto target = std::filesystem::canonical(path, error);
  if (error || !isContainedBy(root_, target)) return;
  const auto status = std::filesystem::status(path, error);
  if (error) return;

  auto insert = [&](auto& entries) {
    const auto logicalPath = path.lexically_normal();
    const auto [position, inserted] = entries.emplace(*key, logicalPath);
    if (!inserted && position->second != logicalPath) {
      throw std::runtime_error("case-insensitive path collision: " +
                               position->second.string() + " and " +
                               logicalPath.string());
    }
  };
  if (std::filesystem::is_directory(status)) {
    insert(directories_);
    return;
  }
  if (std::filesystem::is_regular_file(status)) insert(files_);
}

std::optional<std::string> Vfs::normalize(const std::string& path) {
  std::filesystem::path parsed(path);
  if (parsed.is_absolute()) return std::nullopt;
  std::string result;
  for (const auto& component : parsed.lexically_normal()) {
    const std::string part = component.generic_string();
    if (part.empty() || part == ".") continue;
    if (part == "..") return std::nullopt;
    if (!result.empty()) result.push_back('/');
    for (unsigned char character : part) {
      result.push_back(static_cast<char>(std::tolower(character)));
    }
  }
  if (result.empty()) return std::nullopt;
  return result;
}

bool Vfs::Overlay::hides(const std::string& key) const {
  auto prefix = key;
  while (!prefix.empty()) {
    if (deleted.contains(prefix)) return true;
    const auto slash = prefix.rfind('/');
    if (slash == std::string::npos) break;
    prefix.resize(slash);
  }
  return false;
}

void Vfs::mountWritableOverlay(const std::filesystem::path& root) {
  auto overlay = std::make_shared<Overlay>();
  overlay->files = std::make_shared<Vfs>(root / "files");
  for (const auto& entry : std::filesystem::directory_iterator(root / "deleted")) {
    if (!entry.is_regular_file()) continue;
    const auto name = entry.path().filename().string();
    if (name.size() != 64 || !std::all_of(name.begin(), name.end(), [](char value) {
          return (value >= '0' && value <= '9') || (value >= 'a' && value <= 'f');
        })) continue;
    std::ifstream input(entry.path(), std::ios::binary);
    std::ostringstream contents;
    contents << input.rdbuf();
    const auto key = normalize(contents.str());
    if (key) overlay->deleted.insert(*key);
  }
  // Async asset decoders retain an immutable view while mutations publish the next one.
  std::atomic_store(&overlay_, std::shared_ptr<const Overlay>(std::move(overlay)));
}

void Vfs::updateWritableOverlay(const std::vector<std::string>& paths,
                               const std::vector<std::string>& deletionMarkers) {
  const auto previous = std::atomic_load(&overlay_);
  if (!previous) throw std::runtime_error("writable overlay is not mounted");
  auto overlay = std::make_shared<Overlay>(*previous);
  auto files = std::make_shared<Vfs>(*previous->files);
  for (const auto& relative : paths) {
    const auto key = normalize(relative);
    if (!key) throw std::runtime_error("invalid overlay update path: " + relative);
    files->files_.erase(*key);
    if (files->directories_.erase(*key)) {
      const auto prefix = *key + '/';
      std::erase_if(files->files_, [&](const auto& entry) { return entry.first.starts_with(prefix); });
      std::erase_if(files->directories_, [&](const auto& entry) { return entry.first.starts_with(prefix); });
    }
    const auto path = (files->root_ / relative).lexically_normal();
    files->indexPath(path);
    for (auto parent = path.parent_path(); parent != files->root_; parent = parent.parent_path()) {
      files->indexPath(parent);
    }
    if (files->directories_.contains(*key)) {
      for (const auto& entry : std::filesystem::recursive_directory_iterator(path)) files->indexPath(entry.path());
    }
  }
  for (const auto& name : deletionMarkers) {
    if (name.size() != 64 || !std::all_of(name.begin(), name.end(), [](char value) {
          return (value >= '0' && value <= '9') || (value >= 'a' && value <= 'f');
        })) throw std::runtime_error("invalid overlay deletion marker");
    std::ifstream input(files->root_.parent_path() / "deleted" / name, std::ios::binary);
    if (!input) continue;
    std::ostringstream contents;
    contents << input.rdbuf();
    if (const auto key = normalize(contents.str())) overlay->deleted.insert(*key);
  }
  overlay->files = std::move(files);
  std::atomic_store(&overlay_, std::shared_ptr<const Overlay>(std::move(overlay)));
}

std::string Vfs::fileIdentity(const std::filesystem::path& path) {
  std::error_code error;
  const auto resolved = std::filesystem::canonical(path, error);
  struct stat info{};
  if (error || ::stat(resolved.c_str(), &info) != 0 || !S_ISREG(info.st_mode)) return {};
  return resolved.generic_string() + ':' + std::to_string(info.st_dev) + ':' +
    std::to_string(info.st_ino) + ':' + std::to_string(info.st_size) + ':' +
    std::to_string(info.st_mtim.tv_sec) + ':' + std::to_string(info.st_mtim.tv_nsec) + ':' +
    std::to_string(info.st_ctim.tv_sec) + ':' + std::to_string(info.st_ctim.tv_nsec);
}

void Vfs::installDerivedFiles(const std::vector<DerivedFile>& files, bool catalog) {
  auto index = std::make_shared<std::unordered_map<std::string, DerivedFile>>();
  for (auto file : files) {
    const auto key = normalize(file.logical);
    const auto source = catalog ? std::optional<std::filesystem::path>{} : resolveOriginal(file.source);
    const auto settings = catalog ? std::optional<std::filesystem::path>{} : resolveOriginal(file.settings);
    if (catalog) {
      if (!key || !normalize(file.source) || !normalize(file.settings) || !file.file.is_absolute() ||
          file.sourceIdentity.empty() || file.settingsIdentity.empty() || file.fileIdentity.empty())
        throw std::runtime_error("invalid derived catalog entry");
    } else {
      if (!key || !source || !settings || !file.file.is_absolute() ||
          file.sourceIdentity.empty() || file.settingsIdentity.empty() ||
          fileIdentity(*source) != file.sourceIdentity || fileIdentity(*settings) != file.settingsIdentity) continue;
      file.fileIdentity = fileIdentity(file.file);
    }
    if (!file.fileIdentity.empty() && !index->emplace(*key, std::move(file)).second)
      throw std::runtime_error("duplicate derived file path");
  }
  std::atomic_store(&derived_, std::shared_ptr<const std::unordered_map<std::string, DerivedFile>>(std::move(index)));
}

std::string Vfs::derivedIdentity(const std::string& path) const {
  const auto key = normalize(path);
  const auto index = std::atomic_load(&derived_);
  if (!key || !index) return {};
  const auto entry = index->find(*key);
  return entry == index->end() ? std::string{} : entry->second.fileIdentity;
}

std::optional<std::filesystem::path> Vfs::resolveDerived(const std::string& path) const {
  const auto key = normalize(path);
  const auto index = std::atomic_load(&derived_);
  if (!key || !index) return std::nullopt;
  const auto found = index->find(*key);
  if (found == index->end()) return std::nullopt;
  if (const auto original = resolveOriginal(path)) return original;
  if (isDirectory(path)) return std::nullopt;
  const auto overlay = std::atomic_load(&overlay_);
  if (overlay && overlay->hides(*key)) return std::nullopt;
  if (overlay) {
    auto prefix = *key;
    while (prefix.find('/') != std::string::npos) {
      prefix.resize(prefix.rfind('/'));
      if (overlay->files->files_.contains(prefix)) return std::nullopt;
    }
  }
  const auto& entry = found->second;
  const auto source = resolveOriginal(entry.source), settings = resolveOriginal(entry.settings);
  if (!source || !settings || fileIdentity(*source) != entry.sourceIdentity ||
      fileIdentity(*settings) != entry.settingsIdentity || fileIdentity(entry.file) != entry.fileIdentity) {
    derivedInvalidated_->store(true, std::memory_order_relaxed);
    return std::nullopt;
  }
  return entry.file;
}

std::optional<std::filesystem::path> Vfs::resolve(const std::string& path) const {
  if (auto original = resolveOriginal(path)) return original;
  return resolveDerived(path);
}

std::optional<std::filesystem::path> Vfs::resolveOriginal(const std::string& path) const {
  const auto key = normalize(path);
  if (!key) return std::nullopt;
  const auto overlay = std::atomic_load(&overlay_);
  if (overlay) {
    auto prefix = *key;
    while (prefix.find('/') != std::string::npos) {
      prefix.resize(prefix.rfind('/'));
      if (overlay->files->files_.contains(prefix)) return std::nullopt;
    }
    if (overlay->files->exists(*key)) return overlay->files->resolve(*key);
    if (overlay->hides(*key)) return std::nullopt;
  }
  const auto found = files_.find(*key);
  if (found == files_.end()) return std::nullopt;
  return found->second;
}

std::optional<std::string> Vfs::readText(const std::string& path) const {
  const auto resolved = resolve(path);
  if (!resolved) return std::nullopt;
  std::ifstream input(*resolved, std::ios::binary);
  if (!input) return std::nullopt;
  std::ostringstream contents;
  contents << input.rdbuf();
  return contents.str();
}

std::optional<std::vector<std::uint8_t>> Vfs::readBytes(const std::string& path) const {
  const auto resolved = resolve(path);
  if (!resolved) return std::nullopt;
  std::ifstream input(*resolved, std::ios::binary | std::ios::ate);
  if (!input) return std::nullopt;
  const auto length = input.tellg();
  if (length < 0) return std::nullopt;
  std::vector<std::uint8_t> contents(static_cast<std::size_t>(length));
  input.seekg(0);
  if (!contents.empty() && !input.read(reinterpret_cast<char*>(contents.data()), length)) {
    return std::nullopt;
  }
  return contents;
}

std::optional<std::vector<std::string>> Vfs::readDirectory(const std::string& path) const {
  const bool root = path.empty() || path == ".";
  const auto key = root ? std::optional<std::string>("") : normalize(path);
  if (!key || !isDirectory(root ? "." : *key)) return std::nullopt;
  const auto overlay = std::atomic_load(&overlay_);
  std::unordered_map<std::string, std::string> merged;
  auto add = [&](const std::filesystem::path& directory) {
    for (const auto& entry : std::filesystem::directory_iterator(directory)) {
      const auto name = entry.path().filename().string();
      const auto child = key->empty() ? name : *key + "/" + name;
      const auto childKey = normalize(child);
      if (childKey && exists(child)) merged[*childKey] = name;
    }
  };
  const auto base = directories_.find(*key);
  if (!overlay || !overlay->hides(*key)) {
    if (root) add(root_);
    else if (base != directories_.end()) add(base->second);
  }
  if (overlay) {
    const auto directory = overlay->files->directories_.find(*key);
    if (root) add(overlay->files->root());
    else if (directory != overlay->files->directories_.end()) add(directory->second);
  }
  const auto derived = std::atomic_load(&derived_);
  if (derived) {
    for (const auto& [childKey, entry] : *derived) {
      const auto slash = childKey.rfind('/');
      const auto parent = slash == std::string::npos ? std::string{} : childKey.substr(0, slash);
      if (parent == *key && exists(entry.logical))
        merged[childKey] = std::filesystem::path(entry.logical).filename().string();
    }
  }
  std::vector<std::string> entries;
  for (const auto& [child, name] : merged) entries.push_back(name);
  std::sort(entries.begin(), entries.end());
  return entries;
}

bool Vfs::exists(const std::string& path) const {
  if (path.empty() || path == ".") return true;
  const auto key = normalize(path);
  if (!key) return false;
  const auto overlay = std::atomic_load(&overlay_);
  if (overlay) {
    auto prefix = *key;
    while (prefix.find('/') != std::string::npos) {
      prefix.resize(prefix.rfind('/'));
      if (overlay->files->files_.contains(prefix)) return false;
    }
    if (overlay->files->exists(*key)) return true;
    if (overlay->hides(*key)) return false;
  }
  return files_.contains(*key) || directories_.contains(*key) || resolveDerived(path).has_value();
}

bool Vfs::isDirectory(const std::string& path) const {
  if (path.empty() || path == ".") return true;
  const auto key = normalize(path);
  if (!key) return false;
  const auto overlay = std::atomic_load(&overlay_);
  if (overlay) {
    auto prefix = *key;
    while (prefix.find('/') != std::string::npos) {
      prefix.resize(prefix.rfind('/'));
      if (overlay->files->files_.contains(prefix)) return false;
    }
    if (overlay->files->exists(*key)) return overlay->files->isDirectory(*key);
    if (overlay->hides(*key)) return false;
  }
  return directories_.contains(*key);
}

}  // namespace pmjs
