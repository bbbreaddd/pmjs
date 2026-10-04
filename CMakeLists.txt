cmake_minimum_required(VERSION 3.20)
project(pmjs_native_runtime LANGUAGES C CXX)

set(CMAKE_C_STANDARD 11)
set(CMAKE_CXX_STANDARD 20)
set(CMAKE_CXX_STANDARD_REQUIRED ON)
set(CMAKE_POSITION_INDEPENDENT_CODE ON)
set(PMJS_DEPENDENCY_PREFIX "" CACHE PATH "Prefix containing target runtime dependencies")
set(PMJS_DEPENDENCY_LOCK "" CACHE FILEPATH "CMake file with exact target pkg-config versions")

if(PMJS_DEPENDENCY_PREFIX AND NOT PMJS_DEPENDENCY_LOCK)
  message(FATAL_ERROR "PMJS_DEPENDENCY_PREFIX requires PMJS_DEPENDENCY_LOCK")
endif()

find_package(PkgConfig REQUIRED)
if(PMJS_DEPENDENCY_PREFIX)
  if(NOT IS_DIRECTORY "${PMJS_DEPENDENCY_PREFIX}")
    message(FATAL_ERROR "PMJS_DEPENDENCY_PREFIX does not exist: ${PMJS_DEPENDENCY_PREFIX}")
  endif()
  set(ENV{PKG_CONFIG_PATH} "")
  set(ENV{PKG_CONFIG_LIBDIR} "${PMJS_DEPENDENCY_PREFIX}/lib/pkgconfig:${PMJS_DEPENDENCY_PREFIX}/share/pkgconfig")
endif()
pkg_check_modules(SDL2 REQUIRED IMPORTED_TARGET sdl2)
pkg_check_modules(EGL REQUIRED IMPORTED_TARGET egl)
pkg_check_modules(GLES REQUIRED IMPORTED_TARGET glesv2)
pkg_check_modules(PNG REQUIRED IMPORTED_TARGET libpng)
pkg_check_modules(JPEG REQUIRED IMPORTED_TARGET libjpeg)
pkg_check_modules(FREETYPE REQUIRED IMPORTED_TARGET freetype2)
pkg_check_modules(HARFBUZZ REQUIRED IMPORTED_TARGET harfbuzz)
pkg_check_modules(AVFORMAT REQUIRED IMPORTED_TARGET libavformat)
pkg_check_modules(AVCODEC REQUIRED IMPORTED_TARGET libavcodec)
pkg_check_modules(AVUTIL REQUIRED IMPORTED_TARGET libavutil)
pkg_check_modules(SWRESAMPLE REQUIRED IMPORTED_TARGET libswresample)
pkg_check_modules(SWSCALE REQUIRED IMPORTED_TARGET libswscale)

if(PMJS_DEPENDENCY_LOCK)
  if(NOT EXISTS "${PMJS_DEPENDENCY_LOCK}")
    message(FATAL_ERROR "PMJS_DEPENDENCY_LOCK does not exist: ${PMJS_DEPENDENCY_LOCK}")
  endif()
  include("${PMJS_DEPENDENCY_LOCK}")
  foreach(dependency IN ITEMS SDL2 EGL GLES PNG JPEG FREETYPE HARFBUZZ AVFORMAT AVCODEC AVUTIL SWRESAMPLE SWSCALE)
    set(lockVariable "PMJS_LOCK_${dependency}")
    if(NOT DEFINED ${lockVariable} OR NOT "${${lockVariable}}" STREQUAL "${${dependency}_VERSION}")
      message(FATAL_ERROR "${dependency} pkg-config version ${${dependency}_VERSION} does not match ${lockVariable}=${${lockVariable}}")
    endif()
  endforeach()
endif()

