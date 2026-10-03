#include "vfs.hpp"

#include <algorithm>
#include <cctype>
#include <fstream>
#include <sstream>
#include <stdexcept>

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

Vfs::Vfs(std::filesystem::path root) : root_(std::filesystem::canonical(root)) {
  const auto options = std::filesystem::directory_options::skip_permission_denied;
  for (const auto& entry :
       std::filesystem::recursive_directory_iterator(root_, options)) {
    const auto relative = entry.path().lexically_relative(root_).generic_string();
    const auto key = normalize(relative);
    if (!key) continue;

    std::error_code error;
    const auto target = std::filesystem::canonical(entry.path(), error);
    if (error || !isContainedBy(root_, target)) continue;
    const auto status = entry.status(error);
    if (error) continue;

    auto insert = [&](auto& entries) {
      const auto logicalPath = entry.path().lexically_normal();
      const auto [position, inserted] = entries.emplace(*key, logicalPath);
      if (!inserted && position->second != logicalPath) {
        throw std::runtime_error("case-insensitive path collision: " +
                                 position->second.string() + " and " +
                                 logicalPath.string());
      }
    };
    if (std::filesystem::is_directory(status)) {
      insert(directories_);
      continue;
    }
    if (std::filesystem::is_regular_file(status)) insert(files_);
  }
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
    std::string decoded;
    auto hex = [](char value) -> int {
      if (value >= '0' && value <= '9') return value - '0';
      if (value >= 'a' && value <= 'f') return value - 'a' + 10;
      return -1;
    };
    if (name.size() % 2) continue;
    for (std::size_t index = 0; index < name.size(); index += 2) {
      const auto high = hex(name[index]), low = hex(name[index + 1]);
      if (high < 0 || low < 0) { decoded.clear(); break; }
      decoded.push_back(static_cast<char>(high * 16 + low));
    }
    const auto key = normalize(decoded);
    if (key) overlay->deleted.insert(*key);
  }
  // Async asset decoders retain an immutable view while mutations publish the next one.
  std::atomic_store(&overlay_, std::shared_ptr<const Overlay>(std::move(overlay)));
}

std::optional<std::filesystem::path> Vfs::resolve(const std::string& path) const {
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
  return files_.contains(*key) || directories_.contains(*key);
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
