#include "skia65/pmjs_skia65.h"
#include <algorithm>
#include <array>
#include <cassert>
#include <cstdint>
#include <cstring>
#include <iostream>
#include <vector>
int main() {
  constexpr int width=17, height=11, stride=width*4+12;
  const float rect[]={5.25f,7.75f,11.5f,7.125f}, gradient[]={4,6,20,16};
  const float offsets[]={0,0.4f,1};
  const uint32_t colors[]={0x2543679d,0xe0903040,0x0208ef81};
  for (int variant=0;variant<9;++variant) {
    std::vector<uint8_t> tight(width*height*4,0), strided(stride*height,77);
    for(int y=0;y<height;++y) std::fill_n(strided.data()+y*stride,width*4,0);
    const float stroke=variant%3==0 ? 0 : variant%3==1 ? 1.5f : 4.25f;
    const size_t count=variant/3;
    assert(pmjs_skia65_rect_bgra(tight.data(),width,height,4,6,rect,0x2543679d,stroke,gradient,offsets,colors,count?3:0));
    assert(pmjs_skia65_rect_bgra_strided(strided.data(),width,height,stride,4,6,rect,0x2543679d,stroke,gradient,offsets,colors,count?3:0));
    std::vector<uint8_t> source(3*20,88);
    for(int y=0;y<3;++y) for(int x=0;x<3;++x) {
      const uint8_t pixel[]={5,127,255,static_cast<uint8_t>(x*127)};
      std::copy_n(pixel,4,source.data()+y*20+x*4);
    }
    const float src[]={0.25f,0.5f,2,2}, dst[]={6.25f,8.75f,8.5f,6.25f};
    assert(pmjs_skia65_image_bgra_strided(tight.data(),width,height,width*4,4,6,source.data(),3,3,20,src,dst,0.63f,variant%2));
    assert(pmjs_skia65_image_bgra_strided(strided.data(),width,height,stride,4,6,source.data(),3,3,20,src,dst,0.63f,variant%2));
    for(int y=0;y<height;++y) {
      assert(std::memcmp(tight.data()+y*width*4,strided.data()+y*stride,width*4)==0);
      for(int x=width*4;x<stride;++x) assert(strided[y*stride+x]==77);
    }
  }
  uint8_t pixel[]={0,127,255,0};
  const float full[]={0,0,1,1};
  uint8_t target[4]={};
  assert(pmjs_skia65_image_bgra_strided(target,1,1,4,0,0,pixel,1,1,4,full,full,1,0));
  assert(std::all_of(target,target+4,[](uint8_t c) { return c == 0; }));
  // Frozen Chromium 65 mixed-alpha source-over results, including scalar tails.
  for (int w : {16,17,32}) for (int green : {0,8,w-1}) for (bool background : {false,true}) {
    std::vector<uint8_t> source(w*4), actual(w*4), expected(w*4);
    const uint8_t hidden[]={0,127,255,0}, visible[]={0,128,0,128};
    const uint8_t greenBackground[]={0,128,0,128};
    const uint8_t hiddenOverGreen[]={0,255,255,128}, greenOverGreen[]={0,192,0,192};
    for(int x=0;x<w;++x) {
      std::copy_n(x==green?visible:hidden,4,source.data()+x*4);
      if(background) {
        std::copy_n(greenBackground,4,actual.data()+x*4);
        std::copy_n(greenBackground,4,expected.data()+x*4);
      }
    }
    const int block=green/16*16;
    if(block+16<=w) for(int x=block;x<block+16;++x)
      std::copy_n(background?(x==green?greenOverGreen:hiddenOverGreen):(x==green?visible:hidden),4,expected.data()+x*4);
    else std::copy_n(background?greenOverGreen:visible,4,expected.data()+green*4);
    const float fullRow[]={0,0,static_cast<float>(w),1};
    assert(pmjs_skia65_image_bgra_strided(actual.data(),w,1,w*4,0,0,source.data(),w,1,w*4,fullRow,fullRow,1,0));
    assert(actual==expected);
  }
  // Over-alpha channel carries are observable in the pinned browser's row path.
  for(int w : {1,2,8,16,17,32}) {
    std::vector<uint8_t> source(w*4,255), actual(w*4), copy(w*4);
    const uint8_t first[]={255,63,0,192}, second[]={255,95,0,224};
    for(int x=0;x<w;++x) {
      source[x*4+3]=127;
      actual[x*4+1]=copy[x*4+1]=128;
      actual[x*4+3]=copy[x*4+3]=128;
    }
    const float row[]={0,0,static_cast<float>(w),1};
    assert(pmjs_skia65_image_bgra_strided(actual.data(),w,1,w*4,0,0,source.data(),w,1,w*4,row,row,1,0));
    assert(pmjs_skia65_image_bgra_strided(copy.data(),w,1,w*4,0,0,actual.data(),w,1,w*4,row,row,1,0));
    for(int x=0;x<w;++x) {
      assert(std::equal(first,first+4,actual.data()+x*4));
      assert(std::equal(second,second+4,copy.data()+x*4));
    }
  }
  std::cout << "[skia65-strided] crop phase, images, padding and premultiplied source-over agree\n";
}