message(STATUS "PMJS dependency versions: SDL2=${SDL2_VERSION} EGL=${EGL_VERSION} GLES=${GLES_VERSION} PNG=${PNG_VERSION} JPEG=${JPEG_VERSION} FREETYPE=${FREETYPE_VERSION} HARFBUZZ=${HARFBUZZ_VERSION} AVFORMAT=${AVFORMAT_VERSION} AVCODEC=${AVCODEC_VERSION} AVUTIL=${AVUTIL_VERSION} SWRESAMPLE=${SWRESAMPLE_VERSION} SWSCALE=${SWSCALE_VERSION}")

set(PMJS_PLATFORM_LIBS PkgConfig::SDL2 PkgConfig::EGL PkgConfig::GLES ${CMAKE_DL_LIBS})
set(PMJS_MEDIA_LIBS PkgConfig::AVFORMAT PkgConfig::AVCODEC PkgConfig::AVUTIL PkgConfig::SWRESAMPLE PkgConfig::SWSCALE)
include(cmake/Effekseer.cmake)
include(cmake/Skia65.cmake)
set(PMJS_RUNTIME_SOURCES
  src/runtime_core.cpp
  src/platform.cpp
  src/dialog.cpp
  src/renderer_core.cpp
  src/renderer_draw.cpp
  src/renderer_custom_filters.cpp
  src/renderer_programs.cpp
  src/renderer_scene.cpp
  src/resources.cpp
  src/canvas.cpp
  src/text_backend.cpp
  src/text_layout.cpp
  src/vfs.cpp
  src/media_decoder.cpp
  src/media_service.cpp
  src/effects.cpp)

option(PMJS_ENABLE_WERROR "Treat compiler warnings as errors" OFF)
option(PMJS_ENABLE_SANITIZERS "Build with AddressSanitizer and UndefinedBehaviorSanitizer" OFF)

set(PMJS_BASE_COMPILE_OPTIONS -Wall -Wextra -Wpedantic -Wshadow)
if(PMJS_ENABLE_WERROR)
  list(APPEND PMJS_BASE_COMPILE_OPTIONS -Werror)
endif()

add_library(pmjs_runtime STATIC ${PMJS_RUNTIME_SOURCES})
target_include_directories(pmjs_runtime PUBLIC src)
target_compile_options(pmjs_runtime PRIVATE ${PMJS_BASE_COMPILE_OPTIONS})
target_link_libraries(pmjs_runtime PUBLIC ${PMJS_PLATFORM_LIBS} PkgConfig::PNG
  PkgConfig::JPEG PkgConfig::FREETYPE PkgConfig::HARFBUZZ ${PMJS_MEDIA_LIBS} EffekseerRendererGL m dl pthread)
if(PMJS_ENABLE_SKIA65)
  target_compile_definitions(pmjs_runtime PRIVATE PMJS_HAS_SKIA65)
  target_link_libraries(pmjs_runtime PRIVATE pmjs_skia65)
endif()

find_path(PMJS_NODE_API_HEADERS node_api.h PATHS /usr/include/node REQUIRED)
add_library(pmjs_native MODULE
  src/node_addon.cpp
  src/node_addon_canvas.cpp
  src/node_addon_dialog.cpp
  src/node_addon_common.cpp
  src/node_addon_entry.cpp
  src/node_addon_effects.cpp
  src/node_addon_graphics.cpp
  src/node_addon_media.cpp
  src/node_addon_platform.cpp
  src/node_addon_resources.cpp
  src/node_addon_runtime.cpp)
file(READ "${CMAKE_CURRENT_SOURCE_DIR}/third_party/effekseer.LICENSE" PMJS_EFFECTS_LICENSE)
configure_file(src/effects_license.hpp.in generated/effects_license.hpp @ONLY)
target_include_directories(pmjs_native PRIVATE "${CMAKE_CURRENT_BINARY_DIR}/generated")
target_include_directories(pmjs_native PRIVATE src)
target_include_directories(pmjs_native SYSTEM PRIVATE "${PMJS_NODE_API_HEADERS}")
target_compile_definitions(pmjs_native PRIVATE NODE_GYP_MODULE_NAME=pmjs_native NAPI_VERSION=8)
target_compile_options(pmjs_native PRIVATE ${PMJS_BASE_COMPILE_OPTIONS})
target_link_libraries(pmjs_native PRIVATE pmjs_runtime)
set_target_properties(pmjs_native PROPERTIES PREFIX "" SUFFIX ".node")

