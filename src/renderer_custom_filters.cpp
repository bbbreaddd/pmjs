#include "renderer.hpp"

#include <GLES3/gl3.h>
#include <algorithm>
#include <cmath>
#include <cstdio>
#include <limits>
#include <stdexcept>
#include <utility>

namespace pmjs {

bool Renderer::isIdentityColorMatrixPlan(const CustomFilterPlan& plan) const {
  constexpr std::array<double, 20> identity{1, 0, 0, 0, 0, 0, 1, 0, 0, 0,
                                          0, 0, 1, 0, 0, 0, 0, 0, 1, 0};
  return matchesColorMatrixPlan(plan, identity);
}

bool Renderer::matchesColorMatrixPlan(const CustomFilterPlan& plan,
                                     const std::array<double, 20>& expected) const {
  if (plan.resolutions.size() != 2 || plan.resolutions[0] != 1 ||
      plan.resolutions[1] != 1 || plan.passes.size() != 1) return false;
  const auto& pass = plan.passes.front();
  if (pass.input != 0 || pass.output != 1 || pass.clear || pass.blend != BlendMode::normal ||
      !pass.samplers.empty() || pass.transform != std::array<float, 6>{1, 0, 0, 1, 0, 0}) return false;
  if (std::any_of(pass.uniformClasses.begin(), pass.uniformClasses.end(),
      [](std::uint8_t value) { return value != 0; })) return false;
  const auto& program = filterProgram(pass.program);
  if (!program.identityColorMatrixContract) return false;
  std::size_t offset = 0;
  bool matrix = false, alpha = false;
  for (const auto& uniform : program.uniforms) {
    const std::size_t count = uniform.components * uniform.count;
    if (offset + count > pass.uniforms.size() || uniform.type != GL_FLOAT) return false;
    if ((uniform.name == "m" || uniform.name == "m[0]") && count == expected.size() && !matrix) {
      matrix = true;
      for (std::size_t index = 0; index < count; ++index)
        if (!std::isfinite(pass.uniforms[offset + index]) ||
            pass.uniforms[offset + index] != expected[index]) return false;
    } else if (uniform.name == "uAlpha" && count == 1 && !alpha) {
      alpha = true;
      if (pass.uniforms[offset] != 1) return false;
    } else return false;
    offset += count;
  }
  return matrix && alpha && offset == pass.uniforms.size();
}

void Renderer::reduceConstantBlackGroups() {
  if (offscreenRender_ || width_ <= 2 || height_ <= 2 ||
      sceneProjection_ != std::array<float, 6>{1, 0, 0, 1, 0, 0}) return;
  constexpr std::array<double, 20> black{1, 0, 0, -1, 0, 0, 1, 0, -1, 0,
                                       0, 0, 1, -1, 0, 0, 0, 0, 1, 0};
  std::vector<RenderCommand> reduced;
  std::size_t copied = 0;
  for (std::size_t begin = 0; begin + 2 < frame_.commands.size(); ++begin) {
    const auto& filter = frame_.commands[begin];
    if (filter.action != RenderCommand::Action::filterBegin ||
        filter.filterParameters[2] != 1 || !filter.customFilterPlan ||
        filter.blendMode != BlendMode::normal ||
        !matchesColorMatrixPlan(*filter.customFilterPlan, black)) continue;
    const auto& area = filter.customFilterPlan->frame;
    const float right = area[0] + area[2], bottom = area[1] + area[3];
    if (area[0] > 0 || area[1] > 0 || right < width_ || bottom < height_ ||
        !std::all_of(area.begin(), area.end(), [](float value) {
          return std::isfinite(value) && value == std::floor(value) &&
            value >= std::numeric_limits<int>::min() / 4 &&
            double(value) <= std::numeric_limits<int>::max() / 4;
        })) continue;
    const auto& backing = frame_.commands[begin + 1];
    if (backing.action != RenderCommand::Action::draw ||
        backing.primitive != RenderCommand::Primitive::screenFill ||
        backing.color != std::array<float, 4>{0, 0, 0, 1} || backing.clipped ||
        backing.blendMode != BlendMode::normal || backing.maskImage ||
        backing.appliesColorMatrix || backing.blur != 0) continue;
    std::size_t end = begin + 2;
    for (; end < frame_.commands.size(); ++end) {
      const auto& draw = frame_.commands[end];
      if (draw.action == RenderCommand::Action::filterEnd) break;
      if (draw.action != RenderCommand::Action::draw ||
          draw.blendMode != BlendMode::normal || draw.maskImage ||
          draw.appliesColorMatrix || draw.blur != 0 ||
          !std::isfinite(draw.color[3]) || draw.color[3] < 0 || draw.color[3] > 1 ||
          (draw.primitive != RenderCommand::Primitive::sprite &&
           draw.primitive != RenderCommand::Primitive::tilingSprite &&
           draw.primitive != RenderCommand::Primitive::tileLayer &&
           draw.primitive != RenderCommand::Primitive::screenFill)) break;
    }
    if (end >= frame_.commands.size() ||
        frame_.commands[end].action != RenderCommand::Action::filterEnd) continue;
    std::vector<std::pair<std::size_t, std::array<int, 4>>> fringes;
    double sourcePixels = 0, borderPixels = 0;
    // Keep a pixel inside the backing too: linear filter sampling can straddle its edge.
    const std::array<std::array<int, 4>, 4> borders{{
      {static_cast<int>(area[0]), static_cast<int>(area[1]), static_cast<int>(right), 1},
      {static_cast<int>(area[0]), height_ - 1, static_cast<int>(right), static_cast<int>(bottom)},
      {static_cast<int>(area[0]), 1, 1, height_ - 1},
      {width_ - 1, 1, static_cast<int>(right), height_ - 1}
    }};
    for (std::size_t index = begin + 2; index < end; ++index) {
      const auto& draw = frame_.commands[index];
      std::array<float, 4> bounds{area[0], area[1], right, bottom};
      if (!draw.tileLayer) {
        bounds = {std::numeric_limits<float>::infinity(), std::numeric_limits<float>::infinity(),
                  -std::numeric_limits<float>::infinity(), -std::numeric_limits<float>::infinity()};
        for (std::size_t corner = 0; corner < 4; ++corner) {
          const float x = corner == 1 || corner == 2 ? draw.destination[0] : 0;
          const float y = corner >= 2 ? draw.destination[1] : 0;
          float px = draw.spriteWorldVertices ? draw.spriteVertices[corner][0] :
            draw.transform[0] * x + draw.transform[2] * y + draw.transform[4];
          float py = draw.spriteWorldVertices ? draw.spriteVertices[corner][1] :
            draw.transform[1] * x + draw.transform[3] * y + draw.transform[5];
          if (draw.roundPixels) { px = std::floor(px); py = std::floor(py); }
          bounds[0] = std::min(bounds[0], px); bounds[1] = std::min(bounds[1], py);
          bounds[2] = std::max(bounds[2], px); bounds[3] = std::max(bounds[3], py);
        }
      }
      const auto pixelsIn = [&](const auto& box) {
        double left = std::max(double(bounds[0]), double(box[0]));
        double top = std::max(double(bounds[1]), double(box[1]));
        double right = std::min(double(bounds[2]), double(box[2]));
        double bottom = std::min(double(bounds[3]), double(box[3]));
        if (draw.clipped) {
          left = std::max(left, double(draw.clip[0])); top = std::max(top, double(draw.clip[1]));
          right = std::min(right, double(draw.clip[2])); bottom = std::min(bottom, double(draw.clip[3]));
        }
        return std::max(0.0, right - left) * std::max(0.0, bottom - top);
      };
      sourcePixels += pixelsIn(std::array<float, 4>{area[0], area[1], right, bottom});
      for (auto border : borders) {
        if (draw.clipped) {
          border[0] = std::max(border[0], draw.clip[0]);
          border[1] = std::max(border[1], draw.clip[1]);
          border[2] = std::min(border[2], draw.clip[2]);
          border[3] = std::min(border[3], draw.clip[3]);
        }
        if (border[0] >= border[2] || border[1] >= border[3]) continue;
        if (bounds[0] >= border[2] || bounds[1] >= border[3] ||
            bounds[2] <= border[0] || bounds[3] <= border[1]) continue;
        borderPixels += pixelsIn(border);
        fringes.emplace_back(index, border);
      }
    }
    const std::size_t sourceDraws = end - begin - 2;
    if (diagnostics_) {
      stats_.constantBlackSourceDraws += sourceDraws;
      stats_.constantBlackBorderDraws += fringes.size();
    }
    // Extra submissions need substantial pixel savings; keep small fringe-only draws intact.
    constexpr double pixelsPerExtraDraw = 4096;
    if (fringes.size() >= sourceDraws && sourcePixels - borderPixels <=
        (fringes.size() - sourceDraws) * pixelsPerExtraDraw) {
      if (diagnostics_) ++stats_.constantBlackGroupsSkipped;
      continue;
    }
    reduced.insert(reduced.end(), frame_.commands.begin() + copied,
                   frame_.commands.begin() + begin + 2);
    for (const auto& [index, border] : fringes) {
      auto fringe = frame_.commands[index];
      fringe.clipped = true; fringe.clip = border;
      reduced.push_back(std::move(fringe));
    }
    copied = end;
    begin = end;
    if (diagnostics_) ++stats_.constantBlackGroups;
  }
  if (!copied) return;
  reduced.insert(reduced.end(), frame_.commands.begin() + copied, frame_.commands.end());
  // Transfer queued ownership before dropping or duplicating source commands.
  for (const auto& command : reduced) {
    if (command.image) images_.beginUse(command.image);
    if (command.maskImage) images_.beginUse(command.maskImage);
    if (command.tileLayer) ++tileLayers_.at(command.tileLayer).queuedReferences;
  }
  discardCommandsFrom(0);
  frame_.commands.swap(reduced);
}

// Cache only isolated, sampler-free chains fed by tracked image draws. The
// final pass still runs against the live destination, preserving its blending.
std::string Renderer::filterIntermediateKey(const RenderCommand& command) const {
  if (offscreenRender_ || command.filterParameters[1] != 1 ||
      sceneProjection_ != std::array<float, 6>{1, 0, 0, 1, 0, 0} ||
      !command.customFilterPlan) return {};
  const auto& plan = *command.customFilterPlan;
  if (plan.passes.empty() || (plan.passes.size() == 1 ?
      plan.passes.front().input != 0 : plan.passes.back().input == 0) ||
      plan.passes.back().output != 1 ||
      !std::all_of(plan.resolutions.begin(), plan.resolutions.end(),
        [](float value) { return value == 1; })) return {};
  int width = 1, height = 1;
  while (width < plan.frame[2]) width *= 2;
  while (height < plan.frame[3]) height *= 2;
  if (static_cast<std::size_t>(width) * height * 4 > 8U * 1024U * 1024U) return {};
  std::string key;
  const auto append = [&](const auto& value) {
    key.append(reinterpret_cast<const char*>(&value), sizeof(value));
  };
  append(width_); append(height_); append(plan.frame); append(command.clip); append(command.clipped);
  append(plan.passes.size());
  for (std::size_t index = 0; index < plan.passes.size(); ++index) {
    const auto& pass = plan.passes[index];
    if (!pass.samplers.empty() || (index + 1 < plan.passes.size() && pass.output == 1)) return {};
    if (plan.passes.size() == 1) continue;
    append(pass.program); append(pass.input); append(pass.output); append(pass.clear);
    append(pass.blend); append(pass.transform); append(pass.uniforms.size());
    for (double value : pass.uniforms) append(value);
    append(pass.uniformClasses.size());
    for (auto value : pass.uniformClasses) append(value);
  }
  const auto begin = static_cast<std::size_t>(&command - frame_.commands.data());
  bool ended = false;
  std::size_t draws = 0;
  for (std::size_t index = begin + 1; index < frame_.commands.size(); ++index) {
    const auto& draw = frame_.commands[index];
    if (draw.action == RenderCommand::Action::filterEnd) { ended = true; break; }
    if (draw.action == RenderCommand::Action::clearRect) {
      append(draw.action); append(draw.clearRectangle);
      continue;
    }
    if (draw.action != RenderCommand::Action::draw || ++draws > 64 ||
        (draw.primitive != RenderCommand::Primitive::sprite &&
         draw.primitive != RenderCommand::Primitive::tilingSprite &&
         draw.primitive != RenderCommand::Primitive::tileLayer) ||
        draw.maskImage || draw.appliesColorMatrix || draw.appliesSpriteColor ||
        draw.appliesMeshPostTintOverlay || draw.blur != 0 || draw.mipmap ||
        draw.standaloneBitmapRegion || draw.textureRotation) return {};
    append(draw.action); append(draw.primitive);
    if (draw.primitive == RenderCommand::Primitive::tileLayer) {
      // Tile handles identify immutable geometry; textures and animation remain live.
      const auto layer = tileLayers_.find(draw.tileLayer);
      if (layer == tileLayers_.end() || layer->second.triangleCoverage ||
          layer->second.triangleSourceMappingEnabled ||
          !std::holds_alternative<TexturedMeshMaterial>(layer->second.material)) return {};
      append(draw.tileLayer); append(draw.tileAnimation); append(draw.transform); append(draw.color);
      append(draw.blendMode); append(draw.nearest); append(draw.clip); append(draw.clipped);
      append(layer->second.images.size());
      for (const auto image : layer->second.images) {
        const auto revision = images_.contentRevision(image);
        if (!revision) return {};
        append(image); append(*revision);
      }
      continue;
    }
    if (draw.tileLayer) return {};
    const auto revision = images_.contentRevision(draw.image);
    if (!revision) return {};
    append(draw.image); append(*revision);
    append(draw.transform); append(draw.source); append(draw.destination); append(draw.color);
    append(draw.blendMode); append(draw.repeat); append(draw.nearest);
    append(draw.clip); append(draw.clipped); append(draw.roundPixels);
    append(draw.pixiSpritePacking); append(draw.premultipliedSpriteTexture);
    append(draw.packedSpriteColor); append(draw.floatSpriteUv); append(draw.spriteWorldVertices);
    if (draw.spriteWorldVertices) append(draw.spriteVertices);
    append(draw.clampedTilingSampling); append(draw.atlasTilingSampling);
    if (draw.clampedTilingSampling) append(draw.tilingUvTransform);
    if (draw.atlasTilingSampling) { append(draw.tilingAtlasMapping); append(draw.tilingAtlasBounds); }
  }
  return ended && draws ? key : std::string{};
}

void Renderer::drawCustomFilterPlan(const CustomFilterPlan& plan, RenderTarget& source,
                                    const RenderTarget& output, const RenderCommand& command,
                                    float sourceResolution, float outputResolution, bool outputYDown,
                                    const std::array<float, 4>& outputFrame, bool sourcePaddingKnownZero, const std::string& cacheKey) {
  const auto& frame = plan.frame;
  const bool cacheHit = !cacheKey.empty() && filterIntermediateTarget_.texture &&
    filterIntermediateSignature_ == cacheKey;
  if (!cacheKey.empty()) filterIntermediateUsed_ = true;
  if (cacheHit && diagnostics_) ++stats_.filterIntermediateCacheHits;
  if (frame[2] == 0 || frame[3] == 0) return;
  const auto pot = [this](float value) {
    if (!std::isfinite(value) || value > maxTextureSize_)
      throw std::invalid_argument("custom filter target exceeds texture size");
    const int size = std::max(1, static_cast<int>(value));
    int result = 1;
    while (result < size) result *= 2;
    if (result > maxTextureSize_) throw std::invalid_argument("custom filter target exceeds texture size");
    return result;
  };
  // Custom groups already have downward-oriented RGBA storage and cleared padding.
  // Borrow only a read-only input; longer chains can write back into target zero.
  const int sourceLogicalWidth = source.logicalWidth > 0 ? source.logicalWidth : source.width;
  const int sourceLogicalHeight = source.logicalHeight > 0 ? source.logicalHeight : source.height;
  const bool borrowInput = sourcePaddingKnownZero &&
      plan.resolutions.size() == 2 && plan.passes.size() == 1 &&
      plan.passes[0].input == 0 && plan.passes[0].output == 1 &&
      plan.passes[0].samplers.empty() && sourceResolution == plan.resolutions[0] &&
      sourceLogicalWidth == pot(frame[2] * plan.resolutions[0]) &&
      sourceLogicalHeight == pot(frame[3] * plan.resolutions[0]) &&
      source.framebuffer != output.framebuffer && source.texture != output.texture;
  const bool sourceCache = plan.passes.size() == 1 && borrowInput;
  // Targets are reused only after the complete pass sequence has finished.
  if (customPassTargets_.size() < plan.resolutions.size())
    customPassTargets_.resize(plan.resolutions.size());
  if (!sourceCache && !cacheHit && !cacheKey.empty() && filterIntermediateTarget_.texture) {
    // Changing inputs render live without allocating a new target every frame.
    filterIntermediateSignature_.clear();
    std::swap(filterIntermediateTarget_, customPassTargets_[plan.passes.back().input]);
  }
  for (std::size_t index = 0; !cacheHit && index < plan.resolutions.size(); ++index) {
    if (index == 1 || (index == 0 && borrowInput)) continue;
    auto& target = customPassTargets_[index];
    const int requestWidth = pot(frame[2] * plan.resolutions[index]);
    const int requestHeight = pot(frame[3] * plan.resolutions[index]);
    if (filterTargetDiagnostics()) {
      std::fprintf(stderr,
        "[pmjs-filter-target] slot=%zu frame=%.2fx%.2f res=%.3f pot=%dx%d\n",
        index, frame[2], frame[3], plan.resolutions[index], requestWidth, requestHeight);
    }
    ensureFilterTarget(target, requestWidth, requestHeight, index, frameTick_, true);
    glBindFramebuffer(GL_FRAMEBUFFER, target.framebuffer);
    // Clear the logical extent only: the physical tail beyond it is never
    // written and is cleared when the target is allocated, so content outside
    // the frame still reads transparent.
    glClearColor(0, 0, 0, 0);
    if (target.fullClearPending) {
      glDisable(GL_SCISSOR_TEST);
      target.fullClearPending = false;
    } else {
      glEnable(GL_SCISSOR_TEST);
      glScissor(0, 0, requestWidth, requestHeight);
    }
    glClear(GL_COLOR_BUFFER_BIT);
    glDisable(GL_SCISSOR_TEST);
    if (diagnostics_) ++stats_.filterTargetClears;
  }
  const auto& input = cacheHit ? filterIntermediateTarget_ :
    borrowInput ? source : customPassTargets_[0];
  const float resolution = plan.resolutions[0];
  const int sourceWidth = static_cast<int>(frame[2] * sourceResolution);
  const int sourceHeight = static_cast<int>(frame[3] * sourceResolution);
  if (!cacheHit && !borrowInput && sourceWidth > 0 && sourceHeight > 0) {
    glBindFramebuffer(GL_READ_FRAMEBUFFER, source.framebuffer);
    glBindFramebuffer(GL_DRAW_FRAMEBUFFER, input.framebuffer);
    glBlitFramebuffer(0, 0, sourceWidth, sourceHeight, 0, 0,
      static_cast<int>(frame[2] * resolution), static_cast<int>(frame[3] * resolution),
      GL_COLOR_BUFFER_BIT, GL_NEAREST);
    if (diagnostics_) ++stats_.framebufferCopies;
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
  const int inputLogicalWidth = input.logicalWidth > 0 ? input.logicalWidth : input.width;
  const int inputLogicalHeight = input.logicalHeight > 0 ? input.logicalHeight : input.height;
  const float u = frame[2] * resolution / inputLogicalWidth;
  const float v = frame[3] * resolution / inputLogicalHeight;
  const float right = frame[0] + frame[2], bottom = frame[1] + frame[3];
  const std::array<float, 24> quad{
    frame[0], frame[1], 0, 0, right, frame[1], u, 0, right, bottom, u, v,
    frame[0], frame[1], 0, 0, right, bottom, u, v, frame[0], bottom, 0, v};
  glBindVertexArray(customFilterVertexArray_);
  glBindBuffer(GL_ARRAY_BUFFER, customFilterVertexBuffer_);
  glBufferData(GL_ARRAY_BUFFER, sizeof(quad), quad.data(), GL_STREAM_DRAW);
  const bool identity = isIdentityColorMatrixPlan(plan);
  for (std::size_t passIndex = cacheHit ? plan.passes.size() - 1 : 0;
       passIndex < plan.passes.size(); ++passIndex) {
    const auto& pass = plan.passes[passIndex];
    const auto& custom = filterProgram(pass.program);
    const auto shader = identity ? custom.identityProgram : custom.program;
    const bool final = pass.output == 1;
    auto& target = customPassTargets_[pass.output];
    const float targetWidth = final ? outputFrame[2] : frame[2];
    const float targetHeight = final ? outputFrame[3] : frame[3];
    glBindFramebuffer(GL_FRAMEBUFFER, final ? output.framebuffer : target.framebuffer);
    glViewport(0, 0, final ? static_cast<int>(outputFrame[2] * outputResolution) : static_cast<int>(frame[2] * plan.resolutions[pass.output]),
      final ? static_cast<int>(outputFrame[3] * outputResolution) : static_cast<int>(frame[3] * plan.resolutions[pass.output]));
    glDisable(GL_SCISSOR_TEST);
    if (pass.clear) {
      glClearColor(0, 0, 0, 0);
      glClear(GL_COLOR_BUFFER_BIT);
      if (diagnostics_) ++stats_.filterTargetClears;
    }
    if (final && command.clipped) {
      glEnable(GL_SCISSOR_TEST);
      glScissor(std::lround((command.clip[0] - outputFrame[0]) * outputResolution),
        std::lround((outputYDown ? command.clip[1] - outputFrame[1] : outputFrame[1] + outputFrame[3] - command.clip[3]) * outputResolution),
        std::lround((command.clip[2] - command.clip[0]) * outputResolution),
        std::lround((command.clip[3] - command.clip[1]) * outputResolution));
    }
    glUseProgram(shader);
    // The vertex stage still hands the fragment the logical coordinate; the
    // sampler read is scaled here when the target is physically larger.
    const RenderTarget* sampled = cacheHit ? &filterIntermediateTarget_ :
      borrowInput ? &source : &customPassTargets_[pass.input];
    const int sampleScaleLocation =
      identity ? custom.identitySampleScaleLocation : custom.sampleScaleLocation;
    if (sampleScaleLocation >= 0) {
      const int sampledWidth = sampled->width > 0 ? sampled->width : 1;
      const int sampledHeight = sampled->height > 0 ? sampled->height : 1;
      const int sampledLogicalWidth = sampled->logicalWidth > 0 ?
        sampled->logicalWidth : sampledWidth;
      const int sampledLogicalHeight = sampled->logicalHeight > 0 ?
        sampled->logicalHeight : sampledHeight;
      glUniform2f(sampleScaleLocation,
        static_cast<float>(sampledLogicalWidth) / sampledWidth,
        static_cast<float>(sampledLogicalHeight) / sampledHeight);
    }
    const bool yDown = !final || outputYDown;
    const float sx = 2.0F / targetWidth, sy = (yDown ? 2.0F : -2.0F) / targetHeight;
    const auto& local = pass.transform;
    const auto& parent = sceneProjection_;
    const std::array<float, 6> transform{
      parent[0] * local[0] + parent[2] * local[1], parent[1] * local[0] + parent[3] * local[1],
      parent[0] * local[2] + parent[2] * local[3], parent[1] * local[2] + parent[3] * local[3],
      parent[0] * local[4] + parent[2] * local[5] + parent[4],
      parent[1] * local[4] + parent[3] * local[5] + parent[5]};
    const std::array<float, 9> projection{sx * transform[0], sy * transform[1], 0,
      sx * transform[2], sy * transform[3], 0,
      -1.0F - (final ? outputFrame[0] * sx : frame[0] * sx) + sx * transform[4],
      (final ? (yDown ? -1.0F : 1.0F) - outputFrame[1] * sy : -1.0F - frame[1] * sy) + sy * transform[5], 1};
    const auto& builtInLocations = identity ? custom.identityBuiltInUniformLocations :
      custom.builtInUniformLocations;
    glUniformMatrix3fv(builtInLocations[0], 1, GL_FALSE, projection.data());
    glUniform4f(builtInLocations[1],
      inputLogicalWidth / resolution, inputLogicalHeight / resolution, frame[0], frame[1]);
    glUniform4f(builtInLocations[2], 0, 0,
      (frame[2] - 1) * resolution / inputLogicalWidth,
      (frame[3] - 1) * resolution / inputLogicalHeight);
    glActiveTexture(GL_TEXTURE0);
    const auto inputTexture = cacheHit ? filterIntermediateTarget_.texture :
      borrowInput ? input.texture : customPassTargets_[pass.input].texture;
    glBindTexture(GL_TEXTURE_2D, inputTexture);
    glTexParameteri(GL_TEXTURE_2D, GL_TEXTURE_MIN_FILTER, GL_LINEAR);
    glTexParameteri(GL_TEXTURE_2D, GL_TEXTURE_MAG_FILTER, GL_LINEAR);
    textureNearestState_[inputTexture] = false;
    glUniform1i(builtInLocations[3], 0);
    std::size_t offset = 0, samplerOffset = 0;
    int unit = 1;
    std::size_t uniformIndex = 0;
    for (const auto& uniform : custom.uniforms) {
      const auto location = identity ? custom.identityUniformLocations[uniformIndex] : uniform.location;
      ++uniformIndex;
      if (uniform.type == GL_SAMPLER_2D) {
        std::vector<GLint> units;
        for (int index = 0; index < uniform.count; ++index) {
          const auto& sampler = pass.samplers[samplerOffset++];
          glActiveTexture(GL_TEXTURE0);
          const auto image = sampler.image ? images_.lookupPremultiplied(sampler.image) : std::optional<ImageInfo>{};
          if (sampler.image && !image) throw std::runtime_error("filter sampler image expired");
          const auto texture = image ? image->texture : customPassTargets_[sampler.target].texture;
          glActiveTexture(GL_TEXTURE0 + unit);
          glBindTexture(GL_TEXTURE_2D, texture);
          const bool mipmap = sampler.mipmap && sampler.image && images_.ensureMipmaps(sampler.image, true);
          glTexParameteri(GL_TEXTURE_2D, GL_TEXTURE_MIN_FILTER, mipmap ?
            (sampler.nearest ? GL_NEAREST_MIPMAP_NEAREST : GL_LINEAR_MIPMAP_LINEAR) :
            (sampler.nearest ? GL_NEAREST : GL_LINEAR));
          const bool potImage = image && !(image->width & (image->width - 1)) && !(image->height & (image->height - 1));
          const auto wrap = potImage ? sampler.wrap : static_cast<std::uint32_t>(GL_CLAMP_TO_EDGE);
          glTexParameteri(GL_TEXTURE_2D, GL_TEXTURE_WRAP_S, wrap);
          glTexParameteri(GL_TEXTURE_2D, GL_TEXTURE_WRAP_T, wrap);
          textureRepeatState_.erase(texture);
          glTexParameteri(GL_TEXTURE_2D, GL_TEXTURE_MAG_FILTER, sampler.nearest ? GL_NEAREST : GL_LINEAR);
          textureNearestState_.erase(texture);
          units.push_back(unit++);
        }
        glUniform1iv(location, uniform.count, units.data());
        continue;
      }
      const auto count = uniform.components * uniform.count;
      const auto start = pass.uniforms.begin() + offset;
      std::vector<float> floats(start, start + count);
      if (!pass.uniformClasses.empty()) {
        for (int index = 0; index < count; ++index) {
          switch (pass.uniformClasses[offset + index]) {
            case 1: floats[index] = std::numeric_limits<float>::quiet_NaN(); break;
            case 2: floats[index] = std::numeric_limits<float>::infinity(); break;
            case 3: floats[index] = -std::numeric_limits<float>::infinity(); break;
          }
        }
      }
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
        case GL_FLOAT: glUniform1fv(location, uniform.count, data); break;
        case GL_FLOAT_VEC2: glUniform2fv(location, uniform.count, data); break;
        case GL_FLOAT_VEC3: glUniform3fv(location, uniform.count, data); break;
        case GL_FLOAT_VEC4: glUniform4fv(location, uniform.count, data); break;
        case GL_FLOAT_MAT2: glUniformMatrix2fv(location, uniform.count, GL_FALSE, data); break;
        case GL_FLOAT_MAT3: glUniformMatrix3fv(location, uniform.count, GL_FALSE, data); break;
        case GL_FLOAT_MAT4: glUniformMatrix4fv(location, uniform.count, GL_FALSE, data); break;
        case GL_INT: case GL_BOOL: glUniform1iv(location, uniform.count, integers.data()); break;
        case GL_INT_VEC2: case GL_BOOL_VEC2: glUniform2iv(location, uniform.count, integers.data()); break;
        case GL_INT_VEC3: case GL_BOOL_VEC3: glUniform3iv(location, uniform.count, integers.data()); break;
        case GL_INT_VEC4: case GL_BOOL_VEC4: glUniform4iv(location, uniform.count, integers.data()); break;
      }
      offset += count;
    }
    glActiveTexture(GL_TEXTURE0);
    glBindTexture(GL_TEXTURE_2D, inputTexture);
    glEnable(GL_BLEND);
    applyBlendMode(pass.blend);
    glDrawArrays(GL_TRIANGLES, 0, 6);
    if (diagnostics_) {
      if (identity) ++stats_.identityFilterShaderDrawCalls;
      ++stats_.drawCalls;
      ++stats_.filterDrawCalls;
    }
  }
  glBindFramebuffer(GL_FRAMEBUFFER, output.framebuffer);
  glViewport(0, 0, static_cast<int>(outputFrame[2] * outputResolution), static_cast<int>(outputFrame[3] * outputResolution));
  if (!cacheKey.empty() && !cacheHit) {
    filterIntermediateSignature_ = cacheKey;
    if (sourceCache) {
      std::swap(filterIntermediateTarget_, source);
    } else {
      destroyTarget(filterIntermediateTarget_);
      std::swap(filterIntermediateTarget_, customPassTargets_[plan.passes.back().input]);
    }
  }
  glBindVertexArray(vertexArray_);
  glBindBuffer(GL_ARRAY_BUFFER, vertexBuffer_);
  glActiveTexture(GL_TEXTURE0);
  glDisable(GL_SCISSOR_TEST);
}

}  // namespace pmjs
