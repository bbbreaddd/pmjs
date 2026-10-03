#pragma once

#include <hb.h>
#include <cstdint>
#include <span>
#include <string>
#include <vector>

namespace pmjs {

struct TextFont {
  std::uint32_t strikeId;
  hb_font_t* font;
};

struct ShapedGlyph {
  std::uint32_t strikeId;
  std::uint32_t glyphIndex;
  std::uint32_t cluster;
  double xAdvance;
  double yAdvance;
  double xOffset;
  double yOffset;
};

struct ShapedText {
  std::vector<ShapedGlyph> glyphs;
  double advanceX = 0;
};

// Fonts are ordered configured fallbacks. Runs use script direction, without bidi layout.
std::vector<std::uint32_t> prepareCanvasText(const std::string& utf8);
ShapedText shapeText(std::span<const std::uint32_t> text,
                     std::span<const TextFont> fonts,
                     std::uint64_t& fallbackShapeCalls, double positionScale = 64.0);

}  // namespace pmjs
