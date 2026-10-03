#pragma once

#include "vfs.hpp"
#include <array>
#include <cstdint>
#include <memory>
#include <string>

namespace pmjs {
class MediaService;

struct EffectDraw {
  std::uint32_t handle = 0;
  std::array<float, 4> viewport{};
  std::array<float, 16> projection{};
  std::array<float, 16> camera{};
  std::array<float, 2> resetViewport{};
};

class Effects {
 public:
  Effects(Vfs& vfs, MediaService& media);
  ~Effects();
  std::uint32_t createContext();
  void releaseContext(std::uint32_t context);
  std::uint32_t load(std::uint32_t context, const std::string& path, float scale);
  void release(std::uint32_t context, std::uint32_t effect);
  std::uint32_t play(std::uint32_t context, std::uint32_t effect,
                     const std::array<float, 3>& location);
  void update(std::uint32_t context, float frames);
  void stopAll(std::uint32_t context);
  bool exists(std::uint32_t handle) const;
  bool validHandle(std::uint32_t handle) const;
  float dynamicInput(std::uint32_t handle, int index) const;
  void control(std::uint32_t handle, const std::string& operation,
               const std::array<double, 4>& values);
  std::uint32_t draw(const EffectDraw& draw);
  std::array<std::uint32_t, 4> counts() const;

 private:
  struct Impl;
  std::unique_ptr<Impl> impl_;
};

}  // namespace pmjs
