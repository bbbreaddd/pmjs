#include "mv_core_types.hpp"
#include <atomic>
#include <cctype>
#include <charconv>
#include <cstdlib>
#include <limits>
namespace pmjs::mv::core {
std::string format(const std::string& value,const std::vector<std::string>& args){
  std::string result;for(std::size_t i=0;i<value.size();++i){
    if(value[i]=='%'&&i+1<value.size()&&std::isdigit(static_cast<unsigned char>(value[i+1]))){
      std::size_t end=i+1;while(end<value.size()&&std::isdigit(static_cast<unsigned char>(value[end])))++end;
      const auto index=std::strtoull(value.substr(i+1,end-i-1).c_str(),nullptr,10);
      result+=index>0&&index<=args.size()?args[index-1]:"undefined";i=end-1;
    }else result+=value[i];
  }return result;
}
std::uint64_t Utils::generateRuntimeId(){static std::atomic<std::uint64_t> next{1};return next++;}
std::string padZero(std::string value,int length) {
  int units = 0;
  for(unsigned char byte : value) {
    if(byte < 0x80 || byte >= 0xc0) units += byte >= 0xf0 ? 2 : 1;
  }
  if(length > units) value.insert(0,static_cast<std::size_t>(length-units),'0');
  return value;
}
std::string Utils::rgbToCssColor(double r,double g,double b) {
  auto rounded = [](double number) {
    if(std::isnan(number)) return std::string("NaN");
    if(std::isinf(number)) return std::string(number < 0 ? "-Infinity" : "Infinity");
    const double lower = std::floor(number);
    number = number - lower < 0.5 ? lower : lower + 1;
    if(number == 0) return std::string("0");
    char buffer[64];
    auto result = std::to_chars(buffer,buffer+sizeof(buffer),number);
    return std::string(buffer,result.ptr);
  };
  return "rgb("+rounded(r)+","+rounded(g)+","+rounded(b)+")";
}
}
