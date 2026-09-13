#include "renderer.hpp"

#include <GLES3/gl3.h>

#include <algorithm>
#include <array>
#include <cmath>
#include <unordered_set>

namespace pmjs {
namespace {
void applyBlendMode(BlendMode mode) {
  switch (mode) {
    case BlendMode::normal:
      glBlendFuncSeparate(GL_ONE, GL_ONE_MINUS_SRC_ALPHA,
                          GL_ONE, GL_ONE_MINUS_SRC_ALPHA);
      break;
    case BlendMode::additive:
      glBlendFuncSeparate(GL_ONE, GL_ONE, GL_ONE, GL_ONE);
      break;
    case BlendMode::multiply:
      glBlendFuncSeparate(GL_DST_COLOR, GL_ONE_MINUS_SRC_ALPHA,
                          GL_ONE, GL_ONE_MINUS_SRC_ALPHA);
      break;
    case BlendMode::screen:
      glBlendFuncSeparate(GL_ONE, GL_ONE_MINUS_SRC_COLOR,
                          GL_ONE, GL_ONE_MINUS_SRC_ALPHA);
      break;
  }
}
}  // namespace

void Renderer::render() {
  std::uint32_t& rootFramebuffer = offscreenRender_ ? offscreenFramebuffer_ :
                                                      sceneFramebuffer_;
  std::uint32_t& rootTexture = offscreenRender_ ? offscreenTexture_ :
                                                  sceneTexture_;
  const bool shouldRenderScene =
      sceneSubmittedThisFrame_ || offscreenRender_ || !hasValidSceneFrame_;
  if (shouldRenderScene) {
    glBindFramebuffer(GL_FRAMEBUFFER, rootFramebuffer);
    glViewport(0, 0, width_, height_);
    glClearColor(clearColor_[0], clearColor_[1], clearColor_[2], clearColor_[3]);
    glClear(GL_COLOR_BUFFER_BIT);

    vertices_.clear();
    vertices_.reserve(frame_.commands.size() * 72);
  struct DrawOperation {
    std::uint32_t tileLayer = 0;
    std::uint32_t texture;
    BlendMode blendMode;
    bool repeat;
    bool nearest;
    GLsizei first;
    GLsizei count;
    const RenderCommand* command = nullptr;
    std::array<int, 4> clip{};
    bool clipped = false;
    float textureWidth = 1;
    float textureHeight = 1;
    float blur = 0;
    ImageHandle maskImage = 0;
    std::array<float, 6> maskTransform{};
    const RenderCommand* matrixCommand = nullptr;
    RenderCommand::Action action = RenderCommand::Action::draw;
    bool appliesSpriteColor = false;
    std::array<float, 4> colorTone{};
    std::array<float, 4> blendColor{};
    RenderCommand::Primitive primitive = RenderCommand::Primitive::sprite;
  };
  std::vector<DrawOperation> operations;
  std::size_t preparingFilterDepth = 0;
  for (const RenderCommand& command : frame_.commands) {
    if (command.action != RenderCommand::Action::draw) {
      if (command.action == RenderCommand::Action::filterEnd &&
          preparingFilterDepth > 0) --preparingFilterDepth;
      DrawOperation operation{};
      operation.command = &command;
      operation.action = command.action;
      if (command.action == RenderCommand::Action::filterEnd) {
        const std::array<float, 72> vertices = {
          -1,  1, 0, 1, 1, 1, 1, 1, 0, 0, 1, 1,
           1,  1, 1, 1, 1, 1, 1, 1, 0, 0, 1, 1,
           1, -1, 1, 0, 1, 1, 1, 1, 0, 0, 1, 1,
          -1,  1, 0, 1, 1, 1, 1, 1, 0, 0, 1, 1,
           1, -1, 1, 0, 1, 1, 1, 1, 0, 0, 1, 1,
          -1, -1, 0, 0, 1, 1, 1, 1, 0, 0, 1, 1,
        };
        operation.first = static_cast<GLsizei>(vertices_.size() / 12U);
        operation.count = 6;
        vertices_.insert(vertices_.end(), vertices.begin(), vertices.end());
      }
      operations.push_back(operation);
      if (command.action == RenderCommand::Action::filterBegin) {
        ++preparingFilterDepth;
      }
      continue;
    }
    if (command.appliesColorMatrix) {
      const std::array<float, 72> vertices = {
        -1,  1, 0, 1, 1, 1, 1, 1, 0, 0, 1, 1,
         1,  1, 1, 1, 1, 1, 1, 1, 0, 0, 1, 1,
         1, -1, 1, 0, 1, 1, 1, 1, 0, 0, 1, 1,
        -1,  1, 0, 1, 1, 1, 1, 1, 0, 0, 1, 1,
         1, -1, 1, 0, 1, 1, 1, 1, 0, 0, 1, 1,
        -1, -1, 0, 0, 1, 1, 1, 1, 0, 0, 1, 1,
      };
      DrawOperation operation{};
      operation.first = static_cast<GLsizei>(vertices_.size() / 12U);
      operation.count = 6;
      operation.matrixCommand = &command;
      operations.push_back(operation);
      vertices_.insert(vertices_.end(), vertices.begin(), vertices.end());
      continue;
    }
    if (command.tileLayer != 0) {
      operations.push_back({command.tileLayer, 0, command.blendMode,
                            false, command.nearest, 0, 0, &command, command.clip,
                            command.clipped, 1, 1, 0, 0, {}, {}});
      operations.back().primitive = command.primitive;
      continue;
    }
    const auto info = command.image == 0 ? std::optional<ImageInfo>{} :
                                          images_.lookup(command.image);
    if (command.image != 0 && !info) continue;
    const float textureWidth = info ? static_cast<float>(info->width) : 1.0F;
    const float textureHeight = info ? static_cast<float>(info->height) : 1.0F;
    const std::uint32_t texture = info ? info->texture : whiteTexture_;
    const auto& t = command.transform;
    const auto point = [&](float x, float y) {
      float px = t[0] * x + t[2] * y + t[4];
      float py = t[1] * x + t[3] * y + t[5];
      if (command.roundPixels) {
        px = std::floor(px);
        py = std::floor(py);
      }
      return std::array<float, 2>{px / static_cast<float>(width_) * 2.0F - 1.0F,
                                  1.0F - py / static_cast<float>(height_) * 2.0F};
    };
    const float localWidth = command.destination[0];
    const float localHeight = command.destination[1];
    const auto p0 = point(0, 0);
    const auto p1 = point(localWidth, 0);
    const auto p2 = point(localWidth, localHeight);
    const auto p3 = point(0, localHeight);
    if (preparingFilterDepth == 0) {
      const bool left = p0[0] <= -1 && p1[0] <= -1 &&
                        p2[0] <= -1 && p3[0] <= -1;
      const bool right = p0[0] >= 1 && p1[0] >= 1 &&
                         p2[0] >= 1 && p3[0] >= 1;
      const bool above = p0[1] >= 1 && p1[1] >= 1 &&
                         p2[1] >= 1 && p3[1] >= 1;
      const bool below = p0[1] <= -1 && p1[1] <= -1 &&
                         p2[1] <= -1 && p3[1] <= -1;
      if (left || right || above || below) continue;
    }
    const float u0 = command.source[0] / textureWidth;
    const float v0 = command.source[1] / textureHeight;
    const float u1 = (command.source[0] + command.source[2]) / textureWidth;
    const float v1 = (command.source[1] + command.source[3]) / textureHeight;
    const std::array<std::array<float, 2>, 4> sourceCorners = {
      std::array<float, 2>{u0, v0}, {u1, v0}, {u1, v1}, {u0, v1}
    };
    constexpr std::array<std::array<std::uint8_t, 4>, 8> rotatedCorners = {{
      {{0, 1, 2, 3}}, {{1, 2, 3, 0}}, {{2, 3, 0, 1}}, {{3, 0, 1, 2}},
      {{3, 2, 1, 0}}, {{0, 3, 2, 1}}, {{1, 0, 3, 2}}, {{2, 1, 0, 3}}
    }};
    const auto& uvOrder = rotatedCorners[command.textureRotation];
    const auto& uv0 = sourceCorners[uvOrder[0]];
    const auto& uv1 = sourceCorners[uvOrder[1]];
    const auto& uv2 = sourceCorners[uvOrder[2]];
    const auto& uv3 = sourceCorners[uvOrder[3]];
    const auto& color = command.color;
    const std::array<float, 72> vertices = {
      p0[0], p0[1], uv0[0], uv0[1], color[0], color[1], color[2], color[3], u0, v0, u1, v1,
      p1[0], p1[1], uv1[0], uv1[1], color[0], color[1], color[2], color[3], u0, v0, u1, v1,
      p2[0], p2[1], uv2[0], uv2[1], color[0], color[1], color[2], color[3], u0, v0, u1, v1,
      p0[0], p0[1], uv0[0], uv0[1], color[0], color[1], color[2], color[3], u0, v0, u1, v1,
      p2[0], p2[1], uv2[0], uv2[1], color[0], color[1], color[2], color[3], u0, v0, u1, v1,
      p3[0], p3[1], uv3[0], uv3[1], color[0], color[1], color[2], color[3], u0, v0, u1, v1,
    };
    vertices_.insert(vertices_.end(), vertices.begin(), vertices.end());
    if (operations.empty() || operations.back().tileLayer != 0 ||
        operations.back().texture != texture ||
        operations.back().blendMode != command.blendMode ||
        operations.back().repeat != command.repeat ||
        operations.back().nearest != command.nearest ||
        operations.back().blur != command.blur ||
        operations.back().maskImage != command.maskImage ||
        operations.back().maskTransform != command.maskTransform ||
        operations.back().appliesSpriteColor != command.appliesSpriteColor ||
        operations.back().colorTone != command.colorTone ||
        operations.back().blendColor != command.blendColor ||
        operations.back().primitive != command.primitive ||
        operations.back().clipped != command.clipped ||
        (command.clipped && operations.back().clip != command.clip)) {
      operations.push_back({0, texture, command.blendMode, command.repeat,
        command.nearest,
        static_cast<GLsizei>(vertices_.size() / 12U - 6U), 6, nullptr,
        command.clip, command.clipped, textureWidth, textureHeight,
        command.blur, command.maskImage, command.maskTransform});
      operations.back().appliesSpriteColor = command.appliesSpriteColor;
      operations.back().colorTone = command.colorTone;
      operations.back().blendColor = command.blendColor;
      operations.back().primitive = command.primitive;
    } else {
      operations.back().count += 6;
    }
  }

  if (!vertices_.empty()) {
    glBindBuffer(GL_ARRAY_BUFFER, vertexBuffer_);
    glBufferData(GL_ARRAY_BUFFER,
                 static_cast<GLsizeiptr>(vertices_.size() * sizeof(float)),
                 vertices_.data(), GL_STREAM_DRAW);
    ++stats_.bufferUploads;
  }

  BlendMode activeBlend = BlendMode::normal;
  std::uint32_t activeProgram = 0;
  bool scissorActive = false;
  std::size_t filterDepth = 0;
  std::array<const RenderCommand*, scene_packet::maxFilterDepth> filterCommands{};
  std::array<bool, scene_packet::maxFilterDepth> savedScissor{};
  std::array<std::array<int, 4>, scene_packet::maxFilterDepth> savedClip{};
  std::array<int, 4> activeClip{};
  applyBlendMode(activeBlend);
  for (const auto& operation : operations) {
    if (operation.action == RenderCommand::Action::filterBegin) {
      ++stats_.filterTargetAcquires;
      if (groupFramebuffers_[filterDepth] && groupTextures_[filterDepth]) {
        ++stats_.filterTargetReuses;
      }
      savedScissor[filterDepth] = operation.command->clipped;
      savedClip[filterDepth] = operation.command->clip;
      filterCommands[filterDepth] = operation.command;
      if (scissorActive) {
        glDisable(GL_SCISSOR_TEST);
        scissorActive = false;
      }
      glBindFramebuffer(GL_FRAMEBUFFER, groupFramebuffers_[filterDepth]);
      glViewport(0, 0, width_, height_);
      glClearColor(0, 0, 0, 0);
      glClear(GL_COLOR_BUFFER_BIT);
      ++stats_.filterTargetClears;
      activeBlend = BlendMode::normal;
      applyBlendMode(activeBlend);
      ++filterDepth;
      continue;
    }
    if (operation.action == RenderCommand::Action::filterEnd) {
      --filterDepth;
      const RenderCommand& filter = *filterCommands[filterDepth];
      ++stats_.filterApplications[static_cast<std::size_t>(filter.filterKind)];
      if (scissorActive) {
        glDisable(GL_SCISSOR_TEST);
        scissorActive = false;
      }
      glViewport(0, 0, width_, height_);
      glUseProgram(program_);
      activeProgram = program_;
      glBindVertexArray(vertexArray_);
      glActiveTexture(GL_TEXTURE0);
      glBindTexture(GL_TEXTURE_2D, groupTextures_[filterDepth]);
      glTexParameteri(GL_TEXTURE_2D, GL_TEXTURE_MIN_FILTER, GL_LINEAR);
      glTexParameteri(GL_TEXTURE_2D, GL_TEXTURE_MAG_FILTER, GL_LINEAR);
      textureNearestState_[groupTextures_[filterDepth]] = false;
      glUniform2f(textureSizeUniform_,
                  static_cast<float>(width_) / filter.filterResolution,
                  static_cast<float>(height_) / filter.filterResolution);
      glUniform1i(maskEnabledUniform_, 0);
      glUniform1i(colorMatrixEnabledUniform_, 0);
      glUniform1i(spriteColorEnabledUniform_, 0);
      glUniform1i(displacementEnabledUniform_, 0);
      glUniform1i(noiseGlitchEnabledUniform_, 0);
      glUniform1i(pixiFilterKindUniform_, 0);
      glUniform1i(premultipliedInputUniform_, 1);

      const bool pictureBlend =
        filter.filterKind == scene_packet::FilterKind::pictureBlend;
      if (pictureBlend) {
        glBindFramebuffer(GL_FRAMEBUFFER, filterDepth == 0 ? rootFramebuffer :
                          groupFramebuffers_[filterDepth - 1]);
        glActiveTexture(GL_TEXTURE3);
        glBindTexture(GL_TEXTURE_2D, filterTexture_);
        glCopyTexSubImage2D(GL_TEXTURE_2D, 0, 0, 0, 0, 0, width_, height_);
        ++stats_.framebufferCopies;
        glTexParameteri(GL_TEXTURE_2D, GL_TEXTURE_MIN_FILTER, GL_LINEAR);
        glTexParameteri(GL_TEXTURE_2D, GL_TEXTURE_MAG_FILTER, GL_LINEAR);
        glUniform1i(bloomImageUniform_, 3);
        glActiveTexture(GL_TEXTURE0);
        glBindTexture(GL_TEXTURE_2D, groupTextures_[filterDepth]);
      }

      std::uint32_t compositeTexture = groupTextures_[filterDepth];
      if (filter.filterKind == scene_packet::FilterKind::blur) {
        glUniform1f(blurUniform_, filter.filterParameters[0]);
        glUniform2f(blurDirectionUniform_, 1, 0);
        glDisable(GL_BLEND);
        std::uint32_t sourceTexture = groupTextures_[filterDepth];
        const int passCount = static_cast<int>(filter.filterParameters[1]);
        for (int pass = 0; pass < passCount; ++pass) {
          const bool targetFilter = sourceTexture == groupTextures_[filterDepth];
          glBindFramebuffer(GL_FRAMEBUFFER,
                            targetFilter ? filterFramebuffer_ :
                                           groupFramebuffers_[filterDepth]);
          glBindTexture(GL_TEXTURE_2D, sourceTexture);
          glDrawArrays(GL_TRIANGLES, operation.first, operation.count);
          ++stats_.drawCalls;
          ++stats_.filterDrawCalls;
          sourceTexture = targetFilter ? filterTexture_ :
                                         groupTextures_[filterDepth];
        }
        glUniform2f(blurDirectionUniform_, 0, 1);
        for (int pass = 1; pass < passCount; ++pass) {
          const bool targetFilter = sourceTexture == groupTextures_[filterDepth];
          glBindFramebuffer(GL_FRAMEBUFFER,
                            targetFilter ? filterFramebuffer_ :
                                           groupFramebuffers_[filterDepth]);
          glBindTexture(GL_TEXTURE_2D, sourceTexture);
          glDrawArrays(GL_TRIANGLES, operation.first, operation.count);
          ++stats_.drawCalls;
          ++stats_.filterDrawCalls;
          sourceTexture = targetFilter ? filterTexture_ :
                                         groupTextures_[filterDepth];
        }
        compositeTexture = sourceTexture;
      } else if (filter.filterKind == scene_packet::FilterKind::blurX ||
                 filter.filterKind == scene_packet::FilterKind::blurY) {
        glUniform1f(blurUniform_, filter.filterParameters[0]);
        glUniform2f(blurDirectionUniform_,
                    filter.filterKind == scene_packet::FilterKind::blurX ? 1 : 0,
                    filter.filterKind == scene_packet::FilterKind::blurY ? 1 : 0);
        glDisable(GL_BLEND);
        std::uint32_t sourceTexture = groupTextures_[filterDepth];
        const int passCount = static_cast<int>(filter.filterParameters[1]);
        for (int pass = 1; pass < passCount; ++pass) {
          const bool targetFilter = sourceTexture == groupTextures_[filterDepth];
          glBindFramebuffer(GL_FRAMEBUFFER,
                            targetFilter ? filterFramebuffer_ :
                                           groupFramebuffers_[filterDepth]);
          glBindTexture(GL_TEXTURE_2D, sourceTexture);
          glDrawArrays(GL_TRIANGLES, operation.first, operation.count);
          ++stats_.drawCalls;
          ++stats_.filterDrawCalls;
          sourceTexture = targetFilter ? filterTexture_ :
                                         groupTextures_[filterDepth];
        }
        compositeTexture = sourceTexture;
      } else if (filter.filterKind == scene_packet::FilterKind::displacement) {
        glUniform1f(blurUniform_, 0);
        glUniform2f(blurDirectionUniform_, 0, 0);
        const auto displacement = images_.lookup(filter.image);
        if (!displacement) continue;
        glActiveTexture(GL_TEXTURE2);
        glBindTexture(GL_TEXTURE_2D, displacement->texture);
        glTexParameteri(GL_TEXTURE_2D, GL_TEXTURE_MIN_FILTER, GL_LINEAR);
        glTexParameteri(GL_TEXTURE_2D, GL_TEXTURE_MAG_FILTER, GL_LINEAR);
        glTexParameteri(GL_TEXTURE_2D, GL_TEXTURE_WRAP_S, GL_REPEAT);
        glTexParameteri(GL_TEXTURE_2D, GL_TEXTURE_WRAP_T, GL_REPEAT);
        textureNearestState_[displacement->texture] = false;
        textureRepeatState_[displacement->texture] = true;
        glUniform1i(displacementImageUniform_, 2);
        glUniform4fv(displacementBoundsUniform_, 1,
                     filter.filterParameters.data());
        glUniform2fv(displacementScaleUniform_, 1,
                     filter.filterParameters.data() + 4);
        glUniform1i(displacementEnabledUniform_, 1);
        glActiveTexture(GL_TEXTURE0);
      } else if (filter.filterKind == scene_packet::FilterKind::alphaMask) {
        glUniform1f(blurUniform_, 0);
        glUniform2f(blurDirectionUniform_, 0, 0);
        const auto mask = images_.lookup(filter.image);
        if (!mask) continue;
        glActiveTexture(GL_TEXTURE1);
        glBindTexture(GL_TEXTURE_2D, mask->texture);
        glUniform1i(maskImageUniform_, 1);
        glUniform1fv(maskTransformUniform_, 6,
                     filter.filterParameters.data());
        glUniform4fv(maskFrameUniform_, 1,
                     filter.filterParameters.data() + 6);
        glUniform2f(maskTextureSizeUniform_, static_cast<float>(mask->width),
                    static_cast<float>(mask->height));
        glUniform1f(maskScreenHeightUniform_, static_cast<float>(height_));
        glUniform1f(maskAlphaUniform_, filter.filterParameters[10]);
        glUniform1i(maskUsesRedUniform_, filter.filterParameters[11] != 0);
        glUniform1i(maskRotationUniform_,
                    static_cast<int>(filter.filterParameters[12]) / 2);
        glUniform2f(maskLocalSizeUniform_, filter.filterParameters[13],
                    filter.filterParameters[14]);
        glUniform1i(maskEnabledUniform_, 1);
        glActiveTexture(GL_TEXTURE0);
      } else if (filter.filterKind == scene_packet::FilterKind::noiseGlitch) {
        glUniform1f(blurUniform_, 0);
        glUniform2f(blurDirectionUniform_, 0, 0);
        glUniform4fv(noiseGlitchParametersUniform_, 1,
                     filter.filterParameters.data());
        glUniform1i(noiseGlitchEnabledUniform_, 1);
      } else if (filter.filterKind == scene_packet::FilterKind::zoomBlur ||
                 filter.filterKind == scene_packet::FilterKind::shockwave) {
        glUniform1f(blurUniform_, 0);
        glUniform2f(blurDirectionUniform_, 0, 0);
        glUniform1fv(pixiFilterParametersUniform_, 10, filter.filterParameters.data());
        glUniform1i(pixiFilterKindUniform_,
                    filter.filterKind == scene_packet::FilterKind::zoomBlur ? 1 : 2);
      } else if (filter.filterKind == scene_packet::FilterKind::advancedBloom) {
        glUniform1f(blurUniform_, 0);
        glUniform2f(blurDirectionUniform_, 0, 0);
        glDisable(GL_BLEND);
        const std::array<float, 10> extractParameters = {
          filter.filterParameters[2], 0, 0, 0, 0, 0, 0, 0, 0, 0};
        glUniform1fv(pixiFilterParametersUniform_, 10,
                     extractParameters.data());
        glUniform1i(pixiFilterKindUniform_, 3);
        glBindFramebuffer(GL_FRAMEBUFFER, bloomFramebuffer_);
        glDrawArrays(GL_TRIANGLES, operation.first, operation.count);
        ++stats_.drawCalls;
        ++stats_.filterDrawCalls;

        std::uint32_t bloomSource = bloomTexture_;
        const int passCount = static_cast<int>(filter.filterParameters[3]);
        for (int pass = 0; pass < passCount; ++pass) {
          const bool targetFilter = bloomSource == bloomTexture_;
          glBindFramebuffer(GL_FRAMEBUFFER,
                            targetFilter ? filterFramebuffer_ :
                                           bloomFramebuffer_);
          glBindTexture(GL_TEXTURE_2D, bloomSource);
          const std::array<float, 10> passParameters = {
            filter.filterParameters[6 + pass], filter.filterParameters[4],
            filter.filterParameters[5], 0, 0, 0, 0, 0, 0, 0};
          glUniform1fv(pixiFilterParametersUniform_, 10,
                       passParameters.data());
          glUniform1i(pixiFilterKindUniform_, 21);
          glDrawArrays(GL_TRIANGLES, operation.first, operation.count);
          ++stats_.drawCalls;
          ++stats_.filterDrawCalls;
          bloomSource = targetFilter ? filterTexture_ : bloomTexture_;
        }
        glActiveTexture(GL_TEXTURE3);
        glBindTexture(GL_TEXTURE_2D, bloomSource);
        glUniform1i(bloomImageUniform_, 3);
        glActiveTexture(GL_TEXTURE0);
        glBindTexture(GL_TEXTURE_2D, groupTextures_[filterDepth]);
        const std::array<float, 10> compositeParameters = {
          filter.filterParameters[0], filter.filterParameters[1],
          0, 0, 0, 0, 0, 0, 0, 0};
        glUniform1fv(pixiFilterParametersUniform_, 10,
                     compositeParameters.data());
        glUniform1i(pixiFilterKindUniform_, 22);
      } else if (filter.filterKind == scene_packet::FilterKind::crt) {
        glUniform1f(blurUniform_, 0);
        glUniform2f(blurDirectionUniform_, 0, 0);
        glUniform1fv(pixiFilterParametersUniform_, 10, filter.filterParameters.data());
        glUniform1i(pixiFilterKindUniform_, 4);
      } else if (filter.filterKind == scene_packet::FilterKind::adjustment ||
                 filter.filterKind == scene_packet::FilterKind::pixelate ||
                 filter.filterKind == scene_packet::FilterKind::rgbSplit ||
                 filter.filterKind == scene_packet::FilterKind::bulgePinch) {
        glUniform1f(blurUniform_, 0);
        glUniform2f(blurDirectionUniform_, 0, 0);
        glUniform1fv(pixiFilterParametersUniform_, 10,
                     filter.filterParameters.data());
        glUniform1i(pixiFilterKindUniform_,
          5 + static_cast<int>(filter.filterKind) -
            static_cast<int>(scene_packet::FilterKind::adjustment));
      } else if (filter.filterKind == scene_packet::FilterKind::twist ||
                 filter.filterKind == scene_packet::FilterKind::ascii ||
                 filter.filterKind == scene_packet::FilterKind::dot ||
                 filter.filterKind == scene_packet::FilterKind::emboss ||
                 filter.filterKind == scene_packet::FilterKind::crossHatch) {
        glUniform1f(blurUniform_, 0);
        glUniform2f(blurDirectionUniform_, 0, 0);
        glUniform1fv(pixiFilterParametersUniform_, 10,
                     filter.filterParameters.data());
        glUniform1i(pixiFilterKindUniform_,
          9 + static_cast<int>(filter.filterKind) -
            static_cast<int>(scene_packet::FilterKind::twist));
      } else if (filter.filterKind == scene_packet::FilterKind::radialBlur ||
                 filter.filterKind == scene_packet::FilterKind::reflection ||
                 filter.filterKind == scene_packet::FilterKind::motionBlur) {
        glUniform1f(blurUniform_, 0);
        glUniform2f(blurDirectionUniform_, 0, 0);
        glUniform1fv(pixiFilterParametersUniform_, 10,
                     filter.filterParameters.data());
        glUniform1i(pixiFilterKindUniform_,
          14 + static_cast<int>(filter.filterKind) -
            static_cast<int>(scene_packet::FilterKind::radialBlur));
      } else if (filter.filterKind == scene_packet::FilterKind::alpha) {
        glUniform1f(blurUniform_, 0);
        glUniform2f(blurDirectionUniform_, 0, 0);
        glUniform1fv(pixiFilterParametersUniform_, 10,
                     filter.filterParameters.data());
        glUniform1i(pixiFilterKindUniform_, 17);
      } else if (filter.filterKind == scene_packet::FilterKind::oldFilm) {
        glUniform1f(blurUniform_, 0);
        glUniform2f(blurDirectionUniform_, 0, 0);
        glUniform1fv(pixiFilterParametersUniform_, 10,
                     filter.filterParameters.data());
        glUniform1i(pixiFilterKindUniform_, 18);
      } else if (filter.filterKind == scene_packet::FilterKind::glow) {
        glUniform1f(blurUniform_, 0);
        glUniform2f(blurDirectionUniform_, 0, 0);
        glUniform1fv(pixiFilterParametersUniform_, 10,
                     filter.filterParameters.data());
        glUniform1i(pixiFilterKindUniform_, 19);
      } else if (filter.filterKind == scene_packet::FilterKind::godray) {
        glUniform1f(blurUniform_, 0);
        glUniform2f(blurDirectionUniform_, 0, 0);
        glUniform1fv(pixiFilterParametersUniform_, 10,
                     filter.filterParameters.data());
        glUniform1i(pixiFilterKindUniform_, 20);
      } else if (filter.filterKind == scene_packet::FilterKind::kawaseBlur) {
        glUniform1f(blurUniform_, 0);
        glUniform2f(blurDirectionUniform_, 0, 0);
        glDisable(GL_BLEND);
        std::uint32_t sourceTexture = groupTextures_[filterDepth];
        const int passCount = static_cast<int>(filter.filterParameters[0]);
        for (int pass = 0; pass < passCount; ++pass) {
          const bool targetFilter = sourceTexture == groupTextures_[filterDepth];
          glBindFramebuffer(GL_FRAMEBUFFER,
                            targetFilter ? filterFramebuffer_ :
                                           groupFramebuffers_[filterDepth]);
          glBindTexture(GL_TEXTURE_2D, sourceTexture);
          const std::array<float, 10> passParameters = {
            filter.filterParameters[3 + pass], filter.filterParameters[1],
            filter.filterParameters[2], 0, 0, 0, 0, 0, 0, 0};
          glUniform1fv(pixiFilterParametersUniform_, 10,
                       passParameters.data());
          glUniform1i(pixiFilterKindUniform_, 21);
          glDrawArrays(GL_TRIANGLES, operation.first, operation.count);
          ++stats_.drawCalls;
          ++stats_.filterDrawCalls;
          sourceTexture = targetFilter ? filterTexture_ :
                                         groupTextures_[filterDepth];
        }
        compositeTexture = sourceTexture;
        glUniform1i(pixiFilterKindUniform_, 0);
      } else if (filter.filterKind == scene_packet::FilterKind::colorMatrix) {
        glUniform1f(blurUniform_, 0);
        glUniform2f(blurDirectionUniform_, 0, 0);
        glUniform1fv(colorMatrixUniform_, 20, filter.filterParameters.data());
        glUniform1f(colorMatrixAlphaUniform_, filter.filterParameters[20]);
        glUniform1i(colorMatrixEnabledUniform_, 1);
      } else if (filter.filterKind == scene_packet::FilterKind::fxaa) {
        glUniform1f(blurUniform_, 0);
        glUniform2f(blurDirectionUniform_, 0, 0);
        glUniform1i(pixiFilterKindUniform_, 25);
      } else if (filter.filterKind == scene_packet::FilterKind::pictureBlend) {
        glUniform1f(blurUniform_, 0);
        glUniform2f(blurDirectionUniform_, 0, 0);
        glUniform1i(pixiFilterKindUniform_,
          filter.filterParameters[0] == 0 ? 23 : 24);
      }

      glBindFramebuffer(GL_FRAMEBUFFER, filterDepth == 0 ? rootFramebuffer :
                        groupFramebuffers_[filterDepth - 1]);
      glBindTexture(GL_TEXTURE_2D, compositeTexture);
      glTexParameteri(GL_TEXTURE_2D, GL_TEXTURE_MIN_FILTER, GL_LINEAR);
      glTexParameteri(GL_TEXTURE_2D, GL_TEXTURE_MAG_FILTER, GL_LINEAR);
      textureNearestState_[compositeTexture] = false;
      if (filter.filterKind == scene_packet::FilterKind::blur) {
        glUniform2f(blurDirectionUniform_, 0, 1);
      }
      activeBlend = BlendMode::normal;
      if (pictureBlend) {
        glDisable(GL_BLEND);
      } else {
        glEnable(GL_BLEND);
        glBlendFuncSeparate(GL_ONE, GL_ONE_MINUS_SRC_ALPHA,
                            GL_ONE, GL_ONE_MINUS_SRC_ALPHA);
      }
      scissorActive = savedScissor[filterDepth];
      activeClip = savedClip[filterDepth];
      if (scissorActive) {
        glEnable(GL_SCISSOR_TEST);
        glScissor(activeClip[0], height_ - activeClip[3],
                  std::max(0, activeClip[2] - activeClip[0]),
                  std::max(0, activeClip[3] - activeClip[1]));
      }
      glDrawArrays(GL_TRIANGLES, operation.first, operation.count);
      ++stats_.drawCalls;
      ++stats_.filterDrawCalls;
      if (pictureBlend) glEnable(GL_BLEND);
      glUniform1i(displacementEnabledUniform_, 0);
      glUniform1i(noiseGlitchEnabledUniform_, 0);
      glUniform1i(pixiFilterKindUniform_, 0);
      glUniform1i(premultipliedInputUniform_, 1);
      glUniform1i(maskEnabledUniform_, 0);
      glUniform1i(colorMatrixEnabledUniform_, 0);
      glUniform1i(spriteColorEnabledUniform_, 0);
      applyBlendMode(activeBlend);
      continue;
    }
    if (operation.matrixCommand) {
      glDisable(GL_BLEND);
      glBindFramebuffer(GL_FRAMEBUFFER, filterFramebuffer_);
      glViewport(0, 0, width_, height_);
      glUseProgram(program_);
      activeProgram = program_;
      glBindVertexArray(vertexArray_);
      glActiveTexture(GL_TEXTURE0);
      glBindTexture(GL_TEXTURE_2D, filterDepth == 0 ? rootTexture :
                    groupTextures_[filterDepth - 1]);
      glUniform2f(textureSizeUniform_, static_cast<float>(width_),
                  static_cast<float>(height_));
      glUniform1f(blurUniform_, 0);
      glUniform2f(blurDirectionUniform_, 0, 0);
      glUniform1i(displacementEnabledUniform_, 0);
      glUniform1i(noiseGlitchEnabledUniform_, 0);
      glUniform1i(pixiFilterKindUniform_, 0);
      glUniform1i(maskEnabledUniform_, 0);
      glUniform1i(colorMatrixEnabledUniform_, 1);
      glUniform1i(spriteColorEnabledUniform_, 0);
      glUniform1fv(colorMatrixUniform_, 20,
                   operation.matrixCommand->colorMatrix.data());
      glUniform1f(colorMatrixAlphaUniform_,
                  operation.matrixCommand->color[3]);
      glDrawArrays(GL_TRIANGLES, operation.first, operation.count);
      ++stats_.drawCalls;
      ++stats_.filterDrawCalls;
      ++stats_.toneAdjustDrawCalls;
      if (filterDepth == 0) {
        std::swap(rootFramebuffer, filterFramebuffer_);
        std::swap(rootTexture, filterTexture_);
        glBindFramebuffer(GL_FRAMEBUFFER, rootFramebuffer);
      } else {
        std::swap(groupFramebuffers_[filterDepth - 1], filterFramebuffer_);
        std::swap(groupTextures_[filterDepth - 1], filterTexture_);
        glBindFramebuffer(GL_FRAMEBUFFER, groupFramebuffers_[filterDepth - 1]);
      }
      glEnable(GL_BLEND);
      applyBlendMode(activeBlend);
      glUniform1i(colorMatrixEnabledUniform_, 0);
      continue;
    }
    if (operation.clipped) {
      if (!scissorActive) {
        glEnable(GL_SCISSOR_TEST);
        scissorActive = true;
      }
      glScissor(operation.clip[0], height_ - operation.clip[3],
                std::max(0, operation.clip[2] - operation.clip[0]),
                std::max(0, operation.clip[3] - operation.clip[1]));
      activeClip = operation.clip;
    } else if (scissorActive) {
      glDisable(GL_SCISSOR_TEST);
      scissorActive = false;
    }
    if (operation.blendMode != activeBlend) {
      activeBlend = operation.blendMode;
      applyBlendMode(activeBlend);
    }
    if (operation.tileLayer != 0) {
      const auto layer = tileLayers_.find(operation.tileLayer);
      if (layer == tileLayers_.end() || !operation.command) continue;
      const auto& command = *operation.command;
      const auto& transform = command.transform;
      const std::array<float, 9> world = {
        transform[0], transform[1], 0.0F,
        transform[2], transform[3], 0.0F,
        transform[4], transform[5], 1.0F,
      };
      glUseProgram(tileProgram_);
      activeProgram = tileProgram_;
      glBindVertexArray(layer->second.vertexArray);
      glUniformMatrix3fv(tileWorldUniform_, 1, GL_FALSE, world.data());
      glUniform2f(tileScreenUniform_, static_cast<float>(width_),
                  static_cast<float>(height_));
      glUniform2f(tileAnimationUniform_, command.tileAnimation[0],
                  command.tileAnimation[1]);
      glUniform4fv(tileColorUniform_, 1, command.color.data());
      if (command.maskImage) {
        const auto mask = images_.lookup(command.maskImage);
        if (!mask) continue;
        glActiveTexture(GL_TEXTURE1);
        glBindTexture(GL_TEXTURE_2D, mask->texture);
        glUniform1i(tileMaskImageUniform_, 1);
        glUniform1i(tileMaskEnabledUniform_, 1);
        glUniform1fv(tileMaskTransformUniform_, 6,
                     command.maskTransform.data());
        glUniform4f(tileMaskFrameUniform_, 0, 0,
                    static_cast<float>(mask->width),
                    static_cast<float>(mask->height));
        glUniform2f(tileMaskTextureSizeUniform_, static_cast<float>(mask->width),
                    static_cast<float>(mask->height));
        glUniform1f(tileMaskScreenHeightUniform_, static_cast<float>(height_));
        glActiveTexture(GL_TEXTURE0);
      } else {
        glUniform1i(tileMaskEnabledUniform_, 0);
      }
      for (const auto& batch : layer->second.batches) {
        glUniform2f(tileTextureSizeUniform_,
                    static_cast<float>(batch.textureWidth),
                    static_cast<float>(batch.textureHeight));
        glBindTexture(GL_TEXTURE_2D, batch.texture);
        const auto nearest = textureNearestState_.find(batch.texture);
        if (nearest == textureNearestState_.end() ||
            nearest->second != operation.nearest) {
          textureNearestState_[batch.texture] = operation.nearest;
          glTexParameteri(GL_TEXTURE_2D, GL_TEXTURE_MIN_FILTER,
                          operation.nearest ? GL_NEAREST : GL_LINEAR);
          glTexParameteri(GL_TEXTURE_2D, GL_TEXTURE_MAG_FILTER,
                          operation.nearest ? GL_NEAREST : GL_LINEAR);
        }
        glDrawArrays(GL_TRIANGLES, batch.first, batch.count);
        ++stats_.drawCalls;
        if (operation.primitive == RenderCommand::Primitive::mesh) {
          ++stats_.meshDrawCalls;
        } else {
          ++stats_.tileDrawCalls;
        }
      }
      continue;
    }

    const bool simpleSprite = operation.blur <= 0 && operation.maskImage == 0 &&
                              !operation.appliesSpriteColor;
    const std::uint32_t spriteProgram = simpleSprite ? simpleProgram_ :
                                                     spriteEffectProgram_;
    if (activeProgram != spriteProgram) {
      glUseProgram(spriteProgram);
      glBindVertexArray(vertexArray_);
      activeProgram = spriteProgram;
    }
    glBindTexture(GL_TEXTURE_2D, operation.texture);
    const auto nearest = textureNearestState_.find(operation.texture);
    if (nearest == textureNearestState_.end() ||
        nearest->second != operation.nearest) {
      textureNearestState_[operation.texture] = operation.nearest;
      glTexParameteri(GL_TEXTURE_2D, GL_TEXTURE_MIN_FILTER,
                      operation.nearest ? GL_NEAREST : GL_LINEAR);
      glTexParameteri(GL_TEXTURE_2D, GL_TEXTURE_MAG_FILTER,
                      operation.nearest ? GL_NEAREST : GL_LINEAR);
    }
    if (!simpleSprite) {
      glUniform1i(spriteEffectColorEnabledUniform_,
                  operation.appliesSpriteColor ? 1 : 0);
      if (operation.appliesSpriteColor) {
        glUniform4fv(spriteEffectColorToneUniform_, 1,
                     operation.colorTone.data());
        glUniform4fv(spriteEffectBlendColorUniform_, 1,
                     operation.blendColor.data());
      }
      glUniform2f(spriteEffectTextureSizeUniform_, operation.textureWidth,
                  operation.textureHeight);
      glUniform1f(spriteEffectBlurUniform_, operation.blur);
    }
    if (!simpleSprite && operation.maskImage) {
      const auto mask = images_.lookup(operation.maskImage);
      if (!mask) continue;
      glActiveTexture(GL_TEXTURE1);
      glBindTexture(GL_TEXTURE_2D, mask->texture);
      glUniform1i(spriteEffectMaskImageUniform_, 1);
      glUniform1i(spriteEffectMaskEnabledUniform_, 1);
      glUniform1fv(spriteEffectMaskTransformUniform_, 6,
                   operation.maskTransform.data());
      glUniform2f(spriteEffectMaskTextureSizeUniform_,
                  static_cast<float>(mask->width),
                  static_cast<float>(mask->height));
      glUniform1f(spriteEffectScreenHeightUniform_,
                  static_cast<float>(height_));
      glActiveTexture(GL_TEXTURE0);
    } else if (!simpleSprite) {
      glUniform1i(spriteEffectMaskEnabledUniform_, 0);
    }
    const auto repeat = textureRepeatState_.find(operation.texture);
    if (repeat == textureRepeatState_.end() || repeat->second != operation.repeat) {
      textureRepeatState_[operation.texture] = operation.repeat;
      glTexParameteri(GL_TEXTURE_2D, GL_TEXTURE_WRAP_S,
                      operation.repeat ? GL_REPEAT : GL_CLAMP_TO_EDGE);
      glTexParameteri(GL_TEXTURE_2D, GL_TEXTURE_WRAP_T,
                      operation.repeat ? GL_REPEAT : GL_CLAMP_TO_EDGE);
    }
    glDrawArrays(GL_TRIANGLES, operation.first, operation.count);
    ++stats_.drawCalls;
    if (operation.primitive == RenderCommand::Primitive::tilingSprite) {
      ++stats_.tilingSpriteDrawCalls;
    } else if (operation.primitive == RenderCommand::Primitive::screenFill) {
      ++stats_.screenFillDrawCalls;
    } else {
      ++stats_.spriteDrawCalls;
    }
    if (simpleSprite) {
      ++stats_.baseSpriteDrawCalls;
    } else {
      ++stats_.effectSpriteDrawCalls;
    }
  }
  if (scissorActive) glDisable(GL_SCISSOR_TEST);
  applyBlendMode(BlendMode::normal);
  stats_.commands += frame_.commands.size();
  discardCommandsFrom(0);
  if (!offscreenRender_ && sceneSubmittedThisFrame_) {
    hasValidSceneFrame_ = true;
  }
} else {
  discardCommandsFrom(0);
  ++stats_.retainedFrames;
}
++stats_.frames;

  if (!offscreenRender_) {
    glBindFramebuffer(GL_READ_FRAMEBUFFER, sceneFramebuffer_);
    glBindFramebuffer(GL_DRAW_FRAMEBUFFER, 0);
    glBlitFramebuffer(0, 0, width_, height_, 0, 0,
                      presentationWidth_, presentationHeight_,
                      GL_COLOR_BUFFER_BIT, GL_NEAREST);
    glBindFramebuffer(GL_FRAMEBUFFER, 0);
  }
}


}  // namespace pmjs
