#pragma once
#include <algorithm>
#include <array>
#include <cmath>
#include <cstdint>
#include <functional>
#include <string>
#include <vector>

namespace pmjs::mv::core {
struct Point {
  double x=0,y=0;
  void set(double first=0){x=first;y=first;}
  void set(double first,double second){x=first;y=second;}
  Point clone()const{return *this;}
  void copy(const Point& point){*this=point;}
  bool equals(const Point& point)const{return x==point.x&&y==point.y;}
};
struct Rectangle {
  double x=0,y=0,width=0,height=0;
  double left()const{return x;} double top()const{return y;}
  double right()const{return x+width;} double bottom()const{return y+height;}
  bool contains(double px,double py)const{return width>0&&height>0&&px>=x&&px<x+width&&py>=y&&py<y+height;}
  Rectangle clone()const{return *this;}
  void copy(const Rectangle& value){*this=value;}
  void pad(double horizontal=0){pad(horizontal,horizontal);}
  void pad(double horizontal,double vertical){x-=horizontal;y-=vertical;width+=horizontal*2;height+=vertical*2;}
};
using Matrix=std::array<float,6>;
inline Matrix multiply(const Matrix& a,const Matrix& b){return{a[0]*b[0]+a[2]*b[1],a[1]*b[0]+a[3]*b[1],a[0]*b[2]+a[2]*b[3],a[1]*b[2]+a[3]*b[3],a[0]*b[4]+a[2]*b[5]+a[4],a[1]*b[4]+a[3]*b[5]+a[5]};}
inline double clamp(double value,double minimum,double maximum){if(std::isnan(value)||std::isnan(minimum)||std::isnan(maximum))return NAN;return std::min(std::max(value,minimum),maximum);}
inline double mod(double value,double divisor){return std::fmod(std::fmod(value,divisor)+divisor,divisor);}
inline double randomInt(double maximum,const std::function<double()>& random){return std::floor(maximum*random());}
std::string padZero(std::string value,int length);
std::string format(const std::string& pattern,const std::vector<std::string>& arguments);
struct Utils {
  static constexpr const char* RPGMAKER_NAME="MV";
  static constexpr const char* RPGMAKER_VERSION="1.6.1";
  static std::uint64_t generateRuntimeId();
  static std::string rgbToCssColor(double red,double green,double blue);
};
}
