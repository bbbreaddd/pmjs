#include "text_layout.hpp"
#include "unicode_default_ignorables.hpp"

#include <algorithm>
#include <limits>
#include <memory>
#include <stdexcept>

namespace pmjs {
namespace {
using Buffer = std::unique_ptr<hb_buffer_t, decltype(&hb_buffer_destroy)>;

Buffer newBuffer() {
  Buffer buffer(hb_buffer_create(), hb_buffer_destroy);
  if (!hb_buffer_allocation_successful(buffer.get())) throw std::bad_alloc();
  return buffer;
}

}  // namespace

std::vector<std::uint32_t> prepareCanvasText(const std::string& text) {
  if (text.size() > static_cast<std::size_t>(std::numeric_limits<int>::max())) {
    throw std::length_error("text too long");
  }
  auto buffer = newBuffer();
  hb_buffer_add_utf8(buffer.get(), text.data(), static_cast<int>(text.size()),
                     0, static_cast<int>(text.size()));
  if (!hb_buffer_allocation_successful(buffer.get())) throw std::bad_alloc();
  unsigned count = 0;
  const auto* info = hb_buffer_get_glyph_infos(buffer.get(), &count);
  std::vector<std::uint32_t> result;
  result.reserve(count);
  for (unsigned i = 0; i < count; ++i) {
    auto cp = info[i].codepoint;
    // Canvas replaces ASCII whitespace, including CR/LF independently, with spaces.
    if (cp == 0x09 || cp == 0x0A || cp == 0x0C || cp == 0x0D) cp = 0x20;
    result.push_back(cp);
  }
  return result;
}

namespace {

bool neutralScript(hb_script_t script) {
  return script == HB_SCRIPT_COMMON || script == HB_SCRIPT_INHERITED ||
         script == HB_SCRIPT_UNKNOWN;
}

std::vector<ShapedGlyph> shapeRun(std::span<const std::uint32_t> text,
    unsigned begin, unsigned end, hb_script_t script, hb_direction_t direction,
    std::span<const TextFont> fonts, std::uint64_t& fallbackShapeCalls,
    bool allowFallback = true) {
  auto buffer = newBuffer();
  hb_buffer_add_utf32(buffer.get(), text.data(), static_cast<int>(text.size()),
                      begin, static_cast<int>(end - begin));
  hb_buffer_set_script(buffer.get(), script);
  hb_buffer_set_direction(buffer.get(), direction);
  hb_buffer_set_language(buffer.get(), hb_language_from_string("und", -1));
  hb_buffer_set_cluster_level(buffer.get(), HB_BUFFER_CLUSTER_LEVEL_MONOTONE_GRAPHEMES);
  // Removal happens after shaping, so joiners and selectors still affect glyph selection.
  hb_buffer_set_flags(buffer.get(), HB_BUFFER_FLAG_REMOVE_DEFAULT_IGNORABLES);
  hb_shape(fonts.front().font, buffer.get(), nullptr, 0);
  if (!hb_buffer_allocation_successful(buffer.get())) throw std::bad_alloc();
  unsigned count = 0;
  const auto* info = hb_buffer_get_glyph_infos(buffer.get(), &count);
  const auto* positions = hb_buffer_get_glyph_positions(buffer.get(), nullptr);
  std::vector<ShapedGlyph> glyphs;
  glyphs.reserve(count);
  for (unsigned i = 0; i < count; ++i) {
    glyphs.push_back({fonts.front().strikeId, info[i].codepoint, info[i].cluster,
      positions[i].x_advance / 64.0, positions[i].y_advance / 64.0,
      positions[i].x_offset / 64.0, positions[i].y_offset / 64.0});
  }

  // Retry whole shaping clusters, including bases and marks, with surrounding context.
  std::vector<unsigned> clusters{end};
  for (const auto& glyph : glyphs) clusters.push_back(glyph.cluster);
  std::sort(clusters.begin(), clusters.end());
  clusters.erase(std::unique(clusters.begin(), clusters.end()), clusters.end());
  std::vector<ShapedGlyph> result;
  const auto missingGlyph = [](const auto& glyph) { return glyph.glyphIndex == 0; };
  const auto fallback = [&](unsigned start, unsigned stop) {
    std::vector<ShapedGlyph> replacement;
    for (std::size_t font = 1; font < fonts.size(); ++font) {
      ++fallbackShapeCalls;
      auto candidate = shapeRun(text, start, stop, script, direction,
                                 fonts.subspan(font, 1), fallbackShapeCalls, false);
      if (!candidate.empty() && std::none_of(candidate.begin(), candidate.end(), missingGlyph)) {
        replacement = std::move(candidate);
        break;
      }
    }
    return replacement;
  };
  for (std::size_t i = 0; i < glyphs.size();) {
    std::size_t j = i + 1;
    while (j < glyphs.size() && glyphs[j].cluster == glyphs[i].cluster) ++j;
    const auto start = glyphs[i].cluster;
    const auto stop = *std::upper_bound(clusters.begin(), clusters.end(), start);
    const bool missing = std::any_of(glyphs.begin() + i, glyphs.begin() + j, missingGlyph);
    const bool invisible = std::all_of(text.begin() + start, text.begin() + stop,
      [](auto cp) { return isDefaultIgnorable(cp); });
    if (!invisible && missing && allowFallback && fonts.size() > 1) {
      // Adjacent missing clusters must shape together to allow fallback ligatures.
      auto spanStart = start;
      auto spanStop = stop;
      auto spanEnd = j;
      while (spanEnd < glyphs.size()) {
        auto nextEnd = spanEnd + 1;
        while (nextEnd < glyphs.size() &&
               glyphs[nextEnd].cluster == glyphs[spanEnd].cluster) ++nextEnd;
        if (!std::any_of(glyphs.begin() + spanEnd, glyphs.begin() + nextEnd, missingGlyph)) break;
        const auto nextStart = glyphs[spanEnd].cluster;
        spanStart = std::min(spanStart, nextStart);
        spanStop = std::max(spanStop, *std::upper_bound(clusters.begin(), clusters.end(), nextStart));
        spanEnd = nextEnd;
      }
      auto replacement = fallback(spanStart, spanStop);
      if (!replacement.empty()) j = spanEnd;
      else if (spanEnd != j) replacement = fallback(start, stop);
      // Keep the original notdef if no configured face can render the complete cluster.
      if (!replacement.empty()) {
        result.insert(result.end(), replacement.begin(), replacement.end());
      } else {
        result.insert(result.end(), glyphs.begin() + i, glyphs.begin() + j);
      }
    } else if (!invisible) {
      result.insert(result.end(), glyphs.begin() + i, glyphs.begin() + j);
    }
    i = j;
  }
  return result;
}
}  // namespace

ShapedText shapeText(std::span<const std::uint32_t> text,
                     std::span<const TextFont> fonts,
                     std::uint64_t& fallbackShapeCalls) {
  ShapedText result;
  if (fonts.empty()) return result;
  std::vector<hb_script_t> scripts;
  scripts.reserve(text.size());
  hb_script_t previous = HB_SCRIPT_UNKNOWN;
  for (auto cp : text) {
    auto script = hb_unicode_script(hb_unicode_funcs_get_default(), cp);
    if (neutralScript(script)) script = previous;
    else previous = script;
    scripts.push_back(script);
  }
  hb_script_t next = HB_SCRIPT_LATIN;
  for (std::size_t i = scripts.size(); i > 0; --i) {
    if (neutralScript(scripts[i - 1])) scripts[i - 1] = next;
    else next = scripts[i - 1];
  }
  for (unsigned begin = 0; begin < text.size();) {
    unsigned end = begin + 1;
    while (end < text.size() && scripts[end] == scripts[begin]) ++end;
    auto direction = hb_script_get_horizontal_direction(scripts[begin]);
    if (direction == HB_DIRECTION_INVALID) direction = HB_DIRECTION_LTR;
    auto run = shapeRun(text, begin, end, scripts[begin], direction, fonts, fallbackShapeCalls);
    for (const auto& glyph : run) result.advanceX += glyph.xAdvance;
    result.glyphs.insert(result.glyphs.end(), run.begin(), run.end());
    begin = end;
  }
  return result;
}
}  // namespace pmjs
