#pragma once
#include "mv_engine.hpp"
#include <type_traits>
#include <stdexcept>
#include <utility>

namespace pmjs::mv {
struct RuntimeBoundObject : RuntimeObject {
  bool active = false;
  virtual const char* bindingType() const = 0;
};
struct BindingField {
  std::string name;
  std::function<Value(RuntimeBoundObject&)> get;
  std::function<void(RuntimeBoundObject&, const Value&)> set;
};
using BindingArgument = std::variant<Value, std::shared_ptr<RuntimeObject>>;
using BindingArguments = std::vector<BindingArgument>;
struct BindingMethod {
  std::string name;
  std::size_t arity;
  std::function<Value(RuntimeBoundObject&, const BindingArguments&)> invoke;
  std::vector<std::string> argumentKinds;
  std::vector<std::pair<std::string, std::size_t>> aliases;
};
struct ClassBinding {
  std::string name, parent, nativeType;
  std::function<std::shared_ptr<RuntimeBoundObject>()> create;
  std::vector<BindingField> fields;
  std::vector<BindingMethod> methods;
};

template<class T> T bindingArgument(const Value& value) {
  if constexpr (std::is_same_v<T, bool>) return value.boolean();
  else if constexpr (std::is_integral_v<T>) return static_cast<T>(value.integer());
  else if constexpr (std::is_floating_point_v<T>) return static_cast<T>(value.number());
  else if constexpr (std::is_same_v<T, std::string>) return value.text();
  else static_assert(std::is_same_v<T, void>, "binding argument type requires a conversion");
}
template<class Get> BindingField bindingField(std::string name, Get get) {
  using T = std::remove_reference_t<std::invoke_result_t<Get, RuntimeBoundObject&>>;
  return {std::move(name), [get](RuntimeBoundObject& object) { return Value(get(object)); },
    [get](RuntimeBoundObject& object, const Value& value) { get(object) = bindingArgument<T>(value); }};
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
template<class R, class... Args, class Get, class Method>
BindingMethod bindingMethodImpl(std::string name, Get get, Method method) {
  return {std::move(name), sizeof...(Args), [get, method](RuntimeBoundObject& object, const BindingArguments& values) {
    if (values.size() != sizeof...(Args)) throw std::invalid_argument("native method argument count differs");
    return invokeBinding<R, Args...>(method, get(object), values, std::index_sequence_for<Args...>{});
  }, { (BindingObjectArgument<std::decay_t<Args>>::value ? "object" : "value")... }, {}};
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
