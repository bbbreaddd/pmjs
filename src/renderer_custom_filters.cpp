#include "renderer.hpp"

#include <GLES3/gl3.h>
#include <algorithm>
#include <cmath>
#include <stdexcept>

namespace pmjs {

void Renderer::drawCustomFilterPlan(const CustomFilterPlan& plan, std::uint32_t source,
                                    std::uint32_t output, const RenderCommand& command,
                                    float sourceResolution, float outputResolution, bool outputYDown,
                                    const std::array<float, 4>& outputFrame) {
  const auto& frame = plan.frame;
  if (frame[2] == 0 || frame[3] == 0) return;
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
  glBindFramebuffer(GL_READ_FRAMEBUFFER, source);
  glBindFramebuffer(GL_DRAW_FRAMEBUFFER, input.framebuffer);
  const int sourceWidth = std::lround(frame[2] * sourceResolution);
  const int sourceHeight = std::lround(frame[3] * sourceResolution);
  if (sourceWidth > 0 && sourceHeight > 0) {
    glBlitFramebuffer(0, 0, sourceWidth, sourceHeight, 0, 0,
      std::lround(frame[2] * resolution), std::lround(frame[3] * resolution),
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
    const float targetWidth = final ? outputFrame[2] : frame[2];
    const float targetHeight = final ? outputFrame[3] : frame[3];
    glBindFramebuffer(GL_FRAMEBUFFER, final ? output : target.framebuffer);
    glViewport(0, 0, final ? std::lround(outputFrame[2] * outputResolution) : static_cast<int>(frame[2] * plan.resolutions[pass.output]),
      final ? std::lround(outputFrame[3] * outputResolution) : static_cast<int>(frame[3] * plan.resolutions[pass.output]));
    glDisable(GL_SCISSOR_TEST);
    if (pass.clear) { glClearColor(0, 0, 0, 0); glClear(GL_COLOR_BUFFER_BIT); }
    if (final && command.clipped) {
      glEnable(GL_SCISSOR_TEST);
      glScissor(std::lround((command.clip[0] - outputFrame[0]) * outputResolution),
        std::lround((outputYDown ? command.clip[1] - outputFrame[1] : outputFrame[1] + outputFrame[3] - command.clip[3]) * outputResolution),
        std::lround((command.clip[2] - command.clip[0]) * outputResolution),
        std::lround((command.clip[3] - command.clip[1]) * outputResolution));
    }
    glUseProgram(custom.program);
    const bool yDown = !final || outputYDown;
    const float sx = 2.0F / targetWidth, sy = (yDown ? 2.0F : -2.0F) / targetHeight;
    const auto& transform = pass.transform;
    const std::array<float, 9> projection{sx * transform[0], sy * transform[1], 0,
      sx * transform[2], sy * transform[3], 0,
      -1.0F - (final ? outputFrame[0] * sx : frame[0] * sx) + sx * transform[4],
      (final ? (yDown ? -1.0F : 1.0F) - outputFrame[1] * sy : -1.0F - frame[1] * sy) + sy * transform[5], 1};
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
          glTexParameteri(GL_TEXTURE_2D, GL_TEXTURE_MIN_FILTER, sampler.nearest ? GL_NEAREST : GL_LINEAR);
          glTexParameteri(GL_TEXTURE_2D, GL_TEXTURE_MAG_FILTER, sampler.nearest ? GL_NEAREST : GL_LINEAR);
          textureNearestState_[texture] = sampler.nearest;
          units.push_back(unit++);
        }
        glUniform1iv(uniform.location, uniform.count, units.data());
        continue;
      }
      const auto count = uniform.components * uniform.count;
      const auto start = pass.uniforms.begin() + offset;
      const std::vector<float> floats(start, start + count);
      const float* data = floats.data();
      std::vector<GLint> integers;
      if (uniform.type == GL_INT || uniform.type == GL_BOOL || uniform.type == GL_INT_VEC2 ||
          uniform.type == GL_BOOL_VEC2 || uniform.type == GL_INT_VEC3 || uniform.type == GL_BOOL_VEC3 ||
          uniform.type == GL_INT_VEC4 || uniform.type == GL_BOOL_VEC4) {
        for (int index = 0; index < count; ++index) {
          const double number = pass.uniforms[offset + index];
          double integer = std::fmod(std::trunc(number), 4294967296.0);
          if (integer < 0) integer += 4294967296.0;
          if (integer >= 2147483648.0) integer -= 4294967296.0;
          integers.push_back(static_cast<GLint>(integer));
        }
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
    glBindTexture(GL_TEXTURE_2D, customPassTargets_[pass.input].texture);
    glEnable(GL_BLEND);
    applyBlendMode(pass.blend);
    glDrawArrays(GL_TRIANGLES, 0, 6);
    if (diagnostics_) { ++stats_.drawCalls; ++stats_.filterDrawCalls; }
  }
  glBindFramebuffer(GL_FRAMEBUFFER, output);
  glViewport(0, 0, std::lround(outputFrame[2] * outputResolution), std::lround(outputFrame[3] * outputResolution));
  glBindVertexArray(vertexArray_);
  glBindBuffer(GL_ARRAY_BUFFER, vertexBuffer_);
  glActiveTexture(GL_TEXTURE0);
  glDisable(GL_SCISSOR_TEST);
}

}  // namespace pmjs
