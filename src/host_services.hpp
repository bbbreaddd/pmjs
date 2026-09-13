#pragma once

#include "canvas.hpp"

#include <array>
#include <cstdint>
#include <functional>
#include <optional>
#include <string>
#include <vector>

namespace pmjs {

struct HostServices {
  struct ImageInfo {
    std::uint32_t handle;
    int width;
    int height;
  };

  struct PixelData {
    int width;
    int height;
    std::vector<std::uint8_t> rgba;
  };

  struct Runtime {
    std::function<void()> requestQuit;
    std::function<std::optional<std::string>(const std::string&)> environment;
  } runtime;

  struct Render {
    std::function<void(float, float, float, float)> setClearColor;
    std::function<void(float, float, float, float, float, float, float, float)> drawQuad;
    std::function<bool(std::uint32_t, const std::array<float, 6>&,
                       const std::array<float, 4>&, float, std::uint32_t,
                       std::uint8_t)> drawImage;
    std::function<bool(std::uint32_t, const std::array<float, 6>&,
                       const std::array<float, 4>&, const std::array<float, 2>&,
                       float, std::uint32_t, std::uint8_t)> drawTiled;
    std::function<std::uint32_t(const std::vector<float>&,
                                const std::vector<std::uint32_t>&)> createTileLayer;
    std::function<std::uint32_t(std::uint32_t, const std::vector<float>&,
      const std::vector<float>&, const std::vector<std::uint32_t>&, bool)> createMesh;
    std::function<bool(std::uint32_t, const std::array<float, 6>&,
                       const std::array<float, 2>&, float, std::uint32_t,
                       std::uint8_t)> drawTileLayer;
    std::function<bool(std::uint32_t)> releaseTileLayer;
    std::function<bool(std::uint32_t)> releaseMesh;
    std::function<bool(int, int)> setRenderTargetSize;
    std::function<bool(int, int)> setScreenRenderSize;
    std::function<bool(std::uint32_t)> renderToCanvas;
    std::function<std::optional<ImageInfo>(int, int)> renderToImage;
  } render;

  struct Scene {
    std::function<bool(std::uint32_t, const std::uint32_t*, std::size_t,
                       const float*, std::size_t, std::size_t)> submit;
  } scene;

  struct Images {
    std::function<std::optional<ImageInfo>(const std::string&)> load;
    std::function<bool(std::uint32_t)> release;
  } images;

  struct Filesystem {
    std::function<std::optional<std::string>(const std::string&)> readText;
    std::function<std::optional<std::vector<std::uint8_t>>(const std::string&)> readBytes;
    std::function<std::optional<std::vector<std::string>>(const std::string&)> readDirectory;
    std::function<bool(const std::string&)> exists;
    std::function<bool(const std::string&)> isDirectory;
  } filesystem;

  struct Input {
    std::function<bool(const std::string&)> down;
    std::function<bool(const std::string&)> pressed;
  } input;

  struct Canvas {
    std::function<std::optional<ImageInfo>(int, int)> create;
    std::function<std::optional<ImageInfo>()> captureScene;
    std::function<bool(std::uint32_t, int, int, int, int, std::uint32_t)> fillRect;
    std::function<bool(std::uint32_t)> clear;
    std::function<bool(std::uint32_t, int, int, int, int)> clearRect;
    std::function<bool(std::uint32_t, std::uint32_t,
                       int, int, int, int, int, int, int, int, float)> drawImage;
    std::function<bool(std::uint32_t, const std::string&, const std::string&,
                       int, int, int, std::uint32_t, int)> drawText;
    std::function<std::optional<int>(const std::string&, const std::string&, int)>
      measureText;
    std::function<std::optional<CanvasTextMetrics>(const std::string&,
      const std::string&, int)> measureTextMetrics;
    std::function<std::optional<std::uint32_t>(std::uint32_t, int, int)> pixel;
    std::function<std::optional<PixelData>(std::uint32_t, int, int, int, int)>
      readPixels;
    std::function<std::optional<std::vector<std::uint8_t>>(std::uint32_t)>
      encodePng;
    std::function<bool(std::uint32_t, int, int, int, int,
                       const std::vector<std::uint8_t>&)> writePixels;
    std::function<bool(std::uint32_t)> blur;
    std::function<bool(std::uint32_t)> release;
  } canvas;
};

}  // namespace pmjs
