#pragma once
#include <node_api.h>
#include <chrono>
#include <map>
#include <string>
#include <vector>

namespace pmjs::addon::bridge_trace {
struct Record {std::string parent,name;std::uint64_t calls=0;double inclusive=0,exclusive=0;};
struct Scope;
inline thread_local bool active=false;
inline thread_local Scope* current=nullptr;
inline thread_local std::map<std::string,Record> records;
inline thread_local std::vector<napi_ref> functions;
struct Scope {
  Scope* parent=nullptr;
  Record* record=nullptr;
  std::chrono::steady_clock::time_point start;
  double children=0;
  explicit Scope(std::string name) {
    if(!active)return;
    parent=current;
    const auto caller=parent ? parent->record->name : "root";
    auto& row=records[caller+"\t"+name];row.parent=caller;row.name=std::move(name);record=&row;
    current=this;start=std::chrono::steady_clock::now();
  }
  ~Scope() {
    if(!record)return;
    const double elapsed=std::chrono::duration<double,std::milli>(std::chrono::steady_clock::now()-start).count();
    ++record->calls;record->inclusive+=elapsed;record->exclusive+=elapsed-children;
    current=parent;if(parent)parent->children+=elapsed;
  }
};
inline std::size_t functionId(napi_env env,napi_value function) {
  if(!active)return 0;
  for(std::size_t i=0;i<functions.size();++i) {
    napi_value candidate;bool same=false;napi_get_reference_value(env,functions[i],&candidate);
    napi_strict_equals(env,function,candidate,&same);if(same)return i+1;
  }
  napi_ref reference;napi_create_reference(env,function,1,&reference);functions.push_back(reference);return functions.size();
}
inline void reset(napi_env env) {
  for(auto ref:functions)napi_delete_reference(env,ref);
  functions.clear();records.clear();
}
}
