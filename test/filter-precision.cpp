#include "renderer_shaders.hpp"

#include <cassert>
#include <iostream>
#include <string>

namespace {

int failures = 0;

void check(bool condition, const char* label) {
  if (!condition) {
    ++failures;
    std::cerr << "FAIL: " << label << "\n";
  }
}

std::string::size_type countOccurrences(const std::string& haystack,
                                        const std::string& needle) {
  std::string::size_type count = 0;
  std::string::size_type at = 0;
  while ((at = haystack.find(needle, at)) != std::string::npos) {
    ++count;
    at += needle.size();
  }
  return count;
}

}

int main() {
  using pmjs::renderer_shaders::filterFragmentSourceWithPrecision;
  using pmjs::renderer_shaders::fragmentSource;

  const std::string stock(fragmentSource);
  check(countOccurrences(stock, "precision mediump float;") == 1,
        "stock source declares its default precision exactly once");
  check(stock.find("precision highp float;") == std::string::npos,
        "stock source has no highp default");

  const std::string high =
      filterFragmentSourceWithPrecision("highp");
  check(countOccurrences(high, "precision highp float;") == 1,
        "highp build declares highp exactly once");
  check(high.find("precision mediump float;") == std::string::npos,
        "highp build keeps no mediump default");
  check(high.size() + 2 == stock.size(),
        "highp build differs from stock only by the shorter qualifier");

  const std::string medium =
      filterFragmentSourceWithPrecision("mediump");
  check(medium == stock, "mediump build is byte-identical to stock");

  const std::string low = filterFragmentSourceWithPrecision("lowp");
  check(countOccurrences(low, "precision lowp float;") == 1,
        "lowp build declares lowp exactly once");

  bool rejected = false;
  try {
    filterFragmentSourceWithPrecision("ultra");
  } catch (const std::runtime_error&) {
    rejected = true;
  }
  check(rejected, "unknown precision string is rejected");

  if (failures == 0) std::cout << "filter-precision: all checks passed\n";
  return failures == 0 ? 0 : 1;
}
