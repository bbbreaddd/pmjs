#include "mv_core_utils.hpp"
#include <cmath>
#include <stdexcept>

namespace pmjs::mv::core {
bool strictEquals(const JsonNode::Ptr& left,const JsonNode::Ptr& right) {
  if(!left||!right)return !left&&!right;
  if(left->data.index()!=right->data.index())return false;
  if(std::holds_alternative<std::monostate>(left->data)||std::holds_alternative<Value::Undefined>(left->data))return true;
  if(const auto* number=std::get_if<double>(&left->data))return *number==std::get<double>(right->data);
  if(const auto* text=std::get_if<std::string>(&left->data))return *text==std::get<std::string>(right->data);
  if(const auto* boolean=std::get_if<bool>(&left->data))return *boolean==std::get<bool>(right->data);
  return left.get()==right.get();
}
namespace {
bool equals(const JsonNode::Array& left,const JsonNode::Array& right,unsigned depth) {
  if(depth>128)throw std::range_error("array equality nesting limit exceeded");
  if(left.size()!=right.size())return false;
  for(std::size_t i=0;i<left.size();++i) {
    const auto* a=left[i]?std::get_if<JsonNode::Array>(&left[i]->data):nullptr;
    const auto* b=right[i]?std::get_if<JsonNode::Array>(&right[i]->data):nullptr;
    if(a&&b){if(!equals(*a,*b,depth+1))return false;}
    else if(!strictEquals(left[i],right[i]))return false;
  }return true;
}
}
bool graphArrayEquals(const JsonNode::Array& left,const JsonNode::Array& right){return equals(left,right,0);}
bool graphArrayContains(const JsonNode::Array& values,const JsonNode::Ptr& value){for(const auto& entry:values)if(strictEquals(entry,value))return true;return false;}
}
