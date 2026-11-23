#include <asm/hwcap.h>
#include <cstdlib>
#include <dlfcn.h>
#include <sys/auxv.h>

// Exercise portable hashing on crypto-capable processors without changing
// discovery of other CPU capabilities used by the linked libraries.
extern "C" unsigned long getauxval(unsigned long type) noexcept {
  using GetAuxval = unsigned long (*)(unsigned long);
  static const auto original = reinterpret_cast<GetAuxval>(dlsym(RTLD_NEXT, "getauxval"));
  if (!original) std::abort();
  const auto value = original(type);
  return type == AT_HWCAP ? value & ~static_cast<unsigned long>(HWCAP_SHA2) : value;
}
