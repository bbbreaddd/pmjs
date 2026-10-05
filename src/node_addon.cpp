#include "node_addon_internal.hpp"

namespace pmjs::addon {

void registerAssetMethods(napi_env env, napi_value exports);
void registerPreparedAssetBindings(napi_env env, napi_value exports);

napi_value init(napi_env env, napi_value exports) {
  registerRuntimeBindings(env, exports);
  registerPlatformBindings(env, exports);
  registerGraphicsBindings(env, exports);
  registerResourceBindings(env, exports);
  registerAssetMethods(env, exports);
  registerPreparedAssetBindings(env, exports);
  registerCanvasBindings(env, exports);
  registerDialogBindings(env, exports);
  registerMediaBindings(env, exports);
  registerEffectBindings(env, exports);
  return exports;
}

}  // namespace pmjs::addon
