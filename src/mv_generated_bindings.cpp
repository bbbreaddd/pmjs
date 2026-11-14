#include "mv_generated_bindings.hpp"
#include "mv_core_display.hpp"

namespace pmjs::mv {
bool GeneratedRuntimeObject::dispatchOverride(const std::string& method) {
  return dispatchValue(method).has_value();
}
std::optional<Value> GeneratedRuntimeObject::dispatchValue(const std::string& method, const Value::Array& arguments) {
  const auto owner=hooks.lock();
  return owner && owner->boundMethod ? owner->boundMethod(shared_from_this(),method,arguments) : std::optional<Value>{};
}
void GeneratedRuntimeObject::listen(const BindingEvent& event, std::uint32_t token) {
  const auto weak=weak_from_this();
  event.add(*this,[weak,token] {
    if (auto object=weak.lock()) if (auto owner=object->hooks.lock(); owner && owner->boundListener)
      owner->boundListener(object,token);
  });
}
void GeneratedRuntimeObject::clearListeners() {
  if (auto owner=hooks.lock(); owner && owner->boundListener) owner->boundListener(shared_from_this(),0);
}
std::shared_ptr<GeneratedRuntimeObject> GeneratedRuntimeObject::nativeLease() {
  ++nativeOwners_; active=true;
  auto self=shared_from_this();
  return {this,[self](GeneratedRuntimeObject*) { if (--self->nativeOwners_==0) self->active=false; }};
}
namespace {
Value audioBufferMetadata(const core::WebAudio& audio) {
  if (!audio.core::WebAudio::isReady()) return {};
  const auto frames=static_cast<double>(audio.bufferFrameCount());
  return Value::Object{{"length",frames}, {"sampleRate",48000}, {"duration",frames/48000}};
}
}

#define MV_BIND_OBJECT(Name, Native, Parent, ...) \
  class Bound##Name final : public Native, public GeneratedRuntimeObject { \
   public: \
    using NativeType = Native; using Self = Bound##Name; \
    Bound##Name() : Native(__VA_ARGS__) {} \
    const char* bindingType() const override { return #Name; }
#define MV_BIND_CLASS(Name, Native, Parent, ...) \
  MV_BIND_OBJECT(Name, Native, Parent, __VA_ARGS__) \
    std::shared_ptr<core::Container> displayObject() override { \
      return std::shared_ptr<core::Container>(shared_from_this(), static_cast<Native*>(this)); \
    }
#define MV_BIND_VOID(Name, Native) \
    void Native() override { if (!dispatchOverride(#Name)) NativeType::Native(); } \
    void base_##Native() { NativeType::Native(); }
#define MV_BIND_INITIALIZE(Native) \
    MV_BIND_VOID(initialize, Native) \
    void initializeNative() override { Native(); }
#define MV_BIND_INITIALIZE1(Native, Type, Parameter, Default) \
    void Native(Type Parameter) override { if (!dispatchValue("initialize",{Parameter})) NativeType::Native(Parameter); } \
    void base_##Native(Type Parameter) { NativeType::Native(Parameter); } \
    void initializeNative() override { Native(Default); }
#define MV_BIND_VOID1(Name, Native, Type, Parameter, Default) \
    void Native(Type Parameter) override { if (!dispatchValue(#Name,{Parameter})) NativeType::Native(Parameter); } \
    void base_##Native(Type Parameter) { NativeType::Native(Parameter); }
#define MV_BIND_VOID2(Name, Native, T1, P1, D1, T2, P2, D2) \
    void Native(T1 P1,T2 P2) override { if (!dispatchValue(#Name,{P1,P2})) NativeType::Native(P1,P2); } \
    void base_##Native(T1 P1,T2 P2) { NativeType::Native(P1,P2); }
#define MV_BIND_VALUE0(Name, Native, Type) \
    Type Native() const override { if (auto value=const_cast<Self*>(this)->dispatchValue(#Name)) return bindingArgument<Type>(*value); return NativeType::Native(); } \
    Type base_##Native() const { return NativeType::Native(); }
#define MV_BIND_RESET(Name, Native) \
    void Native() override { if (!dispatchOverride(#Name)) base_##Native(); } \
    void base_##Native() { NativeType::Native(); clearListeners(); }
#define MV_BIND_FIELD(Name, Native)
#define MV_BIND_POINT(Name, Native)
#define MV_BIND_DISPLAY(Name, Native)
#define MV_BIND_PROPERTY(Name, Native, Setter)
#define MV_BIND_READONLY(Name, Expression)
#define MV_BIND_EVENT(Name, Native)
#define MV_BIND_STATIC0(Name, Native, Type)
#define MV_BIND_STATIC1(Name, Native, Result, Arg, Default)
#define MV_BIND_END() };
#include "mv_binding_schema.def"
#undef MV_BIND_OBJECT
#undef MV_BIND_INITIALIZE1
#undef MV_BIND_VOID1
#undef MV_BIND_VOID2
#undef MV_BIND_VALUE0
#undef MV_BIND_RESET
#undef MV_BIND_PROPERTY
#undef MV_BIND_READONLY
#undef MV_BIND_EVENT
#undef MV_BIND_STATIC0
#undef MV_BIND_STATIC1
#undef MV_BIND_CLASS
#undef MV_BIND_VOID
#undef MV_BIND_INITIALIZE
#undef MV_BIND_FIELD
#undef MV_BIND_POINT
#undef MV_BIND_DISPLAY
#undef MV_BIND_END

std::vector<ClassBinding> generatedClassBindings() {
  std::vector<ClassBinding> result;
#define MV_BIND_CLASS(Name, Native, Parent, ...) \
  { using Type = Bound##Name; \
    const auto get = [](RuntimeBoundObject& object) -> Type& { return dynamic_cast<Type&>(object); }; \
    ClassBinding binding{#Name, #Parent, #Native, [] { return std::make_shared<Type>(); }, {}, {}}; \
    binding.generated = true;
#define MV_BIND_OBJECT(Name, Native, Parent, ...) MV_BIND_CLASS(Name, Native, Parent, __VA_ARGS__)
#define MV_BIND_VOID(Name, Native) binding.methods.push_back(bindingMethod(#Name, get, &Type::base_##Native));
#define MV_BIND_INITIALIZE(Native) \
    binding.initializer = "_initializeNative"; \
    binding.methods.push_back(bindingMethod("_initializeNative", get, &Type::base_##Native));
#define MV_BIND_INITIALIZE1(Native, TypeName, Parameter, Default) \
    binding.initializer="_initializeNative"; binding.constructorDefaults={Default}; \
    binding.methods.push_back(bindingMethod("_initializeNative",get,&Type::base_##Native));
#define MV_BIND_VOID1(Name, Native, Arg, Parameter, Default) \
    { auto method=bindingMethod(#Name,get,&Type::base_##Native); method.defaults={Default}; binding.methods.push_back(std::move(method)); }
#define MV_BIND_VOID2(Name, Native, T1, P1, D1, T2, P2, D2) \
    { auto method=bindingMethod(#Name,get,&Type::base_##Native); method.defaults={D1,D2}; binding.methods.push_back(std::move(method)); }
#define MV_BIND_VALUE0(Name, Native, Result) MV_BIND_VOID(Name,Native)
#define MV_BIND_RESET(Name, Native) MV_BIND_VOID(Name,Native)
#define MV_BIND_PROPERTY(Name, Native, Setter) \
    binding.fields.push_back(bindingProperty(#Name,[get](RuntimeBoundObject& object) { return get(object).Native; }, \
      [get](RuntimeBoundObject& object,auto value) { get(object).Setter(value); }));
#define MV_BIND_READONLY(Name, Expression) \
    binding.fields.push_back({#Name,[get](RuntimeBoundObject& object) -> Value { return Expression; },{}});
#define MV_BIND_EVENT(Name, Native) \
    binding.events.push_back({#Name,[get](RuntimeBoundObject& object,std::function<void()> callback) { get(object).Native(std::move(callback)); }});
#define MV_BIND_STATIC0(Name, Native, Result) \
    binding.statics.push_back({#Name,[](const Value::Array&) -> Value { return Type::NativeType::Native(); },{}});
#define MV_BIND_STATIC1(Name, Native, Result, Arg, Default) \
    binding.statics.push_back({#Name,[](const Value::Array& values) -> Value { \
      return invokeBindingStatic<Result>([](Arg value) -> Result { return Type::NativeType::Native(value); }, bindingArgument<Arg>(values.at(0))); },{Default}});
#define MV_BIND_FIELD(Name, Native) \
    binding.fields.push_back(bindingField(#Name, [get](RuntimeBoundObject& object) -> auto& { return get(object).Native; }));
#define MV_BIND_POINT(Name, Native) \
    binding.fields.push_back(bindingPoint(#Name, [get](RuntimeBoundObject& object) -> auto& { return get(object).Native; }));
#define MV_BIND_DISPLAY(Name, Native) \
    binding.displays.push_back(bindingDisplayField(#Name, [get](RuntimeBoundObject& object) -> auto& { return get(object).Native; }));
#define MV_BIND_END() result.push_back(std::move(binding)); }
#include "mv_binding_schema.def"
#undef MV_BIND_OBJECT
#undef MV_BIND_INITIALIZE1
#undef MV_BIND_VOID1
#undef MV_BIND_VOID2
#undef MV_BIND_VALUE0
#undef MV_BIND_RESET
#undef MV_BIND_PROPERTY
#undef MV_BIND_READONLY
#undef MV_BIND_EVENT
#undef MV_BIND_STATIC0
#undef MV_BIND_STATIC1
#undef MV_BIND_CLASS
#undef MV_BIND_VOID
#undef MV_BIND_INITIALIZE
#undef MV_BIND_FIELD
#undef MV_BIND_POINT
#undef MV_BIND_DISPLAY
#undef MV_BIND_END
  return result;
}

std::shared_ptr<GeneratedRuntimeObject> createGeneratedObject(const std::string& name, const std::shared_ptr<RuntimeHooks>& hooks) {
  static const auto classes = generatedClassBindings();
  for (const auto& binding : classes) if (binding.name == name) {
    auto object = std::dynamic_pointer_cast<GeneratedRuntimeObject>(binding.create());
    object->hooks = hooks; return object;
  }
  throw std::invalid_argument("generated native class is not bound: " + name);
}
std::shared_ptr<RuntimeBoundObject> Session::createGeneratedBinding(const std::string& name) {
  return createGeneratedObject(name, runtimeHooks_);
}
}
