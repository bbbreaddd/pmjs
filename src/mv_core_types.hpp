#pragma once
#include <algorithm>
#include <array>
#include <cmath>
#include <cstdint>
#include <functional>
#include <memory>
#include <string>
#include <vector>

namespace pmjs::mv { struct Value; struct JsonNode; }

namespace pmjs::mv::core {
struct Point {
  double x=0,y=0;
  void set(double first=0){x=std::isnan(first)||first==0?0:first;y=x;}
  void set(double first,double second){x=std::isnan(first)||first==0?0:first;y=second==0?0:std::isnan(second)?x:second;}
  Point clone()const{return *this;}
  void copy(const Point& point){set(point.x,point.y);}
  bool equals(const Point& point)const{return x==point.x&&y==point.y;}
};
struct Rectangle {
  double x=0,y=0,width=0,height=0;
  double left()const{return x;} double top()const{return y;}
  double right()const{return x+width;} double bottom()const{return y+height;}
  bool contains(double px,double py)const{return width>0&&height>0&&px>=x&&px<x+width&&py>=y&&py<y+height;}
  Rectangle clone()const{return *this;}
  Rectangle& copy(const Rectangle& value){*this=value;return *this;}
  void pad(double horizontal=0){pad(horizontal,horizontal);}
  void pad(double horizontal,double vertical){
    horizontal=std::isnan(horizontal)||horizontal==0?0:horizontal;
    vertical=vertical==0?0:std::isnan(vertical)?horizontal:vertical;
    x-=horizontal;y-=vertical;width+=horizontal*2;height+=vertical*2;
  }
  void fit(const Rectangle& rectangle);
  void enlarge(const Rectangle& rectangle);
  static Rectangle emptyRectangle(){return {};}
  static constexpr int type=1;
};
using Matrix=std::array<float,6>;
inline Matrix multiply(const Matrix& a,const Matrix& b){return{a[0]*b[0]+a[2]*b[1],a[1]*b[0]+a[3]*b[1],a[0]*b[2]+a[2]*b[3],a[1]*b[2]+a[3]*b[3],a[0]*b[4]+a[2]*b[5]+a[4],a[1]*b[4]+a[3]*b[5]+a[5]};}
inline double minimum(double first,double second){
  if(std::isnan(first)||std::isnan(second))return NAN;
  if(first==0&&second==0)return std::signbit(first)||std::signbit(second)?-0.0:0.0;
  return std::min(first,second);
}
inline double maximum(double first,double second){
  if(std::isnan(first)||std::isnan(second))return NAN;
  if(first==0&&second==0)return std::signbit(first)&&std::signbit(second)?-0.0:0.0;
  return std::max(first,second);
}
inline double clamp(double value,double lower,double upper){return minimum(maximum(value,lower),upper);}
inline double round(double value){
  if(!std::isfinite(value)||value==0)return value;
  if(value>=-0.5&&value<0)return -0.0;
  const double lower=std::floor(value);
  return value-lower<0.5?lower:lower+1;
}
inline double mod(double value,double divisor){return std::fmod(std::fmod(value,divisor)+divisor,divisor);}
inline double randomInt(double maximum,const std::function<double()>& random){return std::floor(maximum*random());}
std::string padZero(std::string value,double length);
std::string numberPadZero(double value,double length);
std::string format(const std::string& pattern,const std::vector<std::string>& arguments);
std::string formatValues(const std::string& pattern,const std::vector<pmjs::mv::Value>& arguments);
std::vector<std::uint16_t> utf16Units(const std::string& text);
std::size_t utf16Length(const std::string& text);
std::string numberString(double value);
std::string stringValue(const pmjs::mv::Value& value);
double numberValue(const pmjs::mv::Value& value);
bool strictEquals(const pmjs::mv::Value& left,const pmjs::mv::Value& right);
bool strictEquals(const std::shared_ptr<pmjs::mv::JsonNode>& left,const std::shared_ptr<pmjs::mv::JsonNode>& right);
bool graphArrayEquals(const std::vector<std::shared_ptr<pmjs::mv::JsonNode>>& left,const std::vector<std::shared_ptr<pmjs::mv::JsonNode>>& right);
bool graphArrayContains(const std::vector<std::shared_ptr<pmjs::mv::JsonNode>>& values,const std::shared_ptr<pmjs::mv::JsonNode>& value);
bool arrayEquals(const std::vector<pmjs::mv::Value>& left,const std::vector<pmjs::mv::Value>& right);
bool arrayContains(const std::vector<pmjs::mv::Value>& array,const pmjs::mv::Value& value);
inline bool equals(const std::vector<pmjs::mv::Value>& left,const std::vector<pmjs::mv::Value>& right){return arrayEquals(left,right);}
inline bool contains(const std::vector<pmjs::mv::Value>& array,const pmjs::mv::Value& value){return arrayContains(array,value);}
bool contains(const std::string& str,const std::string& sub);
template <typename T>
inline bool contains(const std::vector<T>& arr, const T& element) {
  return std::find(arr.begin(), arr.end(), element) != arr.end();
}
template <typename T>
inline bool equals(const std::vector<T>& a, const std::vector<T>& b) {
  return a == b;
}
template <typename T>
inline std::vector<T> clone(const std::vector<T>& array){return array;}
struct Utils {
  static constexpr const char* RPGMAKER_NAME="MV";
  static constexpr const char* RPGMAKER_VERSION="1.6.1";
  static std::uint64_t generateRuntimeId();
  static std::string rgbToCssColor(double red,double green,double blue);
  static bool isOptionValid(const std::string& name,const std::vector<std::string>& args={},const std::string& search="");
  static bool isNwjs(){return true;}
  static bool isMobileDevice(const std::string& userAgent="");
  static bool isMobileSafari(const std::string& userAgent="");
  static bool isAndroidChrome(const std::string& userAgent="");
  static bool canReadGameFiles(){return true;}
  static bool isSupportPassiveEvent(){return false;}
};
}
