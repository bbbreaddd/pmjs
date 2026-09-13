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

std::optional<std::filesystem::path> Vfs::resolve(const std::string& path) const {
  const auto key = normalize(path);
  if (!key) return std::nullopt;
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
  std::filesystem::path directory;
  if (path.empty() || path == ".") {
    directory = root_;
  } else {
    const auto normalized = normalize(path);
    if (!normalized) return std::nullopt;
    const auto found = directories_.find(*normalized);
    if (found == directories_.end()) return std::nullopt;
    directory = found->second;
  }

  std::vector<std::string> entries;
  for (const auto& entry : std::filesystem::directory_iterator(directory)) {
    entries.push_back(entry.path().filename().string());
  }
  std::sort(entries.begin(), entries.end());
  return entries;
}

bool Vfs::exists(const std::string& path) const {
  const auto normalized = normalize(path);
  return normalized && (files_.contains(*normalized) || directories_.contains(*normalized));
}

bool Vfs::isDirectory(const std::string& path) const {
  const auto normalized = normalize(path);
  return normalized && directories_.contains(*normalized);
}

}  // namespace pmjs
