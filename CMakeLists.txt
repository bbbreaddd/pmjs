cmake_minimum_required(VERSION 3.20)
project(pmjs_native_runtime LANGUAGES C CXX)

set(CMAKE_C_STANDARD 11)
set(CMAKE_CXX_STANDARD 20)
set(CMAKE_CXX_STANDARD_REQUIRED ON)
set(CMAKE_POSITION_INDEPENDENT_CODE ON)
set(PMJS_DEPENDENCY_PREFIX "" CACHE PATH "Prefix containing target runtime dependencies")

find_package(PkgConfig REQUIRED)
if(PMJS_DEPENDENCY_PREFIX)
  set(ENV{PKG_CONFIG_PATH} "${PMJS_DEPENDENCY_PREFIX}/lib/pkgconfig:${PMJS_DEPENDENCY_PREFIX}/share/pkgconfig:$ENV{PKG_CONFIG_PATH}")
endif()
pkg_check_modules(SDL2 REQUIRED IMPORTED_TARGET sdl2)
pkg_check_modules(EGL REQUIRED IMPORTED_TARGET egl)
pkg_check_modules(GLES REQUIRED IMPORTED_TARGET glesv2)
pkg_check_modules(PNG REQUIRED IMPORTED_TARGET libpng)
pkg_check_modules(JPEG REQUIRED IMPORTED_TARGET libjpeg)
pkg_check_modules(FREETYPE REQUIRED IMPORTED_TARGET freetype2)
pkg_check_modules(AVFORMAT REQUIRED IMPORTED_TARGET libavformat)
pkg_check_modules(AVCODEC REQUIRED IMPORTED_TARGET libavcodec)
pkg_check_modules(AVUTIL REQUIRED IMPORTED_TARGET libavutil)
pkg_check_modules(SWRESAMPLE REQUIRED IMPORTED_TARGET libswresample)
pkg_check_modules(SWSCALE REQUIRED IMPORTED_TARGET libswscale)

set(PMJS_PLATFORM_LIBS PkgConfig::SDL2 PkgConfig::EGL PkgConfig::GLES)
set(PMJS_MEDIA_LIBS PkgConfig::AVFORMAT PkgConfig::AVCODEC PkgConfig::AVUTIL PkgConfig::SWRESAMPLE PkgConfig::SWSCALE)
set(PMJS_RUNTIME_SOURCES
  src/runtime_core.cpp
  src/platform.cpp
  src/dialog.cpp
  src/renderer_core.cpp
  src/renderer_draw.cpp
  src/renderer_programs.cpp
  src/renderer_scene.cpp
  src/resources.cpp
  src/canvas.cpp
  src/vfs.cpp
  src/media_decoder.cpp
  src/media_service.cpp)

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
  PkgConfig::JPEG PkgConfig::FREETYPE ${PMJS_MEDIA_LIBS} m dl pthread)

