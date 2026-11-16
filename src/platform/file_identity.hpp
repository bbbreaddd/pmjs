#pragma once

#include <cstdint>
#include <filesystem>
#include <span>
#include <string>
#include <sys/stat.h>

namespace pmjs {
std::string fileIdentity(const std::filesystem::path& canonicalPath, const struct stat& info);
std::string fileIdentity(const std::filesystem::path& path);
bool validContentHash(const std::string& hash);
bool inodeOnlyChange(const std::string& expected, const std::string& actual);
bool contentHashMatches(std::span<const std::uint8_t> bytes, const std::string& expected);
// Hash the opened object and reject path replacement or mutation during verification.
bool fileContentMatches(const std::filesystem::path& path, const std::string& identity,
                        const std::string& expectedHash);
}
