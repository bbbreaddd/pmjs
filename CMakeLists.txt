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
  src/renderer_core.cpp
  src/renderer_draw.cpp
  src/renderer_programs.cpp
  src/renderer_scene.cpp
  src/resources.cpp
  src/canvas.cpp
  src/vfs.cpp
  src/media_decoder.cpp
  src/media_service.cpp)

add_library(pmjs_runtime STATIC ${PMJS_RUNTIME_SOURCES})
target_include_directories(pmjs_runtime PUBLIC src)
target_compile_options(pmjs_runtime PRIVATE -Wall -Wextra -Wpedantic)
target_link_libraries(pmjs_runtime PUBLIC ${PMJS_PLATFORM_LIBS} PkgConfig::PNG
  PkgConfig::JPEG PkgConfig::FREETYPE ${PMJS_MEDIA_LIBS} m dl pthread)

find_path(PMJS_NODE_API_HEADERS node_api.h PATHS /usr/include/node REQUIRED)
add_library(pmjs_native MODULE
  src/node_addon.cpp
  src/node_addon_canvas.cpp
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
target_compile_options(pmjs_native PRIVATE -Wall -Wextra -Wpedantic)
target_link_libraries(pmjs_native PRIVATE pmjs_runtime)
set_target_properties(pmjs_native PROPERTIES PREFIX "" SUFFIX ".node")

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
  pmjs_add_cpp_test(pmjs-media-mix-test native-audio-mix-unit test/media-mix.cpp)
  add_executable(pmjs-platform-input-test test/platform-input.cpp src/platform.cpp)
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
      test/build-js-runtime.test.cjs)
    get_filename_component(PMJS_TEST_NAME "${PMJS_JS_TEST}" NAME_WE)
    add_test(NAME "js-${PMJS_TEST_NAME}" COMMAND ${NODE_EXECUTABLE} --test
      "${CMAKE_CURRENT_SOURCE_DIR}/${PMJS_JS_TEST}")
  endforeach()
  execute_process(COMMAND ${BASE64_EXECUTABLE} -d INPUT_FILE "${CMAKE_CURRENT_SOURCE_DIR}/test/assets/fixture.png.b64" OUTPUT_FILE "${CMAKE_CURRENT_BINARY_DIR}/test-assets/fixture.png" COMMAND_ERROR_IS_FATAL ANY)
  execute_process(COMMAND ${BASE64_EXECUTABLE} -d INPUT_FILE "${CMAKE_CURRENT_SOURCE_DIR}/test/assets/fixture.jpg.b64" OUTPUT_FILE "${CMAKE_CURRENT_BINARY_DIR}/test-assets/fixture.jpg" COMMAND_ERROR_IS_FATAL ANY)
  configure_file("${CMAKE_CURRENT_BINARY_DIR}/test-assets/fixture.png" "${CMAKE_CURRENT_BINARY_DIR}/test-assets/lease.png" COPYONLY)
  configure_file("${CMAKE_CURRENT_BINARY_DIR}/test-assets/fixture.png" "${CMAKE_CURRENT_BINARY_DIR}/test-assets/retained-fixture.png" COPYONLY)
  foreach(PMJS_NODE_TEST IN ITEMS node-scene node-renderer-stats node-image-coalesce node-image-retention)
    add_test(NAME ${PMJS_NODE_TEST} COMMAND ${XVFB_RUN} -a ${NODE_EXECUTABLE}
      "${CMAKE_CURRENT_SOURCE_DIR}/test/${PMJS_NODE_TEST}.cjs" $<TARGET_FILE:pmjs_native> "${CMAKE_CURRENT_BINARY_DIR}/test-assets")
    set_tests_properties(${PMJS_NODE_TEST} PROPERTIES ENVIRONMENT "LIBGL_ALWAYS_SOFTWARE=1")
  endforeach()
endif()
