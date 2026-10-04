set(pmjs_skia65_supported_default OFF)
if(CMAKE_SYSTEM_NAME STREQUAL "Linux" AND CMAKE_SYSTEM_PROCESSOR MATCHES "^(aarch64|arm64|x86_64|amd64|AMD64)$")
  set(pmjs_skia65_supported_default ON)
endif()
option(PMJS_ENABLE_SKIA65 "Link the shared Skia65 text backend" ${pmjs_skia65_supported_default})
option(PMJS_BUILD_SKIA65_COMPONENT "Build the checksum-pinned private Skia65 component" ${PMJS_ENABLE_SKIA65})
set(PMJS_SKIA65_ARM64_SDK "" CACHE PATH "Prepared portable SDK for the Skia65 ARM64 component")
set(PMJS_SKIA65_COMPONENT_DIR "${CMAKE_CURRENT_BINARY_DIR}/skia65" CACHE PATH "Private Skia65 artifact directory")
if(PMJS_ENABLE_SKIA65 OR PMJS_BUILD_SKIA65_COMPONENT)
  find_package(Python3 REQUIRED COMPONENTS Interpreter)
  set(pmjs_skia65_arch x64)
  set(pmjs_skia65_sdk_args "")
  if(CMAKE_SYSTEM_PROCESSOR MATCHES "^(aarch64|arm64)$")
    set(pmjs_skia65_arch arm64)
    if(PMJS_BUILD_SKIA65_COMPONENT AND NOT PMJS_SKIA65_ARM64_SDK)
      message(FATAL_ERROR "The ARM64 Skia65 component requires PMJS_SKIA65_ARM64_SDK")
    endif()
    if(PMJS_SKIA65_ARM64_SDK)
      list(APPEND pmjs_skia65_sdk_args --sdk "${PMJS_SKIA65_ARM64_SDK}")
    endif()
  endif()
  set(pmjs_skia65_sources
    "${CMAKE_CURRENT_SOURCE_DIR}/src/skia65/CMakeLists.txt"
    "${CMAKE_CURRENT_SOURCE_DIR}/src/skia65/pinned_sources.cmake"
    "${CMAKE_CURRENT_SOURCE_DIR}/src/skia65/exports.map"
    "${CMAKE_CURRENT_SOURCE_DIR}/src/skia65/pmjs_skia65.cpp"
    "${CMAKE_CURRENT_SOURCE_DIR}/src/skia65/pmjs_skia65.h"
    "${CMAKE_CURRENT_SOURCE_DIR}/src/skia65/mask_test.cpp"
    "${CMAKE_CURRENT_SOURCE_DIR}/src/skia65/raster_test.cpp"
    "${CMAKE_CURRENT_SOURCE_DIR}/third_party/skia65-mask-tail.patch"
    "${CMAKE_CURRENT_SOURCE_DIR}/third_party/skia65-arm-parity.patch"
    "${CMAKE_CURRENT_SOURCE_DIR}/tools/skia65/build.py"
    "${CMAKE_CURRENT_SOURCE_DIR}/tools/skia65/artifact.py"
    "${CMAKE_CURRENT_SOURCE_DIR}/tools/skia65/component_sources.py"
    "${CMAKE_CURRENT_SOURCE_DIR}/tools/skia65/provision.py"
    "${CMAKE_CURRENT_SOURCE_DIR}/tools/skia65/sources.lock.json"
    "${CMAKE_CURRENT_SOURCE_DIR}/src/text_layout.cpp"
    "${CMAKE_CURRENT_SOURCE_DIR}/src/text_layout.hpp"
    "${CMAKE_CURRENT_SOURCE_DIR}/src/unicode_default_ignorables.hpp")
  set(pmjs_skia65_library "${PMJS_SKIA65_COMPONENT_DIR}/libpmjs-skia65.so")
  set(pmjs_skia65_command "${Python3_EXECUTABLE}" "${CMAKE_CURRENT_SOURCE_DIR}/tools/skia65/build.py"
    --arch "${pmjs_skia65_arch}" --output "${PMJS_SKIA65_COMPONENT_DIR}")
  if(PMJS_BUILD_SKIA65_COMPONENT)
    add_custom_target(pmjs_skia65_component
      COMMAND ${pmjs_skia65_command} --reuse ${pmjs_skia65_sdk_args}
      BYPRODUCTS "${pmjs_skia65_library}" "${PMJS_SKIA65_COMPONENT_DIR}/manifest.json"
      DEPENDS ${pmjs_skia65_sources}
      USES_TERMINAL VERBATIM)
  else()
    execute_process(COMMAND ${pmjs_skia65_command} --verify
      RESULT_VARIABLE pmjs_skia65_validation ERROR_VARIABLE pmjs_skia65_error)
    if(NOT pmjs_skia65_validation EQUAL 0)
      message(FATAL_ERROR "${pmjs_skia65_error}")
    endif()
    add_custom_target(pmjs_skia65_component
      COMMAND ${pmjs_skia65_command} --verify
      DEPENDS ${pmjs_skia65_sources} USES_TERMINAL VERBATIM)
  endif()
  if(PMJS_ENABLE_SKIA65)
    add_library(pmjs_skia65 SHARED IMPORTED)
    set_target_properties(pmjs_skia65 PROPERTIES IMPORTED_LOCATION "${pmjs_skia65_library}")
    add_dependencies(pmjs_skia65 pmjs_skia65_component)
  endif()
endif()
