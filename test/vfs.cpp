#include "vfs.hpp"

#include <chrono>
#include <filesystem>
#include <fstream>
#include <iostream>
#include <stdexcept>
#include <string>

namespace {

class TemporaryDirectory {
 public:
  explicit TemporaryDirectory(const std::string& label) {
    const auto nonce = std::chrono::steady_clock::now().time_since_epoch().count();
    path_ = std::filesystem::temp_directory_path() /
            ("pmjs-vfs-" + label + "-" + std::to_string(nonce));
    std::filesystem::create_directories(path_);
  }

  ~TemporaryDirectory() {
    std::error_code error;
    std::filesystem::remove_all(path_, error);
  }

  const std::filesystem::path& path() const { return path_; }

 private:
  std::filesystem::path path_;
};

void write(const std::filesystem::path& path, const std::string& contents) {
  std::ofstream output(path, std::ios::binary);
  if (!output.write(contents.data(), static_cast<std::streamsize>(contents.size()))) {
    throw std::runtime_error("cannot write VFS fixture");
  }
}

void require(bool condition, const std::string& message) {
  if (!condition) throw std::runtime_error(message);
}

}  // namespace

int main() try {
  TemporaryDirectory fixture("aliases");
  const auto root = fixture.path() / "game";
  const auto outside = fixture.path() / "outside.txt";
  std::filesystem::create_directories(root / "data");
  write(root / "data" / "System.json", "system-data");
  write(outside, "outside-data");
  std::filesystem::create_symlink("System.json", root / "data" / "System.alias");
  std::filesystem::create_symlink(outside, root / "data" / "Outside.alias");
  std::filesystem::create_symlink("Missing.json", root / "data" / "Broken.alias");

  const auto linkedRoot = fixture.path() / "linked-game";
  std::filesystem::create_directory_symlink(root, linkedRoot);
  pmjs::Vfs vfs(linkedRoot);
  require(vfs.readText("DATA/system.JSON") == "system-data",
          "case-insensitive ordinary file lookup failed");
  require(vfs.readText("data/System.alias") == "system-data",
          "contained logical alias was not preserved");
  require(vfs.resolve("data/System.json") != vfs.resolve("data/System.alias"),
          "logical alias collapsed into its canonical target");
  require(!vfs.exists("data/Outside.alias"),
          "outside-root symlink was exposed");
  require(!vfs.exists("data/Broken.alias"),
          "broken symlink was exposed");

  const auto overlay = fixture.path() / "overlay";
  std::filesystem::create_directories(overlay / "files" / "data");
  std::filesystem::create_directories(overlay / "deleted");
  write(overlay / "files" / "data" / "system.JSON", "replacement");
  write(overlay / "files" / "created.bin", std::string("\0\x7f\x80\xff", 4));
  // Marker names are fixed-length hashes; the contents hold the normalized path.
  write(overlay / "deleted" / std::string(64, 'a'), "data/system.alias");
  vfs.mountWritableOverlay(overlay);
  require(vfs.readText("DATA/System.json") == "replacement", "overlay did not replace base");
  require(vfs.readText("created.bin")->size() == 4, "binary overlay read lost bytes");
  require(!vfs.exists("data/System.alias"), "deleted base file reappeared");
  require(vfs.isDirectory(".") && vfs.isDirectory("data"), "merged directory missing");
  const auto entries = vfs.readDirectory("data");
  require(entries && *entries == std::vector<std::string>{"system.JSON"},
          "listing did not merge case aliases and deletion markers");
  require(!vfs.resolve("../outside.txt"), "overlay allowed path traversal");
  write(overlay / "deleted" / std::string(64, 'b'), "data");
  std::filesystem::remove_all(overlay / "files" / "data");
  vfs.mountWritableOverlay(overlay);
  require(!vfs.exists("data") && !vfs.exists("data/System.json"),
          "directory deletion did not hide descendants");
  std::filesystem::create_directory(overlay / "files" / "data");
  write(overlay / "files" / "data" / "new.txt", "new");
  vfs.mountWritableOverlay(overlay);
  require(vfs.readDirectory("data") == std::vector<std::string>{"new.txt"},
          "recreated directory exposed deleted base descendants");
  pmjs::Vfs restarted(root);
  restarted.mountWritableOverlay(overlay);
  require(restarted.readText("data/new.txt") == "new" && !restarted.exists("data/System.json"),
          "overlay state did not persist through a fresh VFS");

  TemporaryDirectory collisionFixture("collision");
  write(collisionFixture.path() / "Name.txt", "upper");
  write(collisionFixture.path() / "name.TXT", "lower");
  bool rejectedCollision = false;
  try {
    pmjs::Vfs collision(collisionFixture.path());
  } catch (const std::runtime_error&) {
    rejectedCollision = true;
  }
  require(rejectedCollision, "ambiguous case collision was accepted");
  return 0;
} catch (const std::exception& error) {
  std::cerr << error.what() << '\n';
  return 1;
}
