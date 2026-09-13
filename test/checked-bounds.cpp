#include "checked_bounds.hpp"

#include <iostream>
#include <stdexcept>
#include <string>

namespace {

void require(bool condition, const std::string& message) {
  if (!condition) throw std::runtime_error(message);
}

}  // namespace

int main() {
  using pmjs::checkedImageExtent;

  // Non-positive dimensions rejected
  require(!checkedImageExtent(0, 100), "width 0 must be rejected");
  require(!checkedImageExtent(100, 0), "height 0 must be rejected");
  require(!checkedImageExtent(-1, 100), "negative width must be rejected");
  require(!checkedImageExtent(100, -5), "negative height must be rejected");

  // Exceeding max dimension rejected
  require(!checkedImageExtent(8193, 100), "width > 8192 must be rejected by default");
  require(!checkedImageExtent(100, 8193), "height > 8192 must be rejected by default");
  require(!checkedImageExtent(1025, 100, 1024), "width > custom max must be rejected");

  // Valid dimensions accepted with correct calculations
  auto valid = checkedImageExtent(640, 480);
  require(valid.has_value(), "640x480 must be valid");
  require(valid->width == 640, "width mismatch");
  require(valid->height == 480, "height mismatch");
  require(valid->strideBytes == 640U * 4U, "stride mismatch");
  require(valid->rgbBytes == 640U * 480U * 3U, "rgbBytes mismatch");
  require(valid->rgbaBytes == 640U * 480U * 4U, "rgbaBytes mismatch");

  // Allocation limit exceeded
  require(!checkedImageExtent(8192, 8192, 8192, 64 * 1024 * 1024),
          "8192x8192 (256MB) must exceed 64MB allocation ceiling");
  auto largeValid = checkedImageExtent(8192, 8192, 8192, 256 * 1024 * 1024);
  require(largeValid.has_value(), "8192x8192 must succeed with 256MB ceiling");
  require(largeValid->rgbaBytes == 8192U * 8192U * 4U, "8192x8192 byte count mismatch");

  std::cout << "native-checked-bounds: all assertions passed\n";
  return 0;
}
