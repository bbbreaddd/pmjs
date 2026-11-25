#include "graphics/renderer.hpp"
#include <SDL.h>
#include <GLES3/gl3.h>
#include <algorithm>
#include <array>
#include <cmath>
#include <cassert>
#include <functional>
#include <iostream>
#include <vector>
#include <utility>

int main() {
  SDL_SetHint(SDL_HINT_VIDEO_X11_FORCE_EGL, "1");
  assert(SDL_Init(SDL_INIT_VIDEO) == 0);
  SDL_GL_SetAttribute(SDL_GL_CONTEXT_PROFILE_MASK, SDL_GL_CONTEXT_PROFILE_ES);
  SDL_GL_SetAttribute(SDL_GL_CONTEXT_MAJOR_VERSION, 3);
  auto* window = SDL_CreateWindow("Opaque coverage", 0, 0, 16, 16, SDL_WINDOW_OPENGL | SDL_WINDOW_HIDDEN);
  assert(window);
  auto context = SDL_GL_CreateContext(window);
  assert(context);
  {
    pmjs::ImageStore images;
    pmjs::Renderer renderer(16, 16, images);
    std::array<std::uint8_t, 16> pixels{255,0,0,255, 255,0,0,255, 255,0,0,255, 255,0,0,255};
    const auto image = images.createRgba(2, 2, pixels.data());
    assert(image);
    const auto draw = [&](float alpha = 1, float x = 0, pmjs::BlendMode blend = pmjs::BlendMode::normal) {
      assert(renderer.queueImage(image->handle, {8,0,0,8,x,0}, {0,0,2,2}, alpha, 0xffffff, blend));
    };
    const auto outsideMesh = renderer.createMesh(image->handle,
      {1000,1000,1004,1000,1000,1004},{0,0,1,0,0,1},{0,1,2},false);
    assert(outsideMesh);
    const auto render = [&](const std::function<void()>& queue, bool ordinary) {
      renderer.beginFrame();
      const auto before = renderer.stats().coveredCommandsSkipped;
      renderer.queueQuad(0,0,16,16,{0,0,1,1});
      queue();
      if (ordinary) {
        // A clipped-away mesh keeps the ordinary draw path without changing target pixels.
        std::array<std::uint32_t,pmjs::scene_packet::metadataStride> metadata{
          8,pmjs::scene_packet::noParent,outsideMesh,0xffffff,0,0,0};
        std::array<float,pmjs::scene_packet::valueStride> values{};
        values[0]=values[3]=values[6]=1;
        assert(renderer.queueScene(pmjs::scene_packet::version,metadata.data(),metadata.size(),
          values.data(),values.size(),1));
      }
      renderer.renderScene();
      assert(glGetError() == GL_NO_ERROR);
      return std::make_pair(renderer.captureSceneRgba(),renderer.stats().coveredCommandsSkipped-before);
    };
    unsigned caseNumber=0;
    const auto compare = [&](const std::function<void()>& queue, std::uint64_t skips) {
      const auto ordinary=render(queue,true),candidate=render(queue,false);
      assert(ordinary.second == 0);
      ++caseNumber;
      if(candidate.second!=skips) std::cerr << "case " << caseNumber << " skipped " << candidate.second << " expected " << skips << "\n";
      assert(candidate.second == skips);
      assert(ordinary.first == candidate.first);
      return candidate.first;
    };
    const auto check = [&](const std::function<void()>& queue, std::uint64_t skips,
                           std::array<std::uint8_t, 4> expected) {
      const auto rendered=compare(queue,skips);
      for (std::size_t i=0;i<rendered.size();++i) assert(rendered[i] == expected[i%4]);
    };
    check([&] { draw(); }, 1, {255,0,0,255});
    check([&] { draw(0.5F); }, 0, {128,0,127,255});
    check([&] { draw(1, 16); }, 0, {0,0,255,255});
    check([&] { draw(1, 0, pmjs::BlendMode::additive); }, 0, {255,0,255,255});
    check([&] { draw(); renderer.queueQuad(0,0,16,16,{0,1,0,0.5F}); }, 1, {127,128,0,255});
    pixels[3] = pixels[7] = pixels[11] = pixels[15] = 128;
    assert(images.updateRgba(image->handle, pixels.data()));
    check([&] { draw(); }, 0, {128,0,127,255});
    pixels[3] = pixels[7] = pixels[11] = pixels[15] = 255;
    assert(images.updateRgba(image->handle, pixels.data()));
    check([&] { draw(); }, 1, {255,0,0,255});
    check([&] { draw(); pixels[3] = pixels[7] = pixels[11] = pixels[15] = 128;
      assert(images.updateRgba(image->handle, pixels.data())); }, 0, {128,0,127,255});
    pixels[3] = pixels[7] = pixels[11] = pixels[15] = 255;
    assert(images.updateRgba(image->handle, pixels.data()));
    check([&] { draw(); draw(); }, 2, {255,0,0,255});
    check([&] { draw(); }, 1, {255,0,0,255});
    for (const int i : {0,8}) { pixels[i] = 0; pixels[i+3] = 0; }
    assert(images.updateRgba(image->handle, pixels.data()));
    renderer.beginFrame();
    auto before = renderer.stats().coveredCommandsSkipped;
    renderer.queueQuad(0,0,16,16,{0,0,1,1}); draw(); renderer.renderScene();
    assert(renderer.stats().coveredCommandsSkipped == before);
    const auto holes = renderer.captureSceneRgba();
    for (int y=0;y<16;++y) for(int x=0;x<16;++x) {
      const float alpha = std::clamp((x+0.5F)/8-0.5F,0.0F,1.0F);
      // Straight-alpha sampling interpolates RGB before source-over multiplication.
      const std::array<int,4> expected{int(std::lround(alpha*alpha*255)),0,
        int(std::lround((1-alpha)*255)),255};
      for(int ch=0;ch<4;++ch) assert(std::abs(int(holes[(y*16+x)*4+ch])-expected[ch]) <= 1);
    }
    for (const int i : {0,8}) { pixels[i] = 255; pixels[i+3] = 255; }
    assert(images.updateRgba(image->handle, pixels.data()));
    check([&] { assert(renderer.queueImage(image->handle,{-8,0,0,8,16,0},
      {0,0,2,2},1,0xffffff,pmjs::BlendMode::normal)); },0,{255,0,0,255});
    check([&] { assert(renderer.queueImage(image->handle,{16,0,0,8,0,0},
      {0,0,1,2},1,0xffffff,pmjs::BlendMode::normal)); },0,{255,0,0,255});
    compare([&] { assert(renderer.queueImage(image->handle,{8,1,0,8,0,0},
      {0,0,2,2},1,0xffffff,pmjs::BlendMode::normal)); },0);
    compare([&] { draw(); renderer.setSceneProjection({1,0,0,1,1,0}); },0);
    const auto packet = [&](std::uint32_t flags, std::array<float,4> clip) {
      std::array<std::uint32_t,pmjs::scene_packet::metadataStride> metadata{
        1,pmjs::scene_packet::noParent,image->handle,0xffffff,0,flags,0};
      std::array<float,pmjs::scene_packet::valueStride> values{};
      values[0]=values[3]=8;values[6]=1;
      values[11]=values[12]=values[13]=values[14]=2;
      std::copy(clip.begin(),clip.end(),values.begin()+17);
      assert(renderer.queueScene(pmjs::scene_packet::version,metadata.data(),metadata.size(),
        values.data(),values.size(),1));
    };
    check([&] { packet(pmjs::scene_packet::hasClipRectangle,{0,0,16,16}); },1,{255,0,0,255});
    compare([&] { packet(pmjs::scene_packet::hasClipRectangle,{0,0,8,16}); },0);
    check([&] { packet(pmjs::scene_packet::nearestSampling|pmjs::scene_packet::mipmapSampling,{}); },1,{255,0,0,255});
    check([&] { packet(pmjs::scene_packet::mipmapSampling,{}); },0,{255,0,0,255});
    std::vector<std::uint8_t> gradientPixels(16*16*4);
    for(int y=0;y<16;++y) for(int x=0;x<16;++x) {
      const auto offset=(y*16+x)*4;
      gradientPixels[offset]=x*17;gradientPixels[offset+1]=y*17;
      gradientPixels[offset+2]=(x*31+y*13)%256;gradientPixels[offset+3]=255;
    }
    const auto gradient=images.createRgba(16,16,gradientPixels.data());assert(gradient);
    const auto drawGradient=[&] { assert(renderer.queueImage(gradient->handle,{1,0,0,1,0,0},
      {0,0,16,16},1,0x8040ff,pmjs::BlendMode::normal)); };
    compare(drawGradient,1);
    for(bool rounded : {false,true}) compare([&] {
      std::array<std::uint32_t,pmjs::scene_packet::metadataStride> metadata{
        1,pmjs::scene_packet::noParent,gradient->handle,0xffffffff,0,
        pmjs::scene_packet::spriteWorldVertices|pmjs::scene_packet::preparedWorldState|
        pmjs::scene_packet::packedSpriteColor|pmjs::scene_packet::nearestSampling|
        (rounded?pmjs::scene_packet::roundPixels:0U),0};
      std::array<float,pmjs::scene_packet::valueStride> values{};
      const float shift=rounded?0.4F:0;
      values[0]=values[1]=values[3]=values[15]=shift;
      values[2]=values[4]=values[5]=values[16]=16+shift;values[6]=1;
      values[11]=values[12]=values[13]=values[14]=16;
      assert(renderer.queueScene(pmjs::scene_packet::version,metadata.data(),metadata.size(),
        values.data(),values.size(),1));
    },1);
    const std::array<std::uint8_t,4> transparentPixel{};
    assert(images.updateRgbaRegion(gradient->handle,0,0,1,1,transparentPixel.data(),1));
    compare(drawGradient,0);
    assert(images.updateRgba(gradient->handle,gradientPixels.data()));compare(drawGradient,1);
    assert(images.release(gradient->handle));
    std::vector<std::uint8_t> largePixels(32*32*4,255);
    const auto large=images.createRgba(32,32,largePixels.data());assert(large);
    check([&] {
      std::array<std::uint32_t,pmjs::scene_packet::metadataStride> metadata{
        1,pmjs::scene_packet::noParent,large->handle,0xffffff,0,
        pmjs::scene_packet::nearestSampling|pmjs::scene_packet::mipmapSampling,0};
      std::array<float,pmjs::scene_packet::valueStride> values{};
      values[0]=values[3]=0.5F;values[6]=1;
      values[11]=values[12]=values[13]=values[14]=32;
      assert(renderer.queueScene(pmjs::scene_packet::version,metadata.data(),metadata.size(),
        values.data(),values.size(),1));
    },0,{255,255,255,255});
    assert(images.release(large->handle));
    const auto gpu=images.createRenderTarget(2,2,true);assert(gpu);
    GLuint framebuffer=0;GLint previous=0;glGetIntegerv(GL_FRAMEBUFFER_BINDING,&previous);
    glGenFramebuffers(1,&framebuffer);glBindFramebuffer(GL_FRAMEBUFFER,framebuffer);
    glFramebufferTexture2D(GL_FRAMEBUFFER,GL_COLOR_ATTACHMENT0,GL_TEXTURE_2D,gpu->texture,0);
    assert(glCheckFramebufferStatus(GL_FRAMEBUFFER)==GL_FRAMEBUFFER_COMPLETE);
    glClearColor(0,1,0,1);glClear(GL_COLOR_BUFFER_BIT);
    glBindFramebuffer(GL_FRAMEBUFFER,previous);glDeleteFramebuffers(1,&framebuffer);
    check([&] { assert(renderer.queueImage(gpu->handle,{8,0,0,8,0,0},
      {0,0,2,2},1,0xffffff,pmjs::BlendMode::normal)); },0,{0,255,0,255});
    assert(images.release(gpu->handle));
    compare([&] { draw(); assert(renderer.setRenderTargetSize(8,8)); },0);
    assert(renderer.setScreenRenderSize(8,8));
    check([&] { assert(renderer.queueImage(image->handle,{4,0,0,4,0,0},
      {0,0,2,2},1,0xffffff,pmjs::BlendMode::normal)); },1,{255,0,0,255});
    assert(renderer.setScreenRenderSize(16,16));
    const auto underneath = images.createRgba(2,2,pixels.data()); assert(underneath);
    renderer.beginFrame(); before = renderer.stats().coveredCommandsSkipped;
    assert(renderer.queueImage(underneath->handle,{8,0,0,8,0,0},{0,0,2,2},1,0xffffff,pmjs::BlendMode::normal));
    assert(images.release(underneath->handle));
    assert(images.inspect(underneath->handle));
    draw(); renderer.renderScene();
    assert(renderer.stats().coveredCommandsSkipped-before == 1);
    assert(!images.inspect(underneath->handle));
    renderer.beginFrame(); assert(glGetError() == GL_NO_ERROR);
    const auto geometryBefore=renderer.tileGeometryGpuBytes();
    const auto tiles=renderer.createTileLayer({{image->handle,{0,0,2,2},{0,0},{0,0}}});
    assert(tiles && renderer.tileGeometryGpuBytes()>geometryBefore);
    renderer.beginFrame();before=renderer.stats().coveredCommandsSkipped;
    assert(renderer.queueTileLayer(tiles,{8,0,0,8,0,0},{0,0},1,0xffffff,pmjs::BlendMode::normal));
    assert(renderer.releaseTileLayer(tiles));
    assert(renderer.tileGeometryGpuBytes()>geometryBefore);
    draw();renderer.renderScene();
    assert(renderer.stats().coveredCommandsSkipped-before==1);
    assert(renderer.tileGeometryGpuBytes()==geometryBefore);
    const auto knownVideo=images.createRgba(2,2,pixels.data(),false,true);assert(knownVideo);
    const auto knownReadbacks=images.renderReadbacks();
    for(int f=0;f<70;++f) {
      assert(images.updateRgba(knownVideo->handle,pixels.data(),true));
      renderer.beginFrame();before=renderer.stats().coveredCommandsSkipped;
      renderer.queueQuad(0,0,16,16,{0,0,1,1});
      assert(renderer.queueImage(knownVideo->handle,{8,0,0,8,0,0},{0,0,2,2},1,0xffffff,pmjs::BlendMode::normal));
      renderer.renderScene();
      assert(renderer.stats().coveredCommandsSkipped-before==1);
    }
    assert(images.renderReadbacks()==knownReadbacks);
    assert(images.updateRgba(knownVideo->handle,pixels.data(),false));
    renderer.beginFrame();before=renderer.stats().coveredCommandsSkipped;
    renderer.queueQuad(0,0,16,16,{0,0,1,1});
    assert(renderer.queueImage(knownVideo->handle,{8,0,0,8,0,0},{0,0,2,2},1,0xffffff,pmjs::BlendMode::normal));
    renderer.renderScene();
    assert(renderer.stats().coveredCommandsSkipped-before==0);
    assert(images.renderReadbacks()==knownReadbacks);
    assert(images.release(knownVideo->handle));
    const auto uncached=images.createRgba(2,2,pixels.data());assert(uncached);
    const auto uncachedReadbacksBefore=images.renderReadbacks();
    for(int f=0;f<70;++f) {
      assert(images.updateRgba(uncached->handle,pixels.data()));
      renderer.beginFrame();before=renderer.stats().coveredCommandsSkipped;
      renderer.queueQuad(0,0,16,16,{0,0,1,1});
      assert(renderer.queueImage(uncached->handle,{8,0,0,8,0,0},{0,0,2,2},1,0xffffff,pmjs::BlendMode::normal));
      renderer.renderScene();
      assert(renderer.stats().coveredCommandsSkipped-before==1);
    }
    assert(images.renderReadbacks()==uncachedReadbacksBefore+1);
    assert(images.release(uncached->handle));
    std::vector<std::uint8_t> oversizedPixels(1025*1024*4,255);
    const auto oversizedUncached=images.createRgba(1025,1024,oversizedPixels.data());assert(oversizedUncached);
    assert(!images.isOpaque(oversizedUncached->handle,false).has_value());
    assert(images.release(oversizedUncached->handle));
    const auto oversizedKnown=images.createRgba(1025,1024,oversizedPixels.data(),false,true);assert(oversizedKnown);
    assert(images.isOpaque(oversizedKnown->handle,false)==true);
    renderer.beginFrame();before=renderer.stats().coveredCommandsSkipped;
    renderer.queueQuad(0,0,16,16,{0,0,1,1});
    assert(renderer.queueImage(oversizedKnown->handle,{16.0F/1025,0,0,16.0F/1024,0,0},{0,0,1025,1024},1,0xffffff,pmjs::BlendMode::normal));
    renderer.renderScene();
    assert(renderer.stats().coveredCommandsSkipped-before==1);
    assert(images.release(oversizedKnown->handle));
    assert(renderer.releaseTileLayer(outsideMesh));
  }
  SDL_GL_DeleteContext(context); SDL_DestroyWindow(window); SDL_Quit();
}
