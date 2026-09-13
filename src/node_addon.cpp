#include "node_addon_internal.hpp"

namespace pmjs::addon {

napi_value init(napi_env env, napi_value exports) {
  registerRuntimeBindings(env, exports);
  registerPlatformBindings(env, exports);
  registerGraphicsBindings(env, exports);
  registerResourceBindings(env, exports);
  registerCanvasBindings(env, exports);
  registerMediaBindings(env, exports);
  return exports;
}

}  // namespace pmjs::addon
