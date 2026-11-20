#include "platform/platform.hpp"
#include "graphics/resources.hpp"
#include "assets/prepared_page.hpp"

#include <algorithm>
#include <array>
#include <cstdio>
#include <filesystem>
#include <stdexcept>
#include <vector>
#include <unistd.h>
#include <png.h>
#include <GLES3/gl3.h>

namespace {
void require(bool condition, const char* message) {
  if (!condition) throw std::runtime_error(message);
}
void write(const std::filesystem::path& path, int width, int height,
           const std::vector<std::uint8_t>& rgba) {
  png_image image{}; image.version = PNG_IMAGE_VERSION;
  image.width = width; image.height = height; image.format = PNG_FORMAT_RGBA;
  require(png_image_write_to_file(&image, path.c_str(), 0, rgba.data(), 0, nullptr), "PNG fixture failed");
}
template <typename Pixel>
void writeGenerated(const std::filesystem::path& path, int width, int height, Pixel pixel) {
  auto* file=std::fopen(path.c_str(),"wb"); require(file,"uniform fixture open failed");
  auto* png=png_create_write_struct(PNG_LIBPNG_VER_STRING,nullptr,nullptr,nullptr);
  auto* info=png_create_info_struct(png); require(png&&info,"uniform fixture allocation failed");
  if(setjmp(png_jmpbuf(png))) throw std::runtime_error("uniform fixture encode failed");
  png_init_io(png,file); png_set_IHDR(png,info,width,height,8,PNG_COLOR_TYPE_RGBA,
      PNG_INTERLACE_NONE,PNG_COMPRESSION_TYPE_DEFAULT,PNG_FILTER_TYPE_DEFAULT);
  png_write_info(png,info);
  std::vector<std::uint8_t> row(static_cast<std::size_t>(width)*4);
  for(int y=0;y<height;++y) {
    for(int x=0;x<width;++x) {
      const auto color=pixel(x,y);std::copy(color.begin(),color.end(),row.begin()+static_cast<std::size_t>(x)*4);
    }
    png_write_row(png,row.data());
  }
  png_write_end(png,info); png_destroy_write_struct(&png,&info);std::fclose(file);
}
std::vector<std::uint8_t> readGpu(const pmjs::ImageInfo& image, int x=0, int y=0, int width=0, int height=0) {
  if (!width) width=image.width;
  if (!height) height=image.height;
  std::vector<std::uint8_t> rgba(static_cast<std::size_t>(width)*height*4);
  GLuint framebuffer = 0; glGenFramebuffers(1,&framebuffer);
  glBindFramebuffer(GL_FRAMEBUFFER,framebuffer);
  glFramebufferTexture2D(GL_FRAMEBUFFER,GL_COLOR_ATTACHMENT0,GL_TEXTURE_2D,image.texture,0);
  require(glCheckFramebufferStatus(GL_FRAMEBUFFER)==GL_FRAMEBUFFER_COMPLETE, "GPU fixture framebuffer failed");
  glReadPixels(x,y,width,height,GL_RGBA,GL_UNSIGNED_BYTE,rgba.data());
  glBindFramebuffer(GL_FRAMEBUFFER,0); glDeleteFramebuffers(1,&framebuffer);
  // Framebuffer readback does not apply texture swizzles.
  glBindTexture(GL_TEXTURE_2D,image.texture);
  const std::array<GLenum,4> parameters{GL_TEXTURE_SWIZZLE_R,GL_TEXTURE_SWIZZLE_G,
                                      GL_TEXTURE_SWIZZLE_B,GL_TEXTURE_SWIZZLE_A};
  std::array<GLint,4> swizzles{};
  for(std::size_t c=0;c<4;++c) glGetTexParameteriv(GL_TEXTURE_2D,parameters[c],&swizzles[c]);
  for(std::size_t i=0;i<rgba.size();i+=4) {
    const std::array<std::uint8_t,4> stored{rgba[i],rgba[i+1],rgba[i+2],rgba[i+3]};
    for(std::size_t c=0;c<4;++c) {
      const auto swizzle=swizzles[c];
      rgba[i+c]=swizzle==GL_ONE ? 255 : swizzle==GL_ZERO ? 0 :
        stored[swizzle==GL_RED ? 0 : swizzle==GL_GREEN ? 1 : swizzle==GL_BLUE ? 2 : 3];
    }
  }
  return rgba;
}
}
int main() {
  pmjs::Platform platform(16,16,"Derived logical images");
  const auto temporaryRoot = std::filesystem::current_path()/".cache/tests";
  std::filesystem::create_directories(temporaryRoot);
  const auto pattern = (temporaryRoot/"derived-images-XXXXXX").string();
  std::vector<char> temporary(pattern.begin(), pattern.end());
  temporary.push_back('\0');
  const auto* directory = mkdtemp(temporary.data());
  require(directory,"temporary fixture failed");
  const std::filesystem::path root(directory);
  {
    pmjs::ImageStore images;
    pmjs::PreparedImageDescriptor descriptor;
    descriptor.width=48; descriptor.height=12;
    descriptor.pages={{"compact-page-0.png",7,7},{"compact-page-1.png",7,7}};
    descriptor.cells={
      {{0,0,16,12},{2,3,2,2},{1,1,2,2},{37,37,37,255},0},
      {{16,0,16,12},{3,2,3,2},{1,1,3,2},{37,37,37,255},1},
      {{32,0,16,12},{0,0,0,0},{0,0,0,0},{37,37,37,255},-1}};
    std::vector<std::uint8_t> original(48*12*4);
    for(std::size_t i=0;i<original.size();i+=4) {
      original[i]=original[i+1]=original[i+2]=37; original[i+3]=255;
    }
    for(std::size_t index=0;index<descriptor.pages.size();++index) {
      std::vector<std::uint8_t> page(7*7*4);
      const auto& cell=descriptor.cells[index];
      for(int y=0;y<cell.crop[3];++y) for(int x=0;x<cell.crop[2];++x) {
        const auto gray=static_cast<std::uint8_t>(61+x*17+y*23);
        const auto offset=(static_cast<std::size_t>(cell.atlas[1]+y)*7+cell.atlas[0]+x)*4;
        page[offset]=page[offset+1]=page[offset+2]=gray; page[offset+3]=255;
        auto* logical=original.data()+
          (static_cast<std::size_t>(cell.rect[1]+cell.crop[1]+y)*48+cell.rect[0]+cell.crop[0]+x)*4;
        logical[0]=logical[1]=logical[2]=gray; logical[3]=255;
      }
      page[0]=19; page[1]=43;
      write(root/descriptor.pages[index].path,7,7,page);
    }
    write(root/"compact-source.png",48,12,original);
    require(images.installPrepared(root/"compact-source.png",root,descriptor),"compact preparation failed");
    auto image=images.loadPng(root/"compact-source.png");
    require(image.has_value(),"compact image load failed");
    for(int tick=0;tick<61;++tick) images.update();
    const auto full = images.lookup(image->handle);
    require(full && readGpu(*full) == original, "fallback lost crop or fill pixels");
    const auto uploads = images.textureUploadBytes();
    require(images.lookup(image->handle)->texture == full->texture && images.textureUploadBytes() == uploads,
      "fallback uploaded twice");
    require(images.beginUse(image->handle),"fallback in-flight use failed");
    images.release(image->handle); images.setWarmBudgetBytes(0); images.update();
    require(glIsTexture(full->texture), "fallback texture died while in flight");
    images.endUse(image->handle); images.update();
    require(!glIsTexture(full->texture) && images.gpuBytes()==0 && images.cpuBytes()==0,
      "fallback texture outlived owner");
    image=images.loadPng(root/"compact-source.png");
    const std::vector<std::uint8_t> replacement(original.size(),255);
    require(images.updateRgba(image->handle,replacement.data()) && !images.hasPreparedBacking(image->handle) &&
      readGpu(*images.lookup(image->handle))==replacement,"mutation retained stale prepared pixels");
    images.release(image->handle); images.update();
    require(images.gpuBytes()==0 && images.cpuBytes()==0,"mutation accounting leaked");
  }
  for (int codec = 0; codec < 3; ++codec) for (int variant = 0; variant < 6; ++variant) {
    pmjs::ImageStore images;
    pmjs::PreparedImageDescriptor descriptor;
    descriptor.width=24; descriptor.height=8;
    descriptor.pages={{"crop-page-0.png",7,7},{"crop-page-1.png",7,7}};
    descriptor.cells={
      {{0,0,8,8},{2,3,3,3},{1,1,3,3},{37,37,37,255},0},
      {{8,0,8,8},{1,1,4,2},{1,1,4,2},{37,37,37,255},1},
      {{16,0,8,8},{0,0,0,0},{0,0,0,0},{37,37,37,255},-1}};
    std::array<std::vector<std::uint8_t>,2> pages;
    for (std::size_t index=0;index<pages.size();++index) {
      auto& page=pages[index]; page.resize(7*7*4);
      const auto& cell=descriptor.cells[index];
      for(int y=0;y<cell.crop[3];++y) for(int x=0;x<cell.crop[2];++x) {
        const auto offset=(static_cast<std::size_t>(cell.atlas[1]+y)*7+cell.atlas[0]+x)*4;
        page[offset]=page[offset+1]=page[offset+2]=61+x*17+y*23;
        page[offset+3]=255;
      }
      // Padding is outside the logical image and must not affect eligibility.
      page[0]=19; page[1]=43;
    }
    if(variant==1) pages[1][(7+1)*4+1]=99;
    if(variant==2) pages[1][(7+1)*4+3]=157;
    if(variant==3) for(auto& cell:descriptor.cells) cell.fill[1]=73;
    if(variant==4) for(auto& cell:descriptor.cells) cell.fill[3]=157;
    if(variant==5) descriptor.cells.back().fill={89,89,89,255};
    for(std::size_t index=0;index<pages.size();++index) {
      if (codec) {
        descriptor.pages[index].path = "crop-page-" + std::to_string(index) + ".pml4";
        pmjs::writeLz4Page(root/descriptor.pages[index].path,7,7,pages[index],codec==2);
      } else write(root/descriptor.pages[index].path,7,7,pages[index]);
    }
    std::vector<std::uint8_t> original(24*8*4);
    for(const auto& cell:descriptor.cells)
      for(int y=0;y<cell.rect[3];++y) for(int x=0;x<cell.rect[2];++x) {
        auto* pixel=original.data()+(static_cast<std::size_t>(cell.rect[1]+y)*24+cell.rect[0]+x)*4;
        const int cx=x-cell.crop[0],cy=y-cell.crop[1];
        if(cx>=0 && cy>=0 && cx<cell.crop[2] && cy<cell.crop[3])
          std::copy_n(pages[cell.page].data()+
              (static_cast<std::size_t>(cell.atlas[1]+cy)*7+cell.atlas[0]+cx)*4,4,pixel);
        else std::copy(cell.fill.begin(),cell.fill.end(),pixel);
      }
    write(root/"crop-source.png",24,8,original);
    require(images.installPrepared(root/"crop-source.png",root,descriptor),"crop preparation failed");
    auto image=images.loadPng(root/"crop-source.png");
    require(image.has_value(),"crop source load failed");
    for(int tick=0;tick<61;++tick) images.update();
    for(const bool premultiplied:{true,false}) {
      GLuint target=0,binding=0,buffer=0;
      if(variant==0) {
        glGenTextures(1,&binding); glBindTexture(GL_TEXTURE_2D,binding);
        glTexImage2D(GL_TEXTURE_2D,0,GL_RGBA8,4,4,0,GL_RGBA,GL_UNSIGNED_BYTE,nullptr);
        glGenFramebuffers(1,&target); glBindFramebuffer(GL_FRAMEBUFFER,target);
        glFramebufferTexture2D(GL_FRAMEBUFFER,GL_COLOR_ATTACHMENT0,GL_TEXTURE_2D,binding,0);
        glGenBuffers(1,&buffer); glBindBuffer(GL_PIXEL_UNPACK_BUFFER,buffer);
        glBufferData(GL_PIXEL_UNPACK_BUFFER,128,nullptr,GL_STATIC_DRAW);
        glPixelStorei(GL_UNPACK_ALIGNMENT,8); glPixelStorei(GL_UNPACK_ROW_LENGTH,8);
        glPixelStorei(GL_UNPACK_SKIP_ROWS,1); glPixelStorei(GL_UNPACK_SKIP_PIXELS,1);
        if(premultiplied) { glEnable(GL_SCISSOR_TEST); glEnable(GL_DITHER); }
        else { glDisable(GL_SCISSOR_TEST); glDisable(GL_DITHER); }
        glScissor(2,2,1,1); glColorMask(GL_FALSE,GL_TRUE,GL_FALSE,GL_TRUE);
      }
      const auto full=premultiplied ? images.lookupPremultiplied(image->handle) : images.lookup(image->handle);
      require(full.has_value(),"crop realization failed");
      if(variant==0) {
        GLint state=0; GLboolean mask[4];
        glGetIntegerv(GL_DRAW_FRAMEBUFFER_BINDING,&state); require(state==static_cast<GLint>(target),"crop changed draw framebuffer");
        glGetIntegerv(GL_READ_FRAMEBUFFER_BINDING,&state); require(state==static_cast<GLint>(target),"crop changed read framebuffer");
        glGetIntegerv(GL_TEXTURE_BINDING_2D,&state); require(state==static_cast<GLint>(binding),"crop changed texture binding");
        glGetIntegerv(GL_PIXEL_UNPACK_BUFFER_BINDING,&state); require(state==static_cast<GLint>(buffer),"crop changed unpack buffer");
        glGetIntegerv(GL_UNPACK_ALIGNMENT,&state); require(state==8,"crop changed unpack alignment");
        glGetIntegerv(GL_UNPACK_ROW_LENGTH,&state); require(state==8,"crop changed unpack row length");
        glGetIntegerv(GL_UNPACK_SKIP_ROWS,&state); require(state==1,"crop changed unpack rows");
        glGetIntegerv(GL_UNPACK_SKIP_PIXELS,&state); require(state==1,"crop changed unpack pixels");
        glGetBooleanv(GL_COLOR_WRITEMASK,mask);
        require(!mask[0] && mask[1] && !mask[2] && mask[3],"crop changed color mask");
        require(bool(glIsEnabled(GL_SCISSOR_TEST))==premultiplied &&
                bool(glIsEnabled(GL_DITHER))==premultiplied,"crop changed clear capabilities");
        glBindFramebuffer(GL_FRAMEBUFFER,0); glDeleteFramebuffers(1,&target);
        glBindBuffer(GL_PIXEL_UNPACK_BUFFER,0); glDeleteBuffers(1,&buffer);
        glBindTexture(GL_TEXTURE_2D,0); glDeleteTextures(1,&binding);
        glPixelStorei(GL_UNPACK_ALIGNMENT,1); glPixelStorei(GL_UNPACK_ROW_LENGTH,0);
        glPixelStorei(GL_UNPACK_SKIP_ROWS,0); glPixelStorei(GL_UNPACK_SKIP_PIXELS,0);
        glDisable(GL_SCISSOR_TEST); glEnable(GL_DITHER); glColorMask(GL_TRUE,GL_TRUE,GL_TRUE,GL_TRUE);
      }
      auto expected=original;
      if(premultiplied) for(std::size_t i=0;i<expected.size();i+=4) for(int c=0;c<3;++c)
        expected[i+c]=(expected[i+c]*expected[i+3]+127)/255;
      require(readGpu(*full)==expected,"crop realization changed exact RGBA pixels");
      const auto uploads=images.textureUploadBytes();
      require((premultiplied ? images.lookupPremultiplied(image->handle) : images.lookup(image->handle)) &&
              images.textureUploadBytes()==uploads,"resident crop backing uploaded twice");
    }
    if(variant==0) {
      require(images.gpuBytes()==2*24*8*4 && images.textureUploadBytes()==2*24*8*4,"fallback allocation or upload accounting failed");
      require(images.preparedPageDecodes()==2,"fallback repeated page decode");
      require(images.readPixelsRegion(image->handle,0,0,24,8)->rgba==original,"crop upload changed straight CPU pixels");
      std::vector<std::uint8_t> replacement(24*8*4);
      for(std::size_t i=0;i<replacement.size();i+=4) {
        replacement[i]=19; replacement[i+1]=43; replacement[i+2]=67; replacement[i+3]=157;
      }
      require(images.updateRgba(image->handle,replacement.data()),"crop backing mutation failed");
      require(!images.hasPreparedBacking(image->handle) && readGpu(*images.lookup(image->handle))==replacement,
              "mutated crop backing retained old pixels or swizzles");
    }
    images.release(image->handle); images.setWarmBudgetBytes(0); images.update();
    require(images.gpuBytes()==0 && images.cpuBytes()==0,"crop backing outlived owner");
  }
  for (const bool opaque : {false, true}) {
    pmjs::ImageStore images;
    std::vector<std::uint8_t> original(8*4*4),page(10*6*4);
    for(int y=0;y<4;++y) for(int x=0;x<8;++x) {
      auto* pixel=original.data()+static_cast<std::size_t>(y*8+x)*4;
      pixel[0]=pixel[1]=pixel[2]=x*23+y*13;
      pixel[3]=opaque || x%3==0 ? 255 : x%3==1 ? 157 : 0;
    }
    for(int y=0;y<6;++y) for(int x=0;x<10;++x)
      std::copy_n(original.data()+(static_cast<std::size_t>(std::clamp(y-1,0,3))*8+
                  std::clamp(x-1,0,7))*4,4,page.data()+static_cast<std::size_t>(y*10+x)*4);
    write(root/"opaque-gray.png",8,4,original); write(root/"opaque-gray-page.png",10,6,page);
    pmjs::PreparedImageDescriptor descriptor;
    descriptor.width=8; descriptor.height=4;
    descriptor.pages={{"opaque-gray-page.png",10,6}};
    descriptor.cells={{{0,0,8,4},{0,0,8,4},{1,1,8,4},{0,0,0,0},0}};
    require(images.installPrepared(root/"opaque-gray.png",root,descriptor),"opaque preparation failed");
    const auto image=images.loadPng(root/"opaque-gray.png");
    require(image.has_value(),"opaque image load failed");
    for(const bool premultiplied:{false,true}) {
      const auto region=images.resolveSpriteRegion(image->handle,0,0,8,4,premultiplied);
      auto expected=page;
      if (premultiplied) for (std::size_t i=0;i<expected.size();i+=4)
        for(int channel=0;channel<3;++channel)
          expected[i+channel]=(expected[i+channel]*expected[i+3]+127)/255;
      require(region && readGpu(region->image)==expected,"grayscale prepared page changed RGBA bytes");
    }
    require(images.gpuBytes()==2*10*6*4,"grayscale page allocation differs");
    require(images.readPixelsRegion(image->handle,0,0,8,4)->rgba==original,
            "premultiplied page upload modified retained straight pixels");
    const auto full=images.lookupPremultiplied(image->handle);
    auto expected=original;
    for(std::size_t i=0;i<expected.size();i+=4) for(int channel=0;channel<3;++channel)
      expected[i+channel]=(expected[i+channel]*expected[i+3]+127)/255;
    require(full && readGpu(*full)==expected,"grayscale full backing changed premultiplied RGBA bytes");
    require(images.readPixelsRegion(image->handle,0,0,8,4)->rgba==original,
            "full upload modified retained straight pixels");
    images.release(image->handle); images.setWarmBudgetBytes(0); images.update();
    require(images.gpuBytes()==0 && images.cpuBytes()==0,"opaque backing outlived its owner");
  }
  {
    pmjs::ImageStore images;
    pmjs::PreparedImageDescriptor descriptor;
    descriptor.width=16; descriptor.height=9;
    descriptor.pages={{"rectangles-0.png",5,5},{"rectangles-1.png",5,5}};
    descriptor.cells={
      {{0,0,8,5},{2,1,3,3},{1,1,3,3},{37,73,109,0},0},
      {{8,0,8,5},{0,0,3,3},{1,1,3,3},{19,43,67,117},1},
      {{0,5,8,4},{0,0,0,0},{0,0,0,0},{0,0,0,0},-1},
      {{8,5,8,4},{3,1,3,2},{1,1,3,2},{11,23,47,255},0}};
    std::array<std::vector<std::uint8_t>,2> pages;
    for (std::size_t index=0;index<pages.size();++index) {
      auto& page=pages[index]; page.resize(5*5*4);
      for(int y=0;y<5;++y) for(int x=0;x<5;++x) {
        const auto offset=static_cast<std::size_t>(y*5+x)*4;
        page[offset]=x*31+index*17; page[offset+1]=y*43;
        page[offset+2]=(x+y)*19; page[offset+3]=(x+y)%3 ? 157 : 0;
      }
      write(root/descriptor.pages[index].path,5,5,page);
    }
    std::vector<std::uint8_t> original(16*9*4);
    for(const auto& cell:descriptor.cells) {
      for(int y=0;y<cell.rect[3];++y) for(int x=0;x<cell.rect[2];++x) {
        auto* destination=original.data()+
            (static_cast<std::size_t>(cell.rect[1]+y)*16+cell.rect[0]+x)*4;
        const int cx=x-cell.crop[0],cy=y-cell.crop[1];
        if(cx>=0 && cy>=0 && cx<cell.crop[2] && cy<cell.crop[3]) {
          const auto offset=(static_cast<std::size_t>(cell.atlas[1]+cy)*5+cell.atlas[0]+cx)*4;
          std::copy_n(pages[cell.page].data()+offset,4,destination);
        } else std::copy(cell.fill.begin(),cell.fill.end(),destination);
      }
    }
    write(root/"rectangles.png",16,9,original);
    require(images.installPrepared(root/"rectangles.png",root,descriptor),"rectangle preparation failed");
    auto image=images.loadPng(root/"rectangles.png");
    require(image && images.hasPreparedBacking(image->handle),"rectangle image lost preparation");
    for(int y=0;y<9;++y) for(int x=0;x<16;++x)
      for(int height=1;height<=9-y;++height) for(int width=1;width<=16-x;++width) {
        const auto region=images.readPixelsRegion(image->handle,x,y,width,height);
        require(region.has_value(),"bounded rectangle read failed");
        for(int row=0;row<height;++row) {
          const auto* expected=original.data()+(static_cast<std::size_t>(y+row)*16+x)*4;
          require(std::equal(expected,expected+width*4,
              region->rgba.data()+static_cast<std::size_t>(row)*width*4),
              "rectangle read changed cropped, empty, shared or hidden RGBA pixels");
        }
      }
    require(images.inspect(image->handle)->texture==0,"CPU rectangle reads realized a texture");
    const auto straight=images.lookup(image->handle);
    require(straight && readGpu(*straight)==original,"rectangle full backing changed RGBA bytes");
    auto expected=original;
    for(std::size_t i=0;i<expected.size();i+=4) for(int c=0;c<3;++c)
      expected[i+c]=(expected[i+c]*expected[i+3]+127)/255;
    const auto premultiplied=images.lookupPremultiplied(image->handle);
    require(premultiplied && readGpu(*premultiplied)==expected,"rectangle full backing changed premultiplication");
    images.release(image->handle); images.setWarmBudgetBytes(0); images.update();
    require(images.gpuBytes()==0 && images.cpuBytes()==0,"rectangle backing outlived its owner");
    std::puts("[derived-images] 6120 bounded rectangle reads preserve exact RGBA");
  }
  {
    pmjs::ImageStore images;
    std::vector<std::uint8_t> original(8*4*4);
    for(int y=1;y<3;++y) for(int x : {1,2,5,6}) {
      const auto offset=static_cast<std::size_t>(y*8+x)*4;
      original[offset]=37;original[offset+1]=73;original[offset+2]=109;
      original[offset+3]=x==1||x==5 ? 0 : 157;
    }
    write(root/"source.png",8,4,original);
    // Both complete 4x4 cells include original neighbouring texels as a halo.
    std::vector<std::uint8_t> atlas(8*4*4);
    for(int y=0;y<4;++y) for(int x=0;x<8;++x)
      std::copy_n(original.data()+static_cast<std::size_t>(y*8+x)*4,4,
                  atlas.data()+static_cast<std::size_t>(y*8+x)*4);
    write(root/"page-0.png",8,4,atlas);
    pmjs::PreparedImageDescriptor descriptor;
    descriptor.width=8;descriptor.height=4;
    descriptor.pages.push_back({"page-0.png",8,4});
    descriptor.cells.push_back({{0,0,4,4},{1,1,2,2},{1,1,2,2},{0,0,0,0},0});
    descriptor.cells.push_back({{4,0,4,4},{1,1,2,2},{5,1,2,2},{0,0,0,0},0});
    auto identity=pmjs::ImageStore::openFile(root/"source.png");
    const auto fileCount=[]() {
      return std::distance(std::filesystem::directory_iterator("/proc/self/fd"), std::filesystem::directory_iterator{});
    };
    const auto filesBefore=fileCount();
    require(images.installPrepared(root/"source.png",root,descriptor,identity->key()),"prepared install failed");
    require(fileCount()==filesBefore,"prepared catalogue eagerly pinned page files");
    require(!images.installPrepared(root/"source.png",root,descriptor,"changed-identity"),"changed source identity accepted");
    auto image=images.loadPng(root/"source.png");
    require(image&&image->width==8&&image->height==4&&image->texture==0,"logical image allocated full GPU backing");
    require(images.cpuBytes()==atlas.size()&&images.preparedPageDecodes()==1,
            "validation did not retain one accounted page decode");
    const auto* pixels=images.readPixels(image->handle);
    require(pixels&&pixels->rgba==original,"logical reconstruction lost exact RGBA or hidden RGB");
    auto region=images.resolveSpriteRegion(image->handle,4,0,4,4,false);
    require(region&&region->source==std::array<float,4>{5,1,2,2}&&region->atlas==std::array<float,4>{5,1,2,2},"cell remapping failed");
    require(images.inspect(image->handle)->texture==0,"ordinary region forced full backing");
    require(images.preparedPageDecodes()==1,"first reconstruction or atlas upload decoded the validated page again");
    for(int tick=0;tick<61;++tick) images.update();
    require(images.cpuBytes()==atlas.size(),"bounded compact CPU page was discarded while idle");
    require(images.resolveSpriteRegion(image->handle,4,0,4,4,false).has_value()&&images.cpuBytes()==atlas.size(),
            "resident GPU page changed retained CPU storage");
    require(images.preparedPageDecodes()==1,"resident page decoded again while retained");
    require(!images.resolveSpriteRegion(image->handle,3,0,2,4,false),"cross-cell crop escaped fallback");
    auto full=images.lookup(image->handle);
    require(full&&readGpu(*full)==original,"full fallback changed original pixels");
    require(images.preparedPageDecodes()==1,"full fallback decoded a retained page again");
    auto premultiplied=images.lookupPremultiplied(image->handle);
    auto expected=original;
    for(std::size_t i=0;i<expected.size();i+=4) for(int c=0;c<3;++c)
      expected[i+c]=(expected[i+c]*expected[i+3]+127)/255;
    require(premultiplied&&readGpu(*premultiplied)==expected,"premultiplied fallback changed conversion");
    auto second=images.loadPng(root/"source.png");
    require(second&&second->handle==image->handle,"prepared owners did not share handle");
    require(images.beginUse(image->handle),"in-flight capture failed");
    images.release(second->handle);images.release(image->handle);images.setWarmBudgetBytes(0);images.update();
    require(images.inspect(image->handle).has_value(),"in-flight logical image evicted");
    images.endUse(image->handle);images.update();
    require(!images.inspect(image->handle)&&images.gpuBytes()==0&&images.cpuBytes()==0,"derived GPU/CPU ownership leaked");
    // Held compact page descriptors preserve snapshots even after cache cleanup.
    image=images.loadPng(root/"source.png");
    require(image&&images.hasPreparedBacking(image->handle),"prepared image acquisition failed");
    std::filesystem::remove(root/"page-0.png");
    require(images.hasPreparedBacking(image->handle),"unlinked prepared page snapshot lost");
    require(images.readPixelsRegion(image->handle,1,1,2,2)->rgba==
      std::vector<std::uint8_t>({37,73,109,0,37,73,109,157,37,73,109,0,37,73,109,157}),"bounded region read changed pixel content");
    images.clearPreparedIndex();
    const std::vector<std::uint8_t> replacement(8*4*4,255);
    write(root/"replacement.png",8,4,replacement);
    std::filesystem::rename(root/"replacement.png",root/"source.png");
    const auto replaced=images.loadPng(root/"source.png");
    require(replaced&&replaced->handle!=image->handle&&!images.hasPreparedBacking(replaced->handle),"replacement source reused old preparation");
    require(images.readPixels(image->handle)->rgba==original,"original owner snapshot changed after replacement");
    images.release(image->handle);images.release(replaced->handle);images.update();
    require(images.gpuBytes()==0,"replacement owners leaked");
  }
  {
    write(root/"lazy-page.png",6,6,std::vector<std::uint8_t>(6*6*4,255));
    pmjs::PreparedImageDescriptor descriptor;
    descriptor.width=4; descriptor.height=4;
    descriptor.pages.push_back({"lazy-page.png",6,6});
    descriptor.cells.push_back({{0,0,4,4},{0,0,4,4},{1,1,4,4},{0,0,0,0},0});
    const auto files=[]() {
      return std::distance(std::filesystem::directory_iterator("/proc/self/fd"),std::filesystem::directory_iterator{});
    };
    auto acquire=[&](pmjs::ImageStore& images, int index) {
      const auto source=root/("lazy-"+std::to_string(index)+".png");
      write(source,4,4,std::vector<std::uint8_t>(4*4*4,255));
      const auto identity=pmjs::ImageStore::openFile(source);
      require(images.installPrepared(source,root,descriptor,identity->key()),"lazy preparation failed");
      const auto image=images.loadPng(source);
      require(image&&image->texture==0,"lazy image materialized before drawing");
      return image->handle;
    };
    {
      pmjs::ImageStore images; images.setWarmBudgetBytes(0);
      const auto before=files();
      const auto pinned=acquire(images,0), inFlight=acquire(images,1), live=acquire(images,2);
      require(images.pin(pinned)&&images.beginUse(inFlight),"lazy owner capture failed");
      images.release(pinned); images.release(inFlight);
      for(int i=3;i<67;++i) images.release(acquire(images,i));
      require(images.warmCount()==64&&images.warmBytes()==0&&images.warmFileCount()==64&&
              images.cpuBytes()==6*6*4&&images.preparedPageDecodes()==1,
              "validated shared lazy page or file accounting failed");
      images.update();
      require(images.warmCount()==0&&images.warmFileCount()==0&&files()==before+3,
              "zero-budget lazy cache retained descriptors");
      require(images.inspect(pinned)&&images.inspect(inFlight)&&images.inspect(live),
              "cache eviction released a live owner");
      const auto decodes=images.preparedPageDecodes();
      require(images.retainCpuPixels(live)&&images.cpuBytes()==6*6*4+4*4*4&&
              images.preparedPageDecodes()==decodes,
              "synchronous CPU retention repeated the decode or kept duplicate pages");
      std::filesystem::remove(root/"lazy-page.png");
      require(images.readPixelsRegion(live,0,0,4,4)->rgba==std::vector<std::uint8_t>(64,255),
              "live captured page lost after deletion");
      images.unpin(pinned); images.endUse(inFlight); images.release(live); images.update();
      require(files()==before&&images.liveCount()==0,"released lazy owners leaked");
    }
    write(root/"lazy-page.png",6,6,std::vector<std::uint8_t>(6*6*4,255));
    {
      pmjs::ImageStore images;
      const auto before=files();
      std::vector<pmjs::ImageHandle> handles;
      for(int i=0;i<132;++i) { const auto image=acquire(images,i); handles.push_back(image); images.release(image); }
      images.update();
      require(images.warmCount()==pmjs::ImageStore::warmFileLimit&&
              images.warmFileCount()==pmjs::ImageStore::warmFileLimit&&
              files()==before+static_cast<int>(pmjs::ImageStore::warmFileLimit),"lazy file limit failed");
      require(!images.inspect(handles.front())&&images.inspect(handles.back()),"lazy cache did not evict oldest entries");
      images.setWarmBudgetBytes(0); images.update(); require(files()==before,"lazy descriptor flush failed");
    }
    {
      pmjs::ImageStore images;
      descriptor.pages.clear(); descriptor.cells.clear(); descriptor.uniform=std::array<std::uint8_t,4>{255,255,255,255};
      for(int i=0;i<260;++i) images.release(acquire(images,i));
      images.update();
      require(images.warmCount()==pmjs::ImageStore::warmEntryLimit&&images.warmFileCount()==0,
              "metadata-only warm entry limit failed");
    }
  }
  {
    pmjs::ImageStore images;
    const std::array<std::uint8_t,4> color{37,73,109,0};
    std::vector<std::uint8_t> original(16*4);
    for(std::size_t i=0;i<original.size();i+=4) std::copy(color.begin(),color.end(),original.begin()+i);
    write(root/"uniform.png",4,4,original);
    pmjs::PreparedImageDescriptor descriptor;descriptor.width=descriptor.height=4;descriptor.uniform=color;
    require(images.installPrepared(root/"uniform.png",root,descriptor),"uniform install failed");
    const auto image=images.loadPng(root/"uniform.png");
    require(image&&!image->knownAllZero,"hidden RGB incorrectly proved empty");
    require(images.readPixels(image->handle)->rgba==original,"uniform straight content changed");
    const auto region=images.resolveSpriteRegion(image->handle,0,0,4,4,false);
    require(region&&region->image.width==1&&region->image.height==1,"uniform image did not use constant backing");
    const std::vector<std::uint8_t> updated(16*4,255);
    require(images.updateRgba(image->handle,updated.data()),"derived mutable detachment failed");
    require(!images.hasPreparedBacking(image->handle)&&!images.resolveSpriteRegion(image->handle,0,0,4,4),"write retained stale immutable mapping");
    require(readGpu(*images.lookup(image->handle))==updated,"write failed to replace logical backing");
    images.release(image->handle);images.setWarmBudgetBytes(0);images.update();
    require(images.gpuBytes()==0,"constant backing leaked after mutation");
  }
  {
    pmjs::ImageStore images;
    const std::array<std::uint8_t,4> color{37,73,109,157};
    writeGenerated(root/"ordinary-boundary.png",4096,4096,[color](int,int) { return color; });
    pmjs::PreparedImageDescriptor descriptor;
    descriptor.width=descriptor.height=4096;descriptor.uniform=color;
    require(images.installPrepared(root/"ordinary-boundary.png",root,descriptor),"ordinary boundary install failed");
    const auto image=images.loadPng(root/"ordinary-boundary.png");
    require(image&&image->texture==0&&images.cpuBytes()==0,"ordinary boundary eagerly materialized backing");
    const auto full=images.lookup(image->handle);
    require(full&&images.cpuBytes()==0,"ordinary full upload retained reconstruction pixels");
    require(readGpu(*full,4095,4095,1,1)==std::vector<std::uint8_t>(color.begin(),color.end()),
            "ordinary full upload changed straight RGBA at the allocation boundary");
    auto expected=color;
    for(int channel=0;channel<3;++channel) expected[channel]=(expected[channel]*expected[3]+127)/255;
    const auto premultiplied=images.lookupPremultiplied(image->handle);
    require(premultiplied&&images.cpuBytes()==0&&images.preparedMaterializations()==2,
            "ordinary premultiplied upload retained reconstruction pixels");
    require(readGpu(*premultiplied,4095,4095,1,1)==std::vector<std::uint8_t>(expected.begin(),expected.end()),
            "ordinary full upload changed premultiplied rounding");
    require(images.textureUploadBytes()==2U*64U*1024U*1024U,"ordinary upload byte accounting changed");
    images.release(image->handle);images.setWarmBudgetBytes(0);images.update();
    require(images.gpuBytes()==0&&images.cpuBytes()==0,"ordinary boundary backing leaked");
  }
  {
    pmjs::ImageStore images;
    // Larger logical readbacks retain compact backing until explicitly requested.
    const std::array<std::uint8_t,4> color{37,73,109,157};
    writeGenerated(root/"oversized.png",4096,4097,[color](int,int) { return color; });
    pmjs::PreparedImageDescriptor descriptor;
    descriptor.width=4096;descriptor.height=4097;descriptor.uniform=color;
    require(images.installPrepared(root/"oversized.png",root,descriptor),"oversized install failed");
    const auto image=images.loadPng(root/"oversized.png");
    require(image&&image->texture==0&&images.cpuBytes()==0,"large image eagerly allocated CPU pixels");
    const auto pixels=images.readPixelsRegion(image->handle,4094,4095,2,2);
    require(pixels&&pixels->rgba.size()==16&&std::equal(color.begin(),color.end(),pixels->rgba.begin()),"oversized bounded read failed");
    const auto compact=images.resolveSpriteRegion(image->handle,0,0,4096,4097,false);
    require(compact&&compact->image.width==1&&images.gpuBytes()==4,"oversized uniform lost compact backing");
    const auto full=images.lookup(image->handle);
    require(full&&full->width==4096&&full->height==4097&&images.preparedMaterializations()==1,"oversized strip GPU fallback failed");
    const auto* logical=images.readPixels(image->handle);
    require(logical&&logical->rgba.size()==4096U*4097U*4U&&
      std::equal(color.begin(),color.end(),logical->rgba.begin())&&
      std::equal(color.begin(),color.end(),logical->rgba.end()-4),"large full CPU readback failed");
    images.release(image->handle);images.setWarmBudgetBytes(0);images.update();
    require(images.gpuBytes()==0&&images.cpuBytes()==0,"oversized backing leaked");
  }
  {
    pmjs::ImageStore images;
    constexpr int cellWidth=896,cellHeight=672,columns=9,rows=6;
    constexpr int width=cellWidth*columns,height=cellHeight*rows;
    const auto color=[](int x,int y) {
      const int cx=std::clamp(x,0,width-1)/cellWidth,cy=std::clamp(y,0,height-1)/cellHeight;
      return std::array<std::uint8_t,4>{static_cast<std::uint8_t>(37+cx),static_cast<std::uint8_t>(73+cy),
        static_cast<std::uint8_t>(109+cx+cy),157};
    };
    writeGenerated(root/"many-pages.png",width,height,color);
    pmjs::PreparedImageDescriptor descriptor;descriptor.width=width;descriptor.height=height;
    for(int cy=0;cy<rows;++cy) for(int cx=0;cx<columns;++cx) {
      const int page=cy*columns+cx;
      const auto name="many-page-"+std::to_string(page)+".png";
      writeGenerated(root/name,cellWidth+2,cellHeight+2,[=](int x,int y) {
        return color(cx*cellWidth+x-1,cy*cellHeight+y-1);
      });
      descriptor.pages.push_back({name,cellWidth+2,cellHeight+2});
      descriptor.cells.push_back({{cx*cellWidth,cy*cellHeight,cellWidth,cellHeight},
        {0,0,cellWidth,cellHeight},{1,1,cellWidth,cellHeight},{0,0,0,0},page});
    }
    require(images.installPrepared(root/"many-pages.png",root,descriptor),"many-page install failed");
    const auto image=images.loadPng(root/"many-pages.png");
    require(image&&image->texture==0&&images.cpuBytes()>0&&images.cpuBytes()<=32U*1024U*1024U&&
            images.preparedPageDecodes()==columns*rows,"many-page validation escaped the decode cache budget");
    std::filesystem::create_hard_link(root/"many-pages.png",root/"many-pages-second.png");
    require(images.installPrepared(root/"many-pages-second.png",root,descriptor),"second many-page install failed");
    const auto second=images.loadPng(root/"many-pages-second.png");
    require(second&&second->handle!=image->handle&&images.cpuBytes()<=32U*1024U*1024U,
            "loading multiple prepared images accumulated unbounded validation pixels");
    images.release(second->handle);images.setWarmBudgetBytes(0);images.update();
    const auto full=images.lookup(image->handle);
    require(full&&images.preparedMaterializations()==1,"many-page oversized strip fallback failed");
    require(images.cpuBytes()<=32U*1024U*1024U,"strip fallback retained more than bounded page cache");
    const auto region=images.readPixelsRegion(image->handle,width-2,height-2,2,2);
    const auto expected=color(width-1,height-1);
    require(region&&std::equal(expected.begin(),expected.end(),region->rgba.begin()),"evicted page could not be reconstructed");
    require(images.cpuBytes()<=32U*1024U*1024U,"region read exceeded bounded page cache");
    const auto* logical=images.readPixels(image->handle);
    require(logical&&logical->rgba.size()==static_cast<std::size_t>(width)*height*4U&&
      std::equal(expected.begin(),expected.end(),logical->rgba.end()-4),
      "many-page full readback below the allocation limit failed");
    images.release(image->handle);images.setWarmBudgetBytes(0);images.update();
    require(images.gpuBytes()==0&&images.cpuBytes()==0,"many-page fallback ownership leaked");
  }
  std::filesystem::remove_all(root);
}
