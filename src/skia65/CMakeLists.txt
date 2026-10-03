cmake_minimum_required(VERSION 3.20)
project(pmjs_skia65 LANGUAGES C CXX ASM)
set(CMAKE_POSITION_INDEPENDENT_CODE ON)
set(CMAKE_CXX_STANDARD 20)
set(CMAKE_CXX_VISIBILITY_PRESET hidden)
set(CMAKE_C_VISIBILITY_PRESET hidden)
set(CMAKE_VISIBILITY_INLINES_HIDDEN ON)
set(PMJS_SKIA65_SOURCE_ROOT "" CACHE PATH "Checksum-provisioned Skia65 source root")
set(PMJS_SKIA65_ARCHIVE "" CACHE FILEPATH "CPU-only Skia archive")
if(NOT EXISTS "${PMJS_SKIA65_ARCHIVE}" OR NOT EXISTS "${PMJS_SKIA65_SOURCE_ROOT}/provision.json")
  message(FATAL_ERROR "Run tools/skia65/build.py before configuring the Skia65 text component")
endif()

set(ft "${PMJS_SKIA65_SOURCE_ROOT}/freetype")
set(chromium "${PMJS_SKIA65_SOURCE_ROOT}/chromium")
set(hb "${chromium}/third_party/harfbuzz-ng/src")
set(skia "${PMJS_SKIA65_SOURCE_ROOT}/skia")
set(icu "${PMJS_SKIA65_SOURCE_ROOT}/icu")

# Keep Chromium's module selection and HarfBuzz autohinting. Embedded PNG
# glyph decoding is excluded along with the raster component's other codecs.
file(MAKE_DIRECTORY "${CMAKE_CURRENT_BINARY_DIR}/include/freetype-custom-config")
file(READ "${chromium}/third_party/freetype/include/freetype-custom-config/ftoption.h" ftOptions)
string(REGEX MATCHALL "#define FT_CONFIG_OPTION_USE_PNG" pngOptions "${ftOptions}")
list(LENGTH pngOptions pngOptionCount)
if(NOT pngOptionCount EQUAL 1)
  message(FATAL_ERROR "Pinned FreeType adaptation no longer matches ${chromium}/third_party/freetype/include/freetype-custom-config/ftoption.h: expected one FT_CONFIG_OPTION_USE_PNG definition")
endif()
string(REPLACE "#define FT_CONFIG_OPTION_USE_PNG" "/* PNG glyph decoding disabled */" ftOptions "${ftOptions}")
file(CONFIGURE OUTPUT "${CMAKE_CURRENT_BINARY_DIR}/include/freetype-custom-config/ftoption.h" CONTENT "${ftOptions}" @ONLY)
file(READ "${chromium}/third_party/freetype/BUILD.gn" ftBuild)
string(REGEX MATCHALL "\"src/src/[^\"]+\\.c\"" ftEntries "${ftBuild}")
set(ftSources "${ft}/builds/unix/ftsystem.c")
foreach(entry IN LISTS ftEntries)
  string(REGEX REPLACE "^\"src/(.*)\"$" "\\1" relative "${entry}")
  if(NOT relative STREQUAL "src/base/ftsystem.c")
    list(APPEND ftSources "${ft}/${relative}")
  endif()
endforeach()
file(READ "${chromium}/third_party/harfbuzz-ng/BUILD.gn" hbBuild)
string(REGEX MATCHALL "\"src/[^\"]+\\.cc\"" hbEntries "${hbBuild}")
set(hbSources "")
foreach(entry IN LISTS hbEntries)
  string(REGEX REPLACE "^\"src/(.*)\"$" "\\1" relative "${entry}")
  if(NOT relative MATCHES "^hb-(glib|coretext)\\.cc$")
    list(APPEND hbSources "${hb}/${relative}")
  endif()
endforeach()
list(REMOVE_DUPLICATES ftSources)
list(REMOVE_DUPLICATES hbSources)

file(READ "${icu}/BUILD.gn" icuBuild)
string(REGEX MATCHALL "\"source/common/[^\"]+\\.(c|cpp)\"" icuEntries "${icuBuild}")
set(icuSources "")
foreach(entry IN LISTS icuEntries)
  string(REPLACE "\"" "" relative "${entry}")
  list(APPEND icuSources "${icu}/${relative}")
endforeach()
list(REMOVE_DUPLICATES icuSources)
file(CONFIGURE OUTPUT "${CMAKE_CURRENT_BINARY_DIR}/icu-data.S" CONTENT
  ".section .rodata\n.balign 16\n.global icudt60_dat\n.hidden icudt60_dat\nicudt60_dat:\n.incbin \"${icu}/common/icudtl.dat\"\n.section .note.GNU-stack,\"\",@progbits\n" @ONLY)
add_library(pmjs-skia65 SHARED pmjs_skia65.cpp ../text_layout.cpp
  ${ftSources} ${hbSources} ${icuSources} "${CMAKE_CURRENT_BINARY_DIR}/icu-data.S")
target_include_directories(pmjs-skia65 PRIVATE
  "${CMAKE_CURRENT_BINARY_DIR}/include" ..)
target_include_directories(pmjs-skia65 SYSTEM PRIVATE
  "${chromium}/third_party/freetype/include"
  "${chromium}/third_party/freetype/include/freetype-custom-config"
  "${ft}/include" "${hb}" "${skia}/include/core" "${skia}/include/ports"
  "${skia}/include/config" "${skia}/include/gpu" "${icu}/source/common" "${icu}/source/i18n")
target_compile_definitions(pmjs-skia65 PRIVATE
  FT2_BUILD_LIBRARY PDFIUM_REQUIRED_MODULES CHROMIUM_RESTRICT_VISIBILITY
  HAVE_UNISTD_H HAVE_FCNTL_H HAVE_OT HAVE_INTEL_ATOMIC_PRIMITIVES HAVE_ICU HAVE_ICU_BUILTIN
  U_COMMON_IMPLEMENTATION U_STATIC_IMPLEMENTATION U_ENABLE_DYLOAD=0 HAVE_DLOPEN=0
  U_USING_ICU_NAMESPACE=0 U_CHARSET_IS_UTF8=1 UCONFIG_ONLY_HTML_CONVERSION=1 UCHAR_TYPE=uint16_t
  FT_CONFIG_CONFIG_H="freetype-custom-config/ftconfig.h"
  FT_CONFIG_MODULES_H="freetype-custom-config/ftmodule.h"
  FT_CONFIG_OPTIONS_H="freetype-custom-config/ftoption.h"
  SK_SUPPORT_GPU=0 SK_SAMPLES_FOR_X _LIBCPP_ENABLE_CXX20_REMOVED_TYPE_TRAITS)
set_source_files_properties(${ftSources} ${hbSources} ${icuSources}
  PROPERTIES COMPILE_OPTIONS "-w")
target_compile_options(pmjs-skia65 PRIVATE -Wall -Wextra -Wpedantic -Wshadow
  $<$<COMPILE_LANGUAGE:CXX>:-fno-char8_t>)
target_link_libraries(pmjs-skia65 PRIVATE "${PMJS_SKIA65_ARCHIVE}" pthread dl m)
target_link_options(pmjs-skia65 PRIVATE
  "LINKER:--version-script,${CMAKE_CURRENT_SOURCE_DIR}/exports.map" "LINKER:-z,defs")
set_target_properties(pmjs-skia65 PROPERTIES OUTPUT_NAME pmjs-skia65
  LINK_DEPENDS "${CMAKE_CURRENT_SOURCE_DIR}/exports.map")
