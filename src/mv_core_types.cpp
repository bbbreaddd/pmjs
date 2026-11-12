#include "mv_core_types.hpp"
#include "mv_engine.hpp"

#include <atomic>
#include <charconv>
#include <cctype>
#include <cstdlib>
#include <limits>
#include <stdexcept>

namespace pmjs::mv::core {
namespace {
bool whitespace(std::uint16_t unit) {
  return unit==0x09||unit==0x0a||unit==0x0b||unit==0x0c||unit==0x0d||unit==0x20||unit==0xa0||unit==0x1680||
    (unit>=0x2000&&unit<=0x200a)||unit==0x2028||unit==0x2029||unit==0x202f||unit==0x205f||unit==0x3000||unit==0xfeff;
}
template<class Argument> std::string formatArguments(const std::string& value,const Argument& argument) {
  std::string result;
  for(std::size_t index=0;index<value.size();++index) {
    if(value[index]=='%'&&index+1<value.size()&&value[index+1]>='0'&&value[index+1]<='9') {
      std::size_t end=index+1;
      while(end<value.size()&&value[end]>='0'&&value[end]<='9')++end;
      const auto position=std::strtoull(value.substr(index+1,end-index-1).c_str(),nullptr,10);
      result+=argument(position);index=end-1;
    }else result+=value[index];
  }
  return result;
}
bool option(const std::string& list,const std::string& name) {
  std::size_t start=0;
  for(;;) {
    const auto end=list.find('&',start);
    if(list.substr(start,end==std::string::npos?end:end-start)==name)return true;
    if(end==std::string::npos)return false;
    start=end+1;
  }
}
}

std::vector<std::uint16_t> utf16Units(const std::string& text) {
  std::vector<std::uint16_t> result;result.reserve(text.size());
  for(std::size_t index=0;index<text.size();) {
    const auto first=static_cast<unsigned char>(text[index]);
    if(first<0x80){result.push_back(first);++index;continue;}
    int count=first>=0xc2&&first<=0xdf?2:first>=0xe0&&first<=0xef?3:first>=0xf0&&first<=0xf4?4:0;
    std::uint32_t code= count==2?first&0x1f:count==3?first&0x0f:count==4?first&0x07:0;
    bool valid=count>0&&index+count<=text.size();
    for(int part=1;part<count&&valid;++part) {
      const auto byte=static_cast<unsigned char>(text[index+part]);
      if((byte&0xc0)!=0x80)valid=false;else code=(code<<6)|(byte&0x3f);
    }
    valid=valid&&!(count==2&&code<0x80)&&!(count==3&&code<0x800)&&!(count==4&&code<0x10000)&&code<=0x10ffff;
    if(!valid){result.push_back(0xfffd);++index;continue;}
    index+=count;
    if(code<=0xffff)result.push_back(static_cast<std::uint16_t>(code));
    else {code-=0x10000;result.push_back(0xd800+(code>>10));result.push_back(0xdc00+(code&0x3ff));}
  }
  return result;
}
std::size_t utf16Length(const std::string& text){return utf16Units(text).size();}
bool contains(const std::string& text,const std::string& sub) {
  const auto first=utf16Units(text),second=utf16Units(sub);
  return std::search(first.begin(),first.end(),second.begin(),second.end())!=first.end()||second.empty();
}
std::string padZero(std::string value,double length) {
  const auto units=utf16Length(value);
  if(length>static_cast<double>(units)) {
    const double target=std::ceil(length);
    if(!std::isfinite(target)||target>static_cast<double>(value.max_size()))throw std::length_error("padded string exceeds supported size");
    value.insert(0,static_cast<std::size_t>(target)-units,'0');
  }
  return value;
}
std::string numberPadZero(double value,double length){return padZero(numberString(value),length);}

std::string format(const std::string& value,const std::vector<std::string>& args) {
  return formatArguments(value,[&](std::uint64_t position){return position>0&&position<=args.size()?args[position-1]:"undefined";});
}
std::string formatValues(const std::string& value,const std::vector<Value>& args) {
  return formatArguments(value,[&](std::uint64_t position){return position>0&&position<=args.size()?stringValue(args[position-1]):"undefined";});
}
std::string numberString(double value) {
  if(std::isnan(value))return "NaN";
  if(std::isinf(value))return value<0?"-Infinity":"Infinity";
  if(value==0)return "0";
  const bool negative=value<0;
  char buffer[64];
  const auto written=std::to_chars(buffer,buffer+sizeof(buffer),std::abs(value));
  if(written.ec!=std::errc{})throw std::runtime_error("cannot format number");
  std::string text(buffer,written.ptr),digits;
  const auto exponentAt=text.find_first_of("eE"),decimalAt=text.find('.');
  const auto mantissaEnd=exponentAt==std::string::npos?text.size():exponentAt;
  int decimal=decimalAt==std::string::npos||decimalAt>mantissaEnd?static_cast<int>(mantissaEnd):static_cast<int>(decimalAt);
  for(std::size_t index=0;index<mantissaEnd;++index)if(text[index]!='.')digits+=text[index];
  if(exponentAt!=std::string::npos)decimal+=std::stoi(text.substr(exponentAt+1));
  while(digits.size()>1&&digits.back()=='0')digits.pop_back();
  if(std::abs(value)>=1e-6&&std::abs(value)<1e21) {
    if(decimal<=0)text="0."+std::string(static_cast<std::size_t>(-decimal),'0')+digits;
    else if(decimal>=static_cast<int>(digits.size()))text=digits+std::string(static_cast<std::size_t>(decimal)-digits.size(),'0');
    else text=digits.substr(0,decimal)+"."+digits.substr(decimal);
  }else {
    text=digits.substr(0,1)+(digits.size()>1?"."+digits.substr(1):"");
    const int exponent=decimal-1;
    text+="e"+std::string(exponent>=0?"+":"")+std::to_string(exponent);
  }
  return negative?"-"+text:text;
}
std::string stringValue(const Value& value) {
  if(value.isUndefined())return "undefined";
  if(std::holds_alternative<std::monostate>(value.data))return "null";
  if(const auto* boolean=std::get_if<bool>(&value.data))return *boolean?"true":"false";
  if(const auto* number=std::get_if<double>(&value.data))return numberString(*number);
  if(const auto* text=std::get_if<std::string>(&value.data))return *text;
  if(const auto* array=std::get_if<Value::Array>(&value.data)) {
    std::string text;
    for(std::size_t index=0;index<array->size();++index) {
      if(index)text+=',';
      if(!(*array)[index].null())text+=stringValue((*array)[index]);
    }
    return text;
  }
  return "[object Object]";
}
double numberValue(const Value& value) {
  if(value.isUndefined())return NAN;
  if(std::holds_alternative<std::monostate>(value.data))return 0;
  if(const auto* number=std::get_if<double>(&value.data))return *number;
  if(const auto* boolean=std::get_if<bool>(&value.data))return *boolean?1:0;
  if(std::holds_alternative<Value::Object>(value.data))return NAN;
  const auto units=utf16Units(stringValue(value));
  std::size_t begin=0,end=units.size();
  while(begin<end&&whitespace(units[begin]))++begin;
  while(end>begin&&whitespace(units[end-1]))--end;
  if(begin==end)return 0;
  std::string text; text.reserve(end-begin);
  for(std::size_t index=begin;index<end;++index){if(units[index]>0x7f)return NAN;text+=static_cast<char>(units[index]);}
  if(text=="Infinity"||text=="+Infinity")return INFINITY;
  if(text=="-Infinity")return -INFINITY;
  if(text.size()>2&&text[0]=='0'&&(text[1]=='x'||text[1]=='X'||text[1]=='o'||text[1]=='O'||text[1]=='b'||text[1]=='B')) {
    const int bits=text[1]=='x'||text[1]=='X'?4:text[1]=='o'||text[1]=='O'?3:1;
    std::uint64_t significant=0;std::size_t count=0;bool round=false,sticky=false;
    for(std::size_t index=2;index<text.size();++index) {
      const char digit=text[index];
      const int number=digit>='0'&&digit<='9'?digit-'0':digit>='a'&&digit<='f'?digit-'a'+10:digit>='A'&&digit<='F'?digit-'A'+10:-1;
      if(number<0||number>=(1<<bits))return NAN;
      for(int bit=bits-1;bit>=0;--bit) {
        const bool one=(number&(1<<bit))!=0;
        if(count==0&&!one)continue;
        if(count<53)significant=(significant<<1)|one;
        else if(count==53)round=one;else sticky=sticky||one;
        ++count;
      }
    }
    if(count<=53)return static_cast<double>(significant);
    if(count>1024)return INFINITY;
    if(round&&(sticky||(significant&1)))++significant;
    return std::ldexp(static_cast<double>(significant),static_cast<int>(count)-53);
  }
  std::size_t index=0;
  if(text[index]=='+'||text[index]=='-')++index;
  bool digits=false;
  while(index<text.size()&&text[index]>='0'&&text[index]<='9'){digits=true;++index;}
  if(index<text.size()&&text[index]=='.'){++index;while(index<text.size()&&text[index]>='0'&&text[index]<='9'){digits=true;++index;}}
  if(!digits)return NAN;
  if(index<text.size()&&(text[index]=='e'||text[index]=='E')) {
    ++index;if(index<text.size()&&(text[index]=='+'||text[index]=='-'))++index;
    const auto first=index;
    while(index<text.size()&&text[index]>='0'&&text[index]<='9')++index;
    if(first==index)return NAN;
  }
  if(index!=text.size())return NAN;
  const char* first=text.data();if(*first=='+')++first;
  double result=0;
  const auto parsed=std::from_chars(first,text.data()+text.size(),result);
  if(parsed.ec==std::errc::result_out_of_range) {
    const auto exponent=text.find_first_of("eE");
    long long power=0;
    if(exponent!=std::string::npos) {
      const auto suffix=text.substr(exponent+1);char* ignored=nullptr;
      power=std::strtoll(suffix.c_str(),&ignored,10);
      power=std::clamp(power,-1000000LL,1000000LL);
    }
    const auto point=text.find('.');
    const auto mantissaEnd=exponent==std::string::npos?text.size():exponent;
    const auto integerEnd=point!=std::string::npos&&point<mantissaEnd?point:mantissaEnd;
    const std::size_t sign=text[0]=='+'||text[0]=='-'?1:0;
    std::size_t firstNonzero=sign;
    while(firstNonzero<mantissaEnd&&(text[firstNonzero]=='0'||text[firstNonzero]=='.'))++firstNonzero;
    const long long order=power+static_cast<long long>(integerEnd)-static_cast<long long>(firstNonzero)-(firstNonzero<integerEnd?1:0);
    result=order>=0?INFINITY:0;
    if(text[0]=='-')result=-result;
  }else if(parsed.ec!=std::errc{}||parsed.ptr!=text.data()+text.size())return NAN;
  return result;
}
bool strictEquals(const Value& left,const Value& right) {
  if(left.data.index()!=right.data.index())return false;
  if(left.isUndefined())return true;
  if(std::holds_alternative<std::monostate>(left.data))return true;
  if(const auto* value=std::get_if<bool>(&left.data))return *value==std::get<bool>(right.data);
  if(const auto* value=std::get_if<double>(&left.data))return *value==std::get<double>(right.data);
  if(const auto* value=std::get_if<std::string>(&left.data))return utf16Units(*value)==utf16Units(std::get<std::string>(right.data));
  return &left==&right;
}
bool arrayEquals(const std::vector<Value>& left,const std::vector<Value>& right) {
  if(left.size()!=right.size())return false;
  for(std::size_t index=0;index<left.size();++index) {
    const auto* first=std::get_if<Value::Array>(&left[index].data);
    const auto* second=std::get_if<Value::Array>(&right[index].data);
    if(first&&second){if(!arrayEquals(*first,*second))return false;}
    else if(!strictEquals(left[index],right[index]))return false;
  }
  return true;
}
bool arrayContains(const std::vector<Value>& array,const Value& value) {
  return std::any_of(array.begin(),array.end(),[&](const auto& item){return strictEquals(item,value);});
}
void Rectangle::fit(const Rectangle& rectangle) {
  if(x<rectangle.x){width+=x;if(width<0)width=0;x=rectangle.x;}
  if(y<rectangle.y){height+=y;if(height<0)height=0;y=rectangle.y;}
  if(x+width>rectangle.x+rectangle.width){width=rectangle.width-x;if(width<0)width=0;}
  if(y+height>rectangle.y+rectangle.height){height=rectangle.height-y;if(height<0)height=0;}
}
void Rectangle::enlarge(const Rectangle& rectangle) {
  const double firstX=minimum(x,rectangle.x),lastX=maximum(x+width,rectangle.x+rectangle.width);
  const double firstY=minimum(y,rectangle.y),lastY=maximum(y+height,rectangle.y+rectangle.height);
  x=firstX;y=firstY;width=lastX-firstX;height=lastY-firstY;
}
std::uint64_t Utils::generateRuntimeId(){static std::atomic<std::uint64_t> next{1};return next++;}
std::string Utils::rgbToCssColor(double red,double green,double blue) {
  return "rgb("+numberString(round(red))+","+numberString(round(green))+","+numberString(round(blue))+")";
}
bool Utils::isOptionValid(const std::string& name,const std::vector<std::string>& args,const std::string& search) {
  return option(search.empty()?search:search.substr(1),name)||(!args.empty()&&option(args.front(),name));
}
bool Utils::isMobileDevice(const std::string& userAgent) {
  std::string lower=userAgent;
  std::transform(lower.begin(),lower.end(),lower.begin(),[](unsigned char byte){return static_cast<char>(std::tolower(byte));});
  for(const auto* name:{"android","webos","iphone","ipad","ipod","blackberry","iemobile","opera mini"})if(lower.find(name)!=std::string::npos)return true;
  return false;
}
bool Utils::isMobileSafari(const std::string& agent) {
  return (agent.find("iPhone")!=std::string::npos||agent.find("iPad")!=std::string::npos||agent.find("iPod")!=std::string::npos)&&
    agent.find("AppleWebKit")!=std::string::npos&&agent.find("CriOS")==std::string::npos;
}
bool Utils::isAndroidChrome(const std::string& agent){return agent.find("Android")!=std::string::npos&&agent.find("Chrome")!=std::string::npos;}
}
