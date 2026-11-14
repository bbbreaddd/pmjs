#pragma once
#include "mv_windows.hpp"

namespace pmjs::mv {
struct WindowBinding {
  std::string name,parent;
  int arguments=0;
  std::vector<std::string> fields;
  bool selectable=false,command=false,data=false;
  std::function<std::shared_ptr<Window_Base>(Session&,const Value::Array&)> create;
  std::function<Value(Window_Base&,Session&,const std::string&,const Value::Array&)> invoke;
};
const std::vector<WindowBinding>& windowBindings();
}