find_path(PMJS_NODE_API_HEADERS node_api.h PATHS /usr/include/node REQUIRED)
add_library(pmjs_native MODULE
  src/node_addon.cpp
  src/node_addon_canvas.cpp
  src/node_addon_dialog.cpp
  src/node_addon_common.cpp
  src/node_addon_entry.cpp
  src/node_addon_graphics.cpp
  src/node_addon_media.cpp
  src/node_addon_platform.cpp
  src/node_addon_resources.cpp
  src/node_addon_runtime.cpp)
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
  pmjs_add_cpp_test(pmjs-checked-bounds-test native-checked-bounds test/checked-bounds.cpp)
  pmjs_add_cpp_test(pmjs-media-mix-test native-audio-mix-unit test/media-mix.cpp)
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
  foreach(PMJS_JS_TEST IN ITEMS
      test/operation-trace.test.cjs
      test/runtime-contract.test.cjs
      test/runner.test.cjs
      test/storage.test.cjs
      test/achievements.test.cjs
      test/build-js-runtime.test.cjs
      test/game-inspect.test.cjs
      test/object-urls.test.cjs
      test/mv-audio-object-url.test.cjs
      test/canvas-gradients.test.cjs
      test/canvas-content-revision.test.cjs
      test/mv-platform-semantics.test.cjs
      test/pmjs-web-dialogs.test.cjs
      test/fonts.test.cjs
      test/scheduler.test.cjs)
    get_filename_component(PMJS_TEST_NAME "${PMJS_JS_TEST}" NAME_WE)
    add_test(NAME "js-${PMJS_TEST_NAME}" COMMAND ${NODE_EXECUTABLE} --test
      "${CMAKE_CURRENT_SOURCE_DIR}/${PMJS_JS_TEST}")
  endforeach()
  file(MAKE_DIRECTORY "${CMAKE_CURRENT_BINARY_DIR}/test-assets")
  execute_process(COMMAND ${BASE64_EXECUTABLE} -d INPUT_FILE "${CMAKE_CURRENT_SOURCE_DIR}/test/assets/fixture.png.b64" OUTPUT_FILE "${CMAKE_CURRENT_BINARY_DIR}/test-assets/fixture.png" COMMAND_ERROR_IS_FATAL ANY)
  execute_process(COMMAND ${BASE64_EXECUTABLE} -d INPUT_FILE "${CMAKE_CURRENT_SOURCE_DIR}/test/assets/fixture.jpg.b64" OUTPUT_FILE "${CMAKE_CURRENT_BINARY_DIR}/test-assets/fixture.jpg" COMMAND_ERROR_IS_FATAL ANY)
  configure_file("${CMAKE_CURRENT_BINARY_DIR}/test-assets/fixture.png" "${CMAKE_CURRENT_BINARY_DIR}/test-assets/lease.png" COPYONLY)
  configure_file("${CMAKE_CURRENT_BINARY_DIR}/test-assets/fixture.png" "${CMAKE_CURRENT_BINARY_DIR}/test-assets/retained-fixture.png" COPYONLY)
  foreach(PMJS_MASK_PNG IN ITEMS probe-content probe-mask-a probe-mask-b)
    execute_process(COMMAND ${BASE64_EXECUTABLE} -d INPUT_FILE "${CMAKE_CURRENT_SOURCE_DIR}/test/assets/${PMJS_MASK_PNG}.png.b64" OUTPUT_FILE "${CMAKE_CURRENT_BINARY_DIR}/test-assets/${PMJS_MASK_PNG}.png" COMMAND_ERROR_IS_FATAL ANY)
  endforeach()
  foreach(PMJS_NODE_TEST IN ITEMS node-scene node-mask-pixels node-renderer-stats node-render-to-image node-render-to-canvas node-image-coalesce node-image-retention node-image-warm-cache node-image-no-warm-cache node-image-fallback node-image-bytes node-audio-bytes node-canvas-deferred node-canvas-radial-gradient node-primitive-surface node-filter-bounds)
    add_test(NAME ${PMJS_NODE_TEST} COMMAND ${XVFB_RUN} -a ${NODE_EXECUTABLE}
      "${CMAKE_CURRENT_SOURCE_DIR}/test/${PMJS_NODE_TEST}.cjs" $<TARGET_FILE:pmjs_native> "${CMAKE_CURRENT_BINARY_DIR}/test-assets")
    set_tests_properties(${PMJS_NODE_TEST} PROPERTIES ENVIRONMENT "LIBGL_ALWAYS_SOFTWARE=1")
  endforeach()
  add_test(NAME node-filter-bounds-fullscreen COMMAND ${XVFB_RUN} -a ${NODE_EXECUTABLE}
    "${CMAKE_CURRENT_SOURCE_DIR}/test/node-filter-bounds.cjs" $<TARGET_FILE:pmjs_native> "${CMAKE_CURRENT_BINARY_DIR}/test-assets")
  set_tests_properties(node-filter-bounds-fullscreen PROPERTIES ENVIRONMENT
    "LIBGL_ALWAYS_SOFTWARE=1;PMJS_FILTER_BOUNDS=0")
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
endif()