if(PMJS_ENABLE_SANITIZERS)
  set(PMJS_SANITIZER_FLAGS -fsanitize=address,undefined -fno-omit-frame-pointer)
  target_compile_options(pmjs_runtime PRIVATE ${PMJS_SANITIZER_FLAGS})
  target_link_options(pmjs_runtime PUBLIC ${PMJS_SANITIZER_FLAGS})
  target_compile_options(pmjs_native PRIVATE ${PMJS_SANITIZER_FLAGS})
  target_link_options(pmjs_native PUBLIC ${PMJS_SANITIZER_FLAGS})
endif()

include(CTest)
if(BUILD_TESTING)
  find_program(XVFB_RUN xvfb-run REQUIRED)
  find_program(BASE64_EXECUTABLE base64 REQUIRED)
  find_program(NODE_EXECUTABLE node REQUIRED)

  function(pmjs_add_cpp_test TARGET TEST_NAME)
    add_executable(${TARGET} ${ARGN})
    target_include_directories(${TARGET} PRIVATE src)
    target_compile_options(${TARGET} PRIVATE -Wall -Wextra -Wpedantic)
    add_test(NAME ${TEST_NAME} COMMAND $<TARGET_FILE:${TARGET}>)
  endfunction()

  pmjs_add_cpp_test(pmjs-vfs-test native-vfs test/vfs.cpp src/vfs.cpp)
  if(PMJS_ENABLE_SKIA65)
    pmjs_add_cpp_test(pmjs-text-backend-default-test native-text-backend-default test/text-backend-default.cpp)
    target_link_libraries(pmjs-text-backend-default-test PRIVATE pmjs_runtime)
    target_compile_definitions(pmjs-text-backend-default-test PRIVATE
      PMJS_TEST_FONT="${CMAKE_CURRENT_SOURCE_DIR}/test/assets/text-shaping.ttf")
  endif()
  add_executable(pmjs-text-backend-unavailable-test test/text-backend-unavailable.cpp src/text_backend.cpp)
  target_include_directories(pmjs-text-backend-unavailable-test PRIVATE src)
  add_test(NAME native-text-backend-unavailable COMMAND pmjs-text-backend-unavailable-test)
  add_test(NAME node-writable-filesystem COMMAND ${XVFB_RUN} -a ${CMAKE_COMMAND} -E env
    SDL_AUDIODRIVER=dummy LIBGL_ALWAYS_SOFTWARE=1
    PMJS_NATIVE_ADDON=$<TARGET_FILE:pmjs_native>
    ${NODE_EXECUTABLE} --test ${CMAKE_CURRENT_SOURCE_DIR}/test/node-writable-filesystem.cjs)
  pmjs_add_cpp_test(pmjs-checked-bounds-test native-checked-bounds test/checked-bounds.cpp)
  pmjs_add_cpp_test(pmjs-filter-precision-test native-filter-precision test/filter-precision.cpp)
  add_executable(pmjs-renderer-clear-test test/renderer-clear.cpp)
  target_link_libraries(pmjs-renderer-clear-test PRIVATE pmjs_runtime)
  target_compile_options(pmjs-renderer-clear-test PRIVATE -UNDEBUG)
  add_test(NAME native-renderer-clear COMMAND ${XVFB_RUN} -a $<TARGET_FILE:pmjs-renderer-clear-test>)
  set_tests_properties(native-renderer-clear PROPERTIES ENVIRONMENT "LIBGL_ALWAYS_SOFTWARE=1")
  pmjs_add_cpp_test(pmjs-media-mix-test native-audio-mix-unit test/media-mix.cpp)
  target_compile_definitions(pmjs-media-mix-test PRIVATE
    PMJS_EFFECT_AUDIO_REFERENCE="${CMAKE_CURRENT_SOURCE_DIR}/test/assets/reference/mz-effects/audio.tsv"
    PMJS_MZ_AUDIO_REFERENCE="${CMAKE_CURRENT_SOURCE_DIR}/test/assets/reference/mz-pan.tsv")
  add_executable(pmjs-image-capabilities-test test/image-capabilities.cpp)
  target_include_directories(pmjs-image-capabilities-test PRIVATE src)
  target_compile_options(pmjs-image-capabilities-test PRIVATE -Wall -Wextra -Wpedantic)
  target_link_libraries(pmjs-image-capabilities-test PRIVATE pmjs_runtime)
  add_test(NAME native-image-capabilities COMMAND ${XVFB_RUN} -a $<TARGET_FILE:pmjs-image-capabilities-test>)
  add_executable(pmjs-audio-assets-test test/audio-assets.cpp)
  target_include_directories(pmjs-audio-assets-test PRIVATE src)
  target_link_libraries(pmjs-audio-assets-test PRIVATE pmjs_runtime)
  target_compile_options(pmjs-audio-assets-test PRIVATE -Wall -Wextra -Wpedantic)
  add_test(NAME native-audio-assets COMMAND pmjs-audio-assets-test)
  add_executable(pmjs-effects-gl-state-test test/effects-gl-state.cpp)
  target_include_directories(pmjs-effects-gl-state-test PRIVATE src)
  target_compile_options(pmjs-effects-gl-state-test PRIVATE -Wall -Wextra -Wpedantic)
  target_link_libraries(pmjs-effects-gl-state-test PRIVATE pmjs_runtime Effekseer)
  add_test(NAME native-effects-gl-state COMMAND ${XVFB_RUN} -a $<TARGET_FILE:pmjs-effects-gl-state-test>
    "${CMAKE_CURRENT_BINARY_DIR}/test-assets" 3)
  set_tests_properties(native-effects-gl-state PROPERTIES
    ENVIRONMENT "LIBGL_ALWAYS_SOFTWARE=1" RESOURCE_LOCK pmjs_effect_fixtures)
  add_test(NAME native-effects-gl-state-es2 COMMAND ${XVFB_RUN} -a $<TARGET_FILE:pmjs-effects-gl-state-test>
    "${CMAKE_CURRENT_BINARY_DIR}/test-assets" 2)
  set_tests_properties(native-effects-gl-state-es2 PROPERTIES
    ENVIRONMENT "LIBGL_ALWAYS_SOFTWARE=1;MESA_GLES_VERSION_OVERRIDE=2.0" RESOURCE_LOCK pmjs_effect_fixtures)
  add_executable(pmjs-media-decoder-test test/media-decoder.cpp)
  target_include_directories(pmjs-media-decoder-test PRIVATE src)
  target_compile_options(pmjs-media-decoder-test PRIVATE -Wall -Wextra -Wpedantic)
  target_link_libraries(pmjs-media-decoder-test PRIVATE pmjs_runtime)
  add_executable(pmjs-audio-seek-test test/audio-seek.cpp)
  target_include_directories(pmjs-audio-seek-test PRIVATE src)
  target_compile_options(pmjs-audio-seek-test PRIVATE -Wall -Wextra -Wpedantic)
  target_link_libraries(pmjs-audio-seek-test PRIVATE pmjs_runtime)
  add_executable(pmjs-platform-input-test test/platform-input.cpp src/platform.cpp)
  add_executable(pmjs-dialog-modal-test test/dialog-modal.cpp)
  target_include_directories(pmjs-dialog-modal-test PRIVATE src)
  target_compile_options(pmjs-dialog-modal-test PRIVATE -Wall -Wextra -Wpedantic)
  target_link_libraries(pmjs-dialog-modal-test PRIVATE pmjs_runtime)
  add_test(NAME native-dialog-modal COMMAND
    ${XVFB_RUN} -a $<TARGET_FILE:pmjs-dialog-modal-test>)
  set_tests_properties(native-dialog-modal PROPERTIES ENVIRONMENT "LIBGL_ALWAYS_SOFTWARE=1")
  target_include_directories(pmjs-platform-input-test PRIVATE src)
  target_compile_options(pmjs-platform-input-test PRIVATE -Wall -Wextra -Wpedantic)
  target_link_libraries(pmjs-platform-input-test PRIVATE ${PMJS_PLATFORM_LIBS})
  add_test(NAME native-input COMMAND
    ${XVFB_RUN} -a $<TARGET_FILE:pmjs-platform-input-test>)
  set_tests_properties(native-input PROPERTIES ENVIRONMENT "LIBGL_ALWAYS_SOFTWARE=1")
  file(GLOB PMJS_JS_TESTS CONFIGURE_DEPENDS RELATIVE "${CMAKE_CURRENT_SOURCE_DIR}"
    "${CMAKE_CURRENT_SOURCE_DIR}/test/*.test.cjs")
  list(SORT PMJS_JS_TESTS)
  foreach(PMJS_JS_TEST IN LISTS PMJS_JS_TESTS)
    get_filename_component(PMJS_TEST_NAME "${PMJS_JS_TEST}" NAME_WE)
    add_test(NAME "js-${PMJS_TEST_NAME}" COMMAND ${NODE_EXECUTABLE} --test
      "${CMAKE_CURRENT_SOURCE_DIR}/${PMJS_JS_TEST}")
  endforeach()
  set_tests_properties(js-text-layout-reference js-pixi-filter-boundary-reference
    PROPERTIES ENVIRONMENT "PMJS_NATIVE_ADDON=$<TARGET_FILE:pmjs_native>;PMJS_TEST_ASSET_ROOT=${CMAKE_CURRENT_BINARY_DIR}/test-assets")
  file(MAKE_DIRECTORY "${CMAKE_CURRENT_BINARY_DIR}/test-assets")
  file(MAKE_DIRECTORY "${CMAKE_CURRENT_BINARY_DIR}/test-assets/effects")
  foreach(PMJS_EFFECT_FIXTURE Square Laser Trigger)
    execute_process(COMMAND ${BASE64_EXECUTABLE} -d
      INPUT_FILE "${CMAKE_CURRENT_SOURCE_DIR}/test/assets/effects/${PMJS_EFFECT_FIXTURE}.efkefc.b64"
      OUTPUT_FILE "${CMAKE_CURRENT_BINARY_DIR}/test-assets/effects/${PMJS_EFFECT_FIXTURE}.efkefc"
      COMMAND_ERROR_IS_FATAL ANY)
  endforeach()
  foreach(PMJS_EFFECT_FIXTURE Ribbon Ring Track Model)
    execute_process(COMMAND ${BASE64_EXECUTABLE} -d
      INPUT_FILE "${CMAKE_CURRENT_SOURCE_DIR}/test/assets/effects/${PMJS_EFFECT_FIXTURE}.efk.b64"
      OUTPUT_FILE "${CMAKE_CURRENT_BINARY_DIR}/test-assets/effects/${PMJS_EFFECT_FIXTURE}.efk"
      COMMAND_ERROR_IS_FATAL ANY)
  endforeach()
  file(MAKE_DIRECTORY "${CMAKE_CURRENT_BINARY_DIR}/test-assets/effects/Model")
  execute_process(COMMAND ${BASE64_EXECUTABLE} -d
    INPUT_FILE "${CMAKE_CURRENT_SOURCE_DIR}/test/assets/effects/Block.efkmodel.b64"
    OUTPUT_FILE "${CMAKE_CURRENT_BINARY_DIR}/test-assets/effects/Model/block.efkmodel"
    COMMAND_ERROR_IS_FATAL ANY)
  execute_process(COMMAND ${BASE64_EXECUTABLE} -d INPUT_FILE "${CMAKE_CURRENT_SOURCE_DIR}/test/assets/fixture.png.b64" OUTPUT_FILE "${CMAKE_CURRENT_BINARY_DIR}/test-assets/fixture.png" COMMAND_ERROR_IS_FATAL ANY)
  execute_process(COMMAND ${NODE_EXECUTABLE} -e "require(process.argv[1]).writeEffectFixtures(process.argv[2])"
    "${CMAKE_CURRENT_SOURCE_DIR}/test/effect-fixtures.cjs" "${CMAKE_CURRENT_BINARY_DIR}/test-assets"
    COMMAND_ERROR_IS_FATAL ANY)
  execute_process(COMMAND ${BASE64_EXECUTABLE} -d INPUT_FILE "${CMAKE_CURRENT_SOURCE_DIR}/test/assets/fixture.jpg.b64" OUTPUT_FILE "${CMAKE_CURRENT_BINARY_DIR}/test-assets/fixture.jpg" COMMAND_ERROR_IS_FATAL ANY)
  execute_process(COMMAND ${BASE64_EXECUTABLE} -d INPUT_FILE "${CMAKE_CURRENT_SOURCE_DIR}/test/assets/fixture-video.mp4.b64" OUTPUT_FILE "${CMAKE_CURRENT_BINARY_DIR}/test-assets/fixture-video.mp4" COMMAND_ERROR_IS_FATAL ANY)
  configure_file("${CMAKE_CURRENT_SOURCE_DIR}/test/assets/testfont.ttf" "${CMAKE_CURRENT_BINARY_DIR}/test-assets/testfont.ttf" COPYONLY)
  configure_file("${CMAKE_CURRENT_SOURCE_DIR}/test/assets/text-shaping.ttf"
    "${CMAKE_CURRENT_BINARY_DIR}/test-assets/text-shaping.ttf" COPYONLY)
  add_test(NAME native-media-decoder COMMAND pmjs-media-decoder-test
    "${CMAKE_CURRENT_BINARY_DIR}/test-assets/fixture-video.mp4")
  execute_process(COMMAND ${BASE64_EXECUTABLE} -d
    INPUT_FILE "${CMAKE_CURRENT_SOURCE_DIR}/test/assets/short-audio.flac.b64"
    OUTPUT_FILE "${CMAKE_CURRENT_BINARY_DIR}/test-assets/short-audio.flac"
    COMMAND_ERROR_IS_FATAL ANY)
  add_test(NAME native-audio-seek COMMAND pmjs-audio-seek-test
    "${CMAKE_CURRENT_BINARY_DIR}/test-assets/short-audio.flac")
  configure_file("${CMAKE_CURRENT_BINARY_DIR}/test-assets/fixture.png" "${CMAKE_CURRENT_BINARY_DIR}/test-assets/lease.png" COPYONLY)
  configure_file("${CMAKE_CURRENT_BINARY_DIR}/test-assets/fixture.png" "${CMAKE_CURRENT_BINARY_DIR}/test-assets/retained-fixture.png" COPYONLY)
  foreach(PMJS_MASK_PNG IN ITEMS probe-content probe-mask-a probe-mask-b)
    execute_process(COMMAND ${BASE64_EXECUTABLE} -d INPUT_FILE "${CMAKE_CURRENT_SOURCE_DIR}/test/assets/${PMJS_MASK_PNG}.png.b64" OUTPUT_FILE "${CMAKE_CURRENT_BINARY_DIR}/test-assets/${PMJS_MASK_PNG}.png" COMMAND_ERROR_IS_FATAL ANY)
  endforeach()
  add_executable(pmjs-canvas-pixels-test test/canvas-pixels.cpp)
  target_include_directories(pmjs-canvas-pixels-test PRIVATE src)
  target_compile_options(pmjs-canvas-pixels-test PRIVATE -UNDEBUG)
  add_test(NAME native-canvas-pixels COMMAND pmjs-canvas-pixels-test)
  add_executable(pmjs-canvas-upload-test test/canvas-upload.cpp)
  target_link_libraries(pmjs-canvas-upload-test PRIVATE pmjs_runtime)
  target_compile_options(pmjs-canvas-upload-test PRIVATE -UNDEBUG)
  add_test(NAME native-canvas-upload COMMAND pmjs-canvas-upload-test)
  foreach(PMJS_NODE_TEST IN ITEMS node-scene node-pixi4-clear node-mask-pixels node-renderer-stats node-render-to-image node-render-to-canvas node-render-target-filters node-image-coalesce node-image-retention node-image-warm-cache node-image-no-warm-cache node-image-fallback node-image-bytes node-audio-bytes node-video-texture node-canvas-deferred node-canvas-radial-gradient node-primitive-surface node-filter-bounds node-tone-boundary-pixels node-mz-color-pixels node-pixi5-zoom-pixels node-pixi5-tiling-pixels node-pixi5-sprite-rounding-pixels node-mz-sampling-pixels node-mesh-post-tint-overlay node-glyph-cache node-text-layout node-text-layout-cache node-text-upload node-freetype-facade node-primitive-canvas)
    add_test(NAME ${PMJS_NODE_TEST} COMMAND ${XVFB_RUN} -a ${NODE_EXECUTABLE}
      "${CMAKE_CURRENT_SOURCE_DIR}/test/${PMJS_NODE_TEST}.cjs" $<TARGET_FILE:pmjs_native> "${CMAKE_CURRENT_BINARY_DIR}/test-assets")
    set_tests_properties(${PMJS_NODE_TEST} PROPERTIES ENVIRONMENT "LIBGL_ALWAYS_SOFTWARE=1")
  endforeach()
  add_test(NAME node-custom-filters COMMAND ${XVFB_RUN} -a ${NODE_EXECUTABLE} --expose-gc
    "${CMAKE_CURRENT_SOURCE_DIR}/test/node-custom-filters.cjs" $<TARGET_FILE:pmjs_native> "${CMAKE_CURRENT_BINARY_DIR}/test-assets")
  set_tests_properties(node-custom-filters PROPERTIES ENVIRONMENT "LIBGL_ALWAYS_SOFTWARE=1;SDL_AUDIODRIVER=dummy")
  set_tests_properties(node-glyph-cache node-text-layout-cache PROPERTIES ENVIRONMENT
    "LIBGL_ALWAYS_SOFTWARE=1;PMJS_TEXT_BACKEND=freetype")
  if(PMJS_ENABLE_SKIA65)
    add_executable(pmjs-skia65-strided-test test/skia65-strided.cpp)
    target_include_directories(pmjs-skia65-strided-test PRIVATE src)
    target_compile_options(pmjs-skia65-strided-test PRIVATE -UNDEBUG)
    target_link_libraries(pmjs-skia65-strided-test PRIVATE pmjs_skia65)
    add_test(NAME native-skia65-strided COMMAND pmjs-skia65-strided-test)
    foreach(PMJS_SKIA_TEST IN ITEMS node-skia65-text node-skia65-canvas node-skia65-cache)
      add_test(NAME ${PMJS_SKIA_TEST} COMMAND ${XVFB_RUN} -a ${NODE_EXECUTABLE}
        "${CMAKE_CURRENT_SOURCE_DIR}/test/${PMJS_SKIA_TEST}.cjs" $<TARGET_FILE:pmjs_native> "${CMAKE_CURRENT_BINARY_DIR}/test-assets")
      set_tests_properties(${PMJS_SKIA_TEST} PROPERTIES ENVIRONMENT
        "LIBGL_ALWAYS_SOFTWARE=1;SDL_AUDIODRIVER=dummy;PMJS_TEXT_BACKEND=skia65")
    endforeach()
  endif()
  set_tests_properties(node-tone-boundary-pixels PROPERTIES ENVIRONMENT
    "LIBGL_ALWAYS_SOFTWARE=1;PMJS_WINDOW_SIZE=64x64")
  add_test(NAME node-filter-bounds-fullscreen COMMAND ${XVFB_RUN} -a ${NODE_EXECUTABLE}
    "${CMAKE_CURRENT_SOURCE_DIR}/test/node-filter-bounds.cjs" $<TARGET_FILE:pmjs_native> "${CMAKE_CURRENT_BINARY_DIR}/test-assets")
  set_tests_properties(node-filter-bounds-fullscreen PROPERTIES ENVIRONMENT
    "LIBGL_ALWAYS_SOFTWARE=1;PMJS_FILTER_BOUNDS=0")
  add_test(NAME node-pixi-precision COMMAND ${XVFB_RUN} -a ${NODE_EXECUTABLE}
    "${CMAKE_CURRENT_SOURCE_DIR}/test/node-pixi-precision.cjs" $<TARGET_FILE:pmjs_native> "${CMAKE_CURRENT_BINARY_DIR}/test-assets")
  set_tests_properties(node-pixi-precision PROPERTIES ENVIRONMENT
    "LIBGL_ALWAYS_SOFTWARE=1")
  function(pmjs_add_presentation_test name game window scale expect)
    add_test(NAME ${name} COMMAND ${XVFB_RUN} -a ${NODE_EXECUTABLE}
      "${CMAKE_CURRENT_SOURCE_DIR}/test/node-presentation.cjs" $<TARGET_FILE:pmjs_native> "${CMAKE_CURRENT_BINARY_DIR}/test-assets")
    set_tests_properties(${name} PROPERTIES ENVIRONMENT
      "LIBGL_ALWAYS_SOFTWARE=1;PMJS_TEST_GAME=${game};PMJS_WINDOW_SIZE=${window};PMJS_PRESENT_SCALE=${scale};PMJS_TEST_EXPECT=${expect}")
  endfunction()
  pmjs_add_presentation_test(node-presentation-identity 640x480 640x480 "" "640,480,0,0,nearest,0")
  pmjs_add_presentation_test(node-presentation-fit 816x624 640x480 "" "628,480,6,0,linear,1")
  pmjs_add_presentation_test(node-presentation-integer-fallback 816x624 640x480 "integer" "628,480,6,0,linear,1")
  pmjs_add_presentation_test(node-presentation-integer-upscale 320x240 640x480 "integer" "640,480,0,0,nearest,0")
  pmjs_add_presentation_test(node-presentation-display 64x64 "" "" "auto")
  pmjs_add_presentation_test(node-presentation-awkward 500x333 640x480 "" "640,426,0,27,linear,1")

  add_test(NAME node-presentation-pixels COMMAND ${XVFB_RUN} -a ${NODE_EXECUTABLE}
    "${CMAKE_CURRENT_SOURCE_DIR}/test/node-presentation-pixels.cjs" $<TARGET_FILE:pmjs_native> "${CMAKE_CURRENT_BINARY_DIR}/test-assets")
  set_tests_properties(node-presentation-pixels PROPERTIES ENVIRONMENT
    "LIBGL_ALWAYS_SOFTWARE=1;PMJS_TEST_GAME=816x624;PMJS_WINDOW_SIZE=640x480")
  foreach(PMJS_EFFECT_TEST node-effects node-mz-effects node-mz-effect-pixels)
    add_test(NAME ${PMJS_EFFECT_TEST} COMMAND ${XVFB_RUN} -a ${NODE_EXECUTABLE}
      "${CMAKE_CURRENT_SOURCE_DIR}/test/${PMJS_EFFECT_TEST}.cjs" $<TARGET_FILE:pmjs_native> "${CMAKE_CURRENT_BINARY_DIR}/test-assets")
    set_tests_properties(${PMJS_EFFECT_TEST} PROPERTIES
      RESOURCE_LOCK pmjs_effect_fixtures
      ENVIRONMENT "LIBGL_ALWAYS_SOFTWARE=1;SDL_AUDIODRIVER=dummy;PMJS_WINDOW_SIZE=64x64")
  endforeach()
endif()
