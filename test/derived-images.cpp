#include "platform.hpp"
#include "resources.hpp"

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
  return rgba;
}
}
int main() {
  pmjs::Platform platform(16,16,"Derived logical images");
  char temporary[] = "/tmp/pmjs-derived-images-XXXXXX";
  const auto* directory = mkdtemp(temporary);
  require(directory,"temporary fixture failed");
  const std::filesystem::path root(directory);
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
    require(images.cpuBytes()==0,"image load retained every compact page eagerly");
    const auto* pixels=images.readPixels(image->handle);
    require(pixels&&pixels->rgba==original,"logical reconstruction lost exact RGBA or hidden RGB");
    auto region=images.resolveSpriteRegion(image->handle,4,0,4,4,false);
    require(region&&region->source==std::array<float,4>{5,1,2,2}&&region->atlas==std::array<float,4>{5,1,2,2},"cell remapping failed");
    require(images.inspect(image->handle)->texture==0,"ordinary region forced full backing");
    for(int tick=0;tick<61;++tick) images.update();
    require(images.cpuBytes()==0,"on-demand compact CPU pages escaped expiry");
    require(images.resolveSpriteRegion(image->handle,4,0,4,4,false).has_value()&&images.cpuBytes()==0,
            "resident GPU page needlessly decoded CPU pixels after expiry");
    require(!images.resolveSpriteRegion(image->handle,3,0,2,4,false),"cross-cell crop escaped fallback");
    auto full=images.lookup(image->handle);
    require(full&&readGpu(*full)==original,"full fallback changed original pixels");
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
      require(image&&image->texture==0&&images.cpuBytes()==0,"lazy image materialized before drawing");
      return image->handle;
    };
    {
      pmjs::ImageStore images; images.setWarmBudgetBytes(0);
      const auto before=files();
      const auto pinned=acquire(images,0), inFlight=acquire(images,1), live=acquire(images,2);
      require(images.pin(pinned)&&images.beginUse(inFlight),"lazy owner capture failed");
      images.release(pinned); images.release(inFlight);
      for(int i=3;i<67;++i) images.release(acquire(images,i));
      require(images.warmCount()==64&&images.warmBytes()==0&&images.warmFileCount()==64,
              "zero-byte lazy file accounting failed");
      images.update();
      require(images.warmCount()==0&&images.warmFileCount()==0&&files()==before+3,
              "zero-budget lazy cache retained descriptors");
      require(images.inspect(pinned)&&images.inspect(inFlight)&&images.inspect(live),
              "cache eviction released a live owner");
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
    require(image&&image->texture==0&&images.cpuBytes()==0,"many-page catalogue retained decoded pages");
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
