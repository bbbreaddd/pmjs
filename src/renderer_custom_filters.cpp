#include "renderer.hpp"

#include <GLES3/gl3.h>
#include <algorithm>
#include <cmath>
#include <stdexcept>

namespace pmjs {

void Renderer::drawCustomFilterPlan(const CustomFilterPlan& plan, std::uint32_t source,
                                    std::uint32_t output, const RenderCommand& command) {
  const auto& frame = plan.frame;
  const auto pot = [this](float value) {
    if (!std::isfinite(value) || value > maxTextureSize_)
      throw std::invalid_argument("custom filter target exceeds texture size");
    int result = 1;
    while (result < value) result *= 2;
    if (result > maxTextureSize_) throw std::invalid_argument("custom filter target exceeds texture size");
    return result;
  };
  // Targets are reused only after the complete pass sequence has finished.
  if (customPassTargets_.size() < plan.resolutions.size())
    customPassTargets_.resize(plan.resolutions.size());
  for (std::size_t index = 0; index < plan.resolutions.size(); ++index) {
    if (index == 1) continue;
    auto& target = customPassTargets_[index];
    ensureTarget(target, pot(frame[2] * plan.resolutions[index]), pot(frame[3] * plan.resolutions[index]));
    glBindFramebuffer(GL_FRAMEBUFFER, target.framebuffer);
    glDisable(GL_SCISSOR_TEST);
    glClearColor(0, 0, 0, 0);
    glClear(GL_COLOR_BUFFER_BIT);
  }
  auto& input = customPassTargets_[0];
  const float resolution = plan.resolutions[0];
  const int x0 = std::clamp(static_cast<int>(frame[0]), 0, width_);
  const int y0 = std::clamp(static_cast<int>(frame[1]), 0, height_);
  const int x1 = std::clamp(static_cast<int>(frame[0] + frame[2]), x0, width_);
  const int y1 = std::clamp(static_cast<int>(frame[1] + frame[3]), y0, height_);
  glBindFramebuffer(GL_READ_FRAMEBUFFER, source);
  glBindFramebuffer(GL_DRAW_FRAMEBUFFER, input.framebuffer);
  if (x1 > x0 && y1 > y0) {
    glBlitFramebuffer(x0, height_ - y1, x1, height_ - y0,
      std::lround((x0 - frame[0]) * resolution), std::lround((y1 - frame[1]) * resolution),
      std::lround((x1 - frame[0]) * resolution), std::lround((y0 - frame[1]) * resolution),
      GL_COLOR_BUFFER_BIT, GL_NEAREST);
  }
  if (!customFilterVertexArray_) {
    glGenVertexArrays(1, &customFilterVertexArray_);
    glGenBuffers(1, &customFilterVertexBuffer_);
    glBindVertexArray(customFilterVertexArray_);
    glBindBuffer(GL_ARRAY_BUFFER, customFilterVertexBuffer_);
    glEnableVertexAttribArray(0);
    glEnableVertexAttribArray(1);
    glVertexAttribPointer(0, 2, GL_FLOAT, GL_FALSE, 4 * sizeof(float), nullptr);
    glVertexAttribPointer(1, 2, GL_FLOAT, GL_FALSE, 4 * sizeof(float), reinterpret_cast<void*>(2 * sizeof(float)));
  }
  const float u = frame[2] * resolution / input.width;
  const float v = frame[3] * resolution / input.height;
  const float right = frame[0] + frame[2], bottom = frame[1] + frame[3];
  const std::array<float, 24> quad{
    frame[0], frame[1], 0, 0, right, frame[1], u, 0, right, bottom, u, v,
    frame[0], frame[1], 0, 0, right, bottom, u, v, frame[0], bottom, 0, v};
  glBindVertexArray(customFilterVertexArray_);
  glBindBuffer(GL_ARRAY_BUFFER, customFilterVertexBuffer_);
  glBufferData(GL_ARRAY_BUFFER, sizeof(quad), quad.data(), GL_STREAM_DRAW);
  for (const auto& pass : plan.passes) {
    const auto& custom = filterProgram(pass.program);
    const bool final = pass.output == 1;
    auto& target = customPassTargets_[pass.output];
    const float targetWidth = final ? width_ : frame[2];
    const float targetHeight = final ? height_ : frame[3];
    glBindFramebuffer(GL_FRAMEBUFFER, final ? output : target.framebuffer);
    glViewport(0, 0, final ? width_ : static_cast<int>(frame[2] * plan.resolutions[pass.output]),
      final ? height_ : static_cast<int>(frame[3] * plan.resolutions[pass.output]));
    glDisable(GL_SCISSOR_TEST);
    if (pass.clear) { glClearColor(0, 0, 0, 0); glClear(GL_COLOR_BUFFER_BIT); }
    if (final && command.clipped) {
      glEnable(GL_SCISSOR_TEST);
      glScissor(command.clip[0], height_ - command.clip[3],
        command.clip[2] - command.clip[0], command.clip[3] - command.clip[1]);
    }
    glUseProgram(custom.program);
    const float sx = 2.0F / targetWidth, sy = (final ? -2.0F : 2.0F) / targetHeight;
    const std::array<float, 9> projection{sx, 0, 0, 0, sy, 0,
      -1.0F - (final ? 0 : frame[0] * sx),
      (final ? 1.0F : -1.0F - frame[1] * sy), 1};
    glUniformMatrix3fv(glGetUniformLocation(custom.program, "projectionMatrix"), 1, GL_FALSE, projection.data());
    glUniform4f(glGetUniformLocation(custom.program, "filterArea"),
      input.width / resolution, input.height / resolution, frame[0], frame[1]);
    glUniform4f(glGetUniformLocation(custom.program, "filterClamp"), 0, 0,
      (frame[2] - 1) * resolution / input.width, (frame[3] - 1) * resolution / input.height);
    glActiveTexture(GL_TEXTURE0);
    glBindTexture(GL_TEXTURE_2D, customPassTargets_[pass.input].texture);
    glTexParameteri(GL_TEXTURE_2D, GL_TEXTURE_MIN_FILTER, GL_LINEAR);
    glTexParameteri(GL_TEXTURE_2D, GL_TEXTURE_MAG_FILTER, GL_LINEAR);
    textureNearestState_[customPassTargets_[pass.input].texture] = false;
    glUniform1i(glGetUniformLocation(custom.program, "uSampler"), 0);
    std::size_t offset = 0, samplerOffset = 0;
    int unit = 1;
    for (const auto& uniform : custom.uniforms) {
      if (uniform.type == GL_SAMPLER_2D) {
        std::vector<GLint> units;
        for (int index = 0; index < uniform.count; ++index) {
          const auto& sampler = pass.samplers[samplerOffset++];
          const auto image = sampler.image ? images_.lookupPremultiplied(sampler.image) : std::optional<ImageInfo>{};
          if (sampler.image && !image) throw std::runtime_error("filter sampler image expired");
          const auto texture = image ? image->texture : customPassTargets_[sampler.target].texture;
          glActiveTexture(GL_TEXTURE0 + unit);
          glBindTexture(GL_TEXTURE_2D, texture);
          glTexParameteri(GL_TEXTURE_2D, GL_TEXTURE_MIN_FILTER, GL_LINEAR);
          glTexParameteri(GL_TEXTURE_2D, GL_TEXTURE_MAG_FILTER, GL_LINEAR);
          textureNearestState_[texture] = false;
          units.push_back(unit++);
        }
        glUniform1iv(uniform.location, uniform.count, units.data());
        continue;
      }
      const float* data = pass.uniforms.data() + offset;
      const auto count = uniform.components * uniform.count;
      std::vector<GLint> integers;
      if (uniform.type == GL_INT || uniform.type == GL_BOOL || uniform.type == GL_INT_VEC2 ||
          uniform.type == GL_BOOL_VEC2 || uniform.type == GL_INT_VEC3 || uniform.type == GL_BOOL_VEC3 ||
          uniform.type == GL_INT_VEC4 || uniform.type == GL_BOOL_VEC4) {
        for (int index = 0; index < count; ++index) integers.push_back(static_cast<GLint>(data[index]));
      }
      switch (uniform.type) {
        case GL_FLOAT: glUniform1fv(uniform.location, uniform.count, data); break;
        case GL_FLOAT_VEC2: glUniform2fv(uniform.location, uniform.count, data); break;
        case GL_FLOAT_VEC3: glUniform3fv(uniform.location, uniform.count, data); break;
        case GL_FLOAT_VEC4: glUniform4fv(uniform.location, uniform.count, data); break;
        case GL_FLOAT_MAT2: glUniformMatrix2fv(uniform.location, uniform.count, GL_FALSE, data); break;
        case GL_FLOAT_MAT3: glUniformMatrix3fv(uniform.location, uniform.count, GL_FALSE, data); break;
        case GL_FLOAT_MAT4: glUniformMatrix4fv(uniform.location, uniform.count, GL_FALSE, data); break;
        case GL_INT: case GL_BOOL: glUniform1iv(uniform.location, uniform.count, integers.data()); break;
        case GL_INT_VEC2: case GL_BOOL_VEC2: glUniform2iv(uniform.location, uniform.count, integers.data()); break;
        case GL_INT_VEC3: case GL_BOOL_VEC3: glUniform3iv(uniform.location, uniform.count, integers.data()); break;
        case GL_INT_VEC4: case GL_BOOL_VEC4: glUniform4iv(uniform.location, uniform.count, integers.data()); break;
      }
      offset += count;
    }
    glActiveTexture(GL_TEXTURE0);
    glEnable(GL_BLEND);
    applyBlendMode(pass.blend);
    glDrawArrays(GL_TRIANGLES, 0, 6);
    if (diagnostics_) { ++stats_.drawCalls; ++stats_.filterDrawCalls; }
  }
  glBindFramebuffer(GL_FRAMEBUFFER, output);
  glViewport(0, 0, width_, height_);
  glBindVertexArray(vertexArray_);
  glBindBuffer(GL_ARRAY_BUFFER, vertexBuffer_);
  glActiveTexture(GL_TEXTURE0);
  glDisable(GL_SCISSOR_TEST);
}

}  // namespace pmjs
