#include "mv_core_types.hpp"
#include <iostream>
#include <stdexcept>
using namespace pmjs::mv::core;
void require(bool condition,const char* message){if(!condition)throw std::runtime_error(message);}
int main()try{
  Point point;point.set(4);require(point.x==4&&point.y==4,"single-coordinate point set");
  point.set(2,0);require(point.clone().equals({2,0}),"point preserves explicit zero");
  Rectangle rectangle{2,3,4,5};require(rectangle.contains(2,3)&&!rectangle.contains(6,3)&&!rectangle.contains(2,8),"rectangle right/bottom are exclusive");
  rectangle.pad(2);require(rectangle.x==0&&rectangle.y==1&&rectangle.width==8&&rectangle.height==9,"uniform rectangle padding");
  rectangle.pad(1,0);require(rectangle.x==-1&&rectangle.y==1,"explicit zero vertical padding");
  require(mod(-1,4)==3&&std::isnan(mod(1,0)),"MV modulo");
  require(clamp(3,8,2)==2&&std::isnan(clamp(NAN,0,1)),"MV clamp order and NaN");
  require(padZero("😀",3)=="0😀"&&padZero("雪",3)=="00雪","UTF-16 padding length");
  require(format("%2/%1/%0/%9",{"a","b"})=="b/a/undefined/undefined","indexed string formatting");
  require(Utils::rgbToCssColor(-1.5,0.5,NAN)=="rgb(-1,1,NaN)","JS rounding and NaN color strings");
  const auto firstId=Utils::generateRuntimeId();
  require(firstId+1==Utils::generateRuntimeId(),"monotonic resource IDs");
  const Matrix translated{1,0,0,1,3,4},scaled{2,0,0,2,0,0};
  require(multiply(translated,scaled)==Matrix{2,0,0,2,3,4},"parent/child affine transform order");
  std::cout<<"native MV core geometry checks passed\n";
}catch(const std::exception& error){std::cerr<<error.what()<<'\n';return 1;}
