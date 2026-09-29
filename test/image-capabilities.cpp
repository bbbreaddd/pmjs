#include "platform.hpp"
#include "resources.hpp"

#include <stdexcept>

int main() {
  pmjs::Platform platform(16, 16, "Image capability test");
  pmjs::ImageStore images;
  const auto sampled = images.createRgba(4, 4, nullptr);
  const auto target = images.createRenderTarget(4, 4);
  if (!sampled || !target) throw std::runtime_error("image allocation failed");
  if (images.isRenderTarget(sampled->handle)) {
    throw std::runtime_error("GPU-only sampled storage acquired render-target capability");
  }
  if (!images.isRenderTarget(target->handle)) {
    throw std::runtime_error("render target lost its mutation capability");
  }
  images.release(sampled->handle);
  images.release(target->handle);
  if (images.isRenderTarget(target->handle)) {
    throw std::runtime_error("released image retained render-target capability");
  }
}
