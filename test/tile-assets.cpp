#include "assets/tile_assets.hpp"
#include <algorithm>
#include <filesystem>
#include <iostream>
#include <stdexcept>
#include <source_location>
#include <unistd.h>
#include <png.h>

namespace {
void require(bool value, std::source_location location = std::source_location::current()) {
  if (!value) throw std::runtime_error("tile asset assertion failed at line "+std::to_string(location.line()));
}
}
int main() try {
  const auto root = std::filesystem::temp_directory_path()/ ("pmjs-tile-assets-"+std::to_string(getpid()));
  std::filesystem::create_directories(root);
  pmjs::ImagePixels original{128,128,std::vector<std::uint8_t>(128*128*4)};
  for (int y=0;y<128;y++) for(int x=0;x<128;x++) {
    const auto offset = static_cast<std::size_t>(y*128+x)*4;
    original.rgba[offset]=x%32;original.rgba[offset+1]=y%32;
    original.rgba[offset+2]=(x+y)%32;original.rgba[offset+3]=(x+y)%4 ? 255 : 0;
  }
  pmjs::writePreparedPng(root/"source.png",128,128,original.rgba);
  auto source=pmjs::ImageStore::openFile(root/"source.png");require(source != nullptr);
  const std::vector<pmjs::AssetRect> rectangles{{0,0,32,32},{32,32,32,32},{8,8,16,16},{96,96,32,32}};
  pmjs::ImagePixels gray{2,1,{20,20,20,255,80,80,80,255}};
  require(pmjs::ImageStore::decodedStorageBytes(gray)==8);
  gray.rgba[7]=97;require(pmjs::ImageStore::decodedStorageBytes(gray)==8);
  require(pmjs::ImageStore::decodedStorageBytes(original)==original.rgba.size());
  const auto prepared = pmjs::prepareTileAssets({{std::shared_ptr<pmjs::ImageFileSource>(std::move(source)),rectangles}},root);
  require(prepared.sources.size()==1 && !prepared.pages.empty());
  for (std::size_t i=0;i<rectangles.size();++i) {
    const auto& region=prepared.sources[0].regions[i];const auto& page=prepared.pages[region.page];
    require(page.width<=2048 && page.height<=2048);
    auto file=pmjs::ImageStore::openFile(root/page.path);auto decoded=pmjs::ImageStore::decodeFile(*file);require(decoded.has_value());
    const auto r=rectangles[i];
    for(int y=-prepared.halo;y<r[3]+prepared.halo;y++) for(int x=-prepared.halo;x<r[2]+prepared.halo;x++) {
      const auto sx=std::clamp(r[0]+x,0,127),sy=std::clamp(r[1]+y,0,127);
      const auto originalOffset=static_cast<std::size_t>(sy*128+sx)*4;
      const auto packedOffset=(static_cast<std::size_t>(region.atlas[1]+y)*decoded->width+region.atlas[0]+x)*4;
      require(std::equal(original.rgba.begin()+originalOffset,original.rgba.begin()+originalOffset+4,decoded->rgba.begin()+packedOffset));
    }
  }
  // The three equivalent interiors have different edge neighborhoods, so the
  // edge piece must not alias an interior even when all non-halo bytes match.
  const auto& regions=prepared.sources[0].regions;
  require(regions[0].atlas != regions[1].atlas);
  require(regions[1].atlas != regions[3].atlas);
  auto duplicateSource=pmjs::ImageStore::openFile(root/"source.png");
  const auto duplicate=pmjs::prepareTileAssets({{std::shared_ptr<pmjs::ImageFileSource>(std::move(duplicateSource)),{{32,32,32,32},{64,64,32,32}}}},root);
  require(duplicate.sources[0].regions[0].atlas==duplicate.sources[0].regions[1].atlas);
  const std::array<std::array<std::uint8_t,8>,2> collisions{{
    {0x46,0xd0,0x32,0x5b,0x53,0x02,0xa3,0x0c}, {0x8c,0x95,0x5e,0x00,0xcd,0xef,0xf3,0x56}}};
  std::vector<pmjs::TileAssetInput> collisionInputs;
  for (std::size_t i=0;i<collisions.size();++i) {
    std::vector<std::uint8_t> bytes(8*8*4);
    std::copy(collisions[i].begin(),collisions[i].end(),bytes.begin()+(2*8+2)*4);
    const auto file=root/("collision-"+std::to_string(i)+".png");
    pmjs::writePreparedPng(file,8,8,bytes);
    collisionInputs.push_back({std::shared_ptr<pmjs::ImageFileSource>(pmjs::ImageStore::openFile(file)),{{0,0,8,8}}});
  }
  std::filesystem::create_directories(root/"collisions");
  const auto collided=pmjs::prepareTileAssets(collisionInputs,root/"collisions");
  require(collided.sources[0].regions[0].atlas!=collided.sources[1].regions[0].atlas);
  require(pmjs::verifyTileAssets(collisionInputs,collided,root/"collisions")==2);
  bool rejected=false;
  try {
    auto invalid=pmjs::ImageStore::openFile(root/"source.png");
    pmjs::prepareTileAssets({{std::shared_ptr<pmjs::ImageFileSource>(std::move(invalid)),{{120,120,32,32}}}},root);
  } catch (const pmjs::AssetPreparationUnsupported&) { rejected=true; }
  require(rejected);
  pmjs::ImagePixels large{3000,1500,std::vector<std::uint8_t>(3000*1500*4)};
  for (int y=0;y<1500;y++) for(int x=0;x<3000;x++) {
    const auto at=static_cast<std::size_t>(y*3000+x)*4;
    large.rgba[at]=x%251;large.rgba[at+1]=y%241;large.rgba[at+2]=(x/100+y/100)%256;large.rgba[at+3]=255;
  }
  // Source compression must not depend on the prepared-output encoding policy.
  png_image sourceImage{};
  sourceImage.version = PNG_IMAGE_VERSION;
  sourceImage.width = 3000; sourceImage.height = 1500; sourceImage.format = PNG_FORMAT_RGBA;
  require(png_image_write_to_file(&sourceImage, (root/"large.png").c_str(), 0, large.rgba.data(), 0, nullptr));
  png_image_free(&sourceImage);
  auto largeFile=pmjs::ImageStore::openFile(root/"large.png");
  std::vector<pmjs::TileAssetInput> demands{{std::shared_ptr<pmjs::ImageFileSource>(std::move(largeFile)),{{0,0,1500,1500},{1500,0,1500,1500}}}};
  require(!pmjs::ImageStore::decodeFile(*demands[0].source, 1024));
  auto excessive = demands;
  excessive[0].rectangles = {{0,0,1500,1500},{300,0,1500,1500},{600,0,1500,1500},{900,0,1500,1500},{1200,0,1500,1500}};
  rejected=false;
  try { pmjs::prepareTileAssets(excessive,root); }
  catch (const pmjs::AssetPreparationUnsupported&) { rejected=true; }
  require(rejected);
  const auto pages=pmjs::prepareTileAssets(demands,root);
  require(pages.pages.size()==2);
  require(pmjs::verifyTileAssets(demands,pages,root)==2);
  auto incomplete=pages;incomplete.sources[0].regions.pop_back();
  rejected=false;
  try {pmjs::verifyTileAssets(demands,incomplete,root);}catch(const std::runtime_error&){rejected=true;}
  require(rejected);
  std::filesystem::remove_all(root);
  std::cout<<"exact tile RGBA, overlapping demands, halos, deduplication and bounds passed\n";
  return 0;
} catch (const std::exception& error) {std::cerr<<error.what()<<'\n';return 1;}
