#pragma once
#include "mv_class_bindings.hpp"

namespace pmjs::mv {
struct GeneratedRuntimeObject : RuntimeBoundObject, std::enable_shared_from_this<GeneratedRuntimeObject> {
  std::weak_ptr<RuntimeHooks> hooks;
  bool dispatchOverride(const std::string& method);
  std::optional<Value> dispatchValue(const std::string& method, const Value::Array& arguments = {});
  void listen(const BindingEvent& event, std::uint32_t token);
  void clearListeners();
  std::shared_ptr<GeneratedRuntimeObject> nativeLease();
  Session* context = nullptr;
  Session& checkedSession() const;
  std::shared_ptr<core::PixelBitmap> bitmap(const std::string& method,const Value::Array& arguments,const std::string& slot);
  bool dispatchObject(const std::string& method,const std::shared_ptr<RuntimeObject>& argument);
  virtual void initializeNative() = 0;
 private:
  std::size_t nativeOwners_ = 0;
};
std::vector<ClassBinding> generatedClassBindings();
std::shared_ptr<GeneratedRuntimeObject> createGeneratedObject(const std::string& name, const std::shared_ptr<RuntimeHooks>& hooks);
}
