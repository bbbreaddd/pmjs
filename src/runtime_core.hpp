#pragma once

#include "canvas.hpp"
#include "host_services.hpp"
#include "media_service.hpp"
#include "platform.hpp"
#include "renderer.hpp"
#include "resources.hpp"
#include "vfs.hpp"

#include <cstdint>
#include <filesystem>
#include <optional>
#include <string>
#include <vector>

namespace pmjs {

class RuntimeCore {
 public:
  RuntimeCore(const std::filesystem::path& root, int width, int height,
              const std::string& title);

  HostServices hostServices();
  std::optional<ImageHandle> resolveImage(std::uint32_t handle) const;
  bool submitScene(std::uint32_t version, const std::uint32_t* metadata,
                   std::size_t metadataCount, const float* values,
                   std::size_t valueCount, std::size_t nodeCount);

  bool pollEvents();
  bool running() const { return running_; }
  void requestQuit() { running_ = false; }
  void injectInput(std::uint16_t input) { injectedInput_ = input; }
  std::uint32_t inputState() const;

  int width() const { return width_; }
  int height() const { return height_; }
  Platform& platform() { return platform_; }
  ImageStore& images() { return images_; }
  CanvasStore& canvases() { return canvases_; }
  Renderer& renderer() { return renderer_; }
  Vfs& vfs() { return vfs_; }
  MediaService& media() { return media_; }

 private:
  int width_;
  int height_;
  Platform platform_;
  ImageStore images_;
  CanvasStore canvases_;
  Renderer renderer_;
  Vfs vfs_;
  MediaService media_;
  std::uint16_t injectedInput_ = 0;
  bool running_ = true;
  std::vector<std::uint32_t> sceneMetadataScratch_;
};

}  // namespace pmjs
