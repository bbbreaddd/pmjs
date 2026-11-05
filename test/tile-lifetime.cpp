#include "platform.hpp"
#include "resources.hpp"
#include "tile_assets.hpp"

#include <algorithm>
#include <array>
#include <filesystem>
#include <fstream>
#include <iostream>
#include <stdexcept>
#include <unistd.h>
extern "C" {
#include <libavutil/mem.h>
#include <libavutil/sha.h>
}

namespace {
void require(bool value, const char* message) {
  if (!value) throw std::runtime_error(message);
}
std::string sha256(const std::filesystem::path& path) {
  std::ifstream input(path, std::ios::binary);
  const std::string bytes((std::istreambuf_iterator<char>(input)), std::istreambuf_iterator<char>());
  auto* context = av_sha_alloc();
  require(context && av_sha_init(context, 256) == 0, "sha256 unavailable");
  av_sha_update(context, reinterpret_cast<const std::uint8_t*>(bytes.data()), bytes.size());
  std::array<std::uint8_t, 32> digest{};
  av_sha_final(context, digest.data());
  av_free(context);
  std::string hex;
  for (const auto byte : digest) { hex += "0123456789abcdef"[byte >> 4]; hex += "0123456789abcdef"[byte & 15]; }
  return hex;
}
std::size_t fileCount() {
  return std::distance(std::filesystem::directory_iterator("/proc/self/fd"),
                       std::filesystem::directory_iterator{});
}
}
int main() try {
  unsetenv("PMJS_GRAPHICS_DIAGNOSTICS");
  pmjs::Platform platform(32, 32, "Tile ownership");
  char temporary[] = "/tmp/pmjs-tile-lifetime-XXXXXX";
  const auto* directory = mkdtemp(temporary);
  require(directory, "temporary directory failed");
  const std::filesystem::path root(directory);
  pmjs::ImagePixels pixels{6, 6, std::vector<std::uint8_t>(6*6*4, 127)};
  pmjs::writePreparedPng(root/"source.png", 6, 6, pixels.rgba);
  pmjs::writePreparedPng(root/"snapshot.png", 6, 6, pixels.rgba);
  pmjs::ImagePixels page{8, 8, std::vector<std::uint8_t>(8*8*4, 127)};
  {
    pmjs::ImageStore images;
    images.setWarmBudgetBytes(0);
    const auto baseline = fileCount();
    pmjs::PreparedTileSet descriptor;
    descriptor.identity = "set-0"; descriptor.directory = root;
    descriptor.sources.push_back({root/"source.png", root/"snapshot.png",
      pmjs::ImageStore::openFile(root/"source.png")->key(), 6, 6,
      {{{0, 0, 3, 3}, {1, 1, 3, 3}, 0}}, {}});
    for (int i = 0; i < 150; ++i) {
      descriptor.identity = "set-"+std::to_string(i);
      const auto filename = "page-"+std::to_string(i)+".png";
      pmjs::writePreparedPng(root/filename, 8, 8, page.rgba);
      descriptor.pages = {{filename, 8, 8}};
      require(images.installTileSet(descriptor), "catalog installation failed");
    }
    require(fileCount() == baseline && images.liveCount() == 0 && images.warmFileCount() == 0,
      "unvisited map catalog retains descriptors");
    const auto catalogBytes = images.tileMetadataBytes();
    require(catalogBytes > 0, "catalog metadata not accounted");
    require(images.installTileSet(descriptor) && images.tileMetadataBytes() == catalogBytes,
      "catalog replacement duplicated metadata");
    auto image = images.loadPng(root/"source.png", false, "set-0");
    require(image && images.hasTileBacking(image->handle), "prepared load failed");
    require(fileCount() == baseline+1, "active backing should capture only the page file");
    const auto prototypeBytes = images.tileMetadataBytes()-catalogBytes;
    require(prototypeBytes > 0, "active backing metadata not accounted");
    auto view = images.createTileSlot(image->handle, 16, 16);
    require(view && images.tileMetadataBytes() == catalogBytes+prototypeBytes,
      "shared view duplicated backing metadata");
    images.release(view->handle); images.update();
    require(images.resolveSpriteRegion(image->handle, 0, 0, 3, 3).has_value(), "covered region failed");
    require(!images.resolveSpriteRegion(image->handle, 4, 4, 1, 1), "unknown region unexpectedly compact");
    images.notePreparedFallback(image->handle, "tile-linear-sampling");
    images.noteTileLoadFallback();
    require(images.tileRegions() == 0 && images.tileRegionSets().empty() && images.tileFallbacks().empty() &&
      images.tileHits() == 0 && images.tilePageDecodes() == 0 && images.tilePageUploads() == 0,
      "disabled tile diagnostics collected detailed counters");
    const auto covered = images.readPixelsRegion(image->handle, 1, 1, 1, 1);
    require(covered && covered->rgba == std::vector<std::uint8_t>(4, 127) &&
      !images.hasCpuPixels(image->handle), "covered read unnecessarily decoded ordinary source");
    require(fileCount() == baseline+1, "covered read captured the fallback snapshot");
    auto source = pmjs::ImageStore::openFile(root/"source.png");
    auto pending = images.capturePrepared(*source, "set-0");
    require(pending && images.validatePrepared(*pending, true), "worker snapshot validation failed");
    require(images.tileMetadataBytes() == catalogBytes+prototypeBytes,
      "pending shared load duplicated backing metadata");
    descriptor.identity = "set-0";
    descriptor.pages = {{"page-0.png", 8, 8}};
    require(images.installTileSet(descriptor) && images.tileMetadataBytes() == catalogBytes+prototypeBytes,
      "catalog replacement lost or duplicated retained backing metadata");
    std::ofstream(root/"snapshot.png") << "invalid";
    auto retained = images.installPreparedLoad(*source, std::move(pending), true);
    require(retained && retained->handle == image->handle && images.hasCpuPixels(image->handle),
      "worker snapshot not transferred into existing view");
    source.reset();
    require(fileCount() == baseline+2, "fallback read did not retain the page and snapshot files");
    for (int i = 0; i < 10; ++i) {
      const auto region = images.readPixelsRegion(image->handle, 5, 5, 1, 1);
      require(region && region->rgba == std::vector<std::uint8_t>(4, 127), "retained region redecodes source");
    }
    images.clearTileSetIndex();
    require(fileCount() == baseline+2, "catalog clearing invalidated active ownership");
    require(images.tileMetadataBytes() == prototypeBytes, "catalog clearing removed retained backing accounting");
    images.setWarmBudgetBytes(4*1024*1024);
    images.release(retained->handle); images.release(image->handle); images.update();
    require(images.tileMetadataBytes() == prototypeBytes, "warm eviction removed retained accounting prematurely");
    images.setWarmBudgetBytes(0); images.update();
    require(images.tileMetadataBytes() == 0, "final eviction retained backing metadata");
    require(fileCount() == baseline && images.warmFileCount() == 0, "zero-budget eviction retained tile files");

    // An unretained fallback snapshot is reused and expires with other CPU caches.
    pmjs::writePreparedPng(root/"snapshot.png", 6, 6, pixels.rgba);
    descriptor.identity = "fallback";
    require(images.installTileSet(descriptor), "fallback catalog failed");
    image = images.loadPng(root/"source.png", false, "fallback");
    require(image.has_value(), "fallback view failed");
    require(images.readPixelsRegion(image->handle, 5, 5, 1, 1).has_value(), "fallback snapshot failed");
    std::ofstream(root/"snapshot.png") << "invalid";
    for (int i = 0; i < 10; ++i) require(images.readPixelsRegion(image->handle, 5, 5, 1, 1).has_value(),
      "small fallback read decoded the full source again");
    for (int i = 0; i < 62; ++i) images.update();
    require(!images.hasCpuPixels(image->handle), "temporary fallback snapshot failed to expire");
    images.release(image->handle); images.update();
    require(fileCount() == baseline, "catalog kept expired fallback file owners");
    images.clearTileSetIndex();
    require(images.tileMetadataBytes() == 0, "final catalog release retained metadata");
  }
  {
    // FUSE exFAT renumbers inodes of unchanged files. A catalog identity that differs only by
    // inode is accepted after hash verification; a wrong hash still invalidates the catalog.
    pmjs::ImageStore images;
    images.setWarmBudgetBytes(0);
    pmjs::writePreparedPng(root/"renumbered.png", 6, 6, pixels.rgba);
    pmjs::writePreparedPng(root/"renumbered-snapshot.png", 6, 6, pixels.rgba);
    pmjs::writePreparedPng(root/"renumbered-page.png", 8, 8, page.rgba);
    const auto renumber = [](const std::string& key) {
      std::size_t end = key.size();
      for (int field = 0; field < 5; ++field) end = key.rfind(':', end-1);
      const auto start = key.rfind(':', end-1)+1;
      return key.substr(0, start)+std::to_string(std::stoull(key.substr(start, end-start))+1)+key.substr(end);
    };
    const auto key = [&](const char* name) { return pmjs::ImageStore::openFile(root/name)->key(); };
    pmjs::PreparedTileSet renumbered;
    renumbered.identity = "renumbered"; renumbered.directory = root;
    renumbered.pages = {{"renumbered-page.png", 8, 8}};
    renumbered.pageHashes = {sha256(root/"renumbered-page.png")};
    renumbered.sources.push_back({root/"renumbered.png", root/"renumbered-snapshot.png",
      renumber(key("renumbered.png")), 6, 6, {{{0, 0, 3, 3}, {1, 1, 3, 3}, 0}}, sha256(root/"renumbered.png")});
    const std::vector<std::string> pages{renumber(key("renumbered-page.png"))};
    const std::vector<std::string> snapshots{renumber(key("renumbered-snapshot.png"))};
    require(images.installTileSet(renumbered, &pages, &snapshots), "renumbered catalog failed");
    auto image = images.loadPng(root/"renumbered.png", false, "renumbered");
    require(image && images.hasTileBacking(image->handle) && images.consumePreparationInvalidations() == 0,
      "inode-only renumbering discarded a verified prepared tile set");
    images.release(image->handle); images.update();
    renumbered.identity = "changed";
    renumbered.sources[0].sourceHash = std::string(64, 'a');
    require(images.installTileSet(renumbered, &pages, &snapshots), "changed catalog failed");
    image = images.loadPng(root/"renumbered.png", false, "changed");
    require(image && !images.hasTileBacking(image->handle) && (images.consumePreparationInvalidations() & 2),
      "unverified renumbered source kept its prepared tile set");
    const auto fallback = images.readPixelsRegion(image->handle, 0, 0, 1, 1);
    require(fallback && fallback->rgba == std::vector<std::uint8_t>(4, 127),
      "rejected prepared data did not recover original source pixels");
    images.release(image->handle); images.update();
  }
  std::filesystem::remove_all(root);
  std::cout << "catalog descriptors, worker snapshots, readback reuse and eviction passed\n";
  return 0;
} catch (const std::exception& error) { std::cerr << error.what() << '\n'; return 1; }
