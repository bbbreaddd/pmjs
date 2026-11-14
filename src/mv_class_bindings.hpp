#pragma once
#include "mv_engine.hpp"
#include "mv_core_audio_graphics.hpp"
#include <type_traits>
#include <stdexcept>
#include <utility>

namespace pmjs::mv {
struct RuntimeBoundObject : RuntimeObject {
  bool active = false;
  virtual const char* bindingType() const = 0;
  virtual std::shared_ptr<core::Container> displayObject() { return {}; }
};
struct BindingField {
  std::string name;
  std::function<Value(RuntimeBoundObject&)> get;
  std::function<void(RuntimeBoundObject&, const Value&)> set;
  std::string kind = "value";
};
struct BindingDisplayField {
  std::string name;
  std::function<std::shared_ptr<core::Container>(RuntimeBoundObject&)> get;
  std::function<void(RuntimeBoundObject&, std::shared_ptr<core::Container>)> set;
};
struct BindingDisplayListField {
  std::string name;
  std::function<std::vector<std::shared_ptr<core::Container>>&(RuntimeBoundObject&)> items;
};
struct BindingReferenceField {
  std::string name;
  std::function<std::shared_ptr<RuntimeObject>(RuntimeBoundObject&)> get;
  std::function<void(RuntimeBoundObject&,std::shared_ptr<RuntimeObject>)> set;
};
using BindingArgument = std::variant<Value, std::shared_ptr<RuntimeObject>>;
using BindingArguments = std::vector<BindingArgument>;
struct BindingMethod {
  std::string name;
  std::size_t arity;
  std::function<Value(RuntimeBoundObject&, const BindingArguments&)> invoke;
  std::vector<std::string> argumentKinds;
  std::vector<std::pair<std::string, std::size_t>> aliases;
  bool returnsValue = true;
  Value::Array defaults{};
  bool inherited = false;
};
struct BindingEvent {
  std::string name;
  std::function<void(RuntimeBoundObject&, std::function<void()>)> add;
};
struct BindingStatic {
  std::string name;
  std::function<Value(const Value::Array&)> invoke;
  Value::Array defaults;
};
struct ClassBinding {
  std::string name, parent, nativeType;
  std::function<std::shared_ptr<RuntimeBoundObject>()> create;
  std::vector<BindingField> fields;
  std::vector<BindingMethod> methods;
  std::string initializer{};
  Value::Array constructorDefaults{};
  std::vector<BindingDisplayField> displays{};
  std::vector<BindingDisplayListField> displayLists{};
  bool generated = false;
  std::vector<BindingEvent> events{};
  std::vector<BindingStatic> statics{};
  std::vector<BindingReferenceField> references{};
};

template<class T> T bindingArgument(const Value& value) {
  if constexpr (std::is_same_v<T, Value>) return value.reference();
  else if constexpr (std::is_same_v<T, bool>) return value.boolean();
  else if constexpr (std::is_integral_v<T>) return static_cast<T>(value.integer());
  else if constexpr (std::is_floating_point_v<T>) return static_cast<T>(value.number());
  else if constexpr (std::is_same_v<T, std::string>) return value.text();
  else if constexpr (std::is_same_v<T, std::vector<std::uint8_t>>) {
    T result;result.reserve(value.arrayLength());for(const auto& item:value.array())result.push_back(static_cast<std::uint8_t>(item.integer()));return result;
  }
  else if constexpr (std::is_same_v<T,core::AudioResponse>) {
    return {bindingArgument<std::vector<std::uint8_t>>(value["response"]),value["responseURL"].text(),value["status"].integer(200)};
  }
  else static_assert(std::is_same_v<T, void>, "binding argument type requires a conversion");
}
template<class T> Value bindingValue(const T& value) {return Value(value);}
inline Value bindingValue(const std::vector<std::uint8_t>& bytes) {
  Value::Array result;result.reserve(bytes.size());for(auto byte:bytes)result.emplace_back(int(byte));return result;
}
inline Value bindingValue(const core::AudioResponse& response) {
  return Value::Object{{"response",bindingValue(response.response)},{"responseURL",response.responseURL},{"status",response.status}};
}
template<class Result, class Function, class... Args> Value invokeBindingStatic(Function function, Args... args) {
  if constexpr (std::is_void_v<Result>) { function(args...); return Value::undefined(); }
  else return Value(function(args...));
}
template<class Get> BindingField bindingField(std::string name, Get get) {
  using T = std::remove_reference_t<std::invoke_result_t<Get, RuntimeBoundObject&>>;
  return {std::move(name), [get](RuntimeBoundObject& object) {
    if constexpr (std::is_same_v<T, Value>) return get(object).reference();
    else return Value(get(object));
  },
    [get](RuntimeBoundObject& object, const Value& value) { get(object) = bindingArgument<T>(value); }};
}
template<class Get> BindingField bindingPoint(std::string name, Get get) {
  return {std::move(name), [get](RuntimeBoundObject& object) {
    const auto& point = get(object); return Value::Object{{"x", point.x}, {"y", point.y}};
  }, [get](RuntimeBoundObject& object, const Value& value) {
    get(object) = {value["x"].number(), value["y"].number()};
  }, "point"};
}
template<class Get, class Set> BindingField bindingProperty(std::string name, Get get, Set set) {
  using T = std::remove_cvref_t<std::invoke_result_t<Get, RuntimeBoundObject&>>;
  return {std::move(name), [get](RuntimeBoundObject& object) { return Value(get(object)); },
    [set](RuntimeBoundObject& object, const Value& value) { set(object, bindingArgument<T>(value)); }};
}
template<class Get> BindingDisplayField bindingDisplayField(std::string name, Get get) {
  using Pointer = std::remove_reference_t<std::invoke_result_t<Get, RuntimeBoundObject&>>;
  return {std::move(name), [get](RuntimeBoundObject& object) { return get(object); },
    [get](RuntimeBoundObject& object, std::shared_ptr<core::Container> value) {
      auto typed = std::dynamic_pointer_cast<typename Pointer::element_type>(value);
      if (value && !typed) throw std::invalid_argument("display field has the wrong native type");
      get(object) = std::move(typed);
    }};
}
template<class Get> BindingDisplayListField bindingDisplayList(std::string name,Get get) {
  return {std::move(name),[get](RuntimeBoundObject& object) -> std::vector<std::shared_ptr<core::Container>>& { return get(object); }};
}
template<class Get> BindingReferenceField bindingReference(std::string name,Get get) {
  using Pointer=std::remove_reference_t<std::invoke_result_t<Get,RuntimeBoundObject&>>;
  return {std::move(name),[get](RuntimeBoundObject& object) { return get(object); },
    [get](RuntimeBoundObject& object,std::shared_ptr<RuntimeObject> value) {
      auto typed=std::dynamic_pointer_cast<typename Pointer::element_type>(value);
      if (value && !typed) throw std::invalid_argument("reference field has the wrong native type"); get(object)=std::move(typed);
    }};
}
template<class T> struct BindingObjectArgument : std::false_type {};
template<class T> struct BindingObjectArgument<std::shared_ptr<T>> : std::is_base_of<RuntimeObject, T> {};
template<class T> T bindingMethodArgument(const BindingArgument& argument) {
  if constexpr (BindingObjectArgument<T>::value) {
    const auto& object = std::get<std::shared_ptr<RuntimeObject>>(argument);
    if (!object) return {};
    auto result = std::dynamic_pointer_cast<typename T::element_type>(object);
    if (!result) throw std::invalid_argument("native object argument has the wrong type");
    return result;
  } else return bindingArgument<T>(std::get<Value>(argument));
}
template<class R, class... Args, class Method, class State, std::size_t... I>
Value invokeBinding(Method method, State& state, const BindingArguments& values, std::index_sequence<I...>) {
  if constexpr (std::is_void_v<R>) {
    std::invoke(method, state, bindingMethodArgument<std::decay_t<Args>>(values[I])...);
    return Value::undefined();
  } else return Value(std::invoke(method, state, bindingMethodArgument<std::decay_t<Args>>(values[I])...));
}
template<class R, class... Args> BindingMethod bindingFunction(std::string name,R(*function)(RuntimeBoundObject&,Args...)) {
  return {std::move(name),sizeof...(Args),[function](RuntimeBoundObject& object,const BindingArguments& values) {
    if (values.size()!=sizeof...(Args)) throw std::invalid_argument("native function argument count differs");
    return invokeBinding<R,Args...>(function,object,values,std::index_sequence_for<Args...>{});
  },{(BindingObjectArgument<std::decay_t<Args>>::value ? "object" : std::is_same_v<std::decay_t<Args>,std::vector<std::uint8_t>> ? "bytes" : std::is_same_v<std::decay_t<Args>,core::AudioResponse> ? "xhr" : "value")...},{},!std::is_void_v<R>};
}
template<class R, class... Args, class Get, class Method>
BindingMethod bindingMethodImpl(std::string name, Get get, Method method) {
  return {std::move(name), sizeof...(Args), [get, method](RuntimeBoundObject& object, const BindingArguments& values) {
    if (values.size() != sizeof...(Args)) throw std::invalid_argument("native method argument count differs");
    return invokeBinding<R, Args...>(method, get(object), values, std::index_sequence_for<Args...>{});
  }, { (BindingObjectArgument<std::decay_t<Args>>::value ? "object" : std::is_same_v<std::decay_t<Args>,std::vector<std::uint8_t>> ? "bytes" : std::is_same_v<std::decay_t<Args>,core::AudioResponse> ? "xhr" : "value")... }, {}, !std::is_void_v<R>};
}
template<class Get, class Owner, class R, class... Args>
BindingMethod bindingMethod(std::string name, Get get, R (Owner::*method)(Args...)) {
  return bindingMethodImpl<R, Args...>(std::move(name), get, method);
}
template<class Get, class Owner, class R, class... Args>
BindingMethod bindingMethod(std::string name, Get get, R (Owner::*method)(Args...) const) {
  return bindingMethodImpl<R, Args...>(std::move(name), get, method);
}
}
