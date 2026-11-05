#include "platform.hpp"
#include "resources.hpp"
#include <filesystem>
#include <iostream>
#include <new>
#include <stdexcept>

namespace {
int allocationCountdown = 0;
void require(bool value, const char* message) {
  if (!value) throw std::runtime_error(message);
}
}
extern "C" void* __real__Znwm(std::size_t);
extern "C" void* __wrap__Znwm(std::size_t size) {
  if (allocationCountdown && --allocationCountdown == 0) throw std::bad_alloc();
  return __real__Znwm(size);
}
int main(int argc, char** argv) try {
  if (argc != 2) return 2;
  pmjs::Platform platform(32, 32, "Image installation rollback");
  const std::filesystem::path root(argv[1]);
  const auto source = pmjs::ImageStore::openFile(root / "fixture.png");
  require(source != nullptr, "cannot open image fixture");
  pmjs::PreparedImageDescriptor descriptor;
  descriptor.width = descriptor.height = 2;
  descriptor.pages = {{"probe-content.png", 16, 16}};
  descriptor.cells = {{{0, 0, 2, 2}, {0, 0, 2, 2}, {1, 1, 2, 2}, {0, 0, 0, 0}, 0}};
  int failures = 0, successes = 0;
  for (int allocation = 1; allocation <= 40; ++allocation) {
    pmjs::ImageStore images;
    images.setWarmBudgetBytes(0);
    require(images.installPrepared(root / "fixture.png", root, descriptor), "cannot install prepared fixture");
    auto load = images.capturePrepared(*source);
    require(load && images.validatePrepared(*load, false), "cannot validate prepared fixture");
    std::optional<pmjs::ImageInfo> image;
    allocationCountdown = allocation;
    try { image = images.installPreparedLoad(*source, std::move(load), false); }
    catch (const std::bad_alloc&) { ++failures; }
    allocationCountdown = 0;
    if (image) { images.release(image->handle); ++successes; }
    images.update();
    require(images.liveCount() == 0 && images.gpuBytes() == 0 && images.cpuBytes() == 0,
      "image installation failure retained a logical owner or pixel storage");
    const auto retry = images.loadPng(root / "fixture.png");
    require(retry.has_value(), "failed prepared installation prevented retry");
    images.release(retry->handle);
  }
  require(failures > 0 && successes > 0, "allocation fixture missed its failure and success cases");
  std::cout << "prepared image installation rolls back every allocation failure\n";
} catch (const std::exception& error) {
  allocationCountdown = 0;
  std::cerr << error.what() << '\n';
  return 1;
}
