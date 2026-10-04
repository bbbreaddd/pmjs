#include "canvas_pixels.hpp"
#include <array>
#include <cassert>
#include <stdexcept>
#include <vector>
using namespace pmjs;
int main() {
  std::array<uint8_t, 4> input{37,67,103,157}, raw{}, output{};
  convertPixel(input.data(), PixelEncoding::StraightRGBA8, raw.data(), PixelEncoding::PremultipliedBGRA8);
  assert((raw == std::array<uint8_t,4>{63,41,23,157}));
  convertPixel(raw.data(), PixelEncoding::PremultipliedBGRA8, output.data(), PixelEncoding::StraightRGBA8);
  assert((output == std::array<uint8_t,4>{37,67,102,157}));
  std::vector<uint8_t> source(48, 99), destination(60, 77);
  for (int y=0; y<3; ++y) for(int x=0; x<2; ++x) {
    const uint8_t color[] = {255,127,5,static_cast<uint8_t>(y*127)};
    std::copy_n(color, 4, source.data()+y*16+x*4);
  }
  convertPixels(ConstPixelView(source.data(),40,2,3,16,PixelEncoding::PremultipliedRGBA8),
    PixelView(destination.data(),48,2,3,20,PixelEncoding::PremultipliedBGRA8));
  for (int y=0;y<3;++y) {
    assert(destination[y*20]==5 && destination[y*20+2]==255);
    for(int x=8;x<20;++x) assert(destination[y*20+x]==77);
  }
  convertPixels(ConstPixelView(destination.data(),48,2,3,20,PixelEncoding::PremultipliedBGRA8),
    PixelView(destination.data(),48,2,3,20,PixelEncoding::PremultipliedRGBA8));
  assert(destination[0]==255 && destination[2]==5 && destination[3]==0);
  for (const auto stride : {size_t{7},SIZE_MAX}) {
    bool rejected=false;
    try { PixelView view(destination.data(),destination.size(),2,3,stride,PixelEncoding::StraightRGBA8); }
    catch(const std::invalid_argument&) { rejected=true; }
    assert(rejected);
  }
  bool rejected=false;
  try { PixelView view(destination.data(),47,2,3,20,PixelEncoding::StraightRGBA8); }
  catch(const std::invalid_argument&) { rejected=true; }
  assert(rejected);
}
