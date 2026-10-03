set(pmjs_skia65_local_default OFF)
if(CMAKE_SYSTEM_NAME STREQUAL "Linux" AND CMAKE_SYSTEM_PROCESSOR MATCHES "^(x86_64|amd64|AMD64)$")
  set(pmjs_skia65_local_default ON)
endif()
option(PMJS_ENABLE_SKIA65 "Link the shared Skia65 text backend" ${pmjs_skia65_local_default})
set(pmjs_skia65_default OFF)
if(PMJS_ENABLE_SKIA65 AND pmjs_skia65_local_default)
  set(pmjs_skia65_default ON)
endif()
option(PMJS_SKIA65_DEFAULT "Select Skia65 by default on local x64 builds" ${pmjs_skia65_default})
option(PMJS_BUILD_SKIA65_PROBE "Build the checksum-pinned private Skia65 component" ${PMJS_ENABLE_SKIA65})
set(PMJS_SKIA65_ARM64_SDK "" CACHE PATH "Prepared portable SDK for the Skia65 ARM64 probe")
if(PMJS_BUILD_SKIA65_PROBE)
  find_package(Python3 REQUIRED COMPONENTS Interpreter)
  set(pmjs_skia65_arch x64)
  set(pmjs_skia65_sdk_args "")
  if(CMAKE_SYSTEM_PROCESSOR MATCHES "^(aarch64|arm64)$")
    set(pmjs_skia65_arch arm64)
    if(NOT PMJS_SKIA65_ARM64_SDK)
      message(FATAL_ERROR "The ARM64 Skia65 probe requires PMJS_SKIA65_ARM64_SDK")
    endif()
    list(APPEND pmjs_skia65_sdk_args --sdk "${PMJS_SKIA65_ARM64_SDK}")
  endif()
  set(pmjs_skia65_sources
    "${CMAKE_CURRENT_SOURCE_DIR}/src/skia65/CMakeLists.txt"
    "${CMAKE_CURRENT_SOURCE_DIR}/src/skia65/exports.map"
    "${CMAKE_CURRENT_SOURCE_DIR}/src/skia65/pmjs_skia65.cpp"
    "${CMAKE_CURRENT_SOURCE_DIR}/src/skia65/pmjs_skia65.h"
    "${CMAKE_CURRENT_SOURCE_DIR}/tools/skia65/build.py"
    "${CMAKE_CURRENT_SOURCE_DIR}/tools/skia65/provision.py"
    "${CMAKE_CURRENT_SOURCE_DIR}/tools/skia65/sources.lock.json")
  set(pmjs_skia65_outputs
    "${CMAKE_CURRENT_SOURCE_DIR}/build-skia65/${pmjs_skia65_arch}/libpmjs-skia65.so"
    "${CMAKE_CURRENT_SOURCE_DIR}/build-skia65/${pmjs_skia65_arch}/manifest.json")
  add_custom_command(OUTPUT ${pmjs_skia65_outputs}
    COMMAND "${Python3_EXECUTABLE}" "${CMAKE_CURRENT_SOURCE_DIR}/tools/skia65/build.py"
      --arch "${pmjs_skia65_arch}" ${pmjs_skia65_sdk_args}
    DEPENDS ${pmjs_skia65_sources}
      "${CMAKE_CURRENT_SOURCE_DIR}/src/text_layout.cpp"
      "${CMAKE_CURRENT_SOURCE_DIR}/src/text_layout.hpp"
      "${CMAKE_CURRENT_SOURCE_DIR}/src/unicode_default_ignorables.hpp"
    USES_TERMINAL VERBATIM)
  add_custom_target(pmjs_skia65_probe DEPENDS ${pmjs_skia65_outputs})
endif()

if(PMJS_ENABLE_SKIA65)
  set(pmjs_skia65_arch x64)
  if(CMAKE_SYSTEM_PROCESSOR MATCHES "^(aarch64|arm64)$")
    set(pmjs_skia65_arch arm64)
  endif()
  set(pmjs_skia65_library "${CMAKE_CURRENT_SOURCE_DIR}/build-skia65/${pmjs_skia65_arch}/libpmjs-skia65.so")
  if(NOT EXISTS "${pmjs_skia65_library}" AND NOT PMJS_BUILD_SKIA65_PROBE)
    message(FATAL_ERROR "Build the checksum-pinned Skia65 component with tools/skia65/build.py first")
  endif()
  add_library(pmjs_skia65 SHARED IMPORTED)
  set_target_properties(pmjs_skia65 PROPERTIES IMPORTED_LOCATION "${pmjs_skia65_library}")
  if(PMJS_BUILD_SKIA65_PROBE)
    add_dependencies(pmjs_skia65 pmjs_skia65_probe)
  endif()
endif()
if(PMJS_SKIA65_DEFAULT AND NOT PMJS_ENABLE_SKIA65)
  message(FATAL_ERROR "PMJS_SKIA65_DEFAULT requires PMJS_ENABLE_SKIA65")
endif()
