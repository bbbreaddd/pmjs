#include <node_api.h>

namespace pmjs::addon {
napi_value init(napi_env env, napi_value exports);
}

NAPI_MODULE(NODE_GYP_MODULE_NAME, pmjs::addon::init)
