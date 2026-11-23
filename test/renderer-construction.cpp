#include "platform/platform.hpp"
#include "graphics/renderer.hpp"
#include "graphics/resources.hpp"

#include <GLES3/gl3.h>
#include <dlfcn.h>
#include <algorithm>
#include <array>
#include <cassert>
#include <cstdlib>
#include <new>
#include <vector>

namespace {
thread_local int allocationCountdown = -1;
bool recordObjects = false;
std::array<GLuint, 8> buffers{}, arrays{};
std::size_t bufferCount = 0, arrayCount = 0;
}

extern "C" void glGenBuffers(GLsizei count, GLuint* names) {
  static const auto real = reinterpret_cast<void (*)(GLsizei, GLuint*)>(dlsym(RTLD_NEXT, "glGenBuffers"));
  assert(real);
  real(count, names);
  if (recordObjects) for (int i = 0; i < count; ++i) {
    assert(bufferCount < buffers.size()); buffers[bufferCount++] = names[i];
  }
}
extern "C" void glGenVertexArrays(GLsizei count, GLuint* names) {
  static const auto real = reinterpret_cast<void (*)(GLsizei, GLuint*)>(dlsym(RTLD_NEXT, "glGenVertexArrays"));
  assert(real);
  real(count, names);
  if (recordObjects) for (int i = 0; i < count; ++i) {
    assert(arrayCount < arrays.size()); arrays[arrayCount++] = names[i];
  }
}

void* operator new(std::size_t bytes) {
  if (allocationCountdown == 0) {
    allocationCountdown = -1;
    throw std::bad_alloc();
  }
  if (allocationCountdown > 0) --allocationCountdown;
  if (auto* memory = std::malloc(bytes ? bytes : 1)) return memory;
  throw std::bad_alloc();
}
void* operator new[](std::size_t bytes) { return ::operator new(bytes); }
void operator delete(void* memory) noexcept { std::free(memory); }
void operator delete[](void* memory) noexcept { std::free(memory); }
void operator delete(void* memory, std::size_t) noexcept { std::free(memory); }
void operator delete[](void* memory, std::size_t) noexcept { std::free(memory); }

int main() {
  pmjs::Platform platform(16, 16, "Resource construction");
  pmjs::ImageStore images;
  std::vector<std::uint8_t> pixels(16 * 16 * 4, 255);
  const auto image = images.createRgba(16, 16, pixels.data(), true);
  assert(image);
  pmjs::Renderer renderer(16, 16, images);
  assert(images.lookupPremultiplied(image->handle));
  const auto references = [&] {
    const auto entries = images.memoryEntries();
    const auto found = std::find_if(entries.begin(), entries.end(), [&](const auto& entry) {
      return entry.handle == image->handle;
    });
    assert(found != entries.end());
    return found->references;
  };
  const auto before = references();
  for (const bool mesh : {false, true}) {
    int failures = 0;
    for (int boundary = 0; boundary < 128; ++boundary) {
      const std::vector<pmjs::TileLayerTile> tiles{{image->handle, {0, 0, 16, 16}, {0, 0}, {0, 0}}};
      const std::vector<float> positions{0, 0, 16, 0, 16, 16};
      const std::vector<double> uvs{0, 0, 1, 0, 1, 1};
      const std::vector<std::uint32_t> indices{0, 1, 2};
      std::uint32_t handle = 0;
      bufferCount = arrayCount = 0;
      recordObjects = true;
      allocationCountdown = boundary;
      try {
        handle = mesh ? renderer.createMesh(image->handle, positions, uvs, indices, false) :
          renderer.createTileLayer(tiles);
      } catch (const std::bad_alloc&) { ++failures; }
      allocationCountdown = -1;
      recordObjects = false;
      if (handle) assert(renderer.releaseTileLayer(handle));
      assert(references() == before);
      for (std::size_t i = 0; i < bufferCount; ++i) assert(!glIsBuffer(buffers[i]));
      for (std::size_t i = 0; i < arrayCount; ++i) assert(!glIsVertexArray(arrays[i]));
      if (handle) break;
      assert(boundary < 127);
    }
    assert(failures > 0);
  }
  images.release(image->handle);
}
