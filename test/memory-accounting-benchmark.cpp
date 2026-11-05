#include "canvas.hpp"
#include "platform.hpp"

#include <array>
#include <chrono>
#include <iostream>
#include <stdexcept>
#include <vector>

namespace {
using Clock = std::chrono::steady_clock;

void run(std::size_t count) {
  pmjs::ImageStore images;
  pmjs::CanvasStore canvases(images);
  images.setWarmBudgetBytes(0);
  std::vector<pmjs::ImageHandle> imageHandles;
  std::vector<pmjs::CanvasHandle> canvasHandles;
  for (std::size_t index = 0; index < count; ++index) {
    auto image = images.installDecodedMemory({1, 1, {37, 53, 71, 255}}, true);
    auto canvas = canvases.create(1, 1);
    if (!image || !canvas || !canvases.drawImage(canvas->handle, image->handle,
        0, 0, 1, 1, 0, 0, 1, 1, 1, false))
      throw std::runtime_error("cannot create accounting fixture");
    const std::array<std::uint8_t, 4> changed{71, 53, 37, 255};
    if (!images.updateRgba(image->handle, changed.data()))
      throw std::runtime_error("cannot materialize accounting snapshot");
    imageHandles.push_back(image->handle);
    canvasHandles.push_back(canvas->handle);
  }
  const auto expected = count * 4;
  if (images.cpuBytes() != expected || canvases.cpuBytes() != expected)
    throw std::runtime_error("resident totals differ from fixture storage");
  std::size_t (*volatile read)(const pmjs::ImageStore&, const pmjs::CanvasStore&) =
    [](const auto& imageStore, const auto& canvasStore) {
      return imageStore.cpuBytes() + canvasStore.cpuBytes();
    };
  constexpr std::size_t reads = 20000, mutations = 1000;
  std::size_t checksum = 0;
  for (std::size_t index = 0; index < 100; ++index) checksum += read(images, canvases);
  const auto start = Clock::now();
  for (std::size_t index = 0; index < reads; ++index) checksum += read(images, canvases);
  const auto readEnd = Clock::now();
  for (std::size_t index = 0; index < mutations; ++index) {
    auto image = images.installDecodedMemory({1, 1, {37, 53, 71, 255}}, true);
    auto canvas = canvases.create(1, 1);
    if (!image || !canvas || !canvases.drawImage(canvas->handle, image->handle,
        0, 0, 1, 1, 0, 0, 1, 1, 1, false))
      throw std::runtime_error("cannot create transient storage");
    const std::array<std::uint8_t, 4> changed{71, 53, 37, 255};
    if (!images.updateRgba(image->handle, changed.data()) ||
        !canvases.release(canvas->handle) || !images.release(image->handle))
      throw std::runtime_error("cannot release transient storage");
  }
  const auto mutationEnd = Clock::now();
  if (images.cpuBytes() != expected || canvases.cpuBytes() != expected)
    throw std::runtime_error("mutation accounting did not return to baseline");
  for (auto handle : canvasHandles) canvases.release(handle);
  for (auto handle : imageHandles) images.release(handle);
  if (images.cpuBytes() || canvases.cpuBytes())
    throw std::runtime_error("fixture storage survived release");
  std::cout << "{\"resources\":" << count << ",\"reads\":" << reads
    << ",\"readNs\":" << std::chrono::duration<double, std::nano>(readEnd - start).count() / reads
    << ",\"mutationUs\":" << std::chrono::duration<double, std::micro>(mutationEnd - readEnd).count() / mutations
    << ",\"checksum\":" << checksum << "}\n";
}
}

int main() {
  pmjs::Platform platform(16, 16, "Memory accounting");
  run(32);
  run(4096);
}
